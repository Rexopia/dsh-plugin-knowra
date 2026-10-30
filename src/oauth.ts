import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  auth, type OAuthClientProvider, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens, type AuthProvider,
} from '@modelcontextprotocol/client'

export const MCP_URL = 'https://mcp.knowra.app/mcp?s=dsh-plugin'
export const RESOURCE = 'https://mcp.knowra.app/mcp'
export const ISSUER = 'https://oauth.knowra.app'
export const SCOPES = 'scout:access usage:read offline_access'
const CALLBACK_PATH = '/oauth/knowra/callback'

export interface Grant {
  version: 1
  resource: string
  client?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  expiresAt?: number
  discovery?: OAuthDiscoveryState
  redirectUrl?: string
}

export interface GrantStore {
  read(): Promise<Grant | undefined>
  /** Must exclude other processes for the complete read/refresh/write operation. */
  modify(change: (grant: Grant | undefined) => Promise<Grant | undefined>): Promise<void>
  remove(): Promise<void>
}

export type AuthNotice = 'failed' | 'expired' | 'unavailable' | 'revocation_failed' | null
export interface AuthState {
  status: 'disconnected' | 'authorizing' | 'connected'
  notice: AuthNotice
}

interface Attempt {
  server: Server
  redirectUrl: string
  state: string
  verifier?: string
  url?: string
  timer: ReturnType<typeof setTimeout>
  settling: boolean
}

export interface OAuthOptions {
  resource?: string
  issuer?: string
  fetch?: typeof fetch
  now?: () => number
  authorizationTimeoutMs?: number
}

/** Only public facts leave this class. Tokens stay in the DSH credential store. */
export class KnowraOAuth {
  readonly resource: string
  readonly issuer: string
  readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly lifetime = new AbortController()
  private attempt?: Attempt
  private starting?: Promise<{ authorizationUrl: string }>
  private notice: AuthNotice = null
  private readonly rejectedTokens = new WeakMap<Response, string>()

