/**
 * The command an outside agent starts to reach IncarnaMind (#351): an MCP
 * server over stdio that hands everything to the running app through its
 * socket (src/core/agents/socket.ts), after a mutual HMAC-SHA256 challenge-
 * response (ADR-0036, #2049) so the app proves it holds the pairing key before
 * the shim authenticates (and the key itself never goes on the wire). The app's
 * own binary runs it as plain Node (`ELECTRON_RUN_AS_NODE`), so nothing is
 * downloaded when an agent starts it, and the app it talks to already has its
 * index loaded.
 *
 * On Unix it also verifies the socket and its parent directory chain before
 * connecting, and checks migrated per-user paths ($XDG_RUNTIME_DIR and
 * `im-<uid>`) ahead of a legacy flat fallback path. On Windows named pipes it
 * retries transient pipe-busy errors with short backoff. When the app isn't
 * open, or the endpoint cannot be verified, the shim answers every request
 * with a plain-word error rather than leaving the agent waiting, and logs a
 * safe diagnostic (never the pairing key) to stderr.
 *
 * It imports nothing at all but Node built-ins (no child_process, no helpers),
 * so its build is one self-contained file starting in tens of milliseconds:
 * Claude's install bundle carries a copy and runs it on Claude's own Node. The
 * wire format matches src/shared/agentSocket.ts; the tests run this shim
 * against the core so the two can't drift apart.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

const AGENT_TOKEN_ENV = "INCARNAMIND_AGENT_TOKEN";
const AGENT_SOCKET_ENV = "INCARNAMIND_AGENT_SOCKET";
const AGENT_CHALLENGE_VERSION = 2;
const AGENT_HANDSHAKE_MAX_BYTES = 16_384;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_SOCKET_PATH_BYTES = 100;
const PIPE_BUSY_RETRY_MS = [25, 50, 100, 200, 400] as const;

const PER_USER_DIR_RE = /^im-(\d+)$/;
const FALLBACK_SOCKET_RE = /^incarnamind-[0-9a-f]{16}\.sock$/;
const WINDOWS_PIPE_RE = /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PROOF_HEX_RE = /^[0-9a-f]{64}$/;

/** The shim doesn't know the interface language, so it says these in both. */
const NOT_OPEN =
  "IncarnaMind isn't open, or connecting agents is turned off in it. Open IncarnaMind, check Settings → AI, then reconnect this agent to it. / IncarnaMind 没有打开，或已关闭智能体连接。打开 IncarnaMind，检查“设置 → AI”，然后让这个智能体重新连接。";
const NOT_SET_UP =
  "This agent's IncarnaMind settings are incomplete. Connect it again in IncarnaMind, in Settings → AI. / 这个智能体的 IncarnaMind 设置不完整。在 IncarnaMind 的“设置 → AI”中重新连接它。";
const UNVERIFIED_ENDPOINT =
  "Couldn't verify IncarnaMind on this local connection, so no pairing key was sent. This agent may have been disconnected, or something else on this computer may be answering in its place. Check Settings → AI in IncarnaMind and reconnect this agent. / 无法验证这个本地连接是否来自 IncarnaMind，未发送配对密钥。这个智能体可能已断开连接，或电脑上的其他程序正在冒充回应。请在 IncarnaMind 的“设置 → AI”中检查并重新连接这个智能体。";

type EndpointVerdict = "ok" | "not-open" | "untrusted";

const isWindowsPipe = (path: string): boolean => path.startsWith("\\\\.\\pipe\\");

const serverProofInput = (shimNonce: string, appNonce: string): string =>
  `incarnamind:v2:server:${shimNonce}:${appNonce}`;

const clientProofInput = (appNonce: string, shimNonce: string): string =>
  `incarnamind:v2:client:${appNonce}:${shimNonce}`;

const hmacHex = (token: string, input: string): string =>
  createHmac("sha256", token).update(input).digest("hex");

function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

const challengeLine = (nonce: string): string =>
  `${JSON.stringify({ incarnamind: AGENT_CHALLENGE_VERSION, nonce })}\n`;

