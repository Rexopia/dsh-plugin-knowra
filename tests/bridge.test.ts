import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { KnowraOAuth, LoginRequired } from '../src/oauth.ts'
import { KnowraBridge } from '../src/bridge.ts'
import { fixture, MemoryStore } from './fixture.ts'

function loginRequired(error: unknown): boolean {
  assert.ok(error instanceof LoginRequired)
  assert.match(error.message, /5 new Scout reports per day/)
  assert.match(error.message, /00:00 UTC/)
  assert.match(error.message, /Plugins → Knowra → Connect Knowra/)
  assert.match(error.message, /https:\/\/knowra\.app\/mcp#connect/)
  assert.doesNotMatch(error.message, /API key/i)
  return true
}

test('native tool adapter: anonymous search, OAuth Scout/usage, refresh on 401, and disconnect', async t => {
  const server = await fixture()
  const store = new MemoryStore()
  const oauth = new KnowraOAuth(store, { resource: `${server.base}/mcp`, issuer: server.base })
  const definitions = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (definition: ToolDefinition) => {
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    } },
    get: () => undefined,
  } as unknown as Context
  const bridge = new KnowraBridge(ctx, oauth, `${server.base}/mcp?s=dsh-plugin`)
  t.after(async () => { await bridge.dispose(); oauth.dispose(); await server.close() })
  await bridge.connect()
  assert.equal(bridge.state, 'ready')
  assert.deepEqual([...definitions.keys()].sort(), ['mcp__knowra__get_scout', 'mcp__knowra__get_usage', 'mcp__knowra__search_papers'])
  const exec = { signal: new AbortController().signal } as Parameters<ToolDefinition['execute']>[1]
  const call = (name: string) => definitions.get(`mcp__knowra__${name}`)!.execute({}, exec)
  assert.deepEqual(await call('search_papers'), { content: [{ type: 'text', text: 'papers' }] })
  await assert.rejects(call('get_usage'), loginRequired)
  await assert.rejects(call('get_scout'), loginRequired)
  assert.deepEqual(server.stats.calls, ['search_papers'])
  assert.equal(server.stats.registrations, 0)
  const { authorizationUrl } = await oauth.start()
  await server.authorize(authorizationUrl)
  assert.deepEqual(await call('get_usage'), { content: [{ type: 'text', text: '{"remaining":5}' }] })
  assert.ok(server.stats.headers.includes('Bearer access-1'))
  server.accessTokens.clear()
  await Promise.all(Array.from({ length: 8 }, () => call('get_scout')))
  assert.equal(server.stats.refreshes, 1)
  assert.ok(server.stats.headers.includes('Bearer access-2'))
  await oauth.disconnect()
  await assert.rejects(call('get_scout'), loginRequired)
  await call('search_papers')
  await bridge.dispose()
  assert.equal(definitions.size, 0)
})
