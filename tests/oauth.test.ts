import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { KnowraOAuth } from '../src/oauth.ts'
import { fixture, MemoryStore } from './fixture.ts'

async function setup(t: test.TestContext) {
  const server = await fixture()
  const store = new MemoryStore()
  const oauth = new KnowraOAuth(store, { resource: `${server.base}/mcp`, issuer: server.base })
  t.after(async () => { oauth.dispose(); await server.close() })
  const login = async () => {
    const { authorizationUrl } = await oauth.start()
    assert.equal((await server.authorize(authorizationUrl)).status, 200)
  }
  return { server, store, oauth, login }
}

test('PKCE + dynamic registration, correct resource/scopes, write-only public status and restart recovery', async t => {
  const { server, store, oauth, login } = await setup(t)
  assert.deepEqual(await oauth.state(), { status: 'disconnected', notice: null })
  assert.equal(await oauth.accessToken(), undefined)
  const { authorizationUrl } = await oauth.start()
  const url = new URL(authorizationUrl)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('resource'), `${server.base}/mcp`)
  assert.equal(url.searchParams.get('scope'), 'scout:access usage:read offline_access')
  assert.equal((await oauth.state()).status, 'authorizing')
  assert.equal((await oauth.start()).authorizationUrl, authorizationUrl)
  assert.equal((await server.authorize(authorizationUrl)).status, 200)
  assert.equal(await oauth.accessToken(), 'access-1')
  assert.equal(server.stats.registrations, 1)
  assert.equal(server.stats.exchanges, 1)
  assert.deepEqual(await oauth.state(), { status: 'connected', notice: null })
  assert.ok(!JSON.stringify(await oauth.state()).includes('access-1'))
  assert.ok(!JSON.stringify(store.grant).includes('verifier'))
  oauth.dispose()
  const restored = new KnowraOAuth(store, { resource: `${server.base}/mcp`, issuer: server.base })
  t.after(() => restored.dispose())
  assert.equal(await restored.accessToken(), 'access-1')
  assert.equal(server.stats.refreshes, 0)
})

test('rejects forged state and callback host without consuming the pending login', async t => {
  const { oauth, server } = await setup(t)
  const { authorizationUrl } = await oauth.start()
  const authUrl = new URL(authorizationUrl)
  const callback = new URL(authUrl.searchParams.get('redirect_uri')!)
  callback.searchParams.set('code', 'stolen-code'); callback.searchParams.set('state', 'wrong-state')
  const response = await fetch(callback)
  assert.equal(response.status, 400)
  assert.equal((await oauth.state()).status, 'authorizing')
  assert.equal(server.stats.exchanges, 0)
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(callback, { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.end()
  })
  assert.equal(wrongHost, 404)
  assert.equal((await server.authorize(authorizationUrl)).status, 200)
})

test('issuer mismatch is rejected before exchanging the authorization code', async t => {
  const { oauth, server, store } = await setup(t)
  const { authorizationUrl } = await oauth.start()
  const response = await fetch(authorizationUrl, { redirect: 'manual' })
  const callback = new URL(response.headers.get('location')!)
  callback.searchParams.set('iss', 'https://untrusted.example')
  assert.equal((await fetch(callback)).status, 400)
  assert.equal(server.stats.exchanges, 0)
  assert.equal(store.grant?.tokens, undefined)
})

test('declined authorization ends the attempt and does not store tokens', async t => {
  const { oauth, store } = await setup(t)
  const { authorizationUrl } = await oauth.start()
  const params = new URL(authorizationUrl).searchParams
  const callback = new URL(params.get('redirect_uri')!)
  callback.searchParams.set('state', params.get('state')!); callback.searchParams.set('error', 'access_denied')
  assert.equal((await fetch(callback)).status, 400)
  assert.deepEqual(await oauth.state(), { status: 'disconnected', notice: 'failed' })
  assert.equal(store.grant?.tokens, undefined)
})

test('expired token rotates only once across concurrent calls and independent plugin instances', async t => {
  const { oauth, store, server, login } = await setup(t)
  await login()
  store.grant!.expiresAt = 0
  const other = new KnowraOAuth(store, { resource: `${server.base}/mcp`, issuer: server.base })
  t.after(() => other.dispose())
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? oauth : other).accessToken()))
  assert.deepEqual(new Set(results), new Set(['access-2']))
  assert.equal(server.stats.refreshes, 1)
  assert.equal(store.grant?.tokens?.refresh_token, 'refresh-2')
})

test('revoked refresh token clears authorization and requests a new explicit login', async t => {
  const { oauth, store, server, login } = await setup(t)
  await login()
  server.refreshTokens.clear(); store.grant!.expiresAt = 0
  assert.equal(await oauth.accessToken(), undefined)
  assert.deepEqual(await oauth.state(), { status: 'disconnected', notice: 'expired' })
  assert.equal(store.grant?.tokens, undefined)
})

test('transient refresh failure preserves credentials for retry', async t => {
  const { oauth, store, server, login } = await setup(t)
  await login()
  store.grant!.expiresAt = 0; server.setRefreshAvailable(false)
  await assert.rejects(oauth.accessToken(), /Could not refresh/)
  assert.equal(store.grant?.tokens?.refresh_token, 'refresh-1')
  server.setRefreshAvailable(true)
  assert.equal(await oauth.accessToken(), 'access-2')
})

test('disconnect revokes the current refresh token and removes local credentials', async t => {
  const { oauth, store, server, login } = await setup(t)
  await login()
  await oauth.disconnect()
  assert.equal(server.stats.revocations, 1)
  assert.equal(store.grant, undefined)
  assert.equal(await oauth.accessToken(), undefined)
})

test('offline disconnect still clears local credentials and reports pending remote revocation', async t => {
  const { oauth, store, server, login } = await setup(t)
  await login(); server.setRevokeAvailable(false)
  assert.deepEqual(await oauth.disconnect(), { status: 'disconnected', notice: 'revocation_failed' })
  assert.equal(store.grant, undefined)
})

test('timeout closes the callback listener and allows a fresh attempt', async t => {
  const server = await fixture()
  const oauth = new KnowraOAuth(new MemoryStore(), { resource: `${server.base}/mcp`, issuer: server.base, authorizationTimeoutMs: 100 })
  t.after(async () => { oauth.dispose(); await server.close() })
  const old = await oauth.start()
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(await oauth.state(), { status: 'disconnected', notice: 'expired' })
  const fresh = await oauth.start()
  assert.notEqual(fresh.authorizationUrl, old.authorizationUrl)
})
