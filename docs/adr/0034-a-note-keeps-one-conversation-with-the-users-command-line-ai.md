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
- **One run per Note at a time.** The core holds one run per Note, as it does for a check, so two windows never resume one conversation at once. While a run goes, the input's Send is Stop.
- **Its working folder** is a folder of IncarnaMind's own for that Note, in IncarnaMind's data folder, empty. Claude Code files the transcript under that folder's name, so one Note's conversation is one project in Claude Code's list of projects, and can be deleted alone (decision 5).
- **The flags are ADR-0032's,** with these differences:
  - no `--no-session-persistence`;
  - `--session-id` on the first request and `--resume` after;
  - `--allowedTools mcp__incarnamind`: every Tool of IncarnaMind's server, whose grant decides what the connection may do (decision 4).

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
- **One pill above it, centred, one line** (#3677), as the User's AI app shows its own:
  - while the request runs: a small moving mark, "Working", then what the AI is doing, in its own words where it wrote some (it is asked to say in a few words what it is about to do before each step), else what it is reading and where ("Reading “Interview 3” · 4 read"), else "Thinking"; and the seconds since the request, from the third;
  - when it ends: the first words of the AI's reply, cut to one line, with "Accept all" at its right end while changes wait in the Note, in place of the line across the top of the Note. Pressed, the pill opens into a card in its place: the whole reply, formatted, a close, and "Accept all" and "Open in chat" under it. The reply is in one place at a time: the pill, its card or the conversation.
  - the run's thinking itself arrives empty in Claude Code's stream, so the pill can't show it; the words come from the lines the AI writes between its steps, and from its reply as it writes it.

  The pill goes when the User types the next request. An applied change stays marked in the Note with its Undo, unlike the User's AI app, where a direct change leaves no mark.
- **Stop:**
  - While a run goes, Send is Stop (Esc too, from the input). Stop ends the run at once: the pill goes, the input is idle, and nothing is added in its place.
  - A change that applied before Stop stays, with its Undo; a change that waits stays waiting; nothing else lands.
  - While a run goes, Return does nothing new: only Stop, and Esc, act (the owner, 2026-11-22). A selection toolbar action then sends nothing either, and a line says the AI is still working and Stop comes first.
- **A failure,** in the pill, one line with one action, as for the check:
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
  - It is hidden; a quiet "Show conversation" (显示对话) beside the pill, or "Open in chat" in its card, opens it above the input, in the Note's column, never higher than a third of the window, so the Note stays in view.
  - It lists each request (the User's words, the selection's quote) and its reply as the AI wrote it, formatted, newest last, from IncarnaMind's record.
  - Esc or "Hide conversation" closes it. It never opens by itself.
- **Explain, Improve writing, Shorten and Translate** in the selection toolbar fill the input with their request and send it. Explain's answer shows in the pill, and its card, and changes nothing.
- **A run that sends nothing for six minutes is stopped,** with a plain line ("{agent} stopped answering for six minutes, so it stopped. Send it again."). While it works, Claude Code sends a tick about every second as it thinks, its words and Tool inputs as it writes them (partial messages, and fine-grained Tool streaming), and a heartbeat every 30 seconds during a Tool call; six minutes is past Claude Code's own five-minute limit for a stream with no data, so its own watchdog and retry act first. Before #3677 the only way out was the run's own 15 minutes. A check run has the same limit.
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
  3. The model is the User's own default, which IncarnaMind doesn't choose.

### 9. The next step's door

The owner's next step gives the conversation the command line's own abilities, as Claude's Cowork has them: the web, files inside a linked Folder, code. Each risky step would be shown and asked first. It is a separate issue, and nothing of it is built here. Two things keep it open:
- **The run's Tool set and permission mode are inputs of a run,** not fixed in the runner. This run passes none of Claude Code's own tools and `dontAsk`.
- **Claude Code's approvals would come to IncarnaMind,** where the app shows its approval card: `--permission-prompt-tool mcp__incarnamind__<tool>` makes a Tool of IncarnaMind's server answer Claude Code's permission prompts in print mode ([CLI reference](https://code.claude.com/docs/en/cli-reference)). Nothing relies on it yet.

### 10. What we never do

- Set `CLAUDE_CONFIG_DIR`, or read Claude Code's transcripts, settings or sign-in.
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
