# Connect Claude Code

[All agents](agents.md) · [简体中文](#简体中文)

## Connect and check

1. Keep IncarnaMind open. In **Settings → Agents**, turn on **Connect AI agents**.
2. Choose **Claude Code → Connect**. Select only the Folders it should read, then **Allow and connect**. Nothing is shared until you approve. **Not in a Folder** is evaluated on every call: Documents outside all Folders, including ones added later, are shared; filing one removes it from that selection; no selection shares nothing.
3. IncarnaMind copies the setup command. Paste it into Terminal, or PowerShell on Windows, and run it. The command configures your own Claude Code; IncarnaMind does not read its sign-in. Keep the copied command private: it contains the pairing credential.
4. Start a new Claude Code session. `/mcp` should list `incarnamind` as connected.
5. Ask: “Using IncarnaMind, what do my Documents say about the cancellation period? Cite the passages and check your citations.” The answer should carry `[cite:…]` references. Ask Claude Code to show a reference in IncarnaMind to inspect the original.

Connect also installs the `incarnamind` Skill in `~/.claude/skills/incarnamind/SKILL.md`. If the client is already running, start a new session so it discovers the connection and Skill.

## What it can read

The connection returns bounded Passages, checked quotes, and Notes from the Folders you selected. It can ask IncarnaMind for an Answer on the model you chose. It cannot read another Folder, download original Document files, change a Document or edit a Note through these tools. Further bounded calls can read more Passages. A found quote means the words occur at the cited Location; it does not prove the agent's claim.

Claude Code can send returned text to its own model under that service's terms. IncarnaMind's **Keep everything on this computer** pauses the connection, even if Claude Code uses a local model. The agent's other tools and permissions are controlled by Claude Code.

## Disconnect

Use **Settings → Agents → Disconnect** in IncarnaMind. This revokes the pairing immediately, including already-open connections, and removes the installed Skill if you have not edited it. To remove the stale Claude Code entry too, run `claude mcp remove --scope user incarnamind`. Removing the client entry alone does not revoke its pairing in IncarnaMind.

If the connection fails, check that IncarnaMind is open, agent connections are on, Local mode is off, and the pairing still has the intended Folders. **Activity** shows its recent calls. Reconnect after moving or reinstalling IncarnaMind.

[Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp) describes client configuration and `/mcp`.

## 简体中文

1. 保持 IncarnaMind 打开。在“设置 → 智能体”中开启智能体连接。
2. 选择 Claude Code 的“连接”，勾选允许读取的文件夹，再选择“允许并连接”。批准前不会共享内容。“不在文件夹中”的范围在每次调用时重新确定：以后添加的未归入文件夹的文档也会共享，移入文件夹后就不再属于这个范围；不选择文件夹就不共享内容。
3. 在终端（Windows 使用 PowerShell）中粘贴并运行复制的设置命令。IncarnaMind 不读取 Claude Code 的登录凭据。复制的命令包含配对凭据，请勿公开或粘贴到对话中。
4. 新开一个 Claude Code 会话，用 `/mcp` 检查 `incarnamind` 是否已连接。连接时会安装 `~/.claude/skills/incarnamind/SKILL.md`。
5. 可以问：“用 IncarnaMind 查一下，我的文档中如何规定取消期限？请给出引用并核对。”再让智能体在 IncarnaMind 中打开引用，对照原文。

智能体只能获取所选文件夹内的文档片段、核对过的引文和笔记，也可以请求 IncarnaMind 生成回答。这些工具不能获取其他文件夹的内容、传输原始文档文件，或修改文档和笔记；智能体可以分次请求更多片段。引文匹配只表示原文中存在这些文字，不代表它支持智能体的判断。

返回的文字可能发送给 Claude Code 使用的 AI 模型，适用该服务的条款。开启“设置 → 隐私 → 所有内容都留在这台电脑上”会暂停连接。智能体的其他工具仍由 Claude Code 管理。

在 IncarnaMind 的“设置 → 智能体”中选择“断开连接”，立即撤销权限，并关闭已有连接。未修改过的 Skill 会被移除。还可以运行 `claude mcp remove --scope user incarnamind`，移除 Claude Code 中失效的设置；仅移除客户端设置不会撤销 IncarnaMind 中的配对。

连接异常时，检查应用是否打开、智能体连接是否开启、本地模式是否关闭，以及共享文件夹是否正确。“活动”列出最近的调用。移动或重新安装 IncarnaMind 后，请重新连接。
