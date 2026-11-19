# Connect your AI agent to IncarnaMind

Available from the public alpha. Connections stay off until you enable them and approve a pairing. [中文版](agents.zh-CN.md)

If you use an AI agent such as Claude, ChatGPT, Codex, Cursor, VS Code, OpenCode or Antigravity, you can let it search the folders you choose in IncarnaMind and quote them. Every quote it gets from IncarnaMind is checked against your Document, and you can open any of them in IncarnaMind to see it in place.

Guides with the exact commands and settings, in English and Chinese: [Claude Code](claude-code.md), [Codex](codex.md), [Cursor](cursor.md).

## Before you start

1. Open IncarnaMind, then **Settings → Agents**, and turn on **Connect AI agents**.
2. Find your agent in the list (agents on this computer come first; type a name to find any other) and click **Connect**.
3. Choose the folders it may read, then click **Allow and connect**. A folder you choose shares the Folders inside it too, with their Documents, Notes and meetings: the list shows them ticked with it, and unticking it gives them back their own choice. A Folder that keeps its work inside it is shared only on its own, and nothing behind its wall comes with a folder outside it. It can't read anything else, and with no folder chosen it reads nothing. **Not in a Folder** is a choice too: it shares the Documents that are in no Folder at the moment of each call, so one added later is shared and one you put in a Folder is no longer. With no Documents yet, it is the one choice, for the Documents you add next. The app's own examples are never part of it. Your Notes are shared with their Folder, and a Meeting with its Note: its Transcript goes where the Note goes. An agent that may write and has Not in a Folder writes its Notes there and reaches those it wrote, never your other Notes in no Folder, nor the Meetings among them.
4. Follow the one step for your agent below.

Keep IncarnaMind open while you use your agent: the agent talks to it.

**What it can read.** The list of the Documents in the folders you chose and the Folders inside them (each one's name and kind, never its text), bounded Passages of them, checked quotes, the Notes in those folders with the Transcript of each Meeting among them (the speakers' names as the Transcript holds them, and when the Meeting started), and, with Not in a Folder, the Notes it wrote there. It can also ask IncarnaMind for an Answer on the model you chose, have IncarnaMind work a figure out on this computer (from numbers it quotes, or with code over a sheet or CSV file in those folders, or over the names, kinds, folders and Tags of what it may read, from which only the numbers come back) and, if you let it write, have a Note it wrote checked. It can't download a Document's original file, read another folder, or change your Documents or Notes: at most, if you allow it, it writes new Notes of its own and proposes changes to yours (see For technical users). To read more, it makes further bounded calls. A found quote means the words occur at the cited Location; it doesn't prove the agent's claim.

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

One setting serves both. Click **Connect**: IncarnaMind adds itself to Codex's settings file (`~/.codex/config.toml`), and shows you first what it adds. Start a new Codex session. The ChatGPT desktop app shares this configuration ([docs](https://learn.chatgpt.com/docs/extend/mcp)); ChatGPT on the web takes only servers on the internet, so it can't reach IncarnaMind. Right after connecting, **Undo** takes the change back.

<a id="cursor"></a>
### Cursor

Click **Connect**. Cursor opens and asks to install IncarnaMind: click **Install**.

<a id="vscode"></a>
### VS Code

With GitHub Copilot. Click **Connect**: IncarnaMind adds itself to Copilot's own MCP settings, `~/.copilot/mcp-config.json`, the file VS Code's [MCP configuration page](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) gives for new setups, and shows you first what it adds. Unlike VS Code's profile settings, this file isn't synced to your other computers. Use IncarnaMind from Copilot Chat in agent mode. Right after connecting, **Undo** takes the change back.

<a id="opencode"></a>
### OpenCode

