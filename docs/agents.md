# Connect your AI agent to IncarnaMind

Available from the public alpha. Connections stay off until you enable them and approve a pairing. [中文版](agents.zh-CN.md)

If you already use an AI agent, such as Claude, ChatGPT, Codex, Cursor or Antigravity, you can let it search the folders you choose in IncarnaMind and quote them. Every quote it gets from IncarnaMind is checked against your Document, and you can open any of them in IncarnaMind to see it in place.

Agent guides: [Claude Code](claude-code.md), [Codex](codex.md), [Cursor](cursor.md). Each covers connection, shared content and revocation in English and Chinese.

## Before you start

1. Open IncarnaMind, then **Settings → Agents**, and turn on **Connect AI agents**.
2. Find your agent in the list (agents on this computer come first) and click **Connect**.
3. Choose the folders it may read, then click **Allow and connect**. It can't read anything else. **Not in a Folder** is a choice too: the Documents that are in no Folder when the agent asks, so a Document you later put in a Folder is no longer shared; your Notes are shared only with their Folder. With no Documents yet, the dialog offers **Add Documents…**.
4. Follow the one step for your agent below.

Keep IncarnaMind open while you use your agent: the agent talks to it.

**What leaves your computer.** What the agent reads goes to the AI model the agent uses, under that service's terms, not IncarnaMind's. Some plans may use it to train their models; check your agent's privacy settings. While **Keep everything on this computer** is on (Settings → Privacy), every agent is paused.

**To stop.** Settings → Agents → **Disconnect**. The agent can't read anything from then on. Each agent's **Activity** lists everything it did.

## Ask in your agent

Once it's connected, ask your agent something like:

> Using IncarnaMind, what do my documents say about the termination clause? Cite your sources.

The answer carries IncarnaMind's citations, written like `[cite:k3x9a2b7]`. To see one, ask:

> Show me that citation in IncarnaMind.

## Your agent, step by step

Menu names can differ a little between versions of each app.

<a id="claude-desktop"></a>
### Claude (the desktop app)

Click **Connect**. Claude opens and shows IncarnaMind: click **Install**. Then start a new chat. Every Claude plan works, the free one included.

<a id="claude-code"></a>
### Claude Code

Click **Connect**: IncarnaMind copies one line. Paste it into Terminal (Windows: PowerShell) and press Return. Start a new Claude Code session; `/mcp` lists IncarnaMind.

<a id="codex"></a>
### ChatGPT app and Codex

One setting serves both. Click **Connect**: IncarnaMind adds itself to Codex's settings file (`~/.codex/config.toml`), and shows you first what it adds. Start a new Codex session. The ChatGPT desktop app reads the same file in its **Work** and **Codex** modes (Plus, Pro, Business and Enterprise); ordinary **Chat** mode doesn't use it. Right after connecting, **Undo** takes the change back.

<a id="cursor"></a>
### Cursor

Click **Connect**. Cursor opens and asks to install IncarnaMind: click **Install**.

<a id="antigravity"></a>
### Antigravity

The way in for Google AI Pro and Ultra subscribers. Click **Connect**: IncarnaMind adds itself to Antigravity's MCP settings, `~/.gemini/config/mcp_config.json` (Google's [MCP page](https://www.antigravity.google/docs/mcp/) gives this path), and shows you first what it adds. In Antigravity, open the agent panel's **MCP Servers** menu to check that IncarnaMind is listed, and start a new conversation.

<a id="workbuddy"></a>
### WorkBuddy

Click **Connect**: IncarnaMind adds itself to WorkBuddy's MCP settings, `~/.workbuddy/mcp.json` (the path in WorkBuddy's [MCP guide](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)), and shows you first what it adds. In WorkBuddy, open **Settings → MCP**: a green status means it is connected.

<a id="other"></a>
### Other agent

Any other agent that can start a local MCP server works. Click **Connect**, and give it a name if you like: IncarnaMind copies its settings, in the `mcpServers` form most agents take (`{ "mcpServers": { "incarnamind": { "command", "args", "env" } } }`). Paste them where your agent adds an MCP server, then restart it. If your agent asks for the command, its arguments and its environment one by one, the **Details for technical users** of the connected agent show each one, with its own **Copy** (the key is hidden on screen and included when you copy). IncarnaMind doesn't write into these agents' files.

Chat apps that only work on the internet (ChatGPT and Claude on the web, Gemini, Le Chat, Grok, Microsoft 365 Copilot, 扣子, 元宝) can't reach IncarnaMind, which serves only this computer.

## The Skill

Without a hint, an agent sometimes answers from memory instead of looking in your Documents. So where an agent reads Skills, **Connect** also adds a short Skill, `incarnamind`, that tells it when to use IncarnaMind. It goes in the agent's own skills folder: `~/.claude/skills/` for Claude Code ([docs](https://code.claude.com/docs/en/skills)), `~/.agents/skills/` for Codex ([docs](https://learn.chatgpt.com/docs/build-skills)), `~/.cursor/skills/` for Cursor ([docs](https://cursor.com/docs/context/skills)) and `~/.gemini/config/skills/` for Antigravity ([docs](https://www.antigravity.google/docs/skills)). **Disconnect** (and **Undo**) removes it, unless you have changed the file. For the other agents, **Details for technical users** has **Copy Skill**: save it as `SKILL.md` in a folder named `incarnamind` inside your agent's skills folder.

## If something goes wrong

Your agent passes on what IncarnaMind says, in plain words.

- **"IncarnaMind isn't open"**: open IncarnaMind, check that **Connect AI agents** is on, then restart the agent or reconnect it to IncarnaMind.
- **"This agent can't read any Documents yet"**: choose its folders in Settings → Agents → **Folders…**.
- **"Agents are paused"**: turn off **Keep everything on this computer** in Settings → Privacy.
- **"This agent is no longer connected"**: it was disconnected. Connect it again in Settings → Agents.
- **An answer from IncarnaMind takes long**: asking IncarnaMind writes a whole Answer on your own chat model. Some agents stop waiting after a minute; Codex is given two minutes when IncarnaMind sets it up.

## For technical users

IncarnaMind is an MCP server over stdio. The command is IncarnaMind's own app, run as Node, with a small script that passes everything on to the running app over a local socket; the environment holds where that socket is and the agent's key. It serves the current MCP version (2026-07-28) and the one before it. Each connected agent's **Details for technical users** copies its settings again.

The Tools: `search`, `read_passages`, `cite`, `check_citations`, `show_citation`, `list_minds`, `read_mind` and `ask`. All are read-only: an agent can't change your Documents or Notes.
