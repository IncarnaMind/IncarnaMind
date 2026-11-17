# The agent core is general; the product stays documents-first

## Context

IncarnaMind v1 stays a documents-first notebook: an Answer's Citations are checked against the Documents wherever it is shown. Since ADR-0017 (#201) an Answer is written in the assistant's conversation, and a Mind gets one through Add to note or the assistant's changes (below). On 2026-10-09 the User asked for "extensibility from the very start", so the agent core is shaped for general-agent work later (files outside Linked folders, a browser, a shell, background and scheduled Tasks, more Connectors) without a rewrite. The design is `docs/designs/agent-extensibility.md`.

## Decision

The core is built from four parts:

- **Tool providers.** Every Tool has one shape and comes from a Tool provider: Document search, Skills, each Connector, web search, the Minds' Tools and the commands now; later Files, Library, Browser, Shell and Schedules. A provider the host can't support isn't registered, so the hosted version simply lacks a local shell.
- **Effects.** Each Tool says what a call does (read, write, execute or network) and where: a folder, a host, a Connector's service, the Documents, a Mind, the Library or the Output location. IncarnaMind works out the Effects itself; a Connector's annotations only narrow them, because the MCP specification calls them untrusted hints.
- **Approvals by Effect.** Approvals are decided from Effects, with policies, requests and "always allow". A policy can trust a Tool, or a scope such as "write inside ~/Reports". Documents are untrusted input and the User's data is private, so an injected instruction must never meet an unbounded "always" (see third-party text below).
- **Runs.** The Tool-calling loop is a Run: instructions, Tools, a model, events, stop and steer. An Answer is one kind of Run. A Task is a later kind, which runs in the background, survives a restart from its journal in SQLite, and outputs its Effects and a log.

**The Run engine.** The loop library sits behind a `RunEngine` interface, which AI SDK 7 implements today (`streamText`, `stopWhen`, `prepareStep`). The library is chosen by measurement, behind this interface (ADR-0007). Nothing above it imports the loop library: Tools, approvals, Runs, the Executor, storage and the UI. Run histories are kept in IncarnaMind's own message form. The model layer (models, consent, provider errors sorted into kinds, one-pass calls such as structured output) stays on the AI SDK whichever library runs the loop. Waiting for approval happens above the engine, in a `gate` it awaits before each Tool call; a Task's pending approval is written to its journal, so it survives a restart.

