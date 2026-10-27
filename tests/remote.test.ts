import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import { remote } from '../src/remote.ts'

test('DSH enforces namespace injection after mounting; scoped page callbacks reach the carrier', async () => {
  const ctx = new Context()
  const calls: string[] = []
  ctx.provide('connection', {
    interactions: 'none', isLoopback: true,
    generation: { getSnapshot: () => undefined },
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
        assert.throws(() => remote.methods['knowra/status'].invoke(page.remote, {}), /remote\.knowra.*without inject/)
        await page.inject(['remote.knowra'], async scoped => {
          const result = await remote.methods['knowra/status'].invoke(scoped.remote, {})
          assert.deepEqual(result, { ok: true, value: { status: 'disconnected', notice: null, server: 'ready' } })
        }).await()
      },
    }).await()
    assert.deepEqual(calls, ['knowra/status'])
  } finally { await ctx.fiber.dispose() }
})
