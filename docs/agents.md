# Connect your AI agent to IncarnaMind

Available from the public alpha. Connections stay off until you enable them and approve a pairing. [中文版](agents.zh-CN.md)

If you use an AI agent such as Claude, ChatGPT, Codex, Cursor or Antigravity, you can let it search the folders you choose in IncarnaMind and quote them. Every quote it gets from IncarnaMind is checked against your Document, and you can open any of them in IncarnaMind to see it in place.

Guides with the exact commands and settings, in English and Chinese: [Claude Code](claude-code.md), [Codex](codex.md), [Cursor](cursor.md).

## Before you start

1. Open IncarnaMind, then **Settings → Agents**, and turn on **Connect AI agents**.
2. Find your agent in the list (agents on this computer come first) and click **Connect**.
3. Choose the folders it may read, then click **Allow and connect**. It can't read anything else, and with no folder chosen it reads nothing. **Not in a Folder** is a choice too: it shares the Documents that are in no Folder at the moment of each call, so one added later is shared and one you put in a Folder is no longer. Your Notes are shared only with their Folder. With no Documents yet, the dialog offers **Add Documents…**.
4. Follow the one step for your agent below.

Keep IncarnaMind open while you use your agent: the agent talks to it.

**What it can read.** Bounded Passages of the Documents in the folders you chose, checked quotes, and the Notes in those folders. It can also ask IncarnaMind for an Answer on the model you chose and, if you let it write, have a Note it wrote checked on that model. It can't download a Document's original file, read another folder, or change your Documents or Notes: at most, if you allow it, it writes new Notes of its own and proposes changes to yours (see For technical users). To read more, it makes further bounded calls. A found quote means the words occur at the cited Location; it doesn't prove the agent's claim.

**What leaves your computer.** What the agent reads goes to the AI model the agent uses, under that service's terms, not IncarnaMind's. Some plans may use it to train their models; check your agent's privacy settings. While **Keep everything on this computer** is on (Settings → Privacy), every agent is paused. The agent's other tools and permissions stay under its own control.

**To stop.** Settings → Agents → **Disconnect**. It revokes the agent's key at once and closes its open connections, so the agent can't read anything from then on. Each agent's **Activity** lists everything it did.

## Ask in your agent

Once it's connected, ask your agent something like:

> Using IncarnaMind, what do my Documents say about the cancellation period? Cite the passages and check your citations.

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

Any other agent that can start a local MCP server works. Click **Connect**, and give it a name if you like: IncarnaMind copies its settings, in the `mcpServers` form most agents take (`{ "mcpServers": { "incarnamind": { "command", "args", "env" } } }`). Paste them where your agent adds an MCP server, then restart it. The connected agent's **Details for technical users** copies them again and, if your agent asks for the command, arguments and environment one by one, shows each with its own **Copy** (the key is hidden on screen and included when you copy). IncarnaMind doesn't write into these agents' files.

Chat apps that only work on the internet (ChatGPT and Claude on the web, Gemini, Le Chat, Grok, Microsoft 365 Copilot, 扣子, 元宝) can't reach IncarnaMind, which serves only this computer.

## The Skill

Without a hint, an agent sometimes answers from memory instead of looking in your Documents. So where an agent reads Skills, **Connect** also adds a short Skill, `incarnamind`, that tells it when to use IncarnaMind. It goes in the agent's own skills folder:

- Claude Code: `~/.claude/skills/` ([docs](https://code.claude.com/docs/en/skills))
- Codex: `~/.agents/skills/` ([docs](https://learn.chatgpt.com/docs/build-skills))
- Cursor: `~/.cursor/skills/` ([docs](https://cursor.com/docs/context/skills))
- Antigravity: `~/.gemini/config/skills/` ([docs](https://www.antigravity.google/docs/skills))

**Disconnect** (and **Undo**) removes it, unless you have changed the file. For the other agents, **Details for technical users** has **Copy Skill**: save it as `SKILL.md` in a folder named `incarnamind` inside your agent's skills folder.

## If something goes wrong

Your agent passes on what IncarnaMind says, in plain words.

- **"IncarnaMind isn't open"**: open IncarnaMind, check that **Connect AI agents** is on, then restart the agent or reconnect it to IncarnaMind.
- **"This agent can't read any Documents yet"**: choose its folders in Settings → Agents → **Folders…**.
- **"Agents are paused"**: turn off **Keep everything on this computer** in Settings → Privacy.
- **"This agent is no longer connected"**: it was disconnected. Connect it again in Settings → Agents.
- **An answer from IncarnaMind takes long**: asking IncarnaMind writes a whole Answer on your own chat model. Some agents stop waiting after a minute; Codex is given two minutes when IncarnaMind sets it up.

Reconnect an agent after you move or reinstall IncarnaMind.

## For technical users

IncarnaMind is an MCP server over stdio. The command is IncarnaMind's own app, run as Node, with a small script that passes everything on to the running app over a local socket; the environment holds where that socket is and the agent's key. It serves the current MCP version (2026-07-28) and the one before it.

The Tools: `search`, `read_passages`, `cite`, `check_citations`, `show_citation`, `list_minds`, `read_mind`, `ask`, `propose_changes`, `create_mind`, `check_mind_yourself`, `report_check` and `check_mind`. All but the last five are read-only, and those five are refused unless you ticked "Let it write notes and propose changes in these Folders" for that agent. Even then an agent can't change your Documents or Notes: it reads a Note with `read_mind` and `named`, which names each paragraph (¶1, ¶2…), then names the paragraph each change is for (¶3 rewrites or, with `remove`, takes out ¶3; ¶3+ adds after it). Its changes wait in the Note, marked with its name, until you accept or reject them, and only the `[cite:…]` tokens IncarnaMind gave it become Citations, each checked again. `create_mind` writes a new Note in one of the folders you chose, from a name and Markdown: it is there at once, changes no Note you have, and its ⋯ menu says which agent wrote it and when. Its text counts as someone else's, and an agent writes at most 20 Notes an hour. An agent checks a Note it wrote with its own model: `check_mind_yourself` gives it the Note's sentences and the rules IncarnaMind's own Check judges by, the agent judges each sentence against the Documents in the Note's folder, and `report_check` hands its results back. IncarnaMind sends nothing to a model for this and needs none set up. It confirms that each quote a result rests on is in its Document, word for word, and marks the Note; a Supported or Contradicted with no quote it can confirm is marked Not checked, and each mark's card names the agent that judged. `check_mind` is IncarnaMind's own check instead, for when you ask the agent for it: it has a Note the agent wrote checked as Check does it: every claim, cited or not, against the Documents in the Note's folder, on the AI model you chose in IncarnaMind. You see each mark in the Note, and the agent gets back the claims that need a look, each with what the Document says. It checks against none but the Documents this agent may read: where you have the Note checked against others, it doesn't check for the agent, and what your own wider check found isn't passed on. It never asks you anything: it is refused while that model isn't set up or allowed, it stops at your monthly cap, and an agent starts at most 20 checks an hour.
