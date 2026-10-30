# The agent core is general; the product stays documents-first

IncarnaMind v1 stays a documents-first notebook: an Answer is written into a Mind, with Citations checked against the Documents. The agent core underneath is shaped so that general-agent work can be added later without rewriting it. That work includes files outside Linked folders, a browser, a shell, background and scheduled Tasks, and more Connectors. The User asked for this on 2026-10-09: "I want extensibility from the very start". The design is `docs/designs/agent-extensibility.md`.

The core is built from four parts:
- **Tool providers.** Every Tool has one shape and comes from a Tool provider: Document search, Skills and each Connector now; later Files, Library, Minds, Browser, Shell and Schedules. A provider the host can't support isn't registered, so the hosted version simply lacks a local shell.
- **Effects.** Each Tool says what a call does (read, write, execute or network) and where: a folder, a host, a Connector's service, the Documents or a Mind. IncarnaMind works out the Effects itself; a Connector's annotations only narrow them, because the MCP specification calls them untrusted hints.
- **Approvals by Effect.** Approvals are decided from Effects, with the existing policies, requests and "always allow". A policy can trust a Tool, or a scope such as "write inside ~/Reports". Once a Run has read untrusted content (Passages, web pages, Connector results), only scope policies let side effects run without asking. Documents are untrusted input and the User's data is private, so an injected instruction must never meet an unbounded "always".
- **Runs.** The Tool-calling loop is a Run: instructions, Tools, a model, events, stop and steer. An Answer is one kind of Run. A Task is a later kind, which runs in the background, survives a restart from its journal in SQLite, and outputs its Effects and a log.

