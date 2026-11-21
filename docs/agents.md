# Connect your AI agent to IncarnaMind

Available from the public alpha. Connections stay off until you enable them and approve a pairing. [中文版](agents.zh-CN.md)

If you use an AI agent such as Claude, ChatGPT, Codex, Cursor, VS Code, OpenCode or Antigravity, you can let it search your Documents and Notes in IncarnaMind, all of them or the folders you choose, and quote them. Every quote it gets from IncarnaMind is checked against your Document, and you can open any of them in IncarnaMind to see it in place.

Guides with the exact commands and settings, in English and Chinese: [Claude Code](claude-code.md), [Codex](codex.md), [Cursor](cursor.md).

## Before you start

1. Open IncarnaMind, then **Settings → Agents**, and turn on **Connect AI agents**.
2. Find your agent in the list (agents on this computer come first; type a name to find any other) and click **Connect**.
3. Choose what it may read, then click **Allow and connect**. **All my Documents and notes, and what I add later** is chosen already: the agent reads every Folder, and what is in no Folder, your Notes there included, as they are at the moment of each call, so a Folder, Document or Note you add later is shared too. A Folder that keeps its work inside it, a Project among them, is never part of that: it is shared only on its own, under **Choose Folders**, and the dialog says so when you have one. The app's own examples are never shared. With no Folder yet, there is nothing else to choose, and the dialog says it in words.

   With **Choose Folders**, you tick the folders instead. A folder you choose shares the Folders inside it too, with their Documents, Notes and meetings: the list shows them ticked with it, and unticking it gives them back their own choice. A Folder that keeps its work inside it is shared only on its own, and nothing behind its wall comes with a folder outside it. It can't read anything else, and with no folder chosen it reads nothing. **Not in a Folder** is a choice too: it shares the Documents that are in no Folder at the moment of each call, so one added later is shared and one you put in a Folder is no longer. Your Notes are shared with their Folder, and a Meeting with its Note: its Transcript goes where the Note goes. An agent that may write and has Not in a Folder writes its Notes and Canvases there and reaches those it wrote, never your other Notes in no Folder, nor the Meetings among them. With all, it also writes its Notes in no Folder unless it names one of its Folders, and a Canvas in no Folder is still only its own.

   You change it later under **Folders…** next to the connection in Settings → Agents, in the same two choices. Going from all to **Choose Folders** starts with the folders all reaches then ticked, so only what comes later stops being shared. A connection made before this choice existed keeps the folders it had: nothing widens until you choose all.
4. Follow the one step for your agent below.

Keep IncarnaMind open while you use your agent: the agent talks to it.

**What it can read.** The list of the Documents in the folders it may read and the Folders inside them (each one's name and kind, never its text), bounded Passages of them, checked quotes, the Notes in those folders with the Transcript of each Meeting among them (the speakers' names as the Transcript holds them, and when the Meeting started), the Canvases there, and, with Not in a Folder, the Notes and Canvases it wrote there. It can also ask IncarnaMind for an Answer on the model you chose, have IncarnaMind work a figure out on this computer (with code over a sheet or CSV file in those folders, or over the names, kinds, folders and Tags of what it may read, from which only the numbers come back) and, if you let it write, have a Note it wrote checked. It can't download a Document's original file, read another folder, or change your Documents or Notes: at most, if you allow it, it writes new Notes and Canvases of its own and proposes changes to yours (see For technical users). A Canvas is a page it wrote, such as a report with pictures or a small dashboard, with its own styles and scripts: IncarnaMind shows it in a tab of its own, its Citations open their Passages, and every version it publishes is kept. You don't edit a Canvas, and you delete one as you delete a Note. For a Canvas, IncarnaMind copies in the pictures and other files the agent names, and for a Note it writes, the picture files it names: only those. To read more, it makes further bounded calls. A found quote means the words occur at the cited Location; it doesn't prove the agent's claim.

**When it doesn't find something.** When you have Folders, Documents or Notes the agent wasn't given, a search, the list of what it reads, and its refusal of something it can't read carry one line saying so, and that you can share more in Settings → Agents, so it can tell you that rather than say nothing is there. The line names nothing and counts nothing: it is the same whether one thing or a thousand are left out, and it isn't there when nothing is. A Folder that keeps its work inside it counts when it isn't shared; the examples, Recently deleted and a file an agent handed over don't.