const clientProofLine = (proof: string): string =>
  `${JSON.stringify({ incarnamind: AGENT_CHALLENGE_VERSION, proof })}\n`;

function parseServerChallenge(line: string): { nonce: string; proofs: string[] } | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return null;
    const { incarnamind, nonce, proofs } = value as Record<string, unknown>;
    if (
      incarnamind !== AGENT_CHALLENGE_VERSION ||
      typeof nonce !== "string" ||
      !NONCE_RE.test(nonce) ||
      !Array.isArray(proofs) ||
      !proofs.every(
        (entry): entry is string => typeof entry === "string" && PROOF_HEX_RE.test(entry),
      )
    ) {
      return null;
    }
    return { nonce, proofs };
  } catch {
    return null;
  }
}

/** Logs a diagnostic to stderr without ever including the pairing token or proofs. */
function logDiagnostic(reason: string, target: string): void {
  try {
    process.stderr.write(`incarnamind-agent-shim: ${reason} (${target})\n`);
  } catch {
    // Stderr may already be closed by the host agent.
  }
}

function prefixesFromRoot(target: string): string[] {
  const absolute = resolve(target);
  const { root } = parse(absolute);
  const tail = absolute.slice(root.length).split(sep).filter(Boolean);
  const out = [root];
  let current = root;
  for (const part of tail) {
    current = join(current, part);
    out.push(current);
  }
  return out;
}

