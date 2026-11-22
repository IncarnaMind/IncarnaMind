---
status: proposed (2026-11-22)
---

# Keep the Codex link for a Note Check on CLI 0.170.0

When the User presses Check with Codex connected and no model set up in IncarnaMind, open the request in Codex for the User to send. A background Check would run on the User's plan with access to the Note. Two prerequisites are outstanding on the installed CLI. Its file-backed sign-in follows its profile, and restricting one MCP server to the six Check Tools still leaves other Codex tools available. Keep the link until both prerequisites and the end-to-end Check pass. [Background Checks](0032-a-check-runs-on-the-users-own-command-line-ai.md) · [Issue and acceptance criteria](https://github.com/IncarnaMind/IncarnaMind/issues/3639)

## Sign-in and storage

On macOS, four runs of `codex login status` used an environment without API keys or access tokens. Only Codex handled the designated test sign-in. IncarnaMind would use the command's exit status after consent.

| Codex profile | Operating-system home | Credential store | Exit |
|---|---|---|---|
| Signed-in test profile | Fresh temporary home | File | 0, signed in |
| Empty private profile | Signed-in test user's home | File | 1, signed out |
| Empty private profile | Fresh temporary home | File | 1, signed out |
| Empty private profile | Fresh temporary home | Process memory | 1, signed out |

The CLI found the file-backed sign-in in the designated `CODEX_HOME` even with a fresh `HOME`. Changing only the profile made that sign-in unavailable. A named configuration profile and `--ignore-user-config` both use that same credential home. Linking the credential file into the run would expose the live credential there and couple any refresh to a temporary path. The OS credential-store case remains unverified. A future adapter needs a supported way for Codex itself to use the existing sign-in from an isolated run. [Codex authentication](https://developers.openai.com/codex/auth) · [Configuration reference](https://developers.openai.com/codex/config-reference)

Six local `codex exec` invocations used fresh private directories, a synthetic MCP server and a loopback model endpoint. Each received a single HTTP request. There were zero hosted model requests. With `--ephemeral`, each profile contained zero rollout files but still contained databases, log storage, an installation identifier and skill files. The harness removed the entire private directory after each run. A production adapter would need cleanup on success, failure, Stop and next start after a crash. Deleting files from the User's existing Codex profile would risk their own data. [Non-interactive mode](https://developers.openai.com/codex/noninteractive)

## What the CLI exposed

The test used `codex exec --json --ephemeral --ignore-user-config --ignore-rules --sandbox read-only` with approval policy `never`. The only MCP server advertised the six Check Tools plus one inert control Tool. Its configuration listed only `check_mind_yourself`, `search`, `read_passages`, `cite`, `run_analysis` and `report_check` under `enabled_tools`, with default Tool approval set to `approve`. The server received initialization and Tool discovery. The control Tool's name was absent from the model request.

| Capability | Evidence from the outgoing request |
|---|---|
| Shell, web, plugins and apps | The probe disabled shell and unified execution, web search, hooks, plugins and apps. The restricted request did not list a shell tool. Disabling goals and image viewing also removed those tools. |
| Code mode and patching | The request still listed code execution and wait, and the patch tool. The read-only sandbox is a filesystem write restriction. It does not establish a six-Tool allowlist. |
| Other built-ins | With the multi-agent features disabled, the request still listed six collaboration operations, including starting a sub-agent. User-input, clock and MCP resource operations also remained. |
| Code mode off | The server still received Tool discovery. Discovery and prompt declarations do not prove a Check Tool can be called. ADR-0032 records the earlier signed-in run in which no Check Tool was reached with the host off. |

The calls above inspected the request before any model response. An available tool is not evidence that a model invoked it. A production runner must deny an outside action **before dispatch**. For an observed outside request, say “Codex stopped because it requested an action outside this check. Open the check in Codex.” An unreadable event must also stop the run, with the neutral “Codex stopped before finishing. Open the check in Codex.” Both paths require immediate revocation of the grant and termination of the run. A watcher of completed actions alone comes too late. The per-Note grant protects IncarnaMind's server. It has no authority over Codex's own built-ins.

## Stop, errors and proof still due

In a macOS Stop probe, a fixture held the request open. Killing the Codex process group closed the CLI's streams within 5 ms. Its one observed MCP child was in a **different process group** and was gone at the subsequent process check, within two seconds. The observation does not identify what made the child exit. This proves cleanup for that cooperative child. A future implementation must own the shim's lifetime, revoke the grant, drain output and verify all descendants are gone, including on Windows and Linux. The existing Check runner signals Stop and ends the grant after the runner settles. Today `report_check` can persist marks during a partial report. To guarantee that an interrupted Codex Check leaves no marks, invalidate its grant at Stop and stage its reports until clean completion. At commit, atomically verify the grant, the pairing’s scope and the Note version before saving the marks. Test cancelling after a partial report and immediately before commit, as well as the Note’s Stop indicator.

For a supported credential configuration with a definite signed-out result, say “Sign in to Codex, then try Check again.” A signed-in profile that fails isolation should offer “Open this check in Codex.” A confirmed plan limit should say “Your Codex plan has reached its limit. Try again later.” On simulated HTTP 401 and 429 responses, this CLI emitted a final error with a message and no structured category. Show “Codex stopped before finishing. Check your sign-in and usage in Codex.” for an unclassified service error. The provider errors in these probes were simulated.

Revisit the decision when Codex can reuse the User's sign-in in isolation and enforce a complete pre-dispatch tool policy. Then reuse ADR-0032's consent, in-memory Note grant, revocation and process drain. Run the registered English and Chinese checks, the planted-Document case and Stop through the Note. The marks, unmodified Documents, absent chat, UI timing and crash cleanup remain unverified for background Codex Checks.
