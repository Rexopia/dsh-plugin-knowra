import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { KnowraOAuth, LoginRequired, MCP_URL } from './oauth.ts'

/** Reuse DSH's canonical tool/result adapter with an OAuth-aware SDK transport. */
export class KnowraBridge {
  state: 'connecting' | 'ready' | 'unavailable' = 'connecting'
  private client?: Client
  private connecting?: Promise<Client>
  private pendingClient?: Client
  private readonly tools = new Map<string, () => void>()
  private retry?: ReturnType<typeof setTimeout>
  private instructions?: () => void
  private disposed = false

  constructor(private readonly ctx: Context, private readonly oauth: KnowraOAuth, private readonly url = MCP_URL) {}

  async connect(): Promise<Client> {
    if (this.disposed) throw new Error('Knowra plugin is disabled')
    if (this.client) return this.client
    if (this.connecting) return this.connecting
    const work = this.open()
    this.connecting = work
    void work.then(() => { this.connecting = undefined }, () => { this.connecting = undefined })
    return work
  }

  private async open(): Promise<Client> {
    this.state = 'connecting'
    const client = new Client({ name: 'dsh-plugin-knowra', version: '0.2.2' })
    this.pendingClient = client
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      authProvider: this.oauth.transportAuth(), fetch: this.oauth.fetch,
      onInsufficientScope: 'throw',
    })
    client.onclose = () => {
      if (this.client === client) { this.client = undefined; this.state = 'unavailable'; this.scheduleRetry() }
    }
    try {
      await client.connect(transport)
      const { tools } = await client.listTools()
      const instructions = client.getInstructions()?.trim()
      if (instructions && Buffer.byteLength(instructions, 'utf8') > 32_768) throw new Error('Knowra server instructions are too large')
      if (this.disposed) throw new Error('Knowra plugin is disabled')
      const names = new Set<string>()
      const definitions = tools.map(tool => {
        if (!/^[A-Za-z0-9_-]{1,48}$/.test(tool.name) || names.has(tool.name)) throw new Error('Invalid Knowra tool list')
        names.add(tool.name)
        return createMcpToolDefinition(this.ctx, {
          name: `mcp__knowra__${tool.name}`, rawName: tool.name,
          description: tool.description ?? '', inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
          taskRequired: tool.execution?.taskSupport === 'required',
          call: async (args, execution) => {
            if (tool.name !== 'search_papers' && !await this.oauth.accessToken()) throw new LoginRequired()
            const active = await this.connect()
            return active.callTool({ name: tool.name, arguments: args }, { signal: execution.signal, timeout: 120_000, toolDefinition: tool })
          },
        })
      })
      for (const dispose of this.tools.values()) dispose()
      this.tools.clear()
      try {
        for (const definition of definitions) this.tools.set(definition.name, this.ctx.tools.register(definition))
      } catch (error) {
        for (const dispose of this.tools.values()) dispose()
        this.tools.clear()
        throw error
      }
      this.instructions?.()
      const prompt = this.ctx.get('systemPrompt')
      this.instructions = prompt && instructions ? prompt.section({
        name: 'mcp:knowra', order: prompt.getSectionOrder('MCP_SERVERS'),
        text: `MCP server knowra:\n${instructions}`, interpolate: false,
      }) : undefined
      this.client = client
      this.pendingClient = undefined
      this.state = 'ready'
      return client
    } catch {
      this.pendingClient = undefined
      await client.close().catch(() => {})
      this.state = 'unavailable'
      this.scheduleRetry()
      throw new Error('Knowra MCP is unavailable. Try again shortly.')
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.connect().catch(() => {})
    }, 5000)
    this.retry.unref()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearTimeout(this.retry)
    await this.pendingClient?.close().catch(() => {})
    await this.client?.close()
    await this.connecting?.catch(() => {})
    for (const dispose of this.tools.values()) dispose()
    this.tools.clear()
    this.instructions?.()
  }
}
