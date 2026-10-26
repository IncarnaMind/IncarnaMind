# Connect Cursor

[All agents](agents.md) · [简体中文](#简体中文)

## Connect and check

1. Keep IncarnaMind open. In **Settings → Agents**, turn on **Connect AI agents**.
2. Choose **Cursor → Connect**. Select the Folders it may read, then **Allow and connect**. **Not in a Folder** shares Documents currently outside all Folders; no selection shares nothing.
3. Cursor opens an installation link. Confirm the installation in Cursor, then start a new agent conversation. Connect also installs `~/.cursor/skills/incarnamind/SKILL.md`.
4. Check Cursor's MCP server list for `incarnamind`. The Cursor CLI shares this configuration: `cursor-agent mcp list-tools incarnamind` lists the available tools.
5. Ask: “Using IncarnaMind, what do my Documents say about the cancellation period? Cite the passages and check your citations.” The answer should carry `[cite:…]` references. Ask Cursor to show a reference in IncarnaMind to inspect the original.

If installation links are unavailable, copy the connection's settings from **Details** into your own `~/.cursor/mcp.json`. Keep the existing `mcpServers` entries. The shape below shows where each value goes; replace the placeholders with the copied values, not with guessed paths or a new credential:

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

## What it can read

The connection searches the selected Folders and reads their Notes. It returns bounded Document Passages and checked Citations, rather than original Document files; further bounded calls can read more text. It can request an Answer on IncarnaMind's chosen model. These tools cannot edit your Documents or Notes. A found quote locates the words, rather than proving the agent's claim.

Cursor can send returned text to its own model under that service's terms. **Keep everything on this computer** in IncarnaMind pauses the connection. Cursor's other tools and permissions remain under your control in Cursor.

## Disconnect

Use **Settings → Agents → Disconnect** in IncarnaMind. This revokes the key immediately, closes existing connections, and removes the unchanged Skill. Remove the `incarnamind` entry from Cursor's MCP settings too; IncarnaMind does not edit the configuration Cursor installed through its link. Disabling the server in Cursor alone does not revoke the pairing in IncarnaMind.

If a call fails, check that IncarnaMind is open, connections are enabled, Local mode is off, and the intended Folders remain shared. **Activity** lists recent calls. Reconnect after moving or reinstalling IncarnaMind.

[Cursor's MCP guide](https://prod.cursor.com/docs/mcp) and [CLI MCP commands](https://prod.cursor.com/docs/cli/mcp) describe the client configuration.

## 简体中文

1. 保持 IncarnaMind 打开，在“设置 → 智能体”中开启智能体连接。
2. 选择 Cursor 的“连接”，勾选允许读取的文件夹，再选择“允许并连接”。“不在文件夹中”共享当前未归入文件夹的文档；不选择文件夹就不共享内容。
3. 在 Cursor 打开的安装页面中确认安装，然后新开一个智能体对话。连接时会安装 `~/.cursor/skills/incarnamind/SKILL.md`。
4. 在 Cursor 的 MCP 服务列表中检查 `incarnamind`。Cursor CLI 共用此配置，可以运行 `cursor-agent mcp list-tools incarnamind` 检查工具。
5. 可以问：“用 IncarnaMind 查一下，我的文档中如何规定取消期限？请给出引用并核对。”再让 Cursor 在 IncarnaMind 中打开引用。

安装链接不可用时，从“详情”中复制连接设置，添加到 `~/.cursor/mcp.json` 的 `mcpServers` 中，保留其他服务。上面的 JSON 展示配置格式；请替换所有占位符，不要猜测路径或自行生成凭据。设置包含配对凭据，请勿公开或提交到版本控制。修改后重启 Cursor；它可能另行要求启用服务或批准工具调用。

智能体只能读取所选文件夹内的文档片段和笔记，并获取核对过的引用；不会传输原始文档文件，也不能通过这些工具修改文档和笔记。智能体可以分次读取更多片段，也可以请求 IncarnaMind 生成回答。引文匹配不代表它支持智能体的判断。

返回的文字可能发送给 Cursor 使用的 AI 模型，适用该服务的条款。开启“设置 → 隐私 → 所有内容都留在这台电脑上”会暂停连接。Cursor 的其他工具仍由 Cursor 管理。

在 IncarnaMind 中选择“断开连接”，立即撤销权限并关闭已有连接，未修改过的 Skill 会被移除。还需在 Cursor 中移除 `incarnamind` 设置项；IncarnaMind 不修改 Cursor 通过安装链接写入的配置。仅在 Cursor 中停用服务不会撤销 IncarnaMind 中的配对。