Click **Connect**: IncarnaMind copies one line, `opencode mcp add incarnamind --global …` ([docs](https://opencode.ai/docs/mcp-servers/)). Paste it into Terminal (Windows: PowerShell) and press Return, then start OpenCode again. The line is OpenCode 2's; with OpenCode 1, whose `mcp add` asks its questions one by one, use **Other agent**.

<a id="openclaw"></a>
### OpenClaw

Click **Connect**: IncarnaMind copies one line, `openclaw mcp add incarnamind --command … --no-probe` ([docs](https://docs.openclaw.ai/cli/mcp/registry)). Paste it into Terminal and press Return. `--no-probe` saves IncarnaMind without trying it first, which OpenClaw refuses to do while its Gateway runs.

<a id="antigravity"></a>
### Antigravity

The way in for Google AI Pro and Ultra subscribers. Click **Connect**: IncarnaMind adds itself to Antigravity's MCP settings, `~/.gemini/config/mcp_config.json` (Google's [MCP page](https://www.antigravity.google/docs/mcp/) gives this path), and shows you first what it adds. In Antigravity, open the agent panel's **MCP Servers** menu to check that IncarnaMind is listed, and start a new conversation.

<a id="gemini-cli"></a>
### Gemini CLI

For Gemini Code Assist Standard and Enterprise; Google AI Pro and Ultra subscribers use Antigravity, above. Click **Connect**: IncarnaMind copies one line, `gemini mcp add -s user …` ([docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)). Paste it into Terminal and press Return, then start Gemini CLI again; `/mcp` lists IncarnaMind.

<a id="devin"></a>
### Devin Desktop (formerly Windsurf)

Click **Connect**: IncarnaMind copies its settings. In Devin Desktop, open **Customize → MCPs**, choose **This computer**, open its config file and add IncarnaMind's entry under `mcpServers` ([docs](https://docs.devin.ai/desktop/cascade/mcp)). IncarnaMind doesn't write this file itself: its documented examples carry comments.

<a id="cline"></a>
### Cline

Click **Connect**: IncarnaMind adds itself to Cline's MCP settings, `~/.cline/data/settings/cline_mcp_settings.json`, which Cline's IDE extension, CLI and SDK share ([docs](https://docs.cline.bot/cline-cli/configuration)), and shows you first what it adds. Right after connecting, **Undo** takes the change back.

<a id="kilo-code"></a>
### Kilo Code

Click **Connect**. In Kilo Code, open **Settings → MCP**, choose **Add Server → Local (stdio)** ([docs](https://kilo.ai/docs/automate/mcp/using-in-kilo-code)), and fill in the command, the arguments and the environment that IncarnaMind shows, each with its own **Copy**.

<a id="zed"></a>
### Zed

Click **Connect**: IncarnaMind copies its settings. In Zed, open **Settings → AI → MCP Servers**, choose **Add Server → Add Local Server** ([docs](https://zed.dev/docs/ai/mcp)), put them in place of the example and confirm. IncarnaMind doesn't write Zed's settings file, which can hold comments.

<a id="trae"></a>
### Trae

Click **Connect**: IncarnaMind copies its settings. In Trae, open **Settings → MCP**, choose **Add → Add Manually**, paste and confirm ([docs](https://docs.trae.cn/ide_add-mcp-servers)). Trae doesn't take a command with a space in it, so this works only while IncarnaMind's own path has none.

<a id="qoder"></a>
### Qoder

Click **Connect**: IncarnaMind copies its settings. In Qoder, open **Qoder IDE Settings → MCP → My Servers**, click **+ Add**, add IncarnaMind's entry to the file that opens, and save ([docs](https://docs.qoder.com/user-guide/chat/model-context-protocol)).

<a id="codebuddy"></a>
### CodeBuddy

Click **Connect**: IncarnaMind copies its settings. In CodeBuddy, open **CodeBuddy Settings** at the top right of the chat panel, then **MCP**, click **Add MCP**, paste and save ([docs](https://www.codebuddy.ai/docs/cli/mcp)).

<a id="qwen-code"></a>
### Qwen Code

Click **Connect**: IncarnaMind copies one line, `qwen mcp add --scope user …` ([docs](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/mcp.md)). Paste it into Terminal and press Return, then start Qwen Code again.

<a id="kimi-code"></a>
### Kimi Code

Click **Connect**: IncarnaMind adds itself to Kimi Code's MCP settings, `~/.kimi-code/mcp.json` ([docs](https://www.kimi.com/code/docs/kimi-code-cli/customization/mcp.html)), and shows you first what it adds. Start Kimi Code again. Right after connecting, **Undo** takes the change back.

<a id="workbuddy"></a>
### WorkBuddy

Click **Connect**: IncarnaMind adds itself to WorkBuddy's MCP settings, `~/.workbuddy/mcp.json` (the path in WorkBuddy's [MCP guide](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)), and shows you first what it adds. In WorkBuddy, open **Settings → MCP**: a green status means it is connected.

<a id="minimax-code"></a>
### MiniMax Code

Click **Connect**: IncarnaMind copies its settings. In MiniMax Code, open plugin management, then **MCP Servers**, switch to JSON, paste and save ([docs](https://code.minimax.io/docs/code/agents/mcp.md)).

<a id="other"></a>
### Other agent

Any other agent that can start a local MCP server works. Click **Connect**, and give it a name if you like: IncarnaMind copies its settings, in the `mcpServers` form most agents take (`{ "mcpServers": { "incarnamind": { "command", "args", "env" } } }`). Paste them where your agent adds an MCP server, then restart it. The connected agent's **Details for technical users** copies them again and, if your agent asks for the command, arguments and environment one by one, shows each with its own **Copy** (the key is hidden on screen and included when you copy). IncarnaMind doesn't write into these agents' files. Goose and Cherry Studio connect this way: both ask for the command, the arguments and the environment one by one.

Chat apps that only work on the internet (ChatGPT and Claude on the web, Gemini, Le Chat, Grok, Microsoft 365 Copilot, 扣子, 元宝) can't reach IncarnaMind, which serves only this computer.

## The Skill

Without a hint, an agent sometimes answers from memory instead of looking in your Documents. So where an agent reads Skills, **Connect** also adds a short Skill, `incarnamind`, that tells it when to use IncarnaMind. It goes in a folder the agent reads Skills from, the shared one where the agent reads it:

- `~/.agents/skills/`, which several agents share: Codex and the ChatGPT desktop app ([docs](https://learn.chatgpt.com/docs/build-skills)), Cursor ([docs](https://cursor.com/docs/context/skills)), OpenCode ([docs](https://opencode.ai/docs/skills/)), OpenClaw ([docs](https://docs.openclaw.ai/tools/skills)), Gemini CLI ([docs](https://geminicli.com/docs/cli/skills/)), Devin Desktop ([docs](https://docs.devin.ai/desktop/cascade/mcp)), Kilo Code ([docs](https://kilo.ai/docs/customize/skills)), Qwen Code and Kimi Code
- Claude Code: `~/.claude/skills/` ([docs](https://code.claude.com/docs/en/skills))
- VS Code: `~/.copilot/skills/` ([docs](https://code.visualstudio.com/docs/copilot/customization/agent-skills))
- Antigravity: `~/.gemini/config/skills/` ([docs](https://www.antigravity.google/docs/skills))
- Cline: `~/.cline/skills/`; Qoder: `~/.qoder/skills/`; CodeBuddy: `~/.codebuddy/skills/`

The Skill is added once: an agent that already reads it in another of its folders (Cursor reads Claude Code's too) gets no second copy. **Disconnect** (and **Undo**) removes it once no other connected agent reads that folder, unless you have changed the file. For the other agents, **Details for technical users** has **Copy Skill**: save it as `SKILL.md` in a folder named `incarnamind` inside your agent's skills folder.

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

The Tools: `search`, `read_passages`, `cite`, `check_citations`, `show_citation`, `list_minds`, `read_mind`, `ask`, `propose_changes`, `create_mind`, `check_mind_yourself`, `report_check`, `check_mind`, `calculate` and `run_analysis`. `list_minds` lists each Folder it reaches with what is filed in it, a Folder inside another with its path ("Coast / Engineering"), and marks a Note that holds a Meeting or a voice memo with when it started and its Transcript's id, which the agent searches, reads and cites as any Document; a Transcript is no Document of its own in that list or in a count. All but `propose_changes`, `create_mind`, `check_mind_yourself`, `report_check` and `check_mind` are read-only, and those five are refused unless you ticked "Let it write notes and propose changes in these Folders" for that agent. Even then an agent can't change your Documents or Notes: it reads a Note with `read_mind` and `named`, which names each paragraph (¶1, ¶2…, and a heading the Note opens with, its title, ¶0), then names the paragraph each change is for (¶3 rewrites or, with `remove`, takes out ¶3; ¶3+ adds after it). Its changes wait in the Note, marked with its name, until you accept or reject them, and only the `[cite:…]` tokens IncarnaMind gave it become Citations, each checked again. In a Note it wrote itself, its changes are in the Note at once instead, each one step ⌘Z takes back, with the Note's version from before it in its History; IncarnaMind's window says what changed, at the foot of the sidebar, and a Note it writes while IncarnaMind is open opens in a tab behind the one you are in. There `read_mind` marks the paragraphs that hold words you wrote, and a change it based on the Note before you changed it is refused. A copy you make of its Note is yours, and its changes there wait. `create_mind` writes a new Note in one of the folders you chose, from a name and Markdown: it is there at once, changes no Note you have, and its ⋯ menu says which agent wrote it and when. Its text counts as someone else's, and an agent writes at most 20 Notes an hour. An agent checks a Note it wrote with its own model: `check_mind_yourself` gives it the Note's sentences and the rules IncarnaMind's own Check judges by, the agent judges each sentence against the Documents in the Note's folder, and `report_check` hands its results back. IncarnaMind sends nothing to a model for this and needs none set up. It confirms that each quote a result rests on is in its Document, word for word, and marks the Note; a Supported or Contradicted with no quote it can confirm is marked Not checked, and each mark's card names the agent that judged. A figure no Passage states the agent has worked out by IncarnaMind on this computer, with the code IncarnaMind's own Check uses: `calculate` over numbers it quotes, and `run_analysis`, Python in IncarnaMind's sandbox over a whole sheet or CSV file in its folders, or over the list of the Documents, folders and Notes it may read, whose rows never reach it (only the numbers its code gives do). Each gets an id, and a result that names one in `report_check` is marked as the Check's own worked-out marks are, with its working, but only when the run is that agent's, was made during that check and read nothing it can't read now; any other id marks nothing. After the agent changes a Note it wrote, `propose_changes` tells it how many of the Note's sentences hold no result now, and `check_mind_yourself` gives it just those to check. `check_mind` is IncarnaMind's own check instead, for when you ask the agent for it: it has a Note the agent wrote checked as Check does it: every claim, cited or not, against the Documents in the Note's folder, on the AI model you chose in IncarnaMind. You see each mark in the Note, and the agent gets back the claims that need a look, each with what the Document says. It checks against none but the Documents this agent may read: where you have the Note checked against others, it doesn't check for the agent, and what your own wider check found isn't passed on. It never asks you anything: it is refused while that model isn't set up or allowed, it stops at your monthly cap, and an agent starts at most 20 checks an hour.