**What leaves your computer.** What the agent reads goes to the AI model the agent uses, under that service's terms, not IncarnaMind's. Some plans may use it to train their models; check your agent's privacy settings. While **Keep everything on this computer** is on (Settings → Privacy), every agent is paused. A Canvas runs with no network: it loads nothing from the internet or from this computer and keeps nothing, and a website it links to opens in your browser only when you press **Open in Browser**. The agent's other tools and permissions stay under its own control.

**To stop.** Settings → Agents → **Disconnect**. It revokes the agent's key at once and closes its open connections, so the agent can't read anything from then on. Each agent's **Activity** lists everything it did; a disconnected agent's Activity, and the requests you made for it, leave IncarnaMind's database for good 30 days later, when it next starts.

## Ask in your agent

Once it's connected, ask your agent something like:

> Using IncarnaMind, what do my Documents say about the cancellation period? Cite the passages and check your citations.

The answer carries IncarnaMind's citations, written like `[cite:k3x9a2b7]`. To see one, ask:

> Show me that citation in IncarnaMind.

You can also start from IncarnaMind. On the card of a sentence that needs a look, or on a Note's check for all of them at once, **Ask** and your agent's name opens your agent with one line typed in your words, such as "Fix the sentence IncarnaMind flagged in “Credit memo: Northwind Retail”.", or copies it for you to paste where your agent has no such link. Press send there. The rest of what you asked waits in IncarnaMind for that agent: which Note, each sentence and what its check found, and what to change and leave alone. Your agent reads it with `read_request`, once, and only while it can read the Note; the card says when it has, and its **Activity** shows what it read. With no AI model set up in IncarnaMind, the chat box and the Ask pill ask your agent too, and the chat box also names the Document you have open and keeps the Search scope you set, for what your agent can read; a Note's **Check** asks it to check the Note with `check_mind_yourself` and `report_check`. A look for a request when none is waiting is answered, not refused. What a request names (the open Documents, the scope) is read again when your agent reads it: names are put in as they are then, and one your agent can no longer read refuses the request, which waits.

**What it makes opens.** A Note your agent writes, the Note a file it hands over lives in, and a Canvas it publishes open in a tab in IncarnaMind, behind the one you are in. When you asked that agent from IncarnaMind and it read your request in that connection, it opens in front and IncarnaMind comes to the front with it; an agent you work with on its own never takes the front by itself.

## Your agent, step by step

Menu names can differ a little between versions of each app.

<a id="claude-desktop"></a>
### Claude (the desktop app)

Click **Connect**. Claude opens and shows IncarnaMind: click **Install**. Then start a new chat. Every Claude plan works, the free one included.

IncarnaMind keeps the file Claude installs until Claude has connected, so there is no hurry, and closing IncarnaMind doesn't lose it. If Claude says it can't find the file, click **Open the install in Claude again** next to the connection in Settings → Agents.

<a id="claude-code"></a>
### Claude Code

Click **Connect**: IncarnaMind adds itself to Claude Code's settings file, `~/.claude.json`, and shows first what it adds (under **Details**). Everything else in that file stays as it is, and a copy of the file as it was is kept beside it until you disconnect. Start a new Claude Code session; `/mcp` lists IncarnaMind. If IncarnaMind can't read or change the file, it leaves it alone and copies the line to run in a terminal instead.

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

