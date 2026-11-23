# Outside agent shim: mutual HMAC handshake before authentication

An outside agent reaches the running IncarnaMind app through a small stdio shim (`src/main/agentShim.ts`) connected to a local Unix domain socket or Windows named pipe (`src/core/agents/socket.ts`, #351). Previously, the shim sent its pairing token in plain JSON on line 1 (`{"incarnamind":1,"token":"…"}`) as soon as the connection opened. On a shared computer, another OS account that squatted the endpoint before IncarnaMind opened it (a Windows named pipe or a `/tmp` fallback socket) could receive the pairing key and impersonate IncarnaMind (#2049).

Inspecting OS-level endpoint ownership before connecting is fragile on Windows: invoking PowerShell with `Add-Type` is blocked under Constrained Language Mode, AppLocker and WDAC, triggers EDR rules, adds 1–3 seconds to every agent start, leaves a check-then-connect gap, and pulls `node:child_process` and `os.type` into `src/core` against [`docs/agents/portability.md`](../agents/portability.md).

## Decision

The shim and the app prove knowledge of the pairing token to each other with a mutual HMAC-SHA256 challenge-response (`incarnamind: 2`) using only `node:crypto` (`createHash`, `randomBytes`, `createHmac`, `timingSafeEqual`) before any MCP traffic flows:

1. **Shim challenge (line 1, shim → app):** `{"incarnamind":2,"nonce":"<shimNonce>","keyId":"<16-hex>"}\n`, where `<shimNonce>` is 32 random bytes (base64url) and `<keyId>` is the first 16 hex characters of `SHA-256("incarnamind:v2:key-id:" + token)`. No pairing key or proof leaves the shim. Naming `keyId` lets the app sign only for that pairing (removing any cap on the number of pairings and shrinking what the app signs for a stranger).
2. **App proof and challenge (line 2, app → shim):**
   - If `keyId` matches no live pairing or active check/conversation grant, the app replies `{"incarnamind":2,"unknown":true}\n` and closes the socket. The shim closes immediately (sending 0 key or proof bytes) and answers MCP requests with the plain-word "no longer connected" message instead of warning a User who disconnected on purpose of an impostor; a squatter sending `unknown: true` can only cause a refusal.
   - Otherwise, the app replies `{"incarnamind":2,"nonce":"<appNonce>","proofs":["<hex>",…]}\n`, where `<appNonce>` is 32 random bytes (base64url) and each proof is `HMAC-SHA256(token, "incarnamind:v2:server:" + shimNonce + ":" + appNonce)` for the matching key(s).
3. **Constant-time check in the shim:** the shim computes `HMAC-SHA256(token, "incarnamind:v2:server:" + shimNonce + ":" + appNonce)` for its own token and checks `proofs` with `timingSafeEqual`. If none matches (or the reply is malformed, oversized, times out at 5 s, or closes early), the shim sends nothing further, closes the socket, logs a safe diagnostic without the token to stderr, and answers MCP requests in English and Simplified Chinese explaining that IncarnaMind could not be verified, no pairing key was sent, and to check Settings → AI and reconnect.
4. **Shim authentication (line 3, shim → app):** only after the app proves it holds the key does the shim send `{"incarnamind":2,"proof":"<hex>"}\n`, where `<hex>` is `HMAC-SHA256(token, "incarnamind:v2:client:" + appNonce + ":" + shimNonce)`. The distinct `"server"` and `"client"` domain tags (and reversed nonce order) prevent reflection, and the fresh 32-byte `appNonce` prevents replay. The app verifies `<hex>` in constant time (timing out at 10 s and bounding lines at 16 KB) and binds the MCP session to the matching pairing. The pairing key itself never goes on the wire in version 2.

## Backward compatibility, key rotation, and v1 sunset

Installed shims that carry a frozen copy of `agentShim.js` (such as Claude Desktop's `.mcpb` bundle) still send version 1 (`{"incarnamind":1,"token":"…"}`). On unchanged endpoints (Unix data-folder sockets within 100 bytes and Windows named pipes), the app continues accepting version 1 so updates never cut existing pairings off.

- **Which pairings can tell, and how:** the app sees the handshake version on every connection. Whenever a live pairing connects using version 1, the app records its id in `AgentSettings.shimsOutOfDate` (persisted in device state, no schema migration) and Settings → AI shows a line asking the User to reinstall (with a one-click reopen for bundle clients like Claude Desktop) or reconnect the agent.
- **Key rotation on reinstall:** reinstalling an out-of-date pairing (`openAgentInstallAgain`) rotates the pairing key (`rotateKey`) — issuing a brand-new 256-bit key in the new `.mcpb` bundle, revoking the old key immediately for both v1 and v2, and closing existing connections on it. A key that an older shim may already have leaked to a squatter cannot survive the upgrade. The out-of-date marker clears only once a v2 shim proves itself with the new key (or the pairing is disconnected).
- **Frozen Unix bundles on long data paths:** a frozen `.mcpb` bundle installed before #2049 for a data folder whose socket path exceeded 100 bytes has the old flat `/tmp/incarnamind-<id>.sock` address baked in. After upgrade the app binds only the private relocated socket (`$XDG_RUNTIME_DIR` or `im-<uid>`) and deliberately does not keep listening on an unprivate flat `/tmp` path; that frozen bundle sees "IncarnaMind isn't open" and reconnects via Disconnect + Connect in Settings → AI.
- **Proposed v1 sunset:** stop accepting version 1 in `0.2.0` (or after two minor releases / 90 days following the first release that ships v2 and the `shimsOutOfDate` prompt), so frozen pre-#2049 bundles have a clear migration window before plaintext line-1 tokens are retired.

## Endpoint hygiene beside the handshake

- **Windows:** no PowerShell helper, no `Add-Type`, no `-ExecutionPolicy Bypass`. Because nothing after the handshake is authenticated or encrypted on the stream, a relaying squatter on Windows is prevented by the OS named-pipe semantics that this design rests on:
  - **(a)** the app creates the pipe as the first instance, so a second account cannot create another pipe of the same name beside the app's;
  - **(b)** the default Windows pipe security descriptor grants other standard accounts no write access and no permission to create a new instance.
  - Both **(a)** and **(b)** are inferred from reading Node/libuv and Windows defaults and have not yet been verified by a two-account Windows run (see the manual Windows release check below).
  - The shim retries transient `ERROR_PIPE_BUSY` (`EBUSY`, `EAGAIN`, `EPIPE`) with short bounded backoff (`25, 50, 100, 200, 400 ms`) when several agents start at once.
- **Unix:** when the data-folder socket path exceeds `MAX_SOCKET_PATH_BYTES` (100 bytes), the host (`src/main/platform.ts`) passes `process.env.XDG_RUNTIME_DIR` into the core via `adapters.agents.runtimeDir` (no `process.env` reads inside `src/core`). The app prefers a verified user-owned `0700` `runtimeDir` before `tmpdir()/im-<uid>` and `/tmp/im-<uid>` so another account pre-creating `/tmp/im-<uid>` cannot block agents. Fallback directories are `0700`, sockets are `0600`, ancestor checks follow user-owned and root-owned symlinks with `realpath` and walk from `/` stopping at the first user-owned `0700` directory (accepting `~/.config` at `0775` under umask `002` and user-symlinked data folders). For legacy flat fallback paths, the shim checks migrated paths (`$XDG_RUNTIME_DIR`, `<parent>/im-<uid>`, and `/tmp/im-<uid>` when `<parent>/im-<uid>` exceeds 100 bytes) before the flat path.

## Threat model, verification, and known limits

- **Proven by automated tests (Unix only — CI runs on Linux):** on Unix domain sockets, a decoy server without the pairing key (forged challenge, stale replayed proof, unknown-pairing reply, silent 5 s timeout, oversized reply, or early close) receives only line 1 (`nonce` + `keyId`) and 0 bytes of the pairing key. The app requires `keyId` in v2 line 1, refuses forged, reflected, replayed, oversized, and timed-out line 3 proofs, and rejects in-flight v1 and v2 handshakes whose key was rotated mid-handshake. Reinstalling an out-of-date bundle rotates the key and rejects the old key under both v1 and v2. On Linux CI, a real second OS account (`nobody`) is blocked at both the OS boundary (`0700`/`0600`, `EACCES`) and the shim verification boundary (zero accepted connections on other-account sockets).
- **Windows:** automated CI does not execute Windows named-pipe branches; Windows protection rests on the two inferred OS facts `(a)` and `(b)` above and the manual two-account Windows release check below.
- **Manual two-account Windows release check (standard accounts A and B):**
  1. While IncarnaMind runs as Account A, verify Account B cannot open A's named pipe for writing nor create a pipe of the same name.
  2. With IncarnaMind closed, have Account B create and listen on A's pipe name first; start IncarnaMind as A and verify it reports the endpoint unavailable/occupied and does not listen.
  3. While B holds the pipe, launch A's new v2 shim and verify it refuses cleanly and B receives 0 key bytes.
  4. Stop B's pipe, start IncarnaMind as A, connect A's old v1 bundle, and verify it is marked out of date in Settings → AI and reinstalling issues a new key that revokes the old one.
- **Known limits:**
  - Claude Code and Codex run IncarnaMind's own bundled shim (`out/main/agentShim.js`), so on upgrade they move straight to the v2 handshake and are never marked out of date; any pairing key they previously sent in clear under v1 is not automatically rotated (Users who want a fresh key can Disconnect and Connect again).
  - An old v1 shim that only ever reaches a squatter, or points at an old flat fallback address under the temp folder, is never marked out of date because the mark is recorded only when it reaches the real app.
  - A Linux agent started without the app's `$XDG_RUNTIME_DIR` in its environment (for example over SSH or from a system service) when using a legacy flat path sees "isn't open" until it is reconnected.
  - Neither macOS nor Windows has yet been executed end-to-end with two real OS accounts (Ubuntu Linux CI runs the real `nobody` second-account suite).
- **Out of scope:** malware or another process running as the same OS user account (which can already read the agent's environment, settings files and IncarnaMind's data folder), and privileged administrator or `root` accounts.

## Consequences

- `src/shared/agentSocket.ts` defines both v1 and v2 handshake framing and domain-separated input helpers (pure data, zero Node imports).
- `src/main/agentShim.ts` remains a single self-contained file importing only `node:crypto`, `node:fs`, `node:net`, and `node:path` (starting in tens of milliseconds).
- `src/core/agents/socket.ts` drops `node:child_process`, `os.type`, and `process.env` reads, keeping `src/core` portable per [`docs/agents/portability.md`](../agents/portability.md).
