# Connect Codex

[All agents](agents.md) · [简体中文](#简体中文)

[All agents](agents.md) covers what is the same for every agent: what you share, what an agent can read, what leaves your computer, and how to stop. This page has only what is specific to Codex.

## Connect and check

1. Keep IncarnaMind open. In **Settings → AI**, under **Your AI**, choose **ChatGPT app and Codex → Connect** (if the list is folded, open it with **Connect an agent…** or **Connect another agent…**). Review what Codex may read. **All my Documents and notes, and what I add later** is selected by default. Use **Choose Folders** to limit access or to share a Project on its own. Review the settings change, then choose **Allow and connect**.
2. IncarnaMind adds its entry to `~/.codex/config.toml`, preserving your other servers. It also installs the `incarnamind` Skill in `~/.agents/skills/incarnamind/SKILL.md`. The setup's **Undo** takes both back while they are unchanged.
3. Start a new Codex session. Run `codex mcp list`, or use `/mcp` in its terminal interface, to check the connection.
4. Ask: “Using IncarnaMind, what do my Documents say about the cancellation period? Cite the passages and check your citations.” The answer should name each source Document and its location when available. Ask Codex to show one in IncarnaMind to inspect the original.

When Codex asks to hand a file to IncarnaMind, choose **Allow for this session** to allow further hand-overs in that chat. Choose **Allow** to decide each time.

If you use a custom Codex configuration directory, copy the connection's settings from the connected agent's **Details for technical users** into that configuration instead. They contain the pairing credential: keep them private, and do not share a settings file or paste it into a conversation.

## Disconnect

Use **Settings → AI → Disconnect** in IncarnaMind. It revokes the key at once, closes existing connections, and removes IncarnaMind's settings entry and the Skill if unchanged. Settings you edited are preserved. To remove a remaining client entry, run `codex mcp remove incarnamind`; this command alone does not revoke the pairing in IncarnaMind.

If a call fails, see [If something goes wrong](agents.md#if-something-goes-wrong).

[Codex's MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) describes its stdio configuration and client commands.

## 简体中文

[所有智能体](agents.zh-CN.md)说明各智能体相同的部分：你共享的内容、它能读取什么、哪些内容会离开你的电脑，以及如何停止。本页只写 Codex 特有的内容。

1. 保持 IncarnaMind 打开。在“设置 → AI”的“你的 AI”中，选择“ChatGPT 应用和 Codex”的“连接”（列表收起时，先点“连接智能体…”或“连接其他智能体…”），查看允许 Codex 读取的内容。默认选中“我的全部文档和笔记，包括以后添加的”。要限定范围或单独共享某个项目，点“选择文件夹”。查看设置变更后，点“允许并连接”。
2. IncarnaMind 在 `~/.codex/config.toml` 中添加自己的设置，保留其他服务，并安装 `~/.agents/skills/incarnamind/SKILL.md`。设置未被修改时，可以用“撤销”恢复。
3. 新开一个 Codex 会话。运行 `codex mcp list`，或在终端界面中用 `/mcp` 检查连接。
4. 可以问：“用 IncarnaMind 查一下，我的文档中如何规定取消期限？请给出引用并核对。”回复应列出来源文档，有页码或章节时也应标明。再让 Codex 在 IncarnaMind 中打开引用。

Codex 询问是否把文件交给 IncarnaMind 时，选择 **Allow for this session（允许本次会话）**，这次对话里再交付文件就不用逐次确认。选择 **Allow（允许）** 可逐次确认。

如果使用自定义的 Codex 配置目录，请从已连接智能体的“技术细节”中复制设置，添加到相应目录。复制的设置包含配对凭据，请勿公开或粘贴到对话中。

在 IncarnaMind 中选择“断开连接”，立即撤销权限并关闭已有连接；仍与应用写入内容一致的设置项和技能会被移除。修改过的设置会保留。可以用 `codex mcp remove incarnamind` 移除残留的客户端设置，但仅运行此命令不会撤销 IncarnaMind 中的配对。

异常时，见[遇到问题时](agents.zh-CN.md#遇到问题时)。
