---
status: proposed (2026-11-22)
---

# A Note keeps one conversation with the User's own command-line AI

To change a Note with their own AI, the User today leaves the Note: the request opens the AI's app in a new chat, they press send there, and come back to see what changed. A second request starts another chat that knows nothing of the first (#3627).

The owner decided on 2026-11-22 that the Note is where the User asks. A Note has one input at its foot, where the User says what to change. What is selected is the context. The User's own AI, run by IncarnaMind in the background (ADR-0032), makes the change in the Note. A small label above the input says that it is working, then what it is doing in plain words, then one line on what it did, and Send becomes Stop while it runs. Each Note keeps one conversation, started at the first request and continued by every later one, out of sight unless the User opens it. Explain, Improve writing, Shorten and Translate become requests of this input. A User whose AI is reached only through its own app keeps the link (#3612). The convention is Claude's Docs: a change typed in "Describe a change" lands in the document with a label saying what Claude is doing, and the conversation stays behind "Show chat".

This builds on ADR-0032's runner, consent, grant and limits. It amends ADR-0032 decision 1 in two places:
- the selection toolbar's four actions become requests of this input, not single jobs of their own;
- a request about a Note, typed at its foot, no longer keeps the link.

The assistant panel hosting a whole conversation stays ADR-0026's; this conversation belongs to one Note and runs on the command line, not over ACP.

## On what it rests

