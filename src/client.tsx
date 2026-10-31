import React, { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { remote, type ConnectionState } from './remote.ts'

export const inject = ['slots', 'remote']
type PageProps = { remote: TypertClientRemote; language: () => string }
const strings = {
  en: {
    title: 'Knowra account', search: 'Paper search works without an account. Connect Knowra to read Scout reports and check your allowance.',
    connect: 'Connect Knowra', disconnect: 'Disconnect', pending: 'Finish signing in and approving access in your browser.',
    connected: 'Knowra connected', disconnected: 'Not connected', continue: 'Continue authorization in your browser',
    failed: 'Authorization was not completed. Try connecting again.', expired: 'Authorization expired. Connect Knowra again.',
    unavailable: 'Could not reach Knowra. Please try again.', revocation_failed: 'Disconnected on this device. Revoke the authorization from your Knowra account if needed.',
    loading: 'Checking connection…', server: 'The paper service is temporarily unavailable. It will reconnect automatically.',
    account: 'Manage your Knowra account', privacy: 'Privacy policy', retry: 'Retry',
  },
  zh: {
    title: 'Knowra 账号', search: '论文检索无需登录。连接 Knowra 后即可阅读 Scout 报告、查看剩余额度。',
    connect: '连接 Knowra', disconnect: '断开连接', pending: '请在浏览器中完成登录并允许授权。',
    connected: '已连接 Knowra', disconnected: '尚未连接', continue: '在浏览器中继续授权',
    failed: '未能完成授权，请重新连接。', expired: '授权已过期，请重新连接 Knowra。',
    unavailable: '暂时无法连接 Knowra，请稍后重试。', revocation_failed: '已在本机断开。你仍可前往 Knowra 账户页撤销授权。',
    loading: '正在检查连接…', server: '论文服务暂时不可用，正在自动重连。',
    account: '管理 Knowra 账号', privacy: '隐私政策', retry: '重试',
  },
}

export function KnowraPage({ remote: api, language }: PageProps) {
  const t = strings[language().startsWith('zh') ? 'zh' : 'en']
  const [state, setState] = useState<ConnectionState>()
  const [url, setUrl] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  async function read(signal?: AbortSignal) {
    const result = await api.knowra.status()
    if (signal?.aborted) return
    if (!result.ok) throw new Error('Connection unavailable')
    const next = result.value
    setState(next)
    if (next.status !== 'authorizing') setUrl(undefined)
    setError(false)
  }

  useEffect(() => {
    const controller = new AbortController()
    void read(controller.signal).catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [api])

  useEffect(() => {
    const controller = new AbortController()
    const timer = setInterval(() => { void read(controller.signal).catch(() => { if (!controller.signal.aborted) setError(true) }) }, state?.status === 'authorizing' ? 1500 : 15_000)
    return () => { clearInterval(timer); controller.abort() }
  }, [state?.status, api])

  async function connect() {
    setBusy(true); setError(false)
    try {
      const result = await api.knowra.connect()
      if (!result.ok) throw new Error('Connection unavailable')
      const target = result.value.authorizationUrl
      if (new URL(target).origin !== 'https://oauth.knowra.app') throw new Error('Invalid authorization URL')
      setUrl(target)
      window.open(target, '_blank', 'noopener,noreferrer')
      await read()
    } catch { setError(true) } finally { setBusy(false) }
  }

  async function disconnect() {
    setBusy(true); setError(false)
    try {
      const result = await api.knowra.disconnect()
      if (!result.ok) throw new Error('Connection unavailable')
      setState(result.value); setUrl(undefined)
    } catch { setError(true) } finally { setBusy(false) }
  }

  return <section aria-label={t.title} style={{ padding: '20px 0', maxWidth: 560, lineHeight: 1.6 }}>
    <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>{t.title}</h2>
    <p>{t.search}</p>
    <p role="status" aria-live="polite">{!state ? t.loading : state.status === 'connected' ? t.connected : state.status === 'authorizing' ? t.pending : t.disconnected}</p>
    {state?.notice && <p role="alert">{t[state.notice]}</p>}
    {error && <p role="alert">{t.unavailable}</p>}
    {state?.server === 'unavailable' && <p>{t.server}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      {state?.status === 'disconnected' && <button type="button" disabled={busy} onClick={() => void connect()}>{t.connect}</button>}
      {state && state.status !== 'disconnected' && <button type="button" disabled={busy} onClick={() => void disconnect()}>{t.disconnect}</button>}
      {!state && error && <button type="button" disabled={busy} onClick={() => void read().catch(() => setError(true))}>{t.retry}</button>}
    </div>
    {url && <p><a href={url} target="_blank" rel="noopener noreferrer">{t.continue}</a></p>}
    <p style={{ marginTop: 20 }}><a href="https://knowra.app/account" target="_blank" rel="noopener noreferrer">{t.account}</a>{' · '}<a href="https://knowra.app/privacy" target="_blank" rel="noopener noreferrer">{t.privacy}</a></p>
  </section>
}

export async function apply(context: Context): Promise<void> {
  const ctx = context as Context & {
    remote: TypertClientRemote
    slots: { inject: (name: string, mount: () => unknown) => void; register: (entry: object, component: typeof KnowraPage) => unknown }
  }
  const disposeRemote = await ctx.remote.$mount(remote)
  ctx.effect(() => disposeRemote)
  // $mount creates this namespace. Wait for it in a child fiber so Cordis
  // permits the page's callbacks to access remote.knowra. Declaring it in the
  // root inject list would deadlock before $mount can create the service.
  await ctx.inject(['remote.knowra'], context => {
    const page = context as typeof ctx
    page.slots.inject('plugins.bundle.config', () => page.slots.register({
      name: 'plugins.bundle.config', key: 'dsh-plugin-knowra',
      inject: () => ({ remote: page.remote, language: () => document.documentElement.lang || navigator.language }),
    }, KnowraPage))
  }).await()
}
