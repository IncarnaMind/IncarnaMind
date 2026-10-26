# 把你的 AI 智能体连接到 IncarnaMind

从公开 alpha 版本开始提供；连接默认关闭，需要你开启并批准每个配对。

如果你已经在用 AI 智能体，例如 Claude、ChatGPT、Codex、Cursor 或 Antigravity，可以让它搜索你在 IncarnaMind 中选择的文件夹并引用其中内容。它从 IncarnaMind 得到的每条引文都会与你的文档核对，你也可以在 IncarnaMind 中打开任意一条，查看它在文档中的位置。

智能体指南：[Claude Code](claude-code.md)、[Codex](codex.md)、[Cursor](cursor.md)。每篇都说明连接、共享范围和断开连接。

## 开始之前

1. 打开 IncarnaMind，进入“设置 → 智能体”，开启“连接 AI 智能体”。
2. 在列表中找到你的智能体（这台电脑上已有的排在前面），点击“连接”。
3. 选择它可以读取的文件夹，然后点击“允许并连接”。其他内容它都无法读取。“不在文件夹中”也可以选：它指智能体提问时不在任何文件夹中的文档，所以之后放进文件夹的文档就不再共享；Mind 只随它所在的文件夹共享。还没有文档时，对话框会提供“添加文档…”。
4. 按下面对应智能体的一步操作完成连接。

使用智能体时请保持 IncarnaMind 打开：智能体需要与它通信。

**哪些内容会离开你的电脑。** 智能体读到的内容会发送给它所用的 AI 模型，适用该服务的条款，而非 IncarnaMind 的条款。某些套餐可能会用这些内容训练模型，请查看你的智能体的隐私设置。开启“所有内容都留在这台电脑上”（在“设置 → 隐私”中）时，所有智能体都会暂停。

**停止使用。** 在“设置 → 智能体”中点击“断开连接”，此后它将无法读取任何内容。每个智能体的“活动”会列出它做过的每一件事。

## 在智能体中提问

连接后，可以这样问你的智能体：

> 用 IncarnaMind 查一下，我的文档中关于终止条款是怎么说的？请注明出处。

回答中会带有 IncarnaMind 的引用，形如 `[cite:k3x9a2b7]`。想查看某一条，可以说：

> 在 IncarnaMind 中打开这条引用。

## 各智能体的设置步骤

各应用不同版本的菜单名称可能略有差异。

<a id="claude-desktop"></a>
### Claude（桌面应用）

点击“连接”。Claude 会打开并显示 IncarnaMind：点击“安装”，然后新建一个对话。所有 Claude 套餐都可用，包括免费版。

<a id="claude-code"></a>
### Claude Code

点击“连接”：IncarnaMind 会复制一行命令。把它粘贴到终端（Windows 中为 PowerShell）中运行。新开一个 Claude Code 会话，输入 `/mcp` 即可看到 IncarnaMind。

<a id="codex"></a>
### ChatGPT 应用和 Codex

一份设置同时适用于两者。点击“连接”：IncarnaMind 会把自己添加到 Codex 的设置文件（`~/.codex/config.toml`）中，并先让你看到要添加的内容。新开一个 Codex 会话即可使用。ChatGPT 桌面应用在“工作”和 Codex 模式下读取同一个文件（Plus、Pro、Business 和 Enterprise）；普通对话模式不会用到。连接后可立即点击“撤销”恢复原样。

<a id="cursor"></a>
### Cursor

点击“连接”。Cursor 会打开并询问是否安装 IncarnaMind：点击“安装”。

<a id="antigravity"></a>
### Antigravity

