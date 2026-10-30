<p align="center"><img src="icon.png" width="96" alt="Knowra"></p>

# dsh-plugin-knowra

[Knowra](https://knowra.app/mcp) for [DeepSeek Harness](https://www.deepseek.com/harness/): let your agent search arXiv papers by topic, author or exact dates, and read **Scout** reports that lay out each paper's methods, evidence and limitations, so you can decide which papers deserve a close read.

中文说明见[下方](#中文)。

## Install

In DSH: **Plugins → Add plugin**, enter `dsh-plugin-knowra`, then **Install**.

Or from the command line:

```sh
dsh plugin --profile web add dsh-plugin-knowra
```

Requires DSH **0.2.0-rc.2 or newer in the 0.2.x series**. After enabling the plugin, open **Plugins → Knowra → Connect Knowra**. Complete sign-in and approve access in your browser, then return to DSH. If the browser does not open, use the authorization link shown on the plugin page.

The plugin adds one MCP server, `knowra`, with three tools:

| Tool | What it does | Needs sign-in |
| --- | --- | --- |
| `mcp__knowra__search_papers` | Search arXiv titles, authors and abstracts, with optional UTC date windows (from 2025-08-01) | No |
| `mcp__knowra__get_scout` | Read the Scout report for a paper from the search results | Yes |
| `mcp__knowra__get_usage` | Check your Scout allowance and reset time | Yes |

Try: *"Find papers on memory for LLM agents from the past week, shortlist the relevant ones and read their Scout reports."*

## Connect your Knowra account

Search works right away without an account. To read Scout reports, connect your existing Knowra account from the plugin page.

- Authorization uses OAuth with PKCE. You never paste a key or token into DSH or a chat.
- Tokens are stored by DSH's credential service and refreshed automatically. Your connection survives restarts.
- **Disconnect** cancels a pending sign-in or removes the local connection and revokes its authorization. If the server is unreachable during disconnect, the page tells you to revoke it from your [Knowra account](https://knowra.app/account).
- The browser and DSH must run on the same computer for the local callback. This release targets Desktop and local Web UI; a remote/headless sign-in flow is not included.

**Upgrading from 0.1.x:** remove any `mcp-knowra` overrides you previously added to `~/.dsh/cordis.patch.yml` or a profile patch. This version uses OAuth only and does not read `KNOWRA_API_KEY`. Revoke the old personal key in your Knowra account if you no longer use it elsewhere.

## What this package contains

The package includes a DSH host plugin, a Desktop/Web account page, and an OAuth-aware MCP connection to `https://mcp.knowra.app/mcp`. It uses the official MCP SDK for authorization and DSH's official tool adapter for results. Tokens stay in DSH's local credential store, outside profile configuration, tool arguments and chat messages. The default DSH store is a file readable by your OS account; it is not an OS keychain.

Knowra receives the tool requests your agent sends, not your conversation. See the [privacy policy](https://knowra.app/privacy).

## Development and verification

```sh
npm ci --legacy-peer-deps
npx playwright install chromium
npm run check
npm test
npm run test:compat -- 0.2.0-rc.2
npm run test:compat -- 0.2.1-rc.3
npm pack
```

Tests exercise real local HTTP authorization/token endpoints, PKCE/state validation, refresh-token rotation, restart recovery, revocation, DSH credential persistence and strict Remote descriptors, MCP tool calls, and the built browser module in headless Chromium with DSH's real Remote service and Cordis dependency checks. They use isolated fixtures and do not contact real accounts. `npm pack` builds the host and browser artifacts before packaging; installing the tarball requires no build scripts.

`test:compat` installs the selected full DSH runtime in a temporary directory, checks its installer compatibility rules and built host metadata, then type-checks and runs the same tests against its actual host packages. CI covers both listed runtimes on Linux and Windows. To reuse an existing isolated runtime, set `KNOWRA_COMPAT_RUNTIME_DIR` to its directory.

For a local Web profile, install the resulting tarball with `dsh plugin --profile web add /absolute/path/dsh-plugin-knowra-0.2.3.tgz`. Desktop uses its own profile: install through its Plugins page, or fully quit Desktop and use the Desktop-provided CLI with `--profile desktop`. A fresh real Desktop connection still needs sign-in and approval through the deployed Knowra page.

## Contact

- Email: support@knowra.app
- X: [@knowra_app](https://x.com/knowra_app)
- Xiaohongshu (小红书): [Knowra](https://xhslink.cn/o/3hsTWQKz9pf), ID `knowra_app`
- Issues: [GitHub Issues](https://github.com/Rexopia/dsh-plugin-knowra/issues)

---

## 中文

让 DSH 里的 Agent 直接检索 arXiv 论文（按主题、作者或精确日期），并读 **Scout** 报告：帮你读完全文，标出方法、证据和局限，先判断哪篇值得精读。

**安装**：需要 DSH **0.2.0-rc.2 或更新的 0.2.x 版本**。DSH → 插件 → 添加插件，填 `dsh-plugin-knowra`，安装并启用。

**检索**不需要账号，装好即可用。**读 Scout**：打开「插件 → Knowra」，点击「连接 Knowra」，在浏览器中登录并允许授权，然后返回 DSH。浏览器未自动打开时，点击插件页的授权链接。

授权自动续期，重启后仍可使用；点击「断开连接」可取消登录或撤销连接。本版本支持桌面端和同机运行的 Web UI，浏览器必须能访问 DSH 所在电脑的本机回调地址。

**从 0.1.x 升级**：删除以前手动加入 home／profile patch 的 `mcp-knowra` 配置。新版只使用 OAuth，不再读取 `KNOWRA_API_KEY`。不再使用的旧 key 可在 Knowra 账户页撤销。

**联系我们**：support@knowra.app · X [@knowra_app](https://x.com/knowra_app) · 小红书 [Knowra](https://xhslink.cn/o/3hsTWQKz9pf)（小红书号 knowra_app） · [GitHub Issues](https://github.com/Rexopia/dsh-plugin-knowra/issues)