**The sandbox follows the industry pattern and stays simple** (User, 2026-10-09; `docs/research/sandboxing.md`). Every process a Tool starts goes through an `Executor` with a sandbox level. Skill scripts run at level "os" through `@anthropic-ai/sandbox-runtime` (0.0.81, ADR-0025) on macOS and Linux (#65): Seatbelt or bubblewrap, no network, secret-looking environment variables removed. Windows, and Linux without bubblewrap, stay at "none", and on Windows a script asks every time. A container or a remote machine can come later without changing the Tools. stdio Connectors stay unsandboxed, as in Claude Code, Cursor and Codex, with no extra hardening.

**Sandboxed code runs without asking** (2026-10-18, ADR-0023). Code a model writes for an analysis runs in Pyodide in a hidden, sandboxed renderer with no network, no Node and no files: the Effect scope **sandboxed code**. Its only inputs are values cited from the Documents, which reading already does without asking, and it can neither write a file nor send anything. That sandbox is Chromium's, so it runs on Windows too. `run_code`'s bash runs without asking too, as sandboxed code at level "os" (ADR-0025 decision 4).

### Third-party text asks before "always" (2026-10-11, #78)

**Third-party text** (CONTEXT.md) is what someone other than the User wrote: a saved web page, the document being checked, and text in a Mind or a conversation that came from them (imported from someone else's .docx, a quote from a web page, an Answer by a Run that had read some). Text pasted from other apps can't be traced and counts as the User's.

- **The rule.** Once a Run has read third-party text, a Tool-level "always" (a Connector Tool's "always allow", a Skill's "always run") no longer covers a call that writes or sends data. The call asks, the card says why ("This Answer read a web page", "This Mind contains imported text"), and it offers no "always". A call that runs by default still runs (a Connector Tool marked read-only), and so does an "always run" script in the OS sandbox, which can neither write outside its working folder nor go online.
- In a Run that read only the User's own Documents, "always" still counts. New side-effecting Tools ask unless a scope grant covers them, and until their provider can ask, the Answer's gate refuses their side effects.
- **When a Run is third-party:** from its start, when its Question context holds third-party text or it checks a document (#97); and from the moment a Tool reads some, such as a search that finds a web page's Passages. An outside agent's calls (#351) are untrusted input of the same kind: an Answer one asks for is offered no Tool that writes or sends.
- **Origin is kept with the text.** A Mind records which Blocks hold third-party text and where it came from (ADR-0003, amended); a conversation's Answer records it on its row. An Answer written by a third-party Run is recorded too, so a later Question with it in context counts as third-party.
- **Check Runs get two Tools.** Check against Documents, verify, comparison tables' cells and contradiction watch are offered only Document search and `cite`, so a document being checked can't steer a write or a send.

### Web search's Tools (2026-10-12, #128)

Two Tools of IncarnaMind's own, offered only when web search is on in Settings → Search, Local mode is off, the Answer's model's provider has a web search, and the Question asks for the web. `search_web` searches through that provider; `read_web_page` saves a page that search found as a Web page Document and gives its Passages to cite.

- **Neither asks.** A search goes to a service the User allowed (consent asks before the first). Reading fetches only an address a search of the same Run returned, so nothing the model writes, and nothing of the User's, goes with it; a made-up address is refused with a reason. So "read" from a web host runs by default (`runsByDefault`). A Tool that fetches an address the model chose sends data, and declares "network".
- **Both read third-party text,** so the Run becomes third-party (#78).

### The assistant's changes to Minds apply at once

- **The model decides** (2026-10-21, #1559). Every assistant turn has the Minds' Tools, and the model decides by one rule in its instructions: a piece of writing goes into the empty Mind in front or a new Mind, a change to the User's text is made in place, a question is answered in the reply, and something done to the Documents, Notes or Folders or in the app is a command (#2252). No pattern over the User's words decides: the keyword router of #880 (`routeRequest`) couldn't cover how Users ask.
- **Changes the User asked for apply at once** (#880, #1559), in every Mind touched, with one Undo and a line saying what changed: Edit with AI, the selection menu's AI actions, and the assistant. The core still writes every AI change as Proposals, tagged as written or edited, and the window that asked accepts them; changes the User didn't ask for stay Proposals. **Guards hold back** an edit that would remove most of the selection without mapping onto it, an assistant change that would take out most of the User's own text, and a rewrite over words the User typed since.
- **The model chooses the stretch** (2026-10-25, #1656, #1657, #1864). `edit_mind`'s `part` alone decides it; a wrong start is refused, never redirected to a guessed paragraph. A later `edit_mind` in the same turn revises the turn's changes in place, still one Undo step. The instructions name the whole Library, and list Minds an earlier Answer made as that Answer's sources, not the User's own writing.
- **A claim needs its call** (#1559, #2407). A quick model reads the reply against the record of what each call did (ran, started, refused as the User's alone, failed, not allowed, never made), for Notes and for commands and settings (ADR-0007, #1655); no pattern over the reply's words decides. A reply that claims what no call did is asked once, with that record, and told not to rerun what was refused or not allowed. If it still claims it, it stays, with Try again and a line in the User's language: the line names as unchanged each thing only the User changes that the reply claims or the turn refused, with where to change it, and says of other commands that not all of it was done. Add to note keeps the line. **It fails closed:** a claim that stands, a check that couldn't run, or a failed re-ask (which keeps the first finding) still names each User-only thing the turn refused, and after a refused, failed or not-allowed command the reply shows only once checked. The refusal's own line is never read as a claim, and an honest reply is left alone.

### The assistant runs the app's commands (2026-10-18, #1110; 2026-10-29, #1421)

Whatever the User can do from ⌘K, a menu or a setting, the assistant can do, except privacy and security. Its commands are the window's one list (#1421 replaced #1110's own table), so a command added there is the assistant's at once; a test walks the list and runs every entry the assistant may run. The code is in `src/core/tools/commands/`.

- **Two Tools.** `list_commands` finds what a command would act on, exactly by words in a name, a Tag or a Folder, never by meaning; `run_command` runs a command on what it found, by id. When two things in Recently deleted share a name, the User says which, never the model.
- **Where it runs** (`catalogue.ts`): in the core, through its own interface, or in the window that asked, as ⌘K runs it; the core never imports the window. A window command not started within 30 seconds, or whose window closed, crashed or reloaded, wasn't done, and its card says so. One that goes on (a Check, a recording) returns as started and updates its call when it ends.
- **What asks is decided in one place** (`policy.ts`), from the entry's marks (`appliesTo`, `destructive`, `reversible`, `assistant`) and what checking the call found, never by the command's code.
  - **A change inside the Library runs at once,** even after the Run read Passages or third-party text. This departs from #78's rule for new side-effecting Tools: the Library is now their scope grant.
  - **These ask:** every delete the assistant starts, whatever the Run read (one card names up to 50 of what would go, by the names the User knew, then "and 10 more", with Delete and Don't delete: the one exception to Undo instead of confirmations, since the User's own deletes still happen at once with Undo); a change that would take one Answer past 20 changes, renames included, counted call by call and afresh once allowed; a window command that deletes or can't be taken back; a new Output location, since files are saved there without asking; reading a folder's files (listing the files right in it, of the kinds asked for, following no link out); any command that can turn on the microphone or the computer's sound (`recording: "starts"`), whoever asked; and stopping a recording (`recording: "ends"`) after the Answer read text the User didn't write, since a stopped Meeting can't be resumed. A command that would send anything off the computer asks.
  - Export into the Output location runs at once; a folder inside it may be shared by a sync service, so it asks like any other folder.
  - **An ask offers only Allow or Don't allow** (Delete or Don't delete), never "always", and no stored policy applies to a command. It says when the Run read text the User didn't write (Passages, a Connector's reply, a web page, a saved page's title), to help the User judge; that doesn't change what asks.
- **Never the assistant's:** keys and sign-ins; consent, Local mode, Privacy and the switches that decide what leaves the computer (web search, suggestions as the User writes, cloud transcription); its own approval rules; the monthly spending cap; deleting for good; and the User's own word ("Checked by me", marking text as theirs). These run nothing and ask nothing. **The reply ends with the refusal's own sentence** in the User's language, once, and the model is told to leave it out (#2252); the card keeps only a button to the page where the User changes it, or none for what is set on each thing itself.
- **Not offered:** commands on the assistant itself or on keyboard focus (Stop, New chat, Undo), arranging tabs, file pickers, and what can't be found by name (a Block, a Citation).
- **A request goes on to its end.** A window command or a refusal ends the turn only when the model marks its call as the request's last (`done`, `Tool.endsTurn(result, input)`); its card or sentence is then the reply. The card says only what each `run_command` call returned, failed and denied ones included.
- **One Undo per request** (`steps.ts`), window commands included, all or nothing per change: a command that fails part way takes back what it did, and a Folder or Tag it made is removed for good. An Undo that partly fails says what it kept and can be tried again. Undo leaves, and says so, a Folder or Tag the Run made that the User has since put their own things in.
- **Not for every Run:** check Runs and outside agents over MCP aren't offered the commands; a hosted Run is (ADR-0026).

### Organize and tagging propose, and the User confirms (2026-11-07, #1569, #2339)

Nothing the AI sorts or tags is kept until the User confirms it, whoever started the run (ADR-0012). The assistant's Organize and tagging add what they propose to Suggestions, the Library's one set of proposals, and the reply says what it proposes and ends with a Review button. Nothing moves, no Folder is made and no Tag is added from the chat. Its Undo takes its proposals back out of Suggestions. No question is asked above 20 Documents, since nothing moves; the first-time consent for a cloud service (ADR-0022) and the cost question before a large run billed per token stay. It never proposes moving a Document across a Folder's wall, in or out. Every run, the Library's own included, ends in Suggestions. This replaced filing at once (2026-11-03) and the Library's To review.

## Considered options

- **Keep the core Answer-only and add capabilities as they come:** each would touch the loop, the approval subjects, the Tool-call record and the renderer, and safety would be decided one Tool at a time.
- **Become a general desktop agent now, like WorkBuddy:** v1's promise is checkable Citations.
- **Build the layers above the loop on a coding agent's SDK** (pi-coding-agent, opencode's permissions): they would replace Effects, approvals and storage that must keep the keychain rule, ADR-0003's sync rules and read-only Linked folders, and they assume a repository and an unconfined shell. As the loop alone, pi was measured (ADR-0007).
- **Choose the loop library by argument:** the bake-off measured it; behind the interface, switching later costs the same as now.
- **Approve by Tool only, as Goose and v1 did:** "always allow this Tool" trusts every argument the model will ever send; a scope bounds the damage.
- **A shell in v1:** no expected task needs one, given narrow Tools and sandboxed scripts, and an unsandboxed shell with untrusted Documents and "always allow" is the injection path this record closes.

## Consequences

- The core keeps one Tool shape, Effects with one approval decision, the Run engine interface with a contract suite every engine must pass, taint recorded, and the execution seam.
- The first general capability, when one is scheduled, is Files (a granted read folder and a granted output folder) with Library `add_documents` and Schedules. A Shell comes only after the OS sandbox, and never with Tool-level "always".
- A Files provider never changes a file in a Linked folder, and adds one there only with that folder's permission (ADR-0010, #124).
- A Task's output goes to a Tasks view with its log, and its deliverable where the User chose (a Mind, a folder or the Library).
- Effect policies on folders belong to one device and carry a `device_id` (ADR-0003). Task tables (`runs`, `run_steps`, `schedules`) follow ADR-0003's rules and record the device a Run executes on.
- On macOS the OS sandbox relies on `sandbox-exec` and Seatbelt profiles, which Apple deprecates and doesn't document for third parties; Claude Code and Codex rely on them too.
- Names: the interface calls Find support "Check against Documents" (`editor.ai.checkAgainstDocuments`). A check made now stores `check-against-documents`; an older Note's `find-support` still reads and runs as it, and ⌘K's keywords keep "check find support" (#2004).

## Addendum, 2026-10-11: the User's own agent

We keep our own loop rather than run Claude Code's, Codex's, pi's or OpenClaw's (`docs/research/bring-your-own-agent.md`). The loop is already the AI SDK's; what we write is the Citation check, consent, Proposals, Effects and read-only Linked folders, which an outside harness would drop. Most Users won't have a coding agent, and many use a local model. A User's agent can use IncarnaMind in two ways, both outside our loop.

**IncarnaMind is an MCP server** that a User's agent (Claude Code, Codex, Cursor, Claude Desktop) connects to.

- A stdio command talks to the running app over a local socket. No HTTP port until a client needs one: stdio and a socket are what the MCP security guide recommends for local servers.
- Each agent is a pairing the User makes in Settings, with its own Search scope, its own consent, a token only it holds, and a list of what it did.
- Its Tools read the Documents and the Minds and mint Citations. Its only write is a Proposal, which waits for the User. Only IncarnaMind mints a Citation: every Citation an agent sends back is checked again, and a sentence without one is marked.
- Off by default, offered as an experimental setting first. A new pairing sees no Documents until the User picks its Folders. Local mode pauses every outside agent, because IncarnaMind can't tell which model it sends text to.

**IncarnaMind can host an outside agent over ACP, experimentally** (ADR-0026). A hosted agent is a new kind of Run whose loop runs in the agent's process. It isn't a Run engine, because the model isn't ours.

- It gets IncarnaMind's MCP server at session start, and its text streams into an Answer with re-checked Citations.
- Its permission requests use our approval cards, offering Allow once and Deny, never "always": a hosted Run counts as having read third-party text from its first step (amended 2026-11-01).
- It starts in its most restrictive mode, never one that skips permissions. Its own Tools are outside our Effects, and its consent says so; it runs in the OS sandbox, away from IncarnaMind's data folder and the User's Documents.
- In the assistant, its Note edits through IncarnaMind's write tools apply at once with one Undo, checked as our engine's are, and a delete waits on the approval card (2026-11-01, ADR-0026, #1274). An outside agent over MCP acting on its own still only proposes (#351, #352).

**Which agents.** We never bundle an agent's proprietary binary. Codex, Goose, OpenCode, and Gemini CLI on a paid key are hosted first. Claude Code and Claude Desktop connect through the MCP server, on the User's own sign-in; the User's own Claude Code can also run on their Claude plan, as an opt-in (#385). Signing in with a Claude plan is an experimental route (ADR-0019), off until the User signs in and never preselected. The GitHub Copilot plan signs in through IncarnaMind's own GitHub OAuth App, also off until the User signs in and never preselected; only Copilot's editor profile is experimental in the app, and the READMEs call the Copilot sign-in experimental until a real account has tried the own route (ADR-0019, #876). With either plan, the setup and Settings say that Answers count toward the plan's usage limits.

**Considered options.** Running the User's harness as our engine: rejected, above. A localhost HTTP server with a token: kept for later, as it opens a port web pages can try, and no client we target needs it. Letting agents write to Minds directly: rejected for an outside agent on its own, whose change waits as a Proposal, as an AI change the User didn't ask for does. Trusting ACP's `fs` and `terminal` capabilities to confine the agent: rejected, as agents use their own Tools when the client declines, and ACP v2 removes them.

**Consequences.** A new data flow, "agents", one consent per pairing, listed on the Privacy page. A pairings table follows ADR-0003's rules, with each token kept by `secrets.ts`. The socket listener lives in the main process; the core never imports Electron. `@agentclientprotocol/sdk` (Apache-2.0) is added only with the ACP host.