Every process a Tool starts goes through an `Executor` with a sandbox level. Skill scripts use level "os", the OS sandbox (Seatbelt, bubblewrap), on macOS and Linux (#65), and "none" on Windows (and on Linux without bubblewrap). A container or a remote machine come later, without changing the Tools that use them.

The loop library sits behind a `RunEngine` interface. Today AI SDK 7 implements it, with `streamText`, `stopWhen` and `prepareStep`: the loop its `ToolLoopAgent` wraps. Which library implements it is decided by measurement: the bake-off on `prototype/engine-bakeoff` (AI SDK 7, pi-coding-agent, pi-agent-core with pi-ai), run behind this same interface and recorded in ADR-0007.

Nothing above the interface imports the loop library. That covers Tools, approvals, Runs, the Executor, storage and the UI. Run histories are kept in IncarnaMind's own message form.

The model layer stays on the AI SDK whichever library runs the loop. It builds the models, asks for consent, sorts provider errors into kinds, and makes one-pass calls such as structured output.

Waiting for approval happens above the engine, in a `gate` the engine awaits before each Tool call. A Task's pending approval is written to its journal, so it survives a restart without any engine feature.

## Considered options

- **Keep the core Answer-only and add capabilities as they come** (the previous position). Rejected. Each capability would touch the loop, the approval subjects, the Tool-call record and the renderer, and safety would be decided one Tool at a time.
- **Become a general desktop agent now, like WorkBuddy.** Still rejected for the product. v1's promise is checkable Citations, and general capabilities are deferred.
- **Build the layers above the loop on a coding agent's SDK** (pi-coding-agent's sessions, built-in Tools and permission hooks; opencode's permission config). Rejected. They would replace Effects, approvals and storage that must keep the keychain rule, ADR-0003's sync rules and read-only Linked folders. They also assume a repository and an unconfined shell: pi's own security guide says it runs with the account's permissions, doesn't ask before each Tool call, and leaves isolation to a container, a managed sandbox or a micro-VM extension. As the loop alone, pi is a contestant in the bake-off.
- **Choose the loop library by argument now.** Not done. The bake-off measures the contestants behind the same interface. With the interface in place, switching later costs about the same as switching now.
- **Approve by Tool only, as Goose and v1 do.** Rejected for side effects after untrusted content. "Always allow this Tool" trusts every argument the model will ever send. A scope bounds the damage instead.
- **A shell in v1.** Rejected. None of the general tasks we expect needs one when there are narrow Tools and sandboxed scripts, and an unsandboxed shell plus untrusted Documents plus "always allow" is the injection path this ADR closes.

## Consequences

- Five refactors land before more agent features build on today's shapes: one Tool shape; Effects with one approval decision; the Run engine interface with a contract suite every engine must pass; taint recorded; and the execution seam. Each keeps v1's behaviour and stored data.
- v1's existing "always" policies keep working; taint is only recorded for them for now. When the OS sandbox lands, an unsandboxed Skill script's "always run" asks again after untrusted content; sandboxed scripts keep running without asking. Connector "always allow" stays until there is evidence. New side-effecting providers follow the taint rule from the start.
- The first general capability, when one is scheduled, is Files (a granted read folder and a granted output folder) with Library `add_documents` and Schedules. A Shell comes only after the OS sandbox, and never with Tool-level "always".
- The sandbox follows the industry pattern and stays simple (User, 2026-10-09: "do it the industry-standard way, simple and clean, no over-engineering"; research in `docs/research/sandboxing.md`). Skill scripts run at the "os" level through `@anthropic-ai/sandbox-runtime`, pinned to 0.0.79, on macOS and Linux (#65): Seatbelt or bubblewrap, no network, secret-looking environment variables removed. stdio Connectors stay unsandboxed, as in Claude Code, Cursor, Codex and Muse Code. No extra Connector hardening (environment allowlists, version pinning, description hashing) is built.
- A later Task's output goes to a Tasks view with its log, and its deliverable to where the User chose (a Mind, a folder or the Library), not all into a Mind.
- Effect policies on folders belong to one device: they get a `device_id`, unlike today's per-User rows (ADR-0003).
- Task tables (`runs`, `run_steps`, `schedules`) follow ADR-0003's rules and record the device a Run executes on. "Run" and "Task" enter CONTEXT.md when Tasks are built; "Effect" is in it now.
- A Files provider never changes a file in a Linked folder, and adds a new one there only with that folder's permission (ADR-0010, amended 2026-10-10 by #124).
- On macOS, the OS sandbox relies on `sandbox-exec` and Seatbelt profiles, which Apple deprecates and doesn't document for third parties; Claude Code and Codex rely on them too. Windows stays at sandbox level "none" and asks every time.

## Addendum, 2026-10-11: the User's own agent

The owner asked why we write our own harness rather than use Claude Code's, Codex's, pi's or OpenClaw's, and suggested Users connect their own. We keep our own loop. A User's agent can use IncarnaMind in two ways, both outside that loop. Research: `docs/research/bring-your-own-agent.md`.

**We keep our loop.** The loop is already the AI SDK's. What we write is the Citation check, consent, Proposals, Effects and read-only Linked folders. An outside harness as our engine would drop them: Claude's ACP adapter uses its own file and shell Tools whatever the client allows. Most Users won't have a coding agent, and many use a local model.

**IncarnaMind is an MCP server.** A User can connect their own agent, such as Claude Code, Codex, Cursor or Claude Desktop, to IncarnaMind.
- It runs as a stdio command that talks to the running app over a local socket. There is no HTTP port until a client needs one, because stdio and a socket are what the MCP security guide recommends for local servers.
- Each agent is a pairing the User makes in Settings, with its own Search scope, its own consent, a token only it holds, and a list of what it did.
- Its Tools read the Documents and the Minds and mint Citations. Its only write is a Proposal, which waits for the User in IncarnaMind.
- Only IncarnaMind mints a Citation. Every Citation an agent sends back is checked again, and a sentence without one is marked.
- Off by default, and offered as an experimental setting first. A new pairing sees no Documents until the User picks its Folders. Local mode pauses every outside agent, because IncarnaMind can't tell which model the agent sends text to.

**IncarnaMind can host an outside agent over ACP, later and experimentally.** A hosted agent is a new kind of Run whose loop runs in the agent's process. It isn't a Run engine, because the model isn't ours.
- The agent gets IncarnaMind's MCP server at session start, and its text streams into an Answer Block with re-checked Citations.
- Its permission requests use our approval cards. After our Tools return Passages to it, we stop offering "always allow".
- We start it in its most restrictive mode, and never in one that skips permissions.
- Its own Tools are outside our Effects, and we say so in its consent.

**Which agents.**
- We never bundle an agent's proprietary binary.
- Codex, Goose, OpenCode, and Gemini CLI on a paid key are hosted first.
- Claude Code and Claude Desktop connect through the MCP server above, on the User's own sign-in. The User's own Claude Code can also run on their Claude plan, as an opt-in (#385).
- Signing in with a Claude or GitHub Copilot plan is an experimental sign-in route (ADR-0019): off until the User signs in, never preselected. With either plan, the setup and Settings say that Answers count toward the plan's usage limits.

**Considered options.**
- **Run the User's harness as our engine.** Rejected for the reasons above.
- **A localhost HTTP server with a token.** Kept for later. It opens a port that web pages can try to reach, and no client we target needs it today.
- **Let agents write to Minds directly.** Rejected. A change from outside waits as a Proposal, as an AI change from inside does.
- **Trust ACP's `fs` and `terminal` capabilities to confine the agent.** Rejected. Agents use their own Tools when the client declines, and ACP v2 removes them.

**Consequences.**
- A new data flow, "agents", one consent per pairing, listed on the Privacy page.
- A pairings table, following ADR-0003's rules, with each token kept by `secrets.ts`.
- The socket listener lives in the main process, and the core never imports Electron.
- "Outside agent" enters CONTEXT.md when Phase 1 ships.
- `@agentclientprotocol/sdk` (Apache-2.0) is added only with the ACP host.

## Amendment, 2026-10-11: third-party text asks before "always" (#78)

Web pages and documents other people wrote are now main inputs, so the consequence above that Connector "always allow" stays until there is evidence no longer holds after reading them. **Third-party text** (CONTEXT.md) is what someone other than the User wrote: a saved web page, the document being checked, and text in a Mind or a conversation that came from them (imported from someone else's .docx, a quote added from a web page, an Answer written by a Run that had read some). Text pasted from other apps can't be traced, and counts as the User's.

- **The rule.** Once a Run has read third-party text, a Tool-level "always" (a Connector Tool's "always allow", a Skill's "always run") no longer covers a call that writes or sends data. The call asks, the approval card says why ("This Answer read a web page", "This Mind contains imported text"), and it offers no "always". A call that runs by default still runs (a Connector Tool marked read-only), and so does an "always run" script in the OS sandbox, which can neither write outside its working folder nor go online.
- **Unchanged.** In a Run that read only the User's own Documents, "always" still counts, as above. New side-effecting Tools keep the day-one rule: they ask unless a scope grant covers them, and until their provider can ask, the Answer's gate refuses their side effects.
- **When a Run is third-party.** From its start, when its Question context holds third-party text, or when it checks a document (#97); and from the moment one of its Tools reads some, such as a search that finds a web page's Passages. Calls from an outside agent, the User's own agent connected to IncarnaMind (#351), are untrusted input of the same kind: an Answer one asks for is offered no Tool that writes or sends, so no "always" can be steered by it.
- **Origin is kept with the text.** A Mind records, beside its Blocks, which Blocks hold third-party text and where it came from (ADR-0003, amended); a conversation's Answer records it on its row. An Answer written by a third-party Run is recorded too, so a later Question that has it in its context counts as third-party as well.
- **Check Runs get two Tools.** Find support, verify, comparison tables' cells and contradiction watch are offered only Document search and `cite`, whatever else is set up, so a document being checked can't steer a write or a send. Ordinary Answers keep every Tool.

## Amendment, 2026-10-12: where an Answer is written (ADR-0017)

The opening says an Answer is written into a Mind. With ADR-0017 and #201, an Answer is written in the assistant's conversation instead. A Mind gets it only when the User picks Add to note, or as Proposals the User accepts (#202). The product stays documents-first: wherever an Answer is shown, its Citations are checked against the Documents.

## Amendment, 2026-10-12: web search's Tools (#128)

Web search gives an Answer two Tools of IncarnaMind's own, offered only when the User has it on in Settings → Search, Local mode is off, the Answer's model's provider has a web search of its own, and the Question asks for the web. `search_web` searches through that provider; `read_web_page` saves a page the search found as a Web page Document and gives its Passages to cite.

- **Neither asks the User.** A search sends to a service the User allowed (consent asks before the first). Reading a page is a read from a web host: it fetches only an address a search of the same Run returned, so nothing the model writes, and nothing of the User's, goes with it. An address the model made up is refused with a reason. "Read" from a web host therefore runs by default (`runsByDefault`); a later Tool that fetches an address the model chose sends data, and declares "network". The Research Task's design board (Final-42-Research-Running) shows `fetch_page` asking after a web page was read; with the allowlist there is nothing for that ask to protect, so #130 should revisit it rather than add it.
- **Both read third-party text.** Search results (titles written by other people) and a page's Passages make the Run third-party (#78): from then on, writes and sends a Tool-level "always" would let through ask.

## Amendment, 2026-10-16: edits the User asked for apply at once (#880)

An edit the User asks for applies at once, with one Undo and a line over it saying what changed: one started on the text (Edit with AI, the selection menu's AI actions), and one asked of the assistant to write into a Mind or change it, whose requests `routeRequest` tags. Changes the User didn't ask for stay Proposals, and so does what the guards hold back: an edit that would remove most of the selection without mapping onto it, or an assistant change that would take out most of the User's own text. The core still writes every AI change as Proposals; the window that asked accepts them, and they stay Proposals otherwise.

## Amendment, 2026-10-21: the model decides, and the assistant's changes apply at once (#1559)

The 2026-10-16 amendment's tagging by `routeRequest` is gone: keywords couldn't cover how Users ask ("帮我总结一下这个知识库" fell through), and requests it left unclear were answered in the panel. Every turn in the assistant now has the Minds' Tools, and the model decides by one rule in its instructions: a piece of writing goes into the empty Mind in front or a new Mind, a change to the User's text is made in place, and a question is answered in the reply.

- **Every change the assistant makes applies at once,** in every Mind it touches, with one Undo, and the Answer's line says so. A change in a second Mind no longer waits. The guard still holds back an assistant change that would take out most of the User's own text, and a rewrite over words the User typed since. The core still writes them as Proposals, tagged by what they are (written or edited); the window that asked accepts them.
- **A claim needs its command.** A reply that says it wrote or changed something no call did, or names a fix or a count its edits didn't make, is asked about once, with the record of what the calls did, where a change that applies at once reads as applied. If it still claims it, the reply stays, with a line under it that says nothing was written, or that not every change it describes was made, and Try again.

## Amendment, 2026-10-25: the model chooses the edit's stretch and revises within the turn (#1656, #1657, #1864)

No pattern over the User's words overrides the stretch the model chose with `edit_mind`: its `part` alone decides, and a wrong start is refused rather than silently redirected to a guessed paragraph. Inside one turn, a later `edit_mind` on the turn's own changes revises them in place, as it already did for its waiting Blocks from an earlier turn; the turn still applies in one Undo step. The instructions name the whole Library, and list Minds an earlier Answer made as sources from that Answer rather than as the User's own writing, so a request for a new piece doesn't get drawn into one.

## Amendment, 2026-10-18: model-written code in a sandbox runs without asking (ADR-0023)

Code a model writes for an analysis runs in Pyodide, in a hidden, sandboxed renderer with no network, no Node and no files (ADR-0023). That is a new Effect scope, **sandboxed code**, which runs without asking. It needs no ask because its only inputs are values cited from the Documents, which reading already does without asking, and it can neither write a file nor send anything. The OS sandbox's levels above stay as they are for the processes a Tool starts; this sandbox is Chromium's, and runs on Windows too.

## Amendment, 2026-10-18: the assistant runs the app's commands (#1110)

The assistant can do what the User does with the app's commands. A **Commands** Tool provider gives an Answer in the assistant two Tools: `list_commands` finds the Documents or Minds a command would act on, and `run_command` runs one command on what it found, by id. It matches exactly, by words in a name, a Tag or a Folder, never by meaning. A command added later needs its mark, its check and run in the core, and a line in the Tool's description, but no new Tool.

- **Only commands marked for the assistant run.** The table is `ASSISTANT_COMMANDS`, keyed by the command list's ids. Adding files has its own entry, `documents.addFromFolder`: it reads the folder named and always asks, unlike the Add Documents command, which opens the system's file picker and is never the assistant's. An unmarked command is refused before anything runs.
  - The marked ones rename, move to a Folder, tag, delete to Recently deleted, export a Mind, and add files from a folder.
  - None changes consent, Local mode, keys, sign-ins, approval policies, Privacy or usage data, or deletes for good.
  - A test pins the table and what each entry does.
- **The core runs them**, through its own public interface, as the window's clicks do. The renderer's command list stays the window's.
- **Whether a call asks is decided in one place**, from what the command's entry says it does and what checking the call found, never by the command's own code.
  - **A change inside the Library runs at once.** This holds even after the Run read Passages or third-party text, and so departs from #78's rule that new side-effecting Tools ask unless a scope grant covers them: the Library is now that grant. Each Run's changes are one step of Undo for the session. That step goes on the stack as the Run's first change lands, and back on top as each later one lands, so ⌘Z takes back what just landed first.
  - **Except these, which ask:**
    - **Every delete the assistant starts**, whatever the Run read, since a web page's title or a Document's text could ask for it. One card lists what would go, each by the name the User knew, with what the Conversation's commands renamed it, and "and 10 more" past the 50 it names. It offers Delete and Don't delete. It is the one exception to Undo instead of confirmations, and only for the assistant's deletes: the User's own still happen at once, with Undo.
    - **A change that would take one Answer past 20 changes**, counted across all its calls, renames included. Calls are checked one at a time. Once the User allows one, the count starts again.
  - **Export into the Output location itself runs at once.** The Output location is a new scope, the folder the User chose for new files. A folder inside it may be one a sync service shares, so it asks, as any other folder does.
  - **Reading a folder's files always asks.** The ask lists the files right in that folder, of the kinds asked for, and reads nothing a link leads to outside it.
  - **An ask offers only Allow or Don't allow** (Delete or Don't delete for a delete). It never offers "always", and no stored policy applies to a command.
  - **An ask says when its Run had read text the User didn't write**: Passages, a Connector's reply, a web page, or a saved web page's title among the names it was given. This helps the User judge the request, but doesn't change what asks.
  - None of the marked commands sends anything off the computer. A later one that does asks the same way.
- **Undo is all or nothing per change, and leaves the User's own things alone.**
  - A command that fails part way takes back what it did. A Folder or Tag it made for that change is removed for good, so it never waits in Recently deleted.
  - An Undo that can't take back one change takes back the rest, says which failed and what it kept, and takes back what is left when tried again. Once a try again takes back nothing more, it stops offering one, so ⌘Z reaches older changes. Redo then makes it all again.
  - Undo leaves a Folder or Tag the Run made in place, and says so, when the User has put their own things in it since: Documents, Minds or conversations.
- **Reported from results.** The card under the reply says only what each `run_command` call returned, including the failed and the denied ones.
- **Not for every Run.** Check Runs and outside agents aren't offered them.

## Amendment, 2026-10-26: names in this record (#2004)

The action the amendments above call Find support is called Check against Documents in the interface (`editor.ai.checkAgainstDocuments`): a check made now stores `check-against-documents`, and an older stored Note's `find-support` still reads and runs as Check against Documents, whose ⌘K keywords keep "check find support". The `prototype/*` branches this ADR names are no longer on `origin`; the bake-off's scores stand as recorded.

## Amendment, 2026-10-29: the assistant's commands are the window's one list (#1421)

The 2026-10-18 amendment's table, `ASSISTANT_COMMANDS`, is gone. The assistant's commands are the window's command list, the one ⌘K shows: whatever the User can do from ⌘K, a menu or a setting, the assistant can do, except privacy and security. A command added to the list is the assistant's at once, and a test walks the list and runs every entry the assistant may run through its path.

- **The entry says it.** Each entry of the window's list carries what it acts on (`appliesTo`), whether it deletes (`destructive`) and whether it can be taken back (`reversible`), and whether the assistant never runs it (`assistant`). With each Question the window sends its commands as ⌘K offers them then, each by its English name, with those marks. The core reads them as any input, and drops an entry that acts on nothing the assistant can find.
- **Where a command runs.** The core runs the commands that take what the window would ask the User for (a name, a Folder, a citation style, a font, a setting), restoring from Recently deleted what `list_commands` found there by name (when two things there share the name, the User says which in the tray, never the model), and those of the Library that ⌘K has no entry for (adding a folder's files, a new Tag, a setting), each checked and run through the core's own interface, as before. The window runs the rest as ⌘K runs them, on what `list_commands` found or on the window in front: the core asks it through an event and the window answers through `answerWindowCommand`. The core never imports the window. Only the window that asked runs it (the Question names it by `clientId`). The window says at once that the command started, then how it ended. A command its window didn't start within 30 seconds, or whose window closed, crashed or reloaded first, wasn't done, which its card says. One that goes on, as a Check or a recording waiting for the system's microphone permission does, returns its call as started, and the turn goes on without it; when it ends, its call is updated, during the Answer or after it, also when the Answer was stopped after it started. One still going on when the app quit says, on the next start, that it didn't finish.
- **What asks first** is still decided in one place, from the entry's marks and what checking the call found: as before, and also a command of the window's that deletes or can't be taken back, a new Output location, since a file saved there no longer asks, and a command that can turn on the microphone or the computer's sound (`recording: "starts"`: starting a Meeting or a Voice memo, resuming one, the microphone's switch), whoever asked for it, since a Document's text could. Stopping a recording (`recording: "ends"`) only ends capture, so it asks nothing, unless the Answer has read text the User didn't write (a Document, a web page or the live Transcript, where a participant's words could ask for it): a stopped Meeting can't be picked up again, so it then asks like a start, and the card says where the request came from.
- **Never the assistant's:** keys and sign-ins; consent, Local mode, Privacy and the switches that decide what leaves the computer (web search, suggestions as the User writes, cloud transcription); its own approval rules; the monthly spending cap; deleting for good; and what is the User's own word, "Checked by me" and marking text as theirs. An entry marked so, or a setting named so, runs nothing and asks nothing: its card says where the User changes it, with one button that opens that page, or none for what is done on each thing itself. Not offered at all: commands that act on the assistant itself or on where the keyboard is (Stop, New chat, Undo), how the User arranges their tabs (moving, renaming, pinning, closing), those that wait for the User's choice in a file picker (the assistant adds a folder's files itself), and those that act on what the assistant can't find by name (a Block, a Citation).
- **Organize by content** runs the Library's Organize on the Documents named, or those in no Folder, with the Folder the request names among those it may choose, made if there is none. Its suggestions wait in To review; nothing moves before the User accepts. Its Undo takes back the suggestions it made and that Folder.
- **One Undo per request.** What a window command changed goes into the same step as the Run's other changes.
- **A request goes on to its end.** A command of the window's ends the turn only when the model marks its call as the request's last (`done`, read through `Tool.endsTurn(result, input)`): its card is then the reply, and no closing reply follows. A refusal never ends the turn, so what the request asked for after it is still done.
