---
status: proposed (2026-10-31)
---

# The assistant can run on the User's own agent, over the Agent Client Protocol

The User can use an agent harness they already have, such as Codex or Goose, for the assistant. IncarnaMind supplies the sources, the Citations and the checks; the agent supplies its loop, its own Tools and its model, on the User's own account. Everything the agent writes goes through the same checks as an Answer. Our Run engine stays the default: it led the agent-integration bake-off on document work (#1208), and most Users have no agent.

This records how (#353), under ADR-0013's addendum of 2026-10-11, which already decided that a hosted agent is a new kind of Run whose loop runs in the agent's process, that it gets IncarnaMind's MCP server, that its permission requests use our approval cards and that it starts in its most restrictive mode. A spike on this branch (`src/core/agents/hosted.ts`, `src/main/agentProcesses.ts`, `tests/main/hostedAgent.test.ts`) drives a scripted ACP agent through the seams below, with no network and no vendor binary.

## The protocol and the library

- **ACP v1** (`protocolVersion` 1): JSON-RPC 2.0 over the agent's standard input and output, the client starting the agent as a child process ([transports](https://agentclientprotocol.com/protocol/v1/transports)). v2 is a public draft that removes modes, client file system and terminal; we build on v1 and move when v2 is stable and our agents speak it.
- **`@agentclientprotocol/sdk` 2.0.2**, pinned exactly: Apache-2.0, by the protocol's maintainers, with no dependencies (zod, which we ship, is its peer). The stable v1 entry the core imports is 54 KB minified (13 KB gzipped) and imports nothing from Node; it takes the agent as two web streams (`ndJsonStream`). 2.0.0 replaced `ClientSideConnection` with the `client()` builder the spike uses, and stopped publishing its example agent, so the spike's scripted agent is our own (`tests/fixtures/acp-agent.mjs`). 2.1.0 and later add an optional peer of `@modelcontextprotocol/server` ^2.4.0 for helpers we don't use; we move up once our MCP server package is there.
- **What ACP doesn't promise.** "Permission requests are advisory: the Agent performs its own operations", and "an Agent can act without asking" ([security](https://agentclientprotocol.com/protocol/v1/security)). Our checks hold for what reaches IncarnaMind (its MCP calls, its text, its Proposals); the agent's own Tools are the agent's, and the consent says so.

## Decisions

### 1. A hosted Run

A hosted Run is one Question answered by the User's agent: one ACP prompt turn. It is neither a `RunEngine` nor an `AnswerEngine`, since both take our model and our Tools. It writes its Answer through the same writer an Answer uses, so storage, streaming, Stop, the steps, Citation marks and the Conversation are the Answer's. What it leaves out needs our model: our prompt, our Tool loop, the turn checks that ask the model again, quote retries, structured output and the price.

- **Started in `src/main`, behind an adapter.** The core gets an `AgentProcesses` adapter (`src/core/adapters.ts`): `start({ command, args, cwd, env })` resolves with an `AgentProcess`: its input and output as web streams, `exited`, `stderrTail()` and `stop()`. The desktop app implements it on the login shell's `ProcessLauncher` (`src/main/agentProcesses.ts`), so an agent is found as the User's terminal finds it, and each agent leads its own process group. The core's ACP client (`src/core/agents/hosted.ts`) imports nothing from Node or Electron.
- **One process and one ACP session per Conversation,** while it is in use. Each Question is one prompt turn in it, so the agent keeps its own memory of the Conversation. The process stops after 10 minutes idle, when its window closes, when the User picks another model, and when the app quits. The next Question starts a new process and session, whose first prompt carries the Conversation's earlier turns, as an Answer's Question context does.
- **Its working folder** is a new, empty folder in the system's temporary folder, made for the session and removed after it. Never a Linked folder, the Output location or the User's home: the agent's own Tools start from it.
- **Stop** sends `session/cancel`, answers any permission request still waiting as cancelled (as ACP requires), and waits up to 5 s for the turn to end as `cancelled`. An agent that doesn't is stopped with every process it started, and the next Question starts it again.
- **An agent that exits halfway**, or closes its output, ends the turn once everything it wrote has been read: the Answer keeps the text that came, its Citations checked as usual, its running Tool calls marked failed, and one line with one action: "Codex stopped before it finished · Try again". The end of its error output goes to the log, never into the Answer.
- **Quitting** stops every agent process (input closed, 2 s grace, then the process tree); an Answer still streaming is stored as stopped, as any Answer is.
- **A host that can't start processes** (the mobile app, later) has no `AgentProcesses`, and the model menu has no "Your agents" group (portability rule 13). A Conversation that was on an agent says "Codex runs on your computer, not here" and offers the default model. Because the core's client takes two web streams, a later host can reach an agent elsewhere (a WebSocket to the User's computer) without changing it.
- **Windows.** An agent installed with npm is a `.cmd` shim, which `cross-spawn` runs through `cmd.exe` with its arguments escaped, found through `PATHEXT`. Our MCP server goes to the agent as the app's own absolute `.exe` path, never a `.cmd`: ACP asks agents to start MCP servers "without a shell", and a batch file can't run without one. Paths go as separate arguments, so a space in `C:\Program Files` is safe, and ACP's paths are absolute. Stop ends the process tree with `taskkill /T /F`. The MCP shim reaches the app through the named pipe #351 uses. The SDK splits lines on LF or CRLF.

### 2. The session: IncarnaMind's MCP server, and what we offer the agent

- **Transport: stdio, through #351's shim.** Every ACP agent must take a stdio MCP server in `session/new` ([session setup](https://agentclientprotocol.com/protocol/v1/session-setup)). The server is the shim #351 ships: the app's own binary run as Node, which talks to the running app over the local socket (a named pipe on Windows). Its command and two environment variables go in `session/new`'s `mcpServers`.
- **A run grant, not a pairing.** The session's server is admitted by a grant made for it: 256 random bits, held in memory only, never written to the database, the keychain, a file or a log, and gone when the session ends. A shim started with it later is refused as unpaired. The grant reaches exactly the current Question's Search scope (its Folders, Tags and Documents, resolved at each call, Folder walls kept), and is checked at every call as a pairing is (#351): connecting agents on, Local mode off, consent in place. The Citations it mints belong to it.
  - It is not one of the User's secrets: it opens nothing but that scope for the life of the session. It travels as any stdio MCP configuration does, to the agent and to what the agent starts; ACP calls such `env` values credentials that agents "SHOULD NOT log or persist" ([session setup](https://agentclientprotocol.com/protocol/v1/session-setup)), and one an agent keeps anyway is dead once the session ends. No API key, keychain item or token of the agent's vendor passes either way.
- **Its Tools** are #351's reading Tools (`search`, `read_passages`, `cite`, `check_citations`, `list_minds`, `read_mind`) and #352's `propose_changes`. Not `ask`, which would run our model on the User's account inside their agent's turn, and not `show_citation`, which would move the window.
- **Client capabilities: none that act for the agent.** `fs` (read and write), `terminal` and terminal sign-in (`auth.terminal`) are all declared false, and no elicitation. If we offered `fs`, IncarnaMind would read and write the User's files on the agent's behalf. Declining doesn't confine the agent, which uses its own file Tools instead (ADR-0013's addendum); the consent says so.
- **The most restrictive mode, or no prompt.** Several agents start by asking about little or nothing (Codex's "Auto review", Goose's automatic approval, OpenCode's "allow" defaults), so each agent on our list names how it starts restricted: the setting it documents for that at launch (`INITIAL_AGENT_MODE`, `GOOSE_MODE`, `OPENCODE_PERMISSION`) and the ACP mode that matches. Both are applied, and the mode is checked after `session/new`, before the prompt. An agent that doesn't offer it gets no prompt, and the User reads "Codex didn't offer its read-only mode. Update Codex · How". A mode that skips permissions is never chosen. ACP says agents "SHOULD NOT switch to a mode or configuration that reduces user oversight without user action" ([tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls)); one that does during a turn is stopped, with a line saying so.

### 3. Streaming, and the trust path

- `agent_message_chunk` text becomes the Answer's text, streamed as an Answer streams. `agent_thought_chunk` becomes its reasoning, in the steps, never in the Answer. `plan` is the Run's plan in the steps. The steps start "Codex worked for 12 s" (Codex 用了 12 秒).
- **A Citation is only what IncarnaMind minted and found again.** The agent cites with the tokens our `search` and `cite` hand it (`[cite:k3x9a2b7]`). A token's text is held back while it streams. Each token is looked up among those this session's grant minted, then checked again against its Document as it is now (`recheck`), and only then becomes one of the Answer's Citations, recorded as an Answer's `cite` records them: found, Needs re-check if the Document changed since, or Quote not found. A token that is malformed, made up, or minted for another pairing or session is shown as Quote not found, never dropped and never green.
- **Everything else is marked as an Answer's is**: a sentence without a Citation is uncited, and a number in no quote is an Unchecked figure. Nothing the agent says about its own checking changes a mark.
- **Tool calls.** Calls to our MCP server are listed from our own record of them, which is exact; the agent's report of the same calls is not shown twice. The agent's own Tool calls are listed with its title for them, marked as its own.
- **Its changes are Proposals.** A change to a Note arrives only through #352's `propose_changes`, and waits for the User, whoever asked for it. This differs from the assistant's own changes, which apply at once (ADR-0013, 2026-10-21): the guards those rely on run in our loop, the agent's own Tools may have read anything, and we can't ask its model again. The Answer's card lists the Proposals its grant made, with Accept all. A reply that says it changed something while its grant made no Proposal gets the line that nothing was written, from that record alone.
- **What #352 must expose for this:**
  - `propose_changes` takes the caller's identity as the access layer gives it (a pairing, or a run grant), so the hosted Run calls nothing of its own;
  - its `ProposalRequest` (`source: "outside-agent"`) records the agent's shown name and the grant or pairing id, and an optional `answerId` for the Answer whose turn made them;
  - Proposals can be listed by that id, for the Answer's card and for the claim line above;
  - Citations in proposed text are checked as above, and an uncited sentence is marked.

### 4. Permission requests

- The agent's `session/request_permission` becomes IncarnaMind's approval card, titled by the call's kind: "Run code" (execute), "Write a file" (edit, delete, move), "Open a web page" (fetch), otherwise the agent's own title. The card says "{Agent} runs it with its own tools. IncarnaMind can't see or undo it."
- **Allow once, For this run and Deny. Never "always", in any mode.** We answer with the agent's `allow_once` or `reject_once` option. We never choose `allow_always` or `reject_always`: an agent keeps those in its own settings, where IncarnaMind can't show or take them back. An agent that offers no once option is answered as cancelled.
- **For this run** answers the turn's later requests of the same kind without asking, and ends with the turn. It is never stored as an approval policy.
- **After third-party text** (ADR-0013, #78): once the turn has read some (Passages of a saved web page through our server, the agent's own fetch, or a Question context that holds some), For this run no longer covers a request that writes, runs or sends (every kind but read, search and think), and isn't offered for one; each asks with Allow once or Deny, and the card says why.
- **Calls to IncarnaMind's own server** that an agent asks about (Codex asks about MCP calls) ask like any other: the request's title is the agent's text, which can't prove which server a call goes to. For this run then covers the turn's other reads.
- **Denying** answers the agent's `reject_once`, and ends that step with a line in the steps ("Denied: Run code"); the agent decides how to go on.
- The spike tests that the agent's always options are never chosen, that For this run answers the next call of the kind, that Deny answers reject-once, and that Stop withdraws a waiting request as cancelled.

### 5. Consent (ADR-0022)

- **Given where the User chooses the agent**: "Use for the assistant" in Settings › Agents and apps, or the agent in the model menu's "Your agents · Experimental" group the first time. That place says in one line what goes to the agent, and that its own Tools are outside IncarnaMind's checks and Undo:
  > Codex will get your Question, the note you're in, earlier turns of this chat, and the Passages it asks for from the Question's Search scope. It sends them to its model under your Codex account. Its own tools (shell, files, web) run outside IncarnaMind's checks and Undo.
- A new data flow, **"hosted-agents"**, one service per agent, listed on the Privacy page and revocable there. Revoking it stops a running session at once. It is asked again only if the flow starts sending a kind of data its line didn't name.
- **Background work never uses a hosted agent** and so never asks: checks, tagging, suggestions, Tasks and an outside agent's `ask` run on the User's model as before.

### 6. What we never do

- Show a vendor's sign-in, or run one: terminal sign-in is declared off, and an agent that isn't signed in gets a line telling the User to sign in to it where they set it up, with a link to its own page.
- Read an agent's tokens or settings: no file under an agent's own configuration folder is opened, in code or in research, and a test checks it. Discovery looks only at the login shell's PATH. The agent's environment is the login shell's, as Connectors get it (ADR-0013); IncarnaMind adds only the agent's documented setting for its restrictive start, never a key or a token.
- Bundle a proprietary binary. We start what the User installed.
- Use a coding plan. Plans that limit use to named tools, or forbid custom app backends, are never a route, whichever agent carries them; a hosted agent uses the User's own API key or the agent's own sign-in where its vendor allows a local open-source app to drive it.

### 7. The rest

- **Which agents.** The list, with sources, is in "Agents" below. Each entry in the agent list (the same list Settings › Agents reads, ADR-0019) carries the command, its ACP entry, its most restrictive mode, the lowest version that works, its install page and its sign-in link.
- **Discovery.** An agent on the list whose command is on the login shell's PATH is "found"; any other shows "not set up", and choosing it opens one line with a link to the agent's own install page. Nothing is installed or downloaded by IncarnaMind.
- **Version checks.** When found, and again when its Test runs, the agent's `--version` is read and compared with the lowest version on the list; `initialize` must answer protocol 1. Older: "Goose 1.40 is older than IncarnaMind needs (1.50 or later) · How to update". There is no upper bound; a newer version that breaks shows its plain error, and Test in Settings says "Answered in 4 s" or what went wrong.
- **The meter.** IncarnaMind can't price the agent's model and doesn't pay for it: the agent's own account does. A hosted Run is recorded with its time and no price, and doesn't count toward the Monthly cap, which only governs requests IncarnaMind sends. The Answer shows "Codex worked for 12 s"; when the agent reports its session's cost (`usage_update.cost`), it is shown as the agent's figure ("$0.04, as Codex reports it"), never added to IncarnaMind's totals. The cost page lists hosted agents apart, by time and number of Questions.
- **Local mode** pauses every hosted agent, as it pauses outside agents (ADR-0013): IncarnaMind can't tell where an agent sends what it reads, and an agent's report of its own model is a claim we can't check. The line: "Local mode is on, so Codex can't be used: IncarnaMind can't tell where it sends what it reads · Turn off Local mode". This is stricter than #353's design, which blocked only agents with a cloud model.
- **Sync.** Nothing secret syncs: the run grant is never stored, and the agent's keys and sign-in stay in the agent, on that computer. A Conversation's chosen agent is the User's preference and syncs as a model choice does (`providerId` "agent:codex"); whether the agent is set up, its consent and its version belong to the device (portability rules 11 and 12). On a computer without it, the Conversation says so and offers the default model.

## Agents

Checked on 2026-10-31 against each agent's source and its vendor's terms. #353 (2026-10-13) named Codex, Goose, OpenCode, Cline and Kilo.

**First:**

| Agent | ACP entry | Licence | Takes our MCP server | Its restrictive start | Sign-in it may use |
|---|---|---|---|---|---|
| Codex | adapter `@agentclientprotocol/codex-acp` 2.5.0, over Codex 0.166.0 | Apache-2.0 | yes, stdio and HTTP ([config](https://github.com/agentclientprotocol/codex-acp)) | `INITIAL_AGENT_MODE=read-only`, then mode `read-only`; its default, "Auto review", asks only about what it judges unsafe | an API key, or Codex's own ChatGPT sign-in: "If you've built a local or open-source application using Codex app-server authentication, you can continue using it… App-server authentication has never been permitted for commercial or hosted services" ([OpenAI](https://learn.chatgpt.com/docs/app-server)) |
| Goose | native `goose acp` 1.57.0 | Apache-2.0 | yes, stdio and HTTP | `GOOSE_MODE=approve`, then mode `approve`; its default approves every call, and `chat` offers no Tools at all, ours included | its own providers, set up with `goose configure`; IncarnaMind doesn't see which, so the setup line asks for an API key or a local model |
| OpenCode | native `opencode acp` 2.2.5 | MIT | yes, stdio and HTTP | `OPENCODE_PERMISSION` asking for every edit, command and fetch, then its `plan` agent; "Most permissions default to `allow`" ([docs](https://opencode.ai/docs/permissions/)), and `plan` alone doesn't restrict the shell | its own providers, on the User's keys |
| Gemini CLI | native `gemini --acp` 0.66.0 | Apache-2.0 | yes, stdio, HTTP and SSE | mode `plan` ("Read-only mode") | a paid API key only: "Gemini CLI will remain accessible via paid Gemini and Gemini Enterprise Agent Platform API keys" ([Google](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)); never its Google sign-in for a personal account |
| Qwen Code (second) | `qwen --acp` 0.26.4 | Apache-2.0 | yes, stdio, HTTP and SSE | mode `plan` | an API key only, which is all it offers over ACP; never Alibaba's Coding Plan |

**Later:**
- **Kilo Code** (MIT, an OpenCode fork). Its terms changed hands on 2026-09-30 ([terms](https://kilo.ai/terms)), its npm release lags its source, and after an edit is allowed it also writes through the client's `fs/write_text_file` without checking that the client offered it. Listed once a hand test shows how it behaves against a client with no `fs`.
- **Cline** (Apache-2.0). Dropped from #353's list: `cline --acp` stores the `mcpServers` it is given and never connects them (`apps/cli/src/acp/acpAgent.ts`), so it can't reach IncarnaMind's Documents or mint a Citation. Listed if that changes.
- **Claude Code.** Stays on the MCP server (#351), as ADR-0013's addendum decided. Its ACP adapter runs on the Agent SDK, and "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK" ([Anthropic](https://code.claude.com/docs/en/agent-sdk/overview)). If it is ever hosted, it is with the adapter's `--hide-claude-auth`, which refuses every turn a claude.ai plan would pay for.
- **Mistral Vibe** (Apache-2.0): Mistral's consumer terms forbid integrating its products with products offered to others without permission ([terms](https://legal.mistral.ai/terms/row-consumer-terms), clause (g)). **Kimi Code**: the registry still points at its archived CLI, and its plan is "for personal interactive use only". **GitHub Copilot CLI** and **Cursor**: proprietary, Copilot's ACP still a public preview.

**Never:** **Antigravity CLI**, whose terms make third-party access a breach ([terms](https://antigravity.google/terms)); **pi** (`pi-acp` stores the client's MCP servers without connecting them) and **OpenClaw** (its bridge rejects them).

**Never a coding plan,** whichever agent carries it: Alibaba's Coding Plan ("仅限在编程工具…中使用，禁止以 API 调用的形式用于自动化脚本、自定义应用程序后端…", [Bailian](https://help.aliyun.com/zh/model-studio/coding-plan)), Z.ai's GLM Coding Plan ("may only be used within officially supported tools and products", [Z.ai](https://docs.z.ai/devpack/usage-policy)) and Kimi's. The agent setup line says to use an API key with them.

## Considered options

- **Make the hosted agent a `RunEngine`.** Rejected (ADR-0013's addendum): the model isn't ours, and the engine contract (our Tools, our gate, our window, our temperature) can't be honoured by a loop in another process.
- **Implement `AnswerEngine` for it.** Rejected: most of an `AnswerRequest` (the prompt, the quick model, turn checks that ask again, quote retries, structured output) needs our model. Sharing the Answer's writer keeps what the User sees without pretending to implement the rest.
- **A process per Question.** Rejected: each Question would pay the agent's start (an adapter and its own server), and the agent would forget the Conversation unless every Question carried it all again.
- **One process for the whole app.** Rejected: one crash would end every Conversation, and sessions with different Search scopes would share it.
- **Spawn agents from the core with Node's `child_process`.** Rejected (portability rule 1): the core takes web streams, which a host without Node can give.
- **A localhost HTTP MCP server with a bearer token.** Rejected, as in ADR-0013's addendum: it opens a port a web page can try, and HTTP is optional for agents (`mcpCapabilities.http`).
- **MCP over the ACP connection itself** (`"type": "acp"`, [RFD](https://agentclientprotocol.com/rfds/mcp-over-acp)): no shim, no socket, no grant. Not now: a draft, gated on `mcpCapabilities.acp`, which no agent we list advertises. We move to it when it is stable and they do.
- **Hand the agent a standing pairing (#351).** Rejected: a pairing outlives the Question and has its own Folders, so it would reach more than the Question's Search scope and leave a credential behind.
- **Offer the agent `fs` and `terminal`,** to see its file and shell work. Rejected: IncarnaMind would then read and write the User's files on the agent's behalf, and agents use their own Tools anyway when they prefer (Claude's adapter does, whatever the client offers); v2 removes both.
- **Answer the agent's `allow_always`.** Rejected: it is kept in the agent's own settings, which IncarnaMind can't show or revoke, and it would outlive the turn that read the Passages.
- **Apply the agent's changes at once, as the assistant's own are.** Rejected for now (decision 3): the guards and the claim check that make that safe run in our loop.
- **Download or bundle an agent's ACP adapter.** Rejected for now: an adapter is code we would vouch for and keep current. Where an agent needs one (Codex), the User installs it with the agent, from its page.
- **Count the agent's reported cost toward the Monthly cap.** Rejected: the cap refuses a request before it is sent, and the agent's requests are its own; a figure it reports after the fact can't stop anything.
- **Let Local mode admit agents that say their model is local.** Not now: the agent's word is all we would have. A later amendment can, given a way to tell.

## Consequences

- `@agentclientprotocol/sdk` 2.0.2 is added, pinned exactly (Apache-2.0, small, maintained by the protocol's own maintainers), the dependency ADR-0013's addendum named. The core imports only its stable v1 entry.
- `src/core/adapters.ts` gains `AgentProcesses`, `AgentProcess` and `AgentProgram`; the desktop app supplies them (`src/main/agentProcesses.ts`).
- `src/core/agents/` gains run grants beside pairings, and the hosted Run. #351's access layer takes either. No migration is needed for the grant: its Citations go in `agent_citations` under the grant's id.
- The approval requests gain a kind for an agent's own Tool, with For this run, and no policy.
- A data flow, "hosted-agents", on the Privacy page and in `docs/privacy.md` and `docs/where-your-data-goes.md`.
- The agent list (ADR-0019) gains the hosted fields above. An agent moves on or off the list with a one-line change, when its terms or its ACP support change.
- CONTEXT.md gains a term for the User's agent running the assistant when this is built.
- Before release, each listed agent is tried by hand with the cheapest model that answers (`AGENTS.md`), and its terms read again.
- #352 builds the interface in decision 3 first; #353 builds on it.