function isPrivateUserRuntimeDir(dir: string, uid: number | undefined): boolean {
  if (!isAbsolute(dir)) return false;
  try {
    const resolved = realpathSync(dir);
    const info = lstatSync(resolved);
    if (!info.isDirectory()) return false;
    if (uid !== undefined && info.uid !== uid) return false;
    if ((info.mode & 0o077) !== 0) return false;
    accessSync(resolved, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function verifyUnixDirChain(dir: string, currentUid: number | undefined): EndpointVerdict {
  if (currentUid === undefined) return "ok";
  for (const step of prefixesFromRoot(dir)) {
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(step);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-open" : "untrusted";
    }
    if (info.isSymbolicLink() && info.uid !== 0 && info.uid !== currentUid) {
      return "untrusted";
    }
  }
  let resolved: string;
  try {
    resolved = realpathSync(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-open" : "untrusted";
  }
  for (const step of prefixesFromRoot(resolved)) {
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(step);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-open" : "untrusted";
    }
    if (!info.isDirectory()) return "untrusted";
    if (info.uid !== 0 && info.uid !== currentUid) return "untrusted";
    if (info.uid === currentUid && (info.mode & 0o077) === 0) {
      return "ok";
    }
    const sticky = (info.mode & 0o1000) !== 0;
    if ((info.mode & 0o002) !== 0 && !(info.uid === 0 && sticky)) {
      return "untrusted";
    }
  }
  return "ok";
}

function verifyUnixEndpoint(socketPath: string): { verdict: EndpointVerdict; reason?: string } {
  const currentUid = process.getuid?.();
  const parentDir = dirname(socketPath);
  const parentName = basename(parentDir);
  const socketName = basename(socketPath);
  const perUserMatch = FALLBACK_SOCKET_RE.test(socketName)
    ? PER_USER_DIR_RE.exec(parentName)
    : null;
  const isPerUserDir = perUserMatch !== null;
  if (isPerUserDir && currentUid !== undefined && Number(perUserMatch[1]) !== currentUid) {
    return { verdict: "untrusted", reason: "per-user folder uid mismatch" };
  }
  if (isPerUserDir) {
    const above = verifyUnixDirChain(dirname(parentDir), currentUid);
    if (above !== "ok") return { verdict: above, reason: "parent chain failed verification" };
    let parentStat: ReturnType<typeof lstatSync>;
    try {
      parentStat = lstatSync(parentDir);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { verdict: "not-open" }
        : { verdict: "untrusted", reason: "could not inspect per-user folder" };
    }
    if (!parentStat.isDirectory()) {
      return { verdict: "untrusted", reason: "per-user path is not a directory" };
    }
    if (currentUid !== undefined) {
      if (parentStat.uid !== currentUid) {
        return { verdict: "untrusted", reason: "per-user folder owned by another account" };
      }
      if ((parentStat.mode & 0o077) !== 0) {
        return { verdict: "untrusted", reason: "per-user folder permissions too open" };
      }
    }
  } else {
    const chain = verifyUnixDirChain(parentDir, currentUid);
    if (chain !== "ok") return { verdict: chain, reason: "folder chain failed verification" };
  }
  let socketStat: ReturnType<typeof lstatSync>;
  try {
    socketStat = lstatSync(socketPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { verdict: "not-open" }
      : { verdict: "untrusted", reason: "could not inspect socket" };
  }
  if (!socketStat.isSocket()) return { verdict: "untrusted", reason: "endpoint is not a socket" };
  if (currentUid !== undefined) {
    if (socketStat.uid !== currentUid) {
      return { verdict: "untrusted", reason: "socket owned by another account" };
    }
    if ((socketStat.mode & 0o077) !== 0) {
      return { verdict: "untrusted", reason: "socket permissions too open" };
    }
  }
  return { verdict: "ok" };
}

/**
 * Resolves and verifies the target endpoint. For legacy flat fallback configs
 * (`incarnamind-<id>.sock`), checks migrated per-user locations ($XDG_RUNTIME_DIR
 * and `im-<uid>`) BEFORE the flat path so a stale or hostile flat socket cannot
 * shadow a live migrated app (ADR-0036).
 */
function resolveVerifiedEndpoint(socketPath: string): {
  verdict: EndpointVerdict;
  target: string;
  reason?: string;
} {
  if (isWindowsPipe(socketPath)) {
    return WINDOWS_PIPE_RE.test(socketPath)
      ? { verdict: "ok", target: socketPath }
      : { verdict: "untrusted", target: socketPath, reason: "invalid Windows pipe name" };
  }
  const uid = process.getuid?.();
  const name = basename(socketPath);
  const parent = dirname(socketPath);
  if (
    uid !== undefined &&
    FALLBACK_SOCKET_RE.test(name) &&
    !PER_USER_DIR_RE.test(basename(parent))
  ) {
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    if (runtimeDir) {
      const inRuntime = join(runtimeDir, name);
      if (
        Buffer.byteLength(inRuntime) <= MAX_SOCKET_PATH_BYTES &&
        isPrivateUserRuntimeDir(runtimeDir, uid)
      ) {
        const runtimeResult = verifyUnixEndpoint(inRuntime);
        if (runtimeResult.verdict !== "not-open") {
          return { ...runtimeResult, target: inRuntime };
        }
      }
    }
    const migrated = join(parent, `im-${uid}`, name);
    if (Buffer.byteLength(migrated) <= MAX_SOCKET_PATH_BYTES) {
      const migratedResult = verifyUnixEndpoint(migrated);
      if (migratedResult.verdict !== "not-open") {
        return { ...migratedResult, target: migrated };
      }
    } else if (parent !== "/tmp") {
      const shortMigrated = join("/tmp", `im-${uid}`, name);
      if (Buffer.byteLength(shortMigrated) <= MAX_SOCKET_PATH_BYTES) {
        const shortResult = verifyUnixEndpoint(shortMigrated);
        if (shortResult.verdict !== "not-open") {
          return { ...shortResult, target: shortMigrated };
        }
      }
    }
  }
  const direct = verifyUnixEndpoint(socketPath);
  return { ...direct, target: socketPath };
}

/** Answers every request on stdin with an error saying `message`, until stdin ends. */
function refuseEverything(message: string): void {
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      // Only requests are answered; notifications have no id.
      if (typeof request !== "object" || request === null || !("id" in request)) continue;
      const reply = { jsonrpc: "2.0", id: request.id, error: { code: -32000, message } };
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

function isTransientPipeBusy(error: NodeJS.ErrnoException): boolean {
  return error.code === "EBUSY" || error.code === "EAGAIN" || error.code === "EPIPE";
}

function connectAndAuthenticate(target: string, token: string, attempt = 0): void {
  const socket = createConnection(target);
  let connected = false;
  let verified = false;
  let failed = false;
  let pending: Buffer = Buffer.alloc(0);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const shimNonce = randomBytes(32).toString("base64url");

  const failHandshake = (reason: string) => {
    if (failed || verified) return;
    failed = true;
    if (timer) clearTimeout(timer);
    socket.destroy();
    logDiagnostic(reason, target);
    refuseEverything(UNVERIFIED_ENDPOINT);
  };

  const onHandshakeData = (chunk: Buffer) => {
    if (failed || verified) return;
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf(0x0a);
    if (end === -1) {
      if (pending.length > AGENT_HANDSHAKE_MAX_BYTES)
        failHandshake("challenge exceeded size limit");
      return;
    }
    if (end > AGENT_HANDSHAKE_MAX_BYTES) {
      failHandshake("challenge exceeded size limit");
      return;
    }
    if (timer) clearTimeout(timer);
    const line = pending.subarray(0, end).toString("utf8");
    const rest = pending.subarray(end + 1);
    pending = Buffer.alloc(0);
    const challenge = parseServerChallenge(line);
    if (!challenge) {
      failHandshake("invalid server challenge");
      return;
    }
    const expectedServerProof = hmacHex(token, serverProofInput(shimNonce, challenge.nonce));
    const matched = challenge.proofs.some((proof) => equalHex(proof, expectedServerProof));
    if (!matched) {
      failHandshake("server proof did not match pairing key");
      return;
    }
    verified = true;
    socket.off("data", onHandshakeData);
    const clientProof = hmacHex(token, clientProofInput(challenge.nonce, shimNonce));
    socket.write(clientProofLine(clientProof));
    if (rest.length > 0) process.stdout.write(rest);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  };

  socket.once("connect", () => {
    connected = true;
    timer = setTimeout(() => failHandshake("handshake timed out"), HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    socket.on("data", onHandshakeData);
    socket.write(challengeLine(shimNonce));
  });

  socket.on("error", (error: NodeJS.ErrnoException) => {
    if (failed || verified) return;
    if (!connected) {
      if (
        isWindowsPipe(target) &&
        isTransientPipeBusy(error) &&
        attempt < PIPE_BUSY_RETRY_MS.length
      ) {
        failed = true;
        const delay = PIPE_BUSY_RETRY_MS[attempt];
        socket.destroy();
        setTimeout(() => connectAndAuthenticate(target, token, attempt + 1), delay);
        return;
      }
      failed = true;
      if (error.code !== "ENOENT" && error.code !== "ECONNREFUSED") {
        logDiagnostic(`connect failed (${error.code ?? "unknown"})`, target);
      }
      refuseEverything(NOT_OPEN);
      return;
    }
    failHandshake(`connection error during handshake (${error.code ?? "unknown"})`);
  });

  socket.on("end", () => {
    if (connected && !verified) failHandshake("endpoint closed before proving identity");
  });

  // The app closed the connection: it quit, or the agent was disconnected.
  socket.on("close", () => {
    if (timer) clearTimeout(timer);
    if (verified) {
      process.exit(0);
    } else if (connected && !failed) {
      failHandshake("endpoint closed during handshake");
    }
  });
}

const token = process.env[AGENT_TOKEN_ENV];
const socketPath = process.env[AGENT_SOCKET_ENV];

if (!token || !socketPath) {
  refuseEverything(NOT_SET_UP);
} else {
  const { verdict, target, reason } = resolveVerifiedEndpoint(socketPath);
  if (verdict === "not-open") {
    refuseEverything(NOT_OPEN);
  } else if (verdict === "untrusted") {
    logDiagnostic(reason ?? "untrusted endpoint", target);
    refuseEverything(UNVERIFIED_ENDPOINT);
  } else {
    connectAndAuthenticate(target, token);
  }
}
