# Outside agent shim: mutual HMAC handshake before authentication

An outside agent reaches the running IncarnaMind app through a small stdio shim (`src/main/agentShim.ts`) connected to a local Unix domain socket or Windows named pipe (`src/core/agents/socket.ts`, #351). Previously, the shim sent its pairing token in plain JSON on line 1 (`{"incarnamind":1,"token":"…"}`) as soon as the connection opened. On a shared computer, another OS account that squatted the endpoint before IncarnaMind opened it (a Windows named pipe or a `/tmp` fallback socket) could receive the pairing key and impersonate IncarnaMind (#2049).

Inspecting OS-level endpoint ownership before connecting is fragile on Windows: invoking PowerShell with `Add-Type` is blocked under Constrained Language Mode, AppLocker and WDAC, triggers EDR rules, adds 1–3 seconds to every agent start, leaves a check-then-connect gap, and pulls `node:child_process` and `os.type` into `src/core` against [`docs/agents/portability.md`](../agents/portability.md).

## Decision

The shim and the app prove knowledge of the pairing token to each other with a mutual HMAC-SHA256 challenge-response (`incarnamind: 2`) using only `node:crypto` (`randomBytes`, `createHmac`, `timingSafeEqual`) before any MCP traffic flows:

1. **Shim challenge (line 1, shim → app):** `{"incarnamind":2,"nonce":"<shimNonce>"}\n`, where `<shimNonce>` is 32 random bytes encoded as base64url. No pairing key or key-derived bytes leave the shim.
2. **App proof and challenge (line 2, app → shim):** `{"incarnamind":2,"nonce":"<appNonce>","proofs":["<hex>",…]}\n`, where `<appNonce>` is 32 random bytes (base64url) and each proof is `HMAC-SHA256(token, "incarnamind:v2:server:" + shimNonce + ":" + appNonce)` for every live pairing token and active check-grant token the app currently holds.
3. **Constant-time check in the shim:** the shim computes `HMAC-SHA256(token, "incarnamind:v2:server:" + shimNonce + ":" + appNonce)` for its own token and checks each entry of `proofs` with `timingSafeEqual`. If none matches (or the reply is malformed, times out, or closes early), the shim sends nothing further, closes the socket, logs a safe diagnostic without the token to stderr, and answers MCP requests in English and Simplified Chinese explaining that the connection could not be verified (disconnected or something else answering in IncarnaMind's place) and to check Settings → AI and reconnect.
4. **Shim authentication (line 3, shim → app):** only after the app proves it holds the key does the shim send `{"incarnamind":2,"proof":"<hex>"}\n`, where `<hex>` is `HMAC-SHA256(token, "incarnamind:v2:client:" + appNonce + ":" + shimNonce)`. The distinct `"server"` and `"client"` domain tags prevent reflection. The app verifies `<hex>` in constant time against its live tokens and grants and binds the MCP session to the matching pairing. The pairing key itself never goes on the wire in version 2.

## Backward compatibility and out-of-date shims

Installed shims that carry a frozen copy of `agentShim.js` (such as Claude Desktop's `.mcpb` bundle) still send version 1 (`{"incarnamind":1,"token":"…"}`). On unchanged endpoints (Unix data-folder sockets within 100 bytes and Windows named pipes), the app continues accepting version 1 so updates never cut existing pairings off.

- **Which pairings can tell, and how:** the app sees the handshake version on every connection. Whenever a live pairing connects using version 1, the app records its id in `AgentSettings.shimsOutOfDate` (persisted in device state, no schema migration) and Settings → AI shows a line asking the User to reinstall (with a one-click reopen for bundle clients like Claude Desktop) or reconnect the agent. As soon as that pairing connects with version 2 — or is disconnected — it leaves `shimsOutOfDate`. Pairings that have not connected since the update cannot be distinguished until they connect.
- **Frozen Unix bundles on long data paths:** a frozen `.mcpb` bundle installed before #2049 for a data folder whose socket path exceeded 100 bytes has the old flat `/tmp/incarnamind-<id>.sock` address baked in. After upgrade the app binds only the private relocated socket (`$XDG_RUNTIME_DIR` or `im-<uid>`) and deliberately does not keep listening on an unprivate flat `/tmp` path; that frozen bundle sees "IncarnaMind isn't open" and reconnects by disconnecting and connecting again in Settings → AI, which installs the v2 bundle with the new private path.

## Endpoint hygiene beside the handshake

- **Windows:** no PowerShell helper, no `Add-Type`, no `-ExecutionPolicy Bypass`. Node's `net.createServer` binds the named pipe with its default security descriptor; authentication in both directions is enforced cryptographically by the v2 mutual HMAC-SHA256 handshake (an unauthenticated local account cannot complete the handshake or call MCP tools, and a squatting server without the 256-bit key receives only a random nonce and 0 bytes of the key). The shim retries transient `ERROR_PIPE_BUSY` (`EBUSY`, `EAGAIN`, `EPIPE`) with short backoff when several agents start at once.
- **Unix:** when the data-folder socket path exceeds `MAX_SOCKET_PATH_BYTES` (100 bytes), the app prefers `$XDG_RUNTIME_DIR` (user-owned `0700`, e.g. `/run/user/<uid>`) before `tmpdir()/im-<uid>` and `/tmp/im-<uid>` so another account pre-creating `/tmp/im-<uid>` cannot block agents. Fallback directories are `0700`, sockets are `0600`, ancestor checks follow user-owned and root-owned symlinks with `realpath` and walk from `/` stopping at the first user-owned `0700` directory (accepting `~/.config` at `0775` under umask `002` and user-symlinked data folders). For legacy flat fallback paths, the shim checks migrated paths (`$XDG_RUNTIME_DIR`, `<parent>/im-<uid>`, and `/tmp/im-<uid>` when `<parent>/im-<uid>` exceeds 100 bytes) before the flat path.

## Threat model and scope

- **Proven by automated tests:** on both Unix sockets and Windows named pipes, a decoy server without the pairing key (forged challenge, stale replayed proof, or early close) receives only the random nonce and 0 bytes of the pairing key. On Linux CI, a real second OS account (`nobody`) is blocked at both the OS boundary (`0700`/`0600`, `EACCES`) and the shim verification boundary (zero accepted connections on other-account sockets).
- **Windows multi-account release verification:** because Node binds named pipes with its default DACL rather than a custom OS descriptor, protection against another local Windows account relies on the v2 mutual HMAC-SHA256 handshake; two-account Windows verification is tracked as a manual release check.
- **Out of scope:** malware or another process running as the same OS user account (which can already read the agent's environment, settings files and IncarnaMind's data folder), and privileged administrator or `root` accounts.

## Consequences

- `src/shared/agentSocket.ts` defines both v1 and v2 handshake framing and HMAC helpers (pure `node:crypto` in the core/shim, keeping `src/main/agentShim.ts` a single self-contained file using only Node built-ins that starts in tens of milliseconds).
- `src/core/agents/socket.ts` drops `node:child_process` and `os.type`, keeping `src/core` portable.
- Automated tests prove the decoy property on both Unix and Windows (including a real second-account test on Ubuntu CI using `sudo`), and releases keep a manual two-account Windows named-pipe check.
