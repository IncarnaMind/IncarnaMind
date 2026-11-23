---
status: accepted (2026-11-23); replaces the proposal of 2026-11-22 to keep the link
---

# A Note Check runs on Codex in the background, held by a model catalog, a preflight and a watch

When the User presses Check with Codex connected, its command line on this computer and no model set up in IncarnaMind, IncarnaMind runs the check on the User's own Codex in the background, as it does on Claude Code ([ADR-0032](0032-a-check-runs-on-the-users-own-command-line-ai.md)): nothing opens, no chat is added, the Note says it is being checked with Stop beside it, and the marks land. Where any of what follows doesn't hold, the check goes by the link, as before. [Issue and acceptance criteria](https://github.com/IncarnaMind/IncarnaMind/issues/3639)

The proposal of 2026-11-22 kept the link because two prerequisites were outstanding on Codex 0.170.0: a sign-in usable from an isolated run, and a complete policy that refuses Codex's own tools before they run. Further runs on 0.170.0 met the second and all of the first but one input: the User's global `AGENTS.md`, which the User is told of where they consent. The owner decided on 2026-11-23 to build it on that basis.

This corrects ADR-0032 decision 3, which found that Codex reaches IncarnaMind's Tools only through code mode. With the model catalog below, code mode is off and Codex calls the server's Tools directly.

## The run

`codex exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check --sandbox read-only`, the prompt on stdin, in the User's own Codex folder, so Codex reads its own sign-in and IncarnaMind touches none. With it:

- **A model catalog** (`model_catalog_json`), built at each run from the installed binary's own (`codex debug models --bundled`) with five fields of every model changed: `tool_mode = "direct"`, `apply_patch_tool_type = null`, `multi_agent_version = null`, `experimental_supported_tools = []`, `supports_search_tool = false`. The request then lists only IncarnaMind's Tools and Codex's three MCP resource operations, which reach only IncarnaMind's server. Without the catalog it lists code mode's `exec` and `wait`, with `apply_patch`, a clock and sub-agents inside.
- **Approvals `never`,** IncarnaMind's server with `enabled_tools` set to the check's six Tools and `default_tools_approval_mode = "approve"`, and the features that give the model a tool, an app or a hook turned off, among them the shell, unified exec, apps, plugins, hooks, memories, goals, sub-agents, image tools and the browsers; `features.multi_agent_v2.disable_native_tools`, `tools.experimental_request_user_input.enabled = false`, `web_search = "disabled"` and `project_doc_max_bytes = 0`.
- **Nothing of the run in the User's Codex folder:** `--ephemeral` saves no session, `history.persistence = "none"`, `sqlite_home` and `log_dir` point into the run's own folder, `shell_snapshot` is off (a snapshot exports Codex's environment, and so the grant, into the User's Codex folder), `daemon_auto_start` is off, analytics and OpenTelemetry export are off, and bundled skills aren't installed.
- **The grant** reaches IncarnaMind's server from Codex's environment, named in `env_vars`, never on the command line. IncarnaMind's instructions go in `developer_instructions`, written as TOML so no line break reaches the command line.
- **The model** is Codex's own default with nothing set: by priority, the first model its picker lists among those the sign-in may use. The User's own choice in their config is dropped with the rest of it, as Claude Code's is (ADR-0032 decision 3).

What runs on 0.170.0 showed: every call to a tool the request doesn't list (`apply_patch` in both forms, `exec_command`, `shell`, `spawn_agent`, code mode's `exec`, `view_image`, `request_user_input`, a server Tool left out of `enabled_tools`) gets "unsupported call" back from Codex before it runs, and leaves no event, no server call and no file.

## Before every run

Each of these, or the check goes by the link, with nothing said about the fallback itself:

