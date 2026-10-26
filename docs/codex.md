# Connect Codex

[All agents](agents.md) · [简体中文](#简体中文)

## Connect and check

1. Keep IncarnaMind open. In **Settings → Agents**, turn on **Connect AI agents**.
2. Choose **ChatGPT app and Codex → Connect**. Select the Folders it may read, review the settings change, then choose **Allow and connect**. **Not in a Folder** shares Documents currently outside all Folders; no selection shares nothing.
3. IncarnaMind adds its entry to `~/.codex/config.toml`, preserving your other servers. It also installs `~/.agents/skills/incarnamind/SKILL.md`. The setup's **Undo** takes these changes back while they are unchanged.
4. Start a new Codex session. Run `codex mcp list`, or use `/mcp` in its terminal interface, to check the connection.
5. Ask: “Using IncarnaMind, what do my Documents say about the cancellation period? Cite the passages and check your citations.” The answer should carry `[cite:…]` references. Ask Codex to show a reference in IncarnaMind to inspect the original.

If you use a custom Codex configuration directory, use the connected agent's **Details** to copy its settings into that configuration instead. Keep the copied settings private: they contain the pairing credential. Do not share a settings file or paste it into a conversation.

## What it can read

The connection searches only the selected Folders and reads their Notes. It returns bounded Document Passages and checked Citations, rather than original Document files; an agent can request more text through further bounded calls. It can also request an Answer on IncarnaMind's chosen model. These tools cannot edit your Documents or Notes. A found quote means the words occur at its Location, not that they prove the agent's claim.

Codex can send returned text to its own model under its provider's terms. **Keep everything on this computer** in IncarnaMind pauses every outside-agent connection. Codex's own tools and permissions remain under your control in Codex.

## Disconnect

Use **Settings → Agents → Disconnect** in IncarnaMind. This revokes the key immediately, closes existing connections, and removes IncarnaMind's matching settings entry and unchanged Skill. Settings you edited are preserved. To remove a remaining client entry, use `codex mcp remove incarnamind`; this command alone does not revoke the pairing in IncarnaMind.

If a call fails, check that IncarnaMind is open, connections are enabled, Local mode is off, and the correct Folders remain shared. **Activity** lists recent calls. Reconnect after moving or reinstalling IncarnaMind.

[Codex's MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) describes its stdio configuration and client commands.

## 简体中文

1. 保持 IncarnaMind 打开。在“设置 → 智能体”中开启智能体连接。
2. 选择“ChatGPT 应用和 Codex”的“连接”，勾选允许读取的文件夹，查看设置变更，再选择“允许并连接”。“不在文件夹中”共享当前未归入文件夹的文档；不选择文件夹就不共享内容。
3. IncarnaMind 在 `~/.codex/config.toml` 中添加自己的设置，保留其他服务，并安装 `~/.agents/skills/incarnamind/SKILL.md`。设置未被修改时，可以用“撤销”恢复。
4. 新开一个 Codex 会话。运行 `codex mcp list`，或在终端界面中用 `/mcp` 检查连接。
5. 可以问：“用 IncarnaMind 查一下，我的文档中如何规定取消期限？请给出引用并核对。”再让 Codex 在 IncarnaMind 中打开引用。

如果使用自定义的 Codex 配置目录，请从已连接智能体的“详情”中复制设置，添加到相应目录。复制的设置包含配对凭据，请勿公开或粘贴到对话中。

智能体只能搜索所选文件夹，读取其中的笔记，并分次获取有限的文档片段和核对过的引用；这些工具不会传输原始文档文件，也不能修改文档和笔记。智能体也可以请求 IncarnaMind 使用已选的 AI 模型生成回答。引文匹配不代表它支持智能体的判断。

返回的文字可能发送给 Codex 使用的 AI 模型，适用该服务的条款。开启“设置 → 隐私 → 所有内容都留在这台电脑上”会暂停所有外部智能体连接。Codex 的其他工具仍由 Codex 管理。

在 IncarnaMind 中选择“断开连接”，立即撤销权限并关闭已有连接；仍与应用写入内容一致的设置项和 Skill 会被移除。修改过的设置会保留。可以用 `codex mcp remove incarnamind` 移除残留的客户端设置，但仅运行此命令不会撤销 IncarnaMind 中的配对。

异常时，检查应用是否打开、连接是否开启、本地模式是否关闭、共享文件夹是否正确。“活动”列出最近的调用。移动或重新安装应用后，请重新连接。
