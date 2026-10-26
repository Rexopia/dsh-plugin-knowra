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

Restart DSH after installing. The plugin adds one MCP server, `knowra`, with three tools:

| Tool | What it does | Needs a key |
| --- | --- | --- |
| `mcp__knowra__search_papers` | Search arXiv titles, authors and abstracts, with optional UTC date windows (from 2025-08-01) | No |
| `mcp__knowra__get_scout` | Read the Scout report for a paper from the search results | Yes |
| `mcp__knowra__get_usage` | Check your Scout allowance and reset time | Yes |

Try: *"Find papers on memory for LLM agents from the past week, shortlist the relevant ones and read their Scout reports."*

## Scout: add your API key

Search works right away. To read Scout reports, create a personal API key in your [Knowra account](https://knowra.app/account). Need more Scout reads? You can upgrade to [Pro](https://knowra.app/pricing).

- **Terminal**: export the key before starting DSH:
  ```sh
  export KNOWRA_API_KEY=your_key
  ```
- **Desktop app**: add this to `~/.dsh/cordis.patch.yml` (create the file if needed), then restart DSH:
  ```yaml
  - id: mcp-knowra
    config:
      serverName: knowra
      transport: streamable-http
      url: https://mcp.knowra.app/mcp?s=dsh-plugin
      headers:
        Authorization: Bearer your_key
  ```

Keep the key out of chats and tool arguments. You can revoke it any time in your Knowra account.

## What this package contains

Only a `cordis.patch.yml` that points DSH's official MCP client (`@deepseek-ai/dsh-mcp-client`) at `https://mcp.knowra.app/mcp`. No code runs on your machine. Knowra receives only the tool requests your agent sends, not your conversation. See the [privacy policy](https://knowra.app/privacy).

## Contact

- Email: support@knowra.app
- X: [@knowra_app](https://x.com/knowra_app)
- Xiaohongshu (小红书): Knowra, ID `knowra_app`
- Issues: [GitHub Issues](https://github.com/Rexopia/dsh-plugin-knowra/issues)

---

## 中文

让 DSH 里的 Agent 直接检索 arXiv 论文（按主题、作者或精确日期），并读 **Scout** 报告：帮你读完全文，标出方法、证据和局限，先判断哪篇值得精读。

**安装**：DSH → 插件 → 添加插件，填 `dsh-plugin-knowra`，点安装，然后重启 DSH。

**检索**不需要账号，装好即可用。**读 Scout** 需要在 [Knowra 账户页](https://knowra.app/account)创建个人 API key；需要更多 Scout 可以升级 [Pro](https://knowra.app/pricing)：

- 命令行启动：先 `export KNOWRA_API_KEY=你的key`
- 桌面版：把上面英文部分的 YAML 写进 `~/.dsh/cordis.patch.yml`（`Bearer ` 后面换成你的 key），重启 DSH

不要把 key 发在对话里或写进工具参数；随时可以在账户页撤销。

**联系我们**：support@knowra.app · X [@knowra_app](https://x.com/knowra_app) · 小红书 Knowra（小红书号 knowra_app） · [GitHub Issues](https://github.com/Rexopia/dsh-plugin-knowra/issues)