Google AI Pro 和 Ultra 订阅用户的接入方式。点击“连接”：IncarnaMind 会把自己添加到 Antigravity 的 MCP 设置 `~/.gemini/config/mcp_config.json` 中（路径见 Google 的 [MCP 说明页](https://www.antigravity.google/docs/mcp/)），并先让你看到要添加的内容。在 Antigravity 中打开智能体面板的 MCP Servers 菜单，确认 IncarnaMind 已列出，然后新开一个对话。

<a id="workbuddy"></a>
### WorkBuddy

点击“连接”：IncarnaMind 会把自己添加到 WorkBuddy 的 MCP 设置 `~/.workbuddy/mcp.json` 中（路径见 WorkBuddy 的 [MCP 指南](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)），并先让你看到要添加的内容。在 WorkBuddy 的“设置 → MCP”中查看：状态为绿色即已连接。

<a id="other"></a>
### 其他智能体

任何能启动本地 MCP 服务器的智能体都可以使用。点击“连接”，也可以给它起个名字：IncarnaMind 会复制它的设置，格式是多数智能体采用的 `mcpServers` 形式（`{ "mcpServers": { "incarnamind": { "command", "args", "env" } } }`）。把它粘贴到你的智能体添加 MCP 服务器的地方，然后重新启动。如果智能体要求分别填写命令、参数和环境变量，已连接智能体的“技术细节”会逐项显示，每项都有自己的“复制”（屏幕上密钥是隐藏的，复制时会包含密钥）。IncarnaMind 不会写入这些智能体的文件。

只能在互联网上使用的聊天应用（网页版 ChatGPT 和 Claude、Gemini、Le Chat、Grok、Microsoft 365 Copilot、扣子、元宝）无法连接 IncarnaMind，因为它只服务这台电脑。

## 技能

没有提示时，智能体有时会凭记忆回答，而不去查看你的文档。所以对读取技能的智能体，点击“连接”时还会添加一个简短的技能 `incarnamind`，告诉它何时使用 IncarnaMind。它放在智能体自己的技能文件夹中：Claude Code 是 `~/.claude/skills/`（[文档](https://code.claude.com/docs/en/skills)），Codex 是 `~/.agents/skills/`（[文档](https://learn.chatgpt.com/docs/build-skills)），Cursor 是 `~/.cursor/skills/`（[文档](https://cursor.com/docs/context/skills)），Antigravity 是 `~/.gemini/config/skills/`（[文档](https://www.antigravity.google/docs/skills)）。点击“断开连接”（或“撤销”）会把它删除，除非你改过这个文件。其他智能体可在“技术细节”中点击“复制技能”：把它保存为 SKILL.md，放进智能体技能文件夹中名为 `incarnamind` 的文件夹。

## 遇到问题时

你的智能体会把 IncarnaMind 的提示原样告诉你。

- **“IncarnaMind 没有打开”**：打开 IncarnaMind，确认“连接 AI 智能体”已开启，然后重新启动智能体，或让它重新连接 IncarnaMind。
- **“这个智能体还不能读取任何文档”**：在“设置 → 智能体 → 文件夹…”中为它选择文件夹。
- **“智能体已暂停”**：在“设置 → 隐私”中关闭“所有内容都留在这台电脑上”。
- **“这个智能体已不再连接 IncarnaMind”**：它已断开连接，重新点击“连接”即可。
- **IncarnaMind 的回答需要较长时间**：向 IncarnaMind 提问时，它会用你自己的对话模型生成完整的回答。有些智能体只等待一分钟；由 IncarnaMind 设置的 Codex 会等待两分钟。

## 技术细节

IncarnaMind 是一个通过 stdio 运行的 MCP 服务器。命令是以 Node 方式运行的 IncarnaMind 应用本身，加上一个小脚本，它通过本机套接字把所有请求转给正在运行的应用；环境变量中是套接字的位置和这个智能体的密钥。它同时支持当前的 MCP 版本（2026-07-28）和上一版本。每个已连接智能体的“技术细节”可以再次复制它的设置。

工具包括：`search`、`read_passages`、`cite`、`check_citations`、`show_citation`、`list_minds`、`read_mind` 和 `ask`，都是只读的：智能体无法更改你的文档或 Mind。
