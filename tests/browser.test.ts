import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

test('built desktop page uses real Cordis injection and DSH Remote for status, authorization and disconnect', async t => {
  const require = createRequire(import.meta.url)
  const gatewayPath = require.resolve('@deepseek-ai/dsh-api-gateway/client')
  const gatewaySource = await readFile(gatewayPath, 'utf8')
  const wrappedGateway = gatewaySource.trimStart().startsWith('window.__ModuleLoader__.load(')
  const harness = await build({
    stdin: { contents: `
      import * as React from 'react';
      import * as jsx from 'react/jsx-runtime';
      import { createRoot } from 'react-dom/client';
      import * as Cordis from '@deepseek-ai/cordis';
      import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
      ${wrappedGateway ? 'let ClientGateway;' : `import * as ClientGateway from ${JSON.stringify(gatewayPath)};`}
      const seed = { react: React, 'react/jsx-runtime': jsx, '@deepseek-ai/cordis': Cordis };
      window.testState = { status: 'disconnected', notice: null, server: 'ready' };
      window.testCalls = [];
      window.testFailures = false;
      window.__ModuleLoader__ = { load: entry => {
        const module = entry.factory(id => { if (!(id in seed)) throw new Error('Unknown external: ' + id); return seed[id]; });
        ${wrappedGateway ? "if (entry.id === '@deepseek-ai/dsh-api-gateway') { ClientGateway = module; return; }" : ''}
        const ctx = new Cordis.Context();
        window.testContext = ctx;
        ctx.provide('connection', {
          interactions: 'none', isLoopback: true,
          generation: { getSnapshot: () => undefined },
          registerGenerationSource: () => () => {},
          start: () => ({ stop() {} }),
          rpc: {
            open: () => { throw new Error('No streams in this test'); },
            call: async (_channel, endpoint) => {
              if (window.testFailures) return { ok: false, error: { code: 'gateway/internal', message: 'Test carrier unavailable', details: {} } };
              if (endpoint === 'knowra/status') return { ok: true, value: window.testState };
              if (endpoint === 'knowra/connect') {
                window.testCalls.push('connect'); window.testState = { ...window.testState, status: 'authorizing' };
                return { ok: true, value: { authorizationUrl: 'https://oauth.knowra.app/oauth/authorize?test=1' } };
              }
              if (endpoint === 'knowra/disconnect') {
                window.testCalls.push('disconnect'); window.testState = { ...window.testState, status: 'disconnected' };
                return { ok: true, value: window.testState };
              }
              throw new Error('Unexpected endpoint: ' + endpoint);
            },
          },
        });
        ctx.provide('slots', {
          inject: (name, mount) => mount(),
          register: (entry, Component) => { window.slot = entry.key; createRoot(document.getElementById('root')).render(React.createElement(Component, entry.inject())); return () => {}; },
        });
        (async () => {
          await ctx.plugin(TypertRegistry).await();
          await ctx.plugin(ClientGateway).await();
          // A real plugin fiber enforces remote.knowra injection; invoking the
          // component from the root Context would silently bypass this check.
          await ctx.plugin({ ...module, name: 'knowra-browser-test' }).await();
          window.descriptors = ctx.typert.remotes.list().map(x => x.namespace + '/' + x.method);
        })().catch(error => { window.testStartupError = error.message; console.error(error); });
      } };
      ${wrappedGateway ? gatewaySource : ''}
    `, resolveDir: process.cwd(), loader: 'js' },
    bundle: true, platform: 'browser', format: 'iife', write: false,
  })
  const client = await readFile('lib/client.js', 'utf8')
  const server = createServer((req, res) => {
    if (req.url === '/harness.js' || req.url === '/client.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' })
      res.end(req.url === '/harness.js' ? harness.outputFiles[0].text : client)
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html lang="zh"><style>body{font:15px system-ui;margin:40px;color:#222}button{padding:9px 16px;border:1px solid #ccc;border-radius:8px;background:white;cursor:pointer}a{color:#18644b}</style><div id="root"></div><script src="/harness.js"></script><script src="/client.js"></script></html>')
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const page = await browser.newPage({ viewport: { width: 800, height: 620 } })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
  await page.waitForFunction(() => (window as any).testStartupError || document.getElementById('root')?.textContent?.includes('尚未连接'))
  assert.equal(await page.evaluate(() => (window as any).testStartupError), undefined)
  await page.getByText('尚未连接', { exact: true }).waitFor().catch(async error => {
    throw new Error(`Page startup failed: ${JSON.stringify({ errors, startup: await page.evaluate(() => (window as any).testStartupError) })}`, { cause: error })
  })
  assert.deepEqual(await page.evaluate(() => (window as any).descriptors), ['knowra/status', 'knowra/connect', 'knowra/disconnect'])
  assert.equal(await page.evaluate(() => (window as any).slot), 'dsh-plugin-knowra')
  // Keep browser authorization inside this isolated test; never navigate to a real account.
  await browser.contexts()[0].route('https://oauth.knowra.app/**', route => route.fulfill({ body: 'Test authorization page' }))
  await page.getByRole('button', { name: '连接 Knowra', exact: true }).click()
  await page.getByText('请在浏览器中完成登录并允许授权。').waitFor()
  assert.equal(await page.getByRole('button', { name: '连接 Knowra', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '断开连接', exact: true }).count(), 1)
  assert.equal(await page.getByRole('link', { name: '在浏览器中继续授权' }).getAttribute('href'), 'https://oauth.knowra.app/oauth/authorize?test=1')
  await page.evaluate(() => { (window as any).testState.status = 'connected' })
  await page.getByText('已连接 Knowra', { exact: true }).waitFor()
  assert.equal(await page.getByRole('link', { name: '在浏览器中继续授权' }).count(), 0)
  await page.screenshot({ path: join(tmpdir(), 'knowra-dsh-oauth-settings.png') })
  await page.getByRole('button', { name: '断开连接' }).click()
  await page.getByText('尚未连接', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '连接 Knowra', exact: true }).count(), 1)
  assert.deepEqual(await page.evaluate(() => (window as any).testCalls), ['connect', 'disconnect'])
  assert.deepEqual(errors, [])
})
