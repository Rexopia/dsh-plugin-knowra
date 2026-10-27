import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Grant, GrantStore } from '../src/oauth.ts'

export class MemoryStore implements GrantStore {
  grant?: Grant
  private queue = Promise.resolve()
  async read() { await this.queue; return this.grant ? structuredClone(this.grant) : undefined }
  async modify(change: (grant: Grant | undefined) => Promise<Grant | undefined>) {
    const work = this.queue.then(async () => {
      const grant = await change(this.grant ? structuredClone(this.grant) : undefined)
      this.grant = grant ? JSON.parse(JSON.stringify(grant)) : undefined
    })
    this.queue = work.catch(() => {})
    await work
  }
  async remove() { await this.modify(async () => undefined) }
}

export async function fixture() {
  let base = ''
  let tokenId = 0
  const clients = new Map<string, { redirect_uris: string[] }>()
  const codes = new Map<string, { challenge: string; redirect: string }>()
  const refreshTokens = new Set<string>()
  const accessTokens = new Set<string>()
  const stats = { registrations: 0, exchanges: 0, refreshes: 0, revocations: 0, calls: [] as string[], headers: [] as string[] }
  let revokeAvailable = true
  let refreshAvailable = true
  const token = () => {
    tokenId++
    const access_token = `access-${tokenId}`, refresh_token = `refresh-${tokenId}`
    accessTokens.add(access_token); refreshTokens.add(refresh_token)
    return { access_token, refresh_token, token_type: 'Bearer', expires_in: 600, scope: 'scout:access usage:read offline_access' }
  }
  const server = createServer((req, res) => { void handle(req, res).catch(() => { res.writeHead(500); res.end() }) })
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, base)
    stats.headers.push(String(req.headers.authorization ?? ''))
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') {
      json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['scout:access', 'usage:read', 'offline_access'] }); return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`, revocation_endpoint: `${base}/oauth/revoke`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ['scout:access', 'usage:read', 'offline_access'] }); return
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    if (url.pathname === '/register') {
      const metadata = JSON.parse(body)
      if (metadata.token_endpoint_auth_method !== 'none') { json({ error: 'invalid_client_metadata' }, 400); return }
      const id = `client-${++stats.registrations}`
      clients.set(id, metadata)
      json({ ...metadata, client_id: id }, 201); return
    }
    if (url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri')!
      if (!clients.has(url.searchParams.get('client_id')!) || url.searchParams.get('code_challenge_method') !== 'S256') {
        json({ error: 'invalid_request' }, 400); return
      }
      const code = `code-${codes.size + 1}`
      codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect })
      const callback = new URL(redirect)
      callback.searchParams.set('state', url.searchParams.get('state')!)
      callback.searchParams.set('code', code)
      callback.searchParams.set('iss', base)
      res.writeHead(302, { Location: callback.href }); res.end(); return
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(body)
      if (params.get('resource') !== `${base}/mcp`) { json({ error: 'invalid_target' }, 400); return }
      if (params.get('grant_type') === 'authorization_code') {
        const code = codes.get(params.get('code')!)
        const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url')
        if (!code || code.challenge !== challenge || code.redirect !== params.get('redirect_uri')) { json({ error: 'invalid_grant' }, 400); return }
        codes.delete(params.get('code')!); stats.exchanges++; json(token()); return
      }
      if (params.get('grant_type') === 'refresh_token') {
        if (!refreshAvailable) { json({ error: 'temporarily_unavailable' }, 503); return }
        const old = params.get('refresh_token')!
        if (!refreshTokens.delete(old)) { json({ error: 'invalid_grant' }, 400); return }
        stats.refreshes++; json(token()); return
      }
    }
    if (url.pathname === '/oauth/revoke') {
      if (!revokeAvailable) { json({ error: 'temporarily_unavailable' }, 503); return }
      stats.revocations++; refreshTokens.delete(new URLSearchParams(body).get('token')!); json({}); return
    }
    if (url.pathname === '/mcp') {
      if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405); res.end(); return }
      const request = JSON.parse(body)
      const id = request.id
      if (id === undefined) { res.writeHead(202); res.end(); return }
      let result: unknown
      if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'knowra-test', version: '1' } }
      else if (request.method === 'tools/list') result = { tools: ['search_papers', 'get_usage', 'get_scout'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) }
      else if (request.method === 'tools/call') {
        const name = request.params.name
        if (name !== 'search_papers' && !accessTokens.has(String(req.headers.authorization).replace(/^Bearer /, ''))) {
          res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }); res.end(); return
        }
        stats.calls.push(name)
        result = { content: [{ type: 'text', text: name === 'get_usage' ? '{"remaining":5}' : 'papers' }] }
      } else { json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return }
      json({ jsonrpc: '2.0', id, result }); return
    }
    json({ error: 'not_found' }, 404)
  }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  base = `http://127.0.0.1:${address.port}`
  return {
    base, stats, refreshTokens, accessTokens,
    setRevokeAvailable: (value: boolean) => { revokeAvailable = value },
    setRefreshAvailable: (value: boolean) => { refreshAvailable = value },
    async authorize(url: string) {
      const response = await fetch(url, { redirect: 'manual' })
      const callback = response.headers.get('location')
      if (!callback) throw new Error('No callback')
      return fetch(callback)
    },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