The Skill is added once: an agent that already reads it in another of its folders (Cursor reads Claude Code's too) gets no second copy. IncarnaMind keeps the copy it wrote up to date: when it starts and when you connect an agent, a copy you haven't changed is rewritten with the current text, in every folder it wrote one to. A copy you changed is left as it is, and that agent's row in Settings → Agents says its Skill is out of date, with **Replace…**, which asks first, because your changes go. **Disconnect** (and **Undo**) removes the copy IncarnaMind wrote, whichever version it is, once no other connected agent reads that folder; a copy you changed stays, and Settings says where. For the other agents, **Details for technical users** has **Copy Skill**: save it as `SKILL.md` in a folder named `incarnamind` inside your agent's skills folder.

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

Ask your connected AI to organize your Documents. It reads the names, file types and opening text of waiting Documents in its shared Folders, and the names of the Folders and Tags it can suggest. Its proposals appear under its name in Suggestions. You choose which to confirm. For a connection made before Tag names were shared, choose **Allow sharing Tag names** in Settings → Agents to include your custom Tags.

With no AI model set up in IncarnaMind, `ask` and `check_mind` are not listed, because they can only refuse; they appear when a model is set up, in the agent's app at once where it follows a changed Tool list, else when it starts again. The Tools: `list_sorting`, `propose_sorting`, `search`, `read_passages`, `cite`, `check_citations`, `show_citation`, `list_minds`, `read_mind`, `ask`, `propose_changes`, `create_mind`, `check_mind_yourself`, `report_check`, `check_mind`, `run_analysis`, `publish_canvas`, `read_canvas`, `update_canvas`, `hand_over_file` and `read_request`. `read_request` gives an agent the rest of a request you made of it from IncarnaMind (above, Ask in your agent): the Note's name and internal id, the sentences that need a look with what the check found of each, and what to change and leave alone, or for a meeting its Transcript's internal id and how to prepare its notes. Each request is read once, by the agent you asked alone, and only while that agent can read the Note; with the Note's name it reads the request about that Note, else the newest. `list_minds` lists each Folder it reaches with what is filed in it, its Canvases among them (each one's title, internal id, version and last change), a Folder inside another with its path ("Coast / Engineering"), and marks a Note that holds a Meeting or a voice memo with when it started and its Transcript's id, which the agent searches, reads and cites as any Document; a Transcript is no Document of its own in that list or in a count. All but `propose_changes`, `create_mind`, `check_mind_yourself`, `report_check`, `check_mind`, `publish_canvas`, `update_canvas` and `hand_over_file` are read-only, and those eight are refused unless you ticked "Let it write notes and propose changes in these Folders" for that agent. Even then an agent can't change your Documents or Notes: it reads a Note with `read_mind` and `named`, which names each paragraph (¶1, ¶2…, and a heading the Note opens with, its title, ¶0), then names the paragraph each change is for (¶3 rewrites or, with `remove`, takes out ¶3; ¶3+ adds after it). Its changes wait in the Note, marked with its name, until you accept or reject them, and only the `[cite:…]` tokens IncarnaMind gave it become Citations, each checked again. In a Note it wrote itself, its changes are in the Note at once instead, each one step ⌘Z takes back, with the Note's version from before it in its History; IncarnaMind's window says what changed, at the foot of the sidebar, and a Note it writes while IncarnaMind is open opens in a tab behind the one you are in. There `read_mind` marks the paragraphs that hold words you wrote, and a change it based on the Note before you changed it is refused. A copy you make of its Note is yours, and its changes there wait. `create_mind` writes a new Note in one of the folders you chose, from a name and Markdown: it is there at once, changes no Note you have, and its ⋯ menu says which agent wrote it and when. Its text counts as someone else's, and an agent writes at most 20 Notes an hour. A picture in that Markdown, `![alt](…)` on a line of its own, is kept in the Note: a PNG, JPEG, GIF, WebP or SVG file named by its full path (an SVG is kept as a PNG drawn from it, so it runs nothing it held), which IncarnaMind reads where it is when that call names it, and only then, with the same reader as a Canvas's files (never through a symbolic link, never a folder or a device), or a picture given inline as a `data:` URL; at most 1 MB a picture and 10 in a call. One it can't keep is a line in the Note saying why, and the agent is told. A chart is a table of its figures, each cited, with a ```` ```chart ```` block of JSON right under it giving the chart's kind and title: IncarnaMind draws the Note's chart from that table, as the assistant draws one, each value keeping its cell's Citation, and the Note's check judges it as it judges a sentence. `propose_changes` takes both in the paragraphs it adds, and `read_mind` shows each picture (without its data) and each chart in its place, named as a paragraph is, so a change can replace or remove it: the old one and the new one are one change. A chart drawn from a table a change corrects is drawn again from it, as Update draws it. Each tab of a Note starts with a ```` ```tab ```` block holding the tab's title, as `read_mind` shows it and as `create_mind` and `propose_changes` write one; a tab it adds to your Note waits for you with the first Block it holds. `publish_canvas` publishes a Canvas from a title, its HTML and the full paths of the files it uses, in one of the folders you chose or, with Not in a Folder, in no Folder, where only that agent reaches it. IncarnaMind reads the files named in that call, and only those: a picture, font, style sheet, script or data file (CSV, JSON or text), each read where it is, never through a symbolic link, and never a folder or a device; at most 10 MB a file, 50 files and 25 MB a Canvas, its HTML at most 2 MB besides the pictures inline in it. It copies them into its data folder (`Canvases/`); a picture the agent has no file of comes inline in the page. `read_canvas` gives an agent a Canvas's HTML, its version, and its files' names, kinds and sizes, and `update_canvas` makes a new version from the one it read, refused once there is a newer one; every version is kept, and an agent publishes at most 60 versions an hour. `hand_over_file` takes a deck (.pptx), workbook (.xlsx), Word file (.docx) or PDF the agent made, by its full path on this computer, into one of the folders you chose or no Folder: IncarnaMind reads that one file with the same reader as a Canvas's files (at most 50 MB), keeps a copy of each version in its data folder (`Handed files/`), and makes it a Document of your Library and a Note of its check, which it checks as Check someone else's file does: a deck slide by slide with its titles and notes, a workbook every sheet at once with each formula worked out again. The check runs on the AI model you chose in IncarnaMind, only when it needs nothing asked of you; with none set up, the agent is told to check the file itself, as it checks a Note it wrote (`check_mind_yourself`, then `report_check`). The agent gets back what needs a look, where it is in the file (a slide, a page or a sheet) and what the Document says. The same path handed over again is the same item: other bytes make its next version, with a check of its own, and the same bytes tell how its check is going, trying a check that failed again. A file in one of your Linked folders is handed over as that folder's own Document, not a copy. The hand-over is refused, with nothing kept, while you've paused that Linked folder, and when the agent doesn't reach that Document: one in a Folder you haven't shared with it, or one in no Folder when you haven't given it Not in a Folder (a Linked folder's Documents are in no Folder until you file them; make the folder a Project, from its menu, and its files are filed in that Project as they arrive, so an agent given the Project reaches them). The agent is told why, without the name of any Folder it can't read. In the next version a line the one before had too keeps its result while it still stands (its words, what it was checked with, a deck's slide as the file holds it or else the headings and lines above it, and its Documents unchanged), so only what changed is checked again: on a deck, the slide an edit is on. A result stands for an agent only while it reaches the Documents the result rests on: one whose Document changed, or that you filed where the agent doesn't read, is checked again before the agent is told it, here and in `check_mind` and `check_mind_yourself`. The check's card says which agent handed it over, which version it is and how many claims kept a result, checks every claim again at a press, and opens the others; Ask in your agent on it asks the agent to fix the file and hand it over again. An agent hands over at most 60 files an hour. Only the `[cite:…]` tokens IncarnaMind gave that agent, written in the page's text, become Citations, each opening its Passage in IncarnaMind. The page runs its scripts with no network: it loads nothing from the internet or from this computer, keeps nothing, and a website it links to opens in your browser only when you press Open in Browser. An agent checks a Note it wrote with its own model: `check_mind_yourself` gives it the Note's sentences and the rules IncarnaMind's own Check judges by, the agent judges each sentence against the Documents in the Note's folder, and `report_check` hands its results back. IncarnaMind sends nothing to a model for this and needs none set up. It confirms that each quote a result rests on is in its Document, word for word, and marks the Note; a Supported or Contradicted with no quote it can confirm is marked Not checked, and each mark's card names the agent that judged. A figure no Passage states the agent works out itself and gives in `report_check` with its working: each number it used with the `[cite:…]` whose quote holds it, the expression over them and the figure. IncarnaMind confirms each number's digits in its quote and that the expression gives the figure, and marks the result as the Check's own worked-out marks are, with that working; a working that doesn't check out marks nothing. For rows or lists it has `run_analysis`, Python in IncarnaMind's sandbox over a whole sheet or CSV file in its folders, or over the list of the Documents, folders and Notes it may read, whose rows never reach it (only the numbers its code gives do). Each run gets an id, and a result that names one in `report_check` is marked the same way, but only when the run is that agent's, was made during that check and read nothing it can't read now; any other id marks nothing. After the agent changes a Note it wrote, `propose_changes` tells it how many of the Note's sentences hold no result now, and `check_mind_yourself` gives it just those to check. `check_mind` is IncarnaMind's own check instead, for when you ask the agent for it: it has a Note the agent wrote checked as Check does it: every claim, cited or not, against the Documents in the Note's folder, on the AI model you chose in IncarnaMind. You see each mark in the Note, and the agent gets back the counts its page shows: how many sentences need a look, are not checked, can be cited, are supported or are the writer's own views. The first three are listed sentence by sentence, each with its group and, where a Passage decides it, what the Document says and a token to cite it by, so what the agent tells you is what the Note's page shows. For a sentence that can be cited the token is for the Passage to add: one the sentence doesn't cite yet. A sentence a Document supports but whose Citations don't hold that Passage yet counts as one that can be cited, not as supported and not as one that needs a look. It checks against none but the Documents this agent may read: where you have the Note checked against others, it doesn't check for the agent, and what your own wider check found isn't passed on: those sentences are told as not checked. It never asks you anything: it is refused while that model isn't set up or allowed, it stops at your monthly cap, and an agent starts at most 20 checks an hour.
