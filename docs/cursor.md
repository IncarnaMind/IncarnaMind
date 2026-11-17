# Connect Cursor

[All agents](agents.md) · [简体中文](#简体中文)

[All agents](agents.md) covers what is the same for every agent: the folders you share, what an agent can read, what leaves your computer, and how to stop. This page has only what is specific to Cursor.

## Connect and check

1. Keep IncarnaMind open. In **Settings → Agents**, turn on **Connect AI agents**, then choose **Cursor → Connect**. Select the Folders it may read, then **Allow and connect**.
2. Cursor opens an installation link. Confirm the installation in Cursor, then start a new agent conversation. Connect also installs the `incarnamind` Skill in `~/.cursor/skills/incarnamind/SKILL.md`.
3. Check Cursor's MCP server list for `incarnamind`. The Cursor CLI shares this configuration: `agent mcp list-tools incarnamind` lists the available tools.
4. Ask: “Using IncarnaMind, what do my Documents say about the cancellation period? Cite the passages and check your citations.” The answer should carry `[cite:…]` references. Ask Cursor to show one in IncarnaMind to inspect the original.

If installation links are unavailable, copy the connection's settings from **Details for technical users** into your own `~/.cursor/mcp.json`. Keep the existing `mcpServers` entries. The shape below shows where each value goes; replace the placeholders with the copied values, not with guessed paths or a new credential:

```json
{
  "mcpServers": {
    "incarnamind": {
      "command": "<app executable>",
      "args": ["<shipped agentShim.js>"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "INCARNAMIND_AGENT_SOCKET": "<socket>",
        "INCARNAMIND_AGENT_TOKEN": "<pairing key>"
      }
    }
  }
}
```

The copied settings contain the pairing credential. Keep them private and out of version control. Restart Cursor after a manual configuration change. Cursor may ask separately whether to enable the server or approve a tool call.

## Disconnect

Use **Settings → Agents → Disconnect** in IncarnaMind. It revokes the key at once, closes existing connections, and removes the Skill if unchanged. Remove the `incarnamind` entry from Cursor's MCP settings too: IncarnaMind does not edit the configuration Cursor installed through its link. Disabling the server in Cursor alone does not revoke the pairing in IncarnaMind.

If a call fails, see [If something goes wrong](agents.md#if-something-goes-wrong).

[Cursor's MCP guide](https://prod.cursor.com/docs/mcp) and [CLI MCP commands](https://prod.cursor.com/docs/cli/mcp) describe the client configuration.

## 简体中文

[所有智能体](agents.zh-CN.md)说明各智能体相同的部分：共享哪些文件夹、它能读取什么、哪些内容会离开你的电脑，以及如何停止。本页只写 Cursor 特有的内容。

1. 保持 IncarnaMind 打开。在“设置 → 智能体”中开启“连接 AI 智能体”，选择 Cursor 的“连接”，勾选允许读取的文件夹，再选择“允许并连接”。
2. 在 Cursor 打开的安装页面中确认安装，然后新开一个智能体对话。连接时会安装 `~/.cursor/skills/incarnamind/SKILL.md`。
3. 在 Cursor 的 MCP 服务列表中检查 `incarnamind`。Cursor CLI 共用此配置，可以运行 `agent mcp list-tools incarnamind` 检查工具。
4. 可以问：“用 IncarnaMind 查一下，我的文档中如何规定取消期限？请给出引用并核对。”再让 Cursor 在 IncarnaMind 中打开引用。

安装链接不可用时，从“技术细节”中复制连接设置，添加到 `~/.cursor/mcp.json` 的 `mcpServers` 中，保留其他服务。上面的 JSON 展示配置格式；请替换所有占位符，不要猜测路径或自行生成凭据。设置包含配对凭据，请勿公开或提交到版本控制。修改后重启 Cursor；它可能另行要求启用服务或批准工具调用。

在 IncarnaMind 中选择“断开连接”，立即撤销权限并关闭已有连接，未修改过的技能会被移除。还需在 Cursor 中移除 `incarnamind` 设置项；IncarnaMind 不修改 Cursor 通过安装链接写入的配置。仅在 Cursor 中停用服务不会撤销 IncarnaMind 中的配对。

异常时，见[遇到问题时](agents.zh-CN.md#遇到问题时)。
