import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

export const authStateSchema = z.object({
  status: z.enum(['disconnected', 'authorizing', 'connected']),
  notice: z.enum(['failed', 'expired', 'unavailable', 'revocation_failed']).nullable(),
  server: z.enum(['connecting', 'ready', 'unavailable']),
})
export type ConnectionState = z.infer<typeof authStateSchema>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    knowra: {
      status(): Promise<RemoteResult<ConnectionState>>
      connect(): Promise<RemoteResult<{ authorizationUrl: string }>>
      disconnect(): Promise<RemoteResult<ConnectionState>>
    }
  }
}

// Use the descriptor contract available since 0.2.0-rc.2. The newer
// createTypertRemoteInfo helper is not exported by that runtime.
// Host and browser share these strict results; no token fields cross them.
const method = (name: string, typeSymbol: string, create: () => z.ZodType): InvocationDescriptor => ({
  id: `dsh-plugin-knowra#knowra/${name}`,
  service: 'knowraAuth', namespace: 'knowra', method: name,
  invocation: { kind: 'direct' }, parameters: [],
  result: { mode: 'strict', typeSymbol, create },
})
export const remote = {
  package: 'dsh-plugin-knowra',
  descriptors: [
    method('status', 'knowra.ConnectionState', () => authStateSchema),
    method('connect', 'knowra.Authorization', () => z.object({ authorizationUrl: z.url() })),
    method('disconnect', 'knowra.ConnectionState', () => authStateSchema),
  ],
} satisfies TypertRemoteContribution

export const TYPERT = {
  package: 'dsh-plugin-knowra', face: 'host' as const, schemas: [],
  model: { services: [], events: [], objects: [] }, invocations: remote.descriptors,
}
