# Connect Claude Code

[All agents](agents.md) · [简体中文](#简体中文)

[All agents](agents.md) covers what is the same for every agent: the folders you share, what an agent can read, what leaves your computer, and how to stop. This page has only what is specific to Claude Code.

## Connect and check

1. Keep IncarnaMind open. In **Settings → AI**, under **Your AI**, choose **Claude Code → Connect** (if the list is folded, open it with **Connect an agent…** or **Connect another agent…**). Select only the Folders it should read (with none yet, it reads the Documents you add), then **Allow and connect**. What it will add is under **Details**.
2. IncarnaMind adds itself to Claude Code's settings file, `~/.claude.json`: one entry, `incarnamind`, under `mcpServers`. It does not read Claude Code's sign-in. Everything else in the file stays as it is, and a copy of the file as it was, `~/.claude.json.incarnamind-backup`, is kept beside it until you disconnect. The entry holds the pairing credential, so keep the file private. If the file is a link, such as one a dotfiles manager keeps, the file it points to is changed and the link stays. If the file can't be read or changed (it holds comments, or a number that can't be kept exactly), IncarnaMind leaves it alone and copies the setup command instead: paste it into Terminal, or PowerShell on Windows, and run it.
3. Start a new Claude Code session, so it finds the connection and the `incarnamind` Skill, which Connect installs in `~/.claude/skills/incarnamind/SKILL.md`. A session that was already open may not see it. `/mcp` should list `incarnamind` as connected.
4. Ask: “Using IncarnaMind, what do my Documents say about the cancellation period? Cite the passages and check your citations.” The answer should carry `[cite:…]` references. Ask Claude Code to show one in IncarnaMind to inspect the original.

**Keep everything on this computer** pauses the connection even if Claude Code uses a local model.

## Disconnect

Use **Settings → AI → Disconnect** in IncarnaMind. It revokes the pairing at once, including open connections, takes IncarnaMind's entry out of `~/.claude.json` and deletes the copy it kept, and removes the Skill if you have not edited it. What Claude Code or you have added to the file since stays. If you connected with the command, remove its entry with `claude mcp remove --scope user incarnamind`. Removing the client entry alone does not revoke the pairing in IncarnaMind.

If the connection fails, see [If something goes wrong](agents.md#if-something-goes-wrong).

[Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp) describes client configuration and `/mcp`.

## 简体中文

[所有智能体](agents.zh-CN.md)说明各智能体相同的部分：共享哪些文件夹、它能读取什么、哪些内容会离开你的电脑，以及如何停止。本页只写 Claude Code 特有的内容。

1. 保持 IncarnaMind 打开。在“设置 → AI”的“你的 AI”中，选择 Claude Code 的“连接”（列表收起时，先点“连接智能体…”或“连接其他智能体…”），勾选允许读取的文件夹（还没有文件夹时，它读取你之后添加的文档），再选择“允许并连接”。它要添加的内容在“详情”里。
2. IncarnaMind 会把自己添加到 Claude Code 的设置文件 `~/.claude.json` 中：在 `mcpServers` 下加一项 `incarnamind`。它不读取 Claude Code 的登录凭据。文件里的其他内容保持原样，断开连接之前，会在旁边保留一份该文件原来的样子 `~/.claude.json.incarnamind-backup`。这一项包含配对凭据，请保管好这个文件。如果这个文件是链接（比如用配置文件管理工具管理的），改动的是它指向的文件，链接保持不变。如果文件无法读取或修改（比如里面有注释，或有无法精确保存的数字），IncarnaMind 不会动它，而是复制设置命令：在终端（Windows 使用 PowerShell）中粘贴并运行。
3. 新开一个 Claude Code 会话，用 `/mcp` 检查 `incarnamind` 是否已连接；已经打开的会话可能看不到它。连接时会安装 `~/.claude/skills/incarnamind/SKILL.md`。
4. 可以问：“用 IncarnaMind 查一下，我的文档中如何规定取消期限？请给出引用并核对。”再让智能体在 IncarnaMind 中打开引用，对照原文。

开启“所有内容都留在这台电脑上”会暂停连接，即使 Claude Code 使用本地模型。

在 IncarnaMind 的“设置 → AI”中选择“断开连接”，立即撤销权限，并关闭已有连接，把 IncarnaMind 的那一项从 `~/.claude.json` 中拿掉，删除保留的那份副本，并移除未修改过的技能。Claude Code 或你自己之后加进文件的内容会保留。如果你是用命令连接的，可以运行 `claude mcp remove --scope user incarnamind` 移除那一项；仅移除客户端设置不会撤销 IncarnaMind 中的配对。

连接异常时，见[遇到问题时](agents.zh-CN.md#遇到问题时)。