- **A conversation continues by its id.**
  - `claude -p --session-id <uuid>` starts a conversation with an id IncarnaMind chooses; `claude -p --resume <id>` continues it ([CLI reference](https://code.claude.com/docs/en/cli-reference)).
  - MCP servers, settings and Tool flags are not restored on resume, so each run passes them again ([sessions](https://code.claude.com/docs/en/sessions)).
  - The system prompt is recorded on the conversation's first request and used for every later one until the conversation is compacted.
- **It stays out of the User's list.** "Claude Code leaves sessions created with `claude -p` or the Agent SDK out of the session picker and out of `claude --continue`", and a `claude -p` run started from a script gets no generated title ([sessions](https://code.claude.com/docs/en/sessions)). The real run proves it on this computer (decision 3).
- **Never two runs on one conversation.** Two `claude -p` runs resuming one session at once both write one transcript, and messages from one of them can go missing ([sessions](https://code.claude.com/docs/en/sessions)).
- **Where it is kept.**
  - The transcript is `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the working folder's path with every character other than letters and digits replaced by `-`.
  - It is plaintext and holds the messages, the Tool calls and their results, and the system prompt and Tool definitions Claude Code sent ([the .claude directory](https://code.claude.com/docs/en/claude-directory)).
  - Claude Code deletes it once it is older than `cleanupPeriodDays`, 30 days by default. `claude purge <path> --yes` deletes a project's transcripts without asking, on this computer only.
  - Checked signed out in a temporary home (Claude Code 2.1.330, no model call): a `claude -p --session-id <id>` run wrote exactly one file, `projects/<its working folder>/<id>.jsonl`. It added no line to `history.jsonl` and no entry for the folder to `.claude.json`. `claude purge <the folder> --yes` then deleted it.
- **Not in a folder of its own.** `CLAUDE_CONFIG_DIR` moves all of this, but "keys the macOS Keychain entry to that directory too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different entry", and `.credentials.json` moves with it ([authentication](https://code.claude.com/docs/en/authentication)). A run with a folder of IncarnaMind's own as its config folder would not be signed in as the User. "A folder of IncarnaMind's own" is therefore the run's working folder, never Claude Code's config folder.
- **Claude Code itself starts fast.** Signed out, in a temporary home, with no server, `claude -p` with a check run's flags gave its first message in 0.25 to 0.5 s (Claude Code 2.1.330). The model's turns, not the start, are most of a request; the real run measures the rest (decision 8).

## Decisions

### 1. What the User gets

- **One input at the foot of the Note,** to say what to change. Return sends; nothing else opens and nothing is copied.
- **What is selected is the context.** With words selected, the request is about them ("make this bold", "shorter") and changes nothing outside them. With nothing selected, it is about the whole Note. The Note in front is the context, not the limit: "use what my other note says about the ferry" reads that Note, within the connection's Folders (decision 4).
- **A change to the Note the request was made from applies at once, with Undo,** as an edit the User asks of the assistant does (#880): the same applied-edit line over what changed, and one step of the Note's Undo. The owner decided this on 2026-11-22.
- **A change to any other Note waits for the User,** as any agent's change does (#352): a Proposal, shown in the text, accepted or rejected with the one key for each.
- **Where it writes** (#3677): with words selected, there; in an empty Note, the whole Note; otherwise at the cursor, which the request carries as the opening words of the cursor's paragraph, else at the end. A question is answered in the reply and changes nothing; the AI decides which a request is.
- **With words selected,** a change applies at once only if it stays inside them.
  - Code confirms it, call by call: every change of one `propose_changes` call must be to a paragraph that holds the selection.
  - Each such paragraph's words outside the selection must read the same after the change as before (as plain text, so making the words bold or shorter is inside). The spacing right next to the selection may change with it: a figure written out in Chinese characters drops the spaces around it. A Citation or footnote there counts as one mark in those words, in the window and the core alike, so a change that drops one outside the selection waits.
  - A call that changes anything else in the Note waits for the User, whole, and its result says why, so the agent can send the change outside the selection as its own call.
  - The User pointed at those words; a change elsewhere is theirs to accept.
- **The label says what is happening.** Working, then what it is doing in plain words, then one line on what it did. Send becomes Stop while it runs, and Stop ends it. A failure says what went wrong in one line, with what to do.
- **One conversation per Note,** so "undo that" and "now the next paragraph" work. It adds no chat to the User's AI app and stays out of sight until the User opens it.
- **Explain, Improve writing, Shorten and Translate** are requests of this input, with the selection as their context. An explanation shows where the User asked and changes nothing.
- **A User with only a desktop chat app connected, or no AI, keeps what they have today** (#3612's link).

### 2. Which agent

- As ADR-0032 decision 2: a pairing set up for Claude Code, `claude` found on the login shell's PATH without starting it, the consent given (decision 6), 2.1.248 or later, signed in.
- Codex keeps the link (#3639) until its own run is designed and proven.

### 3. One conversation per Note

- **Kept for the Note and the connection.** The first request starts it with an id IncarnaMind makes (`--session-id`), and every later request continues it (`--resume`). A new connection to the same Note starts a new conversation.
- **IncarnaMind keeps the id and its own record.** For each Note: the conversation's id, and for each request the words the User typed, the quote of the selection, and the reply's one line. The record is what the User sees when they open the conversation. IncarnaMind never reads Claude Code's transcript, as ADR-0032 never reads the agent's files.
- **One run per Note at a time.** The core holds one run per Note, as it does for a check, so two windows never resume one conversation at once. While a run goes, a message the User sends goes into that run (see Stop below).
- **Its working folder** is a folder of IncarnaMind's own for that Note, in IncarnaMind's data folder, empty. Claude Code files the transcript under that folder's name, so one Note's conversation is one project in Claude Code's list of projects, and can be deleted alone (decision 5).
- **The flags are ADR-0032's,** with these differences:
  - no `--no-session-persistence`;
  - `--session-id` on the first request and `--resume` after;
  - `--allowedTools mcp__incarnamind`: every Tool of IncarnaMind's server, whose grant decides what the connection may do (decision 4);
  - `--model <value>` when the User chose a model in the box (#3677), and only a value from the list below; the core refuses any other before anything starts.
- **The models, from the run itself** (#3677). Before the prompt goes, the run asks Claude Code which models it offers, in the same process: an `initialize` control request after the settings request, which Claude Code answers itself with no model call and nothing of the Note (measured on Claude Code 2.1.331 with a run's flags, three runs each way on Claude Haiku 5.5: the answer came 5 to 10 ms after the settings answer; the start message gave the same model, permission mode (`dontAsk`) and no tools with the question and without; a marker word the system prompt file asked for ended every reply both ways, so the system prompt still held; and the first word came no later, 678 to 711 ms with the question against 719 to 875 ms without). The answer is heard only once the settings check has passed, so a Claude Code with a managed hook or plugin gives no list. IncarnaMind holds the list in memory until it quits and keeps none of it; nothing of Claude Code starts to look for it. The box shows the model choice once a request's run has given the list, and only while a request from that Note could run (a Claude Code connection that runs here, the consent given, not Local mode); until then it shows none, and the request runs on Claude Code's default.

  IncarnaMind's instructions are the same text for every request of a conversation, since Claude Code keeps the first.
- **A conversation that can't be continued,** removed by Claude Code's own 30-day sweep or by the User, gives way to a new one, and the label says so once ("Started a new conversation: the earlier one was cleared").
- **Proven on this computer before it ships.** In the real run, ten requests across Notes leave the User's `claude --resume` picker and `claude --continue` showing none of them, with the picker widened to every project too (Ctrl+A). If any shows, the conversation is not kept, and the request carries the Note's earlier requests and replies instead (see Considered options).

### 4. What the conversation has: the connection's reach, none of the command line's own tools

- **The grant stands for the pairing,** with its real reach and permissions (ADR-0032 decision 4 otherwise):
  - its Folders and the Documents, Notes and Canvases in them;
  - its write switch ("Let it write notes and propose changes");
  - every Tool of IncarnaMind's server the pairing may call.

  A change to the Note the request was made from applies at once with Undo, inside the selection if there is one (decision 1). A change to any other Note the User wrote waits as a Proposal; one to a Note this agent wrote applies with Undo, as today (#3371). New Notes and Canvases are made as the pairing's own, within its hourly limits (20 Notes, 60 Canvas versions).
- **No file by its path.** The run has none of the command line's tools, so no file of its own. A Tool input that opens a file on this computer by its path could only reach a file the User never gave it, so the grant refuses every one: `cite`'s `path`, `hand_over_file`, and the files a Canvas names. That is the only narrowing.
- **A connection that may only read** can't change a Note. Its first request that would change something ends with one line where the label shows, "{agent} may only read. Let it propose changes?", with one press to allow (decision 7). The press sets that connection's write switch, the one Settings shows, and is remembered. No trip to Settings. Until allowed, a request that only reads (Explain) works.
- **The worst a Document's planted instruction could do,** with the User not watching the run:
  - Read anything the connection may read, and pass it to Claude Code's model. That is what the connection already allows (the "agents" flow), and nothing goes anywhere new.
  - Change the Note the request was made from, at once, inside the selection if there is one. One Undo takes the whole request back, and the applied-edit line shows what changed.
  - Propose changes to any other Note in the Folders. They wait for the User, in place.
  - Change a Note this agent wrote, with Undo.
  - Make up to 20 new Notes and 60 Canvas versions an hour, each marked as the agent's and listed in its Activity.
  - Open a Note, file or Canvas in the User's window.
  - Put a web address into what it writes. Text from a Document could leave this computer only if the User opens that link; a Canvas reaches no network (ADR-0029).
  - Spend the User's plan until the run's 15 minutes run out.

  It can't:
  - read or write any file by its path;
  - run a command, reach the web, or use a Tool of its own;
  - reach a Note or Document outside the connection's Folders;
  - delete a Note, a Document, a Canvas or a Folder (a paragraph it removes is a Proposal on a Note the User wrote, and an Undo step on one it wrote);
  - accept its own Proposals.
- **What holds it:**
  - the flags (no tool of the CLI's own, only IncarnaMind's server);
  - the grant (the connection's Folders and write switch, no path);
  - Proposals waiting for the User;
  - the hourly limits and the 15-minute limit;
  - Activity listing every call;
  - Stop.

  IncarnaMind's instructions say a Document's and a Note's text are data, never instructions, but nothing rests on the model following that.

### 5. The conversation on disk

- **Where.** Claude Code keeps the transcript under the User's Claude Code folder: `~/.claude/projects/<the Note's working folder, as Claude Code names it>/<id>.jsonl`, with a folder of the same id beside it for large Tool results.
- **What it holds,** in plaintext:
  - each request's words and the selection;
  - every Tool call and its result: the Passages, Note text and lists IncarnaMind's Tools gave;
  - the model's replies;
  - IncarnaMind's instructions and the Tool definitions.
- **What IncarnaMind keeps,** in its own database: the conversation's id, and each request's words, selection quote and one-line reply (decision 3). Its tables are sync-ready: random ids, UTC times and soft deletes.
- **When both go:**
  - the Note is deleted for good (from Recently deleted, or after its 30 days there);
  - the connection is removed;
  - the consent is taken back.

  IncarnaMind deletes its record (what was typed, selected and replied goes; the rows stay only as deletions to sync) and, once a run of that conversation has stopped, runs `claude purge <the Note's working folder> --yes`, which deletes that folder's transcripts on this computer, and then the working folder goes. A Note in Recently deleted keeps its conversation, so a restore brings it back whole.
  - If `claude` can't be run then, the record still goes, and the transcript goes in Claude Code's own sweep after 30 days. Settings › Privacy says so.
  - Claude Code's own sweep may delete a transcript sooner, if the User set it shorter. Then the next request starts a new conversation (decision 3).
- **In Settings › Privacy and `docs/privacy.md`,** in the flow's line: "Claude Code keeps each Note's conversation on this computer, in its own folder, until you delete the Note for good, disconnect it or take this back; then IncarnaMind deletes it. Claude Code also deletes one left unused for 30 days."

### 6. Consent (ADR-0022)

- **The same flow as the check, widened in words:** "Your AI, run in the background" (`hosted-agents`).
  - What it sends grows by one kind: the words the User types at a Note's foot, with the selection they're about.
  - Its line says the conversation is kept, as decision 5 words it.
  - One flow keeps one answer to one question: may IncarnaMind start the User's own AI on this computer.
  - ADR-0026 names this flow for a hosted conversation too.
- **Asked again once,** as ADR-0022 does when a flow sends a new kind: a User who allowed the check-only line is asked at their first request typed at a Note's foot. No keeps the link for that request. One flow keeps one answer, so that No also sends Check by the link, until the User allows the flow in Settings › Privacy or connects the agent again.
- **The connect sheet's sentence,** in the owner's words of 2026-11-22, replacing the check-only one: "With no AI model set up here, Check and the box at the bottom of a note run your Claude Code in the background. Nothing opens and no chat is added. It works only through IncarnaMind, and uses your own Claude plan or API key." (没设置 AI 模型时，“核对”和笔记底部的输入框会在后台运行你的 Claude Code，不打开窗口，也不新增对话。它只通过 IncarnaMind 工作，用的是你自己的 Claude 订阅或 API 密钥。)
- **Taken back,** a run going stops at once, both copies of every conversation of that connection are deleted (decision 5), and requests go by the link, as for the check.
- **A new flow was considered and rejected:** two consents for one act, IncarnaMind starting the User's AI, would be one question asked twice.

### 7. Where it shows

- **The input:**
  - It sits at the Note's foot, under the text, in the Note's column.
  - It shows only where the Note's AI is the User's own command-line AI and its command is on this computer's path (looked for as the Note opens, starting nothing); otherwise the Note's foot is as today, and the Ask pill asks by the link.
  - Its placeholder says what it is for ("Describe a change…" / "描述要做的修改…").
  - With text selected, a chip above it quotes the selection's start ("“The harbour handled…”") with ✕ to drop it.
  - Return sends, and Shift+Return makes a new line.
- **One line above it, alone in its row** (#3677), as the User's AI app shows its own:
  - while the request runs, a small pill in the middle: a moving mark, "Working", then what the AI is doing, in its own words where it wrote some (it is asked to say in a few words what it is about to do before each step), else what it is reading and how many so far ("Reading “Interview 3” · 4 read"), else "Thinking"; and the seconds since the request, from the third. Once the AI has sent nothing for 30 seconds, no call of it running in IncarnaMind, it says "Still waiting for {agent}…" until something comes;
  - when it ends, a line as wide as the input: the first words of the AI's reply, cut to one line, and one action at its end. "Accept all" while changes wait in the Note, in place of the line across the top of the Note; else "Open “…”" for a Note it wrote, or left changes waiting in, which opens it (at the first change that waits); else "Undo" while what it changed in the Note can still be undone. With no reply, the line says what it did, and the Notes it names open from there.
  - Pressed, the line opens the conversation at that reply. The reply is in one place at a time: the line or the conversation. The User's AI app opens a card in place first; ours goes straight to the conversation (the owner, 2026-11-22).
  - the run's thinking itself arrives empty in Claude Code's stream, so the line can't show it; the words come from the lines the AI writes between its steps, and from its reply as it writes it.

  The line goes when the User types the next request. An applied change stays marked in the Note with its Undo, unlike the User's AI app, where a direct change leaves no mark.
- **Stop:**
  - While a run goes, Send is Stop while the input is empty, and Send once words are typed (Esc stops too, from the input). Stop ends the run at once: the line goes, the input is idle, and nothing is added in its place.
  - A change that applied before Stop stays, with its Undo; a change that waits stays waiting; nothing else lands.
  - A message sent while a run goes goes into that run at once, as when the User types into the AI's own app while it works (#3765; this replaces "Return does nothing new" of 2026-11-22). It shows at once as sent, marked Waiting, until the AI takes it (Claude Code echoes it back, `--replay-user-messages`): at its next step, or, during a plain reply, as the next turn of the same process once that reply ends. Each reply belongs to the latest message the AI took before it. It is never refused and never lost: the run reads on until every message sent has its answer. One not taken when the User stops stays in the conversation, Not sent, with Send, Edit, Copy and Discard. A selection toolbar action still waits for Stop, since the running request can't take a new selection, and a line says so.
  - The User chooses by the input whether the AI asks before it acts or works on its own, beside the model (#3765): Claude Code's `default` and `auto` modes. It starts on the User's own settings for the AI and names whatever mode they say; a choice holds for the Note's conversation only, new conversations after a line included, and is written nowhere, the AI's own settings least (`--permission-mode` at every start, since a mode set during a run doesn't hold on `--resume`; `set_permission_mode` while it runs, taken from its next step). What the input shows is what the next request starts in and the running one is in: a mode the AI refuses leaves the choice before it, with the reason; one it falls back from at the start (Claude Code 2.1.331 starts in `default`, with no error, when `auto` is turned off in the User's settings) leaves the User's own; and where IncarnaMind hasn't seen the User's own mode since it started, the input names none until a request has. Every window hears each choice.
  - New conversation, in the conversation's name's menu (#3765): every turn stays, a line marks the break after the last request that ran, and the next request begins a new conversation with the AI, which carries none of the turns before it. What Claude Code keeps outside its conversation stays: its own memory of the Note's folder (measured: a new conversation in the same folder named a word the one before had saved there) and the files it made in that folder.
- **A failure,** in the line, with one action, as for the check:
  - not signed in;
  - too old;
  - the plan's or key's limit;
  - out of time;
  - Local mode;
  - the consent taken back;
  - the Note out of reach;
  - "{agent} may only read. Let it propose changes?" with one press, Allow, which sets the connection's write switch and is remembered;
  - anything else.

  It stays until the next request or ✕.
- **The conversation:**
  - It is hidden; "Show conversation" (显示对话) at the Note's top right, beside its menu, or the line above the input, opens it (#3677). It opens upward inside the input's box, over the Note's foot, at most 40% of the window tall, so the Note stays in view and nothing in it moves. One control moves it into the window's one column, left of every tab group (after the sidebar, as the page views of the User's AI apps have it), the tab area's full height, and back; the move keeps the conversation, a request still running, the words typed and the focus, and there is only ever one input. The column shows the conversation of the Note in focus, and stands there only while that Note keeps about 490 px of text and every other group 400 px; otherwise the conversation opens upward from the input instead (#3759). Sending doesn't close it.
  - It lists each request (the User's words, the selection's quote) and its reply as the AI wrote it, formatted, newest last, from IncarnaMind's record.
  - Esc or "Hide conversation" closes it. It never opens by itself.
- **Explain, Improve writing, Shorten and Translate** in the selection toolbar fill the input with their request and send it. Explain's answer shows in the line, and changes nothing.
- **A run that sends nothing for six minutes is stopped,** with a plain line ("{agent} stopped answering for six minutes, so it stopped. Send it again."). While it works, Claude Code sends a tick about every second as it thinks, and its words and Tool inputs as it writes them (partial messages, and fine-grained Tool streaming); the time it waits, silent, on a Tool of IncarnaMind's own doesn't count. Nor does a compaction of its conversation, which it works through without a word: it begins with Claude Code's own "compacting" status line for the run's session and ends with its next status line, the compact boundary, or the model at work again (#3677's real run compacted 153,589 tokens to a summary of 1,360 in 11 s). Meanwhile the line says "Condensing the conversation so far" (正在压缩之前的对话…). A compaction has its own bound, ten minutes, generous since only one was measured and a longer summary takes longer; past it the run ends with "{agent} spent ten minutes condensing this note's conversation without finishing, so it stopped. Send it again.", or with the cause Claude Code named if it was retrying a limit meanwhile. A check run has the same bound and its own line. Six minutes is past Claude Code's own five-minute limit for a stream with no data, so its own watchdog and retry act first. Both this limit and the line's quiet sign use a monotonic clock, which stands still while the computer sleeps on macOS and Linux. Before #3677 the only way out was the run's own 15 minutes. A check run has the same limit.
- **What this changes in `DESIGN.md`,** by the owner's decision: "A Mind has no composer of its own" gives way, since a Note now has this one input. A change the User asked for still applies at once with Undo, as there, in the Note it was asked from. The design entry is the owner's to change.

### 8. Time

- **Measured from Return to the change in the Note,** in the real run. A one-sentence change aims for 15 seconds or less; the bar is set from the first measurements.
- **Where the time goes:**
  - Claude Code's start takes 0.25 to 0.5 s;
  - IncarnaMind's server through the shim takes more, to be measured (likely about a second);
  - then the model's turns: read the Note, propose the change, answer.
- **What would cut it, if the measurement says so, in this order:**
  1. The request carries the selection's paragraph and the Note's version, so the model can propose without reading the Note first: one turn fewer.
  2. One process stays for a Note while its conversation is in use, taking each request on its input (`--input-format stream-json` takes one message after another), and stops after a few idle minutes. That saves the start and the server's connection each time, and keeps the prompt cache warm. It is still one process per conversation.
  3. The model: Claude Code's default, or the one the User chose in the box from Claude Code's own list (decision 3). IncarnaMind never chooses one.

### 9. The next step's door

The owner's next step gives the conversation the command line's own abilities, as Claude's Cowork has them: the web, files inside a linked Folder, code. Each risky step would be shown and asked first. It is a separate issue, and nothing of it is built here. Two things keep it open:
- **The run's Tool set and permission mode are inputs of a run,** not fixed in the runner. This run passes none of Claude Code's own tools and `dontAsk`.
- **Claude Code's approvals would come to IncarnaMind,** where the app shows its approval card: `--permission-prompt-tool mcp__incarnamind__<tool>` makes a Tool of IncarnaMind's server answer Claude Code's permission prompts in print mode ([CLI reference](https://code.claude.com/docs/en/cli-reference)). Nothing relies on it yet.

### 10. What we never do

- Set `CLAUDE_CONFIG_DIR`, or read Claude Code's transcripts, settings or sign-in. The settings check before the prompt (ADR-0032) reads only hooks and plugins, and the `initialize` answer (decision 3) only its models; the rest of it, the account it names among it, is left unread.
- Run two processes on one conversation.
- Start a run without the User's request.
- Give the run a tool of the command line's own, a file by its path, or the web.
- Keep the conversation after the Note is deleted for good, the connection is removed or the consent is taken back.

## Considered options

- **No conversation kept by Claude Code:** every request carries the Note's earlier requests and replies, and Claude Code saves nothing (`--no-session-persistence`, as a check does).
  - It keeps nothing of the User's on disk outside IncarnaMind, and needs no deletion.
  - It loses what the model learned from earlier Tool results, and rereads them at each request.
  - Kept as the fallback if the picker shows a conversation (decision 3), and as the shape Codex may need.
- **Claude Code's config folder of IncarnaMind's own** (`CLAUDE_CONFIG_DIR` with `CLAUDE_CODE_PROJECT_DIR_NAME`). Rejected: it moves the sign-in too, so the User's plan would not be used.
- **One working folder for every Note.** Rejected: one Note's conversation couldn't be deleted alone with Claude Code's own `purge`.
- **The six Tools of a check, widened case by case.** Rejected: the owner's rule is that the conversation has what the connection has; the only narrowing is the file by its path, which the run can't have.
- **Every change waiting, as any agent's does.** Rejected by the owner: the Note the User asked from changes at once, with Undo, as it does when they ask the assistant.

## Consequences

- `src/core/agents/` gains the Note's conversation beside the check run: its record and id (one migration, sync-ready), one run per Note, the label's progress from the run's Tool calls, and deletion on the three events of decision 5. The grant takes two forms: a check's, held to six Tools and one Note, and a conversation's, standing for the pairing and refusing a file by its path.
- `src/main/claudeCode.ts` gains a kept conversation (`--session-id` and `--resume`) and the working folder per Note. `src/main/ownAi.ts` gains `purge`.
- The renderer gains the Note's input, its label and its conversation, each in a component of its own, and moves the selection toolbar's four actions to it when the User's AI is a command-line one.
- The "hosted-agents" flow's line, the connect sheet's sentence, `docs/privacy.md` and `docs/where-your-data-goes.md` say what is sent and what is kept.
- `CONTEXT.md` gains the Note's conversation: the requests typed at a Note's foot and their replies, kept for that Note with the User's own AI. It is not an assistant's Conversation, and it is shown only from its Note.

## Addendum, 2026-11-24: the conversation keeps the AI's own abilities (#3653)

The owner decided on 2026-11-24 that in a Note's conversation the User's own command-line AI runs with what it can do by itself: commands, files, the web, and the skills and tool servers the User set up for it, on the User's own settings for it. IncarnaMind picks no permission mode, adds no setting of its own and builds no sandbox: the abilities, the limits and the questions are the AI's. IncarnaMind adds its Tools and its instructions, shows what the AI does and passes on what it asks. A change to a Note still waits for the User as decision 1 says, and a change an AI proposes never writes a file of the User's own. A background Check is unchanged (ADR-0032, ADR-0035): IncarnaMind's Tools only, unattended, never asking.

This replaces decision 4's "none of the command line's own tools" and the parts of decision 10 that kept the run from its own tools, files and the web, and the flags of decision 3 that came from ADR-0032 decision 3, for the conversation only. Decision 9's door is used, by Claude Code's own control channel rather than a Tool of IncarnaMind's server. Measured on Claude Code 2.1.331 (`docs/research`, and this pull request's real runs).

- **How it runs.** `claude -p --mcp-config <a file only the User's account reads, in the run's own folder> --allowedTools mcp__incarnamind --permission-prompt-tool stdio`, with `--session-id` or `--resume`, `--model` only from the list the agent gave (decision 3), stream-json both ways with partial messages, and IncarnaMind's instructions added to Claude Code's own system prompt from a file (`--append-system-prompt-file`), since its own prompt tells it how to use its tools. No `--permission-mode`, `--settings`, `--setting-sources`, `--restricted`, `--tools` or `--strict-mcp-config`, and none of the switches that leave out the User's CLAUDE.md files, its memory or its claude.ai servers; only its non-essential traffic stays off. The settings check for hooks and plugins before the prompt is gone: the User's own apply. Its `initialize` answer is asked first, and of it the models and the current permission mode are read. The input stays open until the result, since each answer goes there.
- **Where it works.** The conversation's own folder (decision 3), in IncarnaMind's data folder: never the User's home, never under a `.claude` folder.
- **What it asks** comes as Claude Code's `can_use_tool` control request and shows as a card in the conversation, exactly as it would happen: the whole command; a file's path and how many lines, or that a change is made everywhere its text appears; a notebook's cell it adds or writes, whole, or that it deletes one; a page's address, its site in the title; a web search; a tool of a server the User set up, with its input; a read outside the conversation's folder. Like Claude Code's own prompt, the card is what it wants to do, the thing itself and the answers, with no line explaining how it works. Its answers are Claude Code's own prompt's three: Deny; its "don't ask again", when it suggests anything, which applies every suggestion of the question together, sent back exactly as Claude Code gave it, nothing widened, narrowed or added (the owner's decision of 2026-11-24: what the harness offers is what the card shows; measured from Claude Code 2.1.331's own program text and Anthropic's documentation of the prompt); and Allow once last. One thing it grants is the button's words, in Claude Code's own words with where it is kept: for this request (its "session"; measured: gone on `--resume`), in this conversation (its settings in the conversation's folder), or anywhere (the User's own settings for it). Several are a short button saying the widest place it keeps them ("Don't ask again in this conversation"), with every one of them, a mode it switches to and a folder it adds among them, in one small line under it, never cut. A command's card leads with Claude Code's own one line of what it does (the owner, 2026-11-25: "说明在上"), two lines of it until Show all, and the command under it, smaller, every line of it, never folded: the AI's words may not say what the command does, and lines out of sight could hide a second one. The three share one row, Deny first and Allow once last, as the app's approval cards put them; when they don't fit, they stand one under another, full width, as Claude Code lists them: Allow once, the lasting answer, Deny. None is offered when Claude Code says a lasting one mustn't be (`suppress_always_allow_rule`), or when one of its suggestions can't be read, since the answer applies them all. The card no longer names text the conversation read that the User didn't write, nor holds an answer back for it (the owner, 2026-11-24): nearly every conversation reads a Document, so the line would sit on nearly every card and say nothing. Every value on it is shown whole, what a file will hold past twelve lines with how many more there are, every character that draws nothing as its code, and in the order it is stored; a file it writes shows what it holds, and one Claude Code reads as its own (CLAUDE.md, `.claude/`, `.mcp.json`) has the card's one line: "This file changes how Claude Code behaves from now on."
- **Claude Code's own instructions and settings ask, when a file tool or a command names them.** The run registers a PreToolUse hook on Claude Code's control channel at `initialize` (`hookCallbackIds`, failing closed). It answers "ask" for a write or a change by a file tool to CLAUDE.md, CLAUDE.local.md, `.mcp.json`, `.claude.json` or anything under a `.claude` folder, its memory among them, in any letter case (macOS's and Windows's disks open claude.md as CLAUDE.md), with letters a disk folds (the long s, U+017F, is an s) and the characters that draw nothing (Unicode's default ignorable ones) left out, as an older Mac disk (HFS+) and folders some Linux kernels fold the case of leave them out of names, as Windows opens a name (dots or spaces at its end, a stream after a colon, an 8.3 short name), where a symbolic link by another name leads, walked part by part as the system walks it (a link to a link, a relative target in the middle of a path, a ".." after another link), even to a folder or file not there yet, and for any file with other names (a hard link), since which of them it is can't be told cheaply. The path is walked as Claude Code gives it, its own ".." taken from where the walk has reached, and folded as text, since Claude Code may hand it on either way; it asks when either would reach one. It also asks for a file whose real place is where one of the steering names Claude Code reads for the conversation's folder and the folders above it really is, walked the same way (CLAUDE.md that is a link to an AGENTS.md, or to a file nobody has written yet, or ~/.claude kept in a folder of dotfiles); where the walk can't tell (a loop of links, more than 40, a path or the place a walk reaches longer than 4,096 characters, a walk of more than 8,192 steps); for a path from `~`, which may mean another home to Claude Code than to IncarnaMind; for a path that reaches `/proc` or `/dev/fd` at any step, as given or through a link, since those show each process its own view; on Windows, for a path on another computer (`\\server\share`), or a link to one, without touching it, since touching it would reach that computer before the User answers, and where either reading of a link's ".." would reach one. The card says a file changes how Claude Code behaves where that is known, a hard link to one of the steering files by its disk and number among them, and says IncarnaMind can't tell where a file leads where the hook asks for that reason. For a command that names one, in Bash or in Claude Code's PowerShell tool on Windows, its letters are folded the same way, with and without its quotes, backslashes and backticks, and `.claude` straight after a short option (`-C.claude`) counts. How Windows spells a name is tried on Windows by the nightly's packaged Windows job, since unit tests run on Linux. Measured before it: after the file-change answer, CLAUDE.md, CLAUDE.local.md and its memory were written with no card. A text it read could tell it to, and every later request of the conversation would follow it. Asking takes nothing away: the User can still allow it. Measured with it on Claude Code 2.1.331: a write to CLAUDE.md asks in its default, acceptEdits, auto and bypassPermissions modes, and with `disableAllHooks` in the User's settings, which leaves a hook registered this way running; under acceptEdits, claude.md, `.Claude/settings.local.json` and `mv draft.md claude.md` asked and nothing was written; Claude Code's own Write refused to write through a link to CLAUDE.md. A hook answered with an error refuses the call, and the AI says in its reply that a hook stopped it; one not answered keeps the call waiting (no result in 300 s). IncarnaMind answers every call of it at once. The request goes only once Claude Code's answer to `initialize` says it registered the hook and that a failed answer blocks (`hooks_applied` and `hook_on_failure_supported`, as Claude Code's own SDK reads them): one that refuses it, or answers without saying so as a version too old to know them would, is sent nothing, and the line says to update it. Not covered: a command that writes one without spelling its name (a script the User let run without asking, a pattern such as `*.md`, a name the command builds, an archive it unpacks); a tool of the User's own servers; the files CLAUDE.md pulls in with `@path`; a link inside a steering folder that leads elsewhere (a dotfiles folder linked file by file: a write to the file it leads to); another spelling the system takes as the same place (macOS's `/System/Volumes/Data` path, a name in composed against decomposed letters); Claude Code's own folder moved by `CLAUDE_CONFIG_DIR`; and the hook scripts and server commands a settings file names. On Windows, a steering place that is a link to another computer, written to through a drive letter mapped to it, is not seen; and a data folder kept on another computer (a redirected AppData) makes every file write of the conversation ask, since the folder itself is such a path.
- **What it does** with its own tools shows as one quiet step each, beside IncarnaMind's own Tool steps, with how its question was answered. Once in a conversation, above the first such step taken without a question, a line says it uses its own tools on its own settings. When the AI's own mode asks nothing (its auto mode, or the one that skips every question), the conversation says so once.
- **A question waiting** shows the dot an approval waiting shows, on the Note's tab and its row. It waits until the User answers, Stops, or the request reaches its 15-minute limit; meanwhile the run doesn't count as silent. A window opened meanwhile reads it from the core.
- **Stop, and quitting,** ask Claude Code to end at once, before anything is awaited, having looked at what runs under it; Claude Code then ends its commands. After a short wait, what still runs of what was seen under it, each checked to be the process that was seen, is killed with its group, since Claude Code runs each command in a shell that leads a group of its own (an interrupt alone, or killing its group alone, left a backgrounded command running). What a run started is noted in IncarnaMind's data folder while it runs, so the next start ends what a crash or a forced quit left running. A command made to leave its parent between two looks can escape. On Windows `taskkill /T` ends the tree, and nothing is noted.
- **Closed with a question open,** IncarnaMind keeps what was asked (`own_ai_questions`, on this device only, emptied with the conversation), so after a restart the request says what was asked and that it didn't run, with Ask again.
- **A file it made** reaches the Library by `hand_over_file`, which now joins the conversation's Tools, from the conversation's own folder only (its real path, links followed): a file anywhere else, which the AI's own tools would have asked before reading, is refused; `cite` and a Canvas still take no file by its path. Which files `hand_over_file` takes is unchanged (decks, workbooks, Word files and PDFs).
- **Consent.** What the AI adds of the User's by its own setup (CLAUDE.md files, its memory, skills, and what their own servers, connectors, commands, files and pages give it) is a data kind of the request's flow, `own-ai-context` (ADR-0022): a consent given before asks once more, at the next request.
- **A conversation keeps the instructions it began with.** Claude Code records a conversation's system prompt at its first request and sends that record on every resume and fork, until the conversation is compacted (measured: a conversation begun on the earlier run, whose instructions said "through its Tools only", refused every command on the new one, 2 of 2, and a fork copied the same prompt). So every conversation that exists when this ships begins anew at its next request, once, under a new id in the same folder, with one line saying so; IncarnaMind's record of its earlier requests stays. From now on, a later change of IncarnaMind's to these instructions reaches only conversations begun after it.
- **What its own tools can reach** includes IncarnaMind's own data folder, which holds the conversation's folder and, above it, IncarnaMind's database, beyond the Folders the User shares (ADR-0026's addendum of the same day); in its asking mode Claude Code asks before its Read tool reads a file outside the conversation's folder.
- **What a planted instruction could do now** is what the User's settings for their AI allow without a question. In Claude Code's default mode every command that changes something, every file write, every fetch and every tool of the User's own servers asks; the card shows exactly what would happen. In its auto mode or with every question skipped, which the User chose in their own settings, it acts without asking, and the conversation says so.