- `codex` on the login shell's PATH, as a terminal finds it, whose real path is not inside an app (`*.app`, or a Windows app's `WindowsApps` folder): never the copy the ChatGPT app ships for itself. The documented installs (the standalone installer, npm, Homebrew) all resolve outside one.
- `codex --version` at least 0.170.0, the only version this was measured on. A later one runs only through the preflight.
- `codex login status` exiting 0. Nothing else it prints is read; a definite sign-out, a sign-in it can't read and no answer all go by the link.
- **A free preflight:** `codex debug prompt-input`, given the run's own settings in a Codex folder of the run's own, must print exactly the six Tools and the three resource operations, for each model Codex could use with none set (without a model, and pinned to a sign-in to ChatGPT's default where that is another model). It makes no model request. A feature switch this Codex doesn't know makes it fail, and so does a server that doesn't start.
- `codex exec` must start its turn. One that ends first (a setting this Codex no longer takes, which `--strict-config` refuses) sent nothing to a model.

## While it runs

The flags are the wall; IncarnaMind watches the event stream for a sign that one didn't hold. Thread and turn starts and ends, and the service's own error notices, pass. Of the items, only the agent's messages, its reasoning and calls to the six Tools on IncarnaMind's server pass. Anything else ends the run, the grant is revoked and the line says "Codex stopped because it requested an action outside this check. Open the check in Codex.", with Ask by its link as the one action. A line that can't be read, or an event Codex didn't have, ends it with "Codex stopped before finishing. Open the check in Codex." A turn that fails says "Codex stopped before finishing. Check your sign-in and usage in Codex.": Codex gives its errors no category (a plan's limit and a model the plan doesn't include both come as a message), so IncarnaMind doesn't guess which. The rest of ADR-0032's limits apply: 15 minutes, six minutes of silence while no Tool of IncarnaMind's runs, a bounded output.

## Stop and what is left

Stop, quitting, disconnecting, Local mode, a take-back and the Note leaving the agent's reach end Codex's process group (its process tree on Windows), drain its output and revoke the grant, which closes the server's connection: the server Codex started, in a process group of its own, exits with it. The run's folder (mode 0700: the working folder, the catalog, the preflight's Codex folder and the redirected databases, whose log holds Note text) is removed when the run ends, and a folder whose app is gone is removed at the next start. A report that landed before Stop stays, as on Claude Code.

Nothing of the run is kept in the User's Codex folder. Codex itself replaces its own launcher folder there (`tmp/arg0-<platform>/codex-arg0…`: a lock and two links to its own binary) at every start, the User's own included.

## What the User is told

Where they connect Codex: "With no AI model set up here, Check runs your Codex command line in the background, if it is installed. Nothing opens and no chat is added. It works only through IncarnaMind, and uses your own ChatGPT plan or API key. In these runs Codex also reads your own instructions file, AGENTS.md in your Codex folder." A connection made before asks once, in the consent dialog, with the last sentence. Connecting Codex agrees to the check only: a request typed at a Note's foot stays on the link (ADR-0034) and would ask again.

The one input that can't be held off: Codex 0.170.0 always loads `$CODEX_HOME/AGENTS.md` (or `AGENTS.override.md`) into the request, whatever the flags (`codex-home/src/instructions/mod.rs`). It adds no tool; it can only steer how the model checks.

## Measured, and not

On macOS, Codex 0.170.0 (the standalone install), a signed-in throwaway profile, the test build and the real shim: an English, a Chinese and a planted Note each landed both marks right (07:30 supported, 40 bicycles contradicted by 24), with only the six Tools called and nothing outside them asked for; Notes of eight and twenty sentences landed; Stop after the first Tool call cleared the line in 140 ms, and Codex and the server were gone within 2.5 s. Across those runs, a 77-second run, a stopped one and a failing one, the profile's file listing (names, sizes, times) changed only in Codex's launcher folder. The preflight with the catalog took 269 ms (median of 10, worst 325), and a press reached its start in 460 ms. The Windows and Linux process trees are proven with a stand-in for Codex in the packaged app's checks, not with Codex itself. Not verified: Windows and Linux with the real Codex, a managed (organisation) configuration, the operating system's credential store, a token refresh during a long run, plans without the default model, and the ChatGPT desktop app running beside a run.
