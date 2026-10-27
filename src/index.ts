import { type Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { KnowraOAuth, RESOURCE, type Grant, type GrantStore } from './oauth.ts'
import { KnowraBridge } from './bridge.ts'
import type { ConnectionState } from './remote.ts'

export const name = 'knowra'
export const inject = ['credentials', 'tools']

declare module '@deepseek-ai/cordis' {
  interface Context { knowraAuth: KnowraController }
}

export function credentialStore(ctx: Context): GrantStore {
  const key = credentialKey('knowra', 'oauth')
  return {
    read: async () => {
      const record = await ctx.credentials.readRecord(key)
      return record?.kind === 'grant' ? record.payload as Grant : undefined
    },
    modify: async change => {
      await ctx.credentials.modifyRecord(key, async record => {
        const next = {
          kind: 'grant' as const,
          // SDK metadata contains optional undefined fields; the credential
          // service requires payloads to survive a JSON round trip exactly.
          payload: JSON.parse(JSON.stringify(await change(record?.kind === 'grant' ? record.payload as Grant : undefined)
            ?? { version: 1, resource: RESOURCE })),
        }
        return JSON.stringify(next) === JSON.stringify(record) ? undefined : next
      })
    },
    remove: () => ctx.credentials.deleteRecord(key),
  }
}

export class KnowraController extends TypertRemoteService {
  private readonly oauth: KnowraOAuth
  private readonly bridge: KnowraBridge

  constructor(ctx: Context) {
    super(ctx, 'knowraAuth', { namespace: 'knowra' })
    this.oauth = new KnowraOAuth(credentialStore(ctx))
    this.bridge = new KnowraBridge(ctx, this.oauth)
    ctx.effect(() => () => { this.oauth.dispose(); return this.bridge.dispose() })
    // Startup remains usable for anonymous search and does not launch a browser.
    void this.bridge.connect().catch(() => { ctx.logger.warn('Knowra MCP connection will retry.') })
  }

  @Remote
  async status(): Promise<ConnectionState> {
    return { ...await this.oauth.state(), server: this.bridge.state }
  }

  @Remote
  connect(): Promise<{ authorizationUrl: string }> { return this.oauth.start() }

  @Remote
  async disconnect(): Promise<ConnectionState> {
    await this.oauth.disconnect()
    return this.status()
  }
}

export function apply(ctx: Context): void { ctx.plugin(KnowraController) }