  constructor(private readonly store: GrantStore, private readonly options: OAuthOptions = {}) {
    this.resource = options.resource ?? RESOURCE
    this.issuer = options.issuer ?? ISSUER
    this.now = options.now ?? Date.now
    const upstream = options.fetch ?? fetch
    const origins = new Set([new URL(this.resource).origin, new URL(this.issuer).origin])
    this.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (!origins.has(url.origin) || url.username || url.password) throw new Error('Untrusted authorization endpoint')
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      headers.set('User-Agent', 'dsh-plugin-knowra/0.2.3')
      const resource = new URL(this.resource)
      // Scout may generate a report during the tool request. Keep its existing
      // two-minute budget; discovery and token requests use the shorter limit.
      const timeoutMs = url.origin === resource.origin && url.pathname === resource.pathname ? 120_000 : 15_000
      const response = await upstream(input, {
        ...init, headers, redirect: 'error',
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])]),
      })
      const authorization = headers.get('Authorization')
      if (response.status === 401 && authorization?.startsWith('Bearer ')) {
        this.rejectedTokens.set(response, authorization.slice(7))
      }
      return response
    }
  }

  async state(): Promise<AuthState> {
    const grant = await this.store.read()
    return {
      status: this.attempt ? 'authorizing' : grant?.tokens ? 'connected' : 'disconnected',
      notice: this.notice,
    }
  }

  start(): Promise<{ authorizationUrl: string }> {
    this.lifetime.signal.throwIfAborted()
    if (this.attempt?.url) return Promise.resolve({ authorizationUrl: this.attempt.url })
    if (this.starting) return this.starting
    const work = this.begin()
    this.starting = work
    void work.then(() => { this.starting = undefined }, () => { this.starting = undefined })
    return work
  }

  private async begin(): Promise<{ authorizationUrl: string }> {
    this.notice = null
    const server = createServer((req, res) => { void this.callback(req, res).catch(() => reply(res, 500, false)) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') { server.close(); throw new Error('Could not start authorization callback') }
    const attempt: Attempt = {
      server, redirectUrl: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
      state: randomBytes(32).toString('base64url'), settling: false,
      timer: setTimeout(() => { this.notice = 'expired'; this.closeAttempt() }, this.options.authorizationTimeoutMs ?? 300_000),
    }
    attempt.timer.unref()
    this.attempt = attempt
    try {
      await this.transaction(async grant => {
        grant.redirectUrl = attempt.redirectUrl
        const result = await auth(this.provider(grant, attempt), {
          serverUrl: this.resource, scope: SCOPES, fetchFn: this.fetch, forceReauthorization: true,
        })
        if (result !== 'REDIRECT' || !attempt.url) throw new Error('Authorization did not produce a login URL')
      })
      return { authorizationUrl: attempt.url! }
    } catch {
      this.notice = 'unavailable'
      this.closeAttempt()
      throw new Error('Could not start Knowra authorization. Try again.')
    }
  }

  private async callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const attempt = this.attempt
    if (!attempt || attempt.settling) { reply(res, 410, false); return }
    const redirect = new URL(attempt.redirectUrl)
    const url = new URL(req.url ?? '/', redirect.origin)
    if (req.method !== 'GET' || req.headers.host !== redirect.host || url.pathname !== CALLBACK_PATH) {
      reply(res, 404, false); return
    }
    const state = url.searchParams.get('state') ?? ''
    if (url.searchParams.getAll('state').length !== 1 || !equal(state, attempt.state)) { reply(res, 400, false); return }
    attempt.settling = true
    clearTimeout(attempt.timer)
    try {
      const code = url.searchParams.get('code')
      if (url.searchParams.has('error') || !code || url.searchParams.getAll('code').length !== 1) throw new Error('Authorization declined')
      await this.transaction(async grant => {
        const result = await auth(this.provider(grant, attempt), {
          serverUrl: this.resource, scope: SCOPES, authorizationCode: code,
          iss: url.searchParams.get('iss') ?? undefined, fetchFn: this.fetch,
        })
        if (result !== 'AUTHORIZED' || !grant.tokens) throw new Error('Authorization incomplete')
      })
      this.notice = null
      reply(res, 200, true)
    } catch {
      this.notice = 'failed'
      reply(res, 400, false)
    } finally { this.closeAttempt() }
  }

  /** Resolve and refresh under the store's cross-process writer lock. */
  async accessToken(rejectedToken?: string): Promise<string | undefined> {
    this.lifetime.signal.throwIfAborted()
    let value: string | undefined
    await this.transaction(async grant => {
      if (!grant.tokens) return
      const changed = rejectedToken !== undefined && rejectedToken !== grant.tokens.access_token
      const fresh = (grant.expiresAt ?? 0) > this.now() + 30_000
      if (fresh && (rejectedToken === undefined || changed)) { value = grant.tokens.access_token; return }
      if (!grant.tokens.refresh_token) {
        delete grant.tokens; delete grant.expiresAt
        this.notice = 'expired'
        return
      }
      try {
        const result = await auth(this.provider(grant), { serverUrl: this.resource, scope: SCOPES, fetchFn: this.fetch })
        if (result === 'AUTHORIZED') { value = grant.tokens?.access_token; this.notice = null }
      } catch (error) {
        if (error instanceof LoginRequired) { this.notice = 'expired'; return }
        this.notice = 'unavailable'
        throw new Error('Could not refresh Knowra authorization. Try again.')
      }
    })
    return value
  }

  transportAuth(): AuthProvider {
    return {
      token: () => this.accessToken(),
      onUnauthorized: async ({ response }) => {
        const rejected = this.rejectedTokens.get(response)
        if (!rejected) throw new LoginRequired()
        const refreshed = await this.accessToken(rejected)
        if (!refreshed) throw new LoginRequired()
      },
    }
  }

  async disconnect(): Promise<AuthState> {
    this.closeAttempt()
    let failed = false
    // Serialize revocation with refresh, so the current rotated token is revoked.
    await this.store.modify(async grant => {
      if (grant?.tokens && grant.client) {
        try {
          const response = await this.fetch(`${this.issuer}/oauth/revoke`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: grant.tokens.refresh_token ?? grant.tokens.access_token,
              token_type_hint: grant.tokens.refresh_token ? 'refresh_token' : 'access_token', client_id: grant.client.client_id }),
          })
          failed = !response.ok
        } catch { failed = true }
      }
      return undefined
    })
    this.notice = failed ? 'revocation_failed' : null
    return this.state()
  }

  dispose(): void {
    this.lifetime.abort()
    this.closeAttempt()
  }

  private closeAttempt(): void {
    const attempt = this.attempt
    this.attempt = undefined
    if (attempt) { clearTimeout(attempt.timer); attempt.server.close(); attempt.server.closeIdleConnections() }
  }

  private async transaction(change: (grant: Grant) => Promise<void>): Promise<void> {
    let failure: unknown
    await this.store.modify(async previous => {
      const grant: Grant = previous?.version === 1 && previous.resource === this.resource
        ? structuredClone(previous) : { version: 1, resource: this.resource }
      try { await change(grant) } catch (error) { failure = error }
      return grant
    })
    if (failure) throw failure
  }

  private provider(grant: Grant, attempt?: Attempt): OAuthClientProvider {
    return {
      get redirectUrl() { return attempt?.redirectUrl ?? grant.redirectUrl },
      clientMetadata: {
        client_name: 'Knowra for DeepSeek Harness', client_uri: 'https://knowra.app/mcp',
        redirect_uris: [attempt?.redirectUrl ?? grant.redirectUrl!],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: 'none', scope: SCOPES,
      },
      state: () => { if (!attempt) throw new LoginRequired(); return attempt.state },
      clientInformation: () => grant.client,
      saveClientInformation: client => { grant.client = client },
      tokens: () => grant.tokens,
      saveTokens: tokens => {
        grant.tokens = tokens
        grant.expiresAt = this.now() + (tokens.expires_in ?? 600) * 1000
      },
      redirectToAuthorization: url => {
        if (!attempt || this.attempt !== attempt) throw new LoginRequired()
        if (url.origin !== new URL(this.issuer).origin) throw new Error('Unexpected authorization server')
        attempt.url = url.href
      },
      saveCodeVerifier: verifier => { if (!attempt) throw new LoginRequired(); attempt.verifier = verifier },
      codeVerifier: () => { if (!attempt?.verifier) throw new LoginRequired(); return attempt.verifier },
      validateResourceURL: async (_server, resource) => {
        if (resource && resource !== this.resource) throw new Error('Unexpected authorization resource')
        return new URL(this.resource)
      },
      saveDiscoveryState: discovery => { grant.discovery = discovery },
      discoveryState: () => grant.discovery,
      invalidateCredentials: scope => {
        if (scope === 'all' || scope === 'client') delete grant.client
        if (scope === 'all' || scope === 'tokens') { delete grant.tokens; delete grant.expiresAt }
        if (scope === 'all' || scope === 'discovery') delete grant.discovery
        if (attempt && (scope === 'all' || scope === 'verifier')) delete attempt.verifier
      },
    }
  }
}

export class LoginRequired extends Error {
  constructor() { super('Connect Knowra from the plugin page to continue.'); this.name = 'LoginRequired' }
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function reply(res: ServerResponse, status: number, success: boolean): void {
  if (res.writableEnded) return
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(`<!doctype html><meta charset="utf-8"><title>Knowra</title><h1>${success ? 'Knowra connected' : 'Authorization could not be completed'}</h1><p>${success ? 'You can close this tab and return to DeepSeek Harness.' : 'Return to the Knowra plugin page and try connecting again.'}</p>`)
}
