import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { credentialStore } from '../src/index.ts'
import { TYPERT } from '../src/remote.ts'
import { KnowraOAuth } from '../src/oauth.ts'
import { fixture } from './fixture.ts'

test('DSH credential provider persists, restores and clears OAuth tokens without leaking them into the Remote contract', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'knowra-dsh-test-'))
  const server = await fixture()
  const filename = join(directory, '.credentials.yaml')
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: filename, watch: false }).await()
  const store = credentialStore(ctx)
  const oauth = new KnowraOAuth(store, { resource: `${server.base}/mcp`, issuer: server.base })
  t.after(async () => { oauth.dispose(); await ctx.fiber.dispose(); await server.close(); await rm(directory, { recursive: true, force: true }) })
  const { authorizationUrl } = await oauth.start()
  assert.equal((await server.authorize(authorizationUrl)).status, 200)
  assert.match(await readFile(filename, 'utf8'), /refresh-1/)
  // Windows uses account ACLs rather than POSIX file modes.
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600)
  oauth.dispose()
  await ctx.fiber.dispose()
  const next = new Context()
  await next.plugin(LocalCredentialProvider, { path: filename, watch: false }).await()
  const restored = new KnowraOAuth(credentialStore(next), { resource: `${server.base}/mcp`, issuer: server.base })
  t.after(async () => { restored.dispose(); await next.fiber.dispose() })
  assert.equal(await restored.accessToken(), 'access-1')
  await restored.disconnect()
  const after = await readFile(filename, 'utf8')
  assert.ok(!after.includes('access-1') && !after.includes('refresh-1'))
  assert.equal((await restored.state()).status, 'disconnected')
})

test('DSH Typert registry accepts the shared strict Remote descriptors', async () => {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry).await()
  try {
    validateTypertManifest('dsh-plugin-knowra', TYPERT)
    const dispose = ctx.typert.register(TYPERT)
    const status = ctx.typert.local.get('knowra/status')
    assert.equal(status?.service, 'knowraAuth')
    assert.equal(status?.invocation.kind, 'direct')
    assert.deepEqual(status?.parameters, [])
    assert.ok(status && status.result.mode === 'strict')
    const schema = status.result.create()
    assert.deepEqual(schema.parse({ status: 'connected', notice: null, server: 'ready', access_token: 'secret' }), {
      status: 'connected', notice: null, server: 'ready',
    })
    await dispose()
    assert.equal(ctx.typert.local.get('knowra/status'), undefined)
  } finally { await ctx.fiber.dispose() }
})
