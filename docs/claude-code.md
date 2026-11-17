# Connect Claude Code

[All agents](agents.md) · [简体中文](#简体中文)

[All agents](agents.md) covers what is the same for every agent: the folders you share, what an agent can read, what leaves your computer, and how to stop. This page has only what is specific to Claude Code.

## Connect and check

1. Keep IncarnaMind open. In **Settings → Agents**, turn on **Connect AI agents**, then choose **Claude Code → Connect**. Select only the Folders it should read, then **Allow and connect**.
2. IncarnaMind copies the setup command. Paste it into Terminal, or PowerShell on Windows, and run it. It configures your own Claude Code; IncarnaMind does not read its sign-in. Keep the command private: it contains the pairing credential.
3. Start a new Claude Code session, so it finds the connection and the `incarnamind` Skill, which Connect installs in `~/.claude/skills/incarnamind/SKILL.md`. `/mcp` should list `incarnamind` as connected.
4. Ask: “Using IncarnaMind, what do my Documents say about the cancellation period? Cite the passages and check your citations.” The answer should carry `[cite:…]` references. Ask Claude Code to show one in IncarnaMind to inspect the original.

**Keep everything on this computer** pauses the connection even if Claude Code uses a local model.

## Disconnect

Use **Settings → Agents → Disconnect** in IncarnaMind. It revokes the pairing at once, including open connections, and removes the Skill if you have not edited it. To remove the stale Claude Code entry too, run `claude mcp remove --scope user incarnamind`. Removing the client entry alone does not revoke the pairing in IncarnaMind.

If the connection fails, see [If something goes wrong](agents.md#if-something-goes-wrong).

[Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp) describes client configuration and `/mcp`.

## 简体中文

[所有智能体](agents.zh-CN.md)说明各智能体相同的部分：共享哪些文件夹、它能读取什么、哪些内容会离开你的电脑，以及如何停止。本页只写 Claude Code 特有的内容。

1. 保持 IncarnaMind 打开。在“设置 → 智能体”中开启“连接 AI 智能体”，选择 Claude Code 的“连接”，勾选允许读取的文件夹，再选择“允许并连接”。
2. 在终端（Windows 使用 PowerShell）中粘贴并运行复制的设置命令。IncarnaMind 不读取 Claude Code 的登录凭据。复制的命令包含配对凭据，请勿公开或粘贴到对话中。
3. 新开一个 Claude Code 会话，用 `/mcp` 检查 `incarnamind` 是否已连接。连接时会安装 `~/.claude/skills/incarnamind/SKILL.md`。
4. 可以问：“用 IncarnaMind 查一下，我的文档中如何规定取消期限？请给出引用并核对。”再让智能体在 IncarnaMind 中打开引用，对照原文。

开启“所有内容都留在这台电脑上”会暂停连接，即使 Claude Code 使用本地模型。

在 IncarnaMind 的“设置 → 智能体”中选择“断开连接”，立即撤销权限，并关闭已有连接。未修改过的技能会被移除。还可以运行 `claude mcp remove --scope user incarnamind`，移除 Claude Code 中失效的设置；仅移除客户端设置不会撤销 IncarnaMind 中的配对。

连接异常时，见[遇到问题时](agents.zh-CN.md#遇到问题时)。
