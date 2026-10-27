import { createTypertRemoteInfo, type TypertRemoteInfo, type TypertRemoteMethod } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

export const authStateSchema = z.object({
  status: z.enum(['disconnected', 'authorizing', 'connected']),
  notice: z.enum(['failed', 'expired', 'unavailable', 'revocation_failed']).nullable(),
  server: z.enum(['connecting', 'ready', 'unavailable']),
})
export type ConnectionState = z.infer<typeof authStateSchema>

// One shared wire contract for the Host and browser. No token fields cross it.
const method = (create: () => z.ZodType) => ({
  service: 'knowraAuth', invocation: { kind: 'direct' as const }, parameters: [],
  result: { mode: 'strict' as const, typeSymbol: 'knowra.ConnectionState', create },
})
export const remote = createTypertRemoteInfo({
  package: 'dsh-plugin-knowra',
  methods: {
    'knowra/status': method(() => authStateSchema),
    'knowra/connect': method(() => z.object({ authorizationUrl: z.url() })),
    'knowra/disconnect': method(() => authStateSchema),
  },
}, z) as TypertRemoteInfo<{
  'knowra/status': TypertRemoteMethod<Record<string, never>, ConnectionState>
  'knowra/connect': TypertRemoteMethod<Record<string, never>, { authorizationUrl: string }>
  'knowra/disconnect': TypertRemoteMethod<Record<string, never>, ConnectionState>
}>

export const TYPERT = {
  package: 'dsh-plugin-knowra', face: 'host' as const, schemas: [],
  model: { services: [], events: [], objects: [] }, invocations: remote.descriptors,
}
