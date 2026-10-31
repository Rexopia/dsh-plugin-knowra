import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { remote } from '../src/remote.ts'

test('DSH enforces namespace injection after mounting; scoped page callbacks reach the carrier', async () => {
  const require = createRequire(import.meta.url)
  const filename = require.resolve('@deepseek-ai/dsh-api-gateway/client')
  const source = await readFile(filename, 'utf8')
  let Gateway: typeof import('@deepseek-ai/dsh-api-gateway/client') | undefined
  if (source.trimStart().startsWith('window.__ModuleLoader__.load(')) {
    // Older releases ship only a browser module factory at this export.
    const window = { __ModuleLoader__: { load: (entry: { factory: (require: NodeJS.Require) => typeof Gateway }) => { Gateway = entry.factory(require) } } }
    new Function('window', source)(window)
  } else {
    Gateway = await import(pathToFileURL(filename).href)
  }
  assert.ok(Gateway)
  const ctx = new Context()
  const calls: string[] = []
  ctx.provide('connection', {
    interactions: 'none', isLoopback: true,
    generation: { getSnapshot: () => undefined },
    registerGenerationSource: () => () => {},
    start: () => ({ stop() {} }),
    rpc: {
      open: () => { throw new Error('No stream calls expected') },
      call: async (_channel: string, endpoint: string) => {
        calls.push(endpoint)
        return { ok: true, value: { status: 'disconnected', notice: null, server: 'ready' } }
      },
    },
  } as any)
  try {
    await ctx.plugin(TypertRegistry).await()
    await ctx.plugin(Gateway).await()
    await ctx.plugin({
      name: 'knowra-injection-regression', inject: ['remote'],
      async apply(page: Context) {
        await page.remote.$mount(remote)
        assert.throws(() => page.remote.knowra.status(), /remote\.knowra.*without inject/)
        await page.inject(['remote.knowra'], async scoped => {
          const result = await scoped.remote.knowra.status()
          assert.deepEqual(result, { ok: true, value: { status: 'disconnected', notice: null, server: 'ready' } })
        }).await()
      },
    }).await()
    assert.deepEqual(calls, ['knowra/status'])
  } finally { await ctx.fiber.dispose() }
})
