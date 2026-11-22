/**
 * Where outside agents' shims reach the running app (#351): a Unix domain
 * socket in the data folder (a named pipe on Windows), as the MCP security
 * guide advises for a local server, rather than an HTTP port a web page could
 * try. Both platforms enforce same-account ownership (#2049): on Unix, fallback
 * sockets live inside a 0700 per-user directory and sockets are 0600 with
 * pre-bind and post-bind lstat ownership checks; on Windows, libuv claims the
 * pipe with FILE_FLAG_FIRST_PIPE_INSTANCE and an owner-only protected DACL is
 * applied before any connection is served. The core runs in the main process,
 * so this listener does too; it needs only Node.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { type as osType, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { AGENT_TOKEN_ENV } from "../../shared/agentSocket";

const execFileAsync = promisify(execFile);

/** The longest socket path every platform takes: macOS's limit is 104 bytes, Linux's 108. */
export const MAX_SOCKET_PATH_BYTES = 100;

const PER_USER_DIR_RE = /^im-(\d+)$/;
const FALLBACK_SOCKET_RE = /^incarnamind-[0-9a-f]{16}\.sock$/;
const WINDOWS_PIPE_RE = /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/;
const SID_RE = /^S-1-\d+(?:-\d+)+$/i;
const DACL_SDDL_RE = /^D:([A-Z]*)((?:\([^)]*\))*)$/;
const WINDOWS_PIPE_HELPER_TIMEOUT_MS = 10_000;

export const isWindowsPipe = (path: string): boolean => path.startsWith("\\\\.\\pipe\\");

/** Whether `path` can be opened as a local socket (a valid Windows pipe, or a Unix path within the OS limit). */
export const isSocketPathUsable = (path: string): boolean =>
  isWindowsPipe(path)
    ? WINDOWS_PIPE_RE.test(path)
    : Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES;

export type AgentEndpointProblem = "too-long" | "occupied" | "untrusted" | "unavailable";

export class AgentEndpointError extends Error {
  readonly reason: AgentEndpointProblem;
  readonly code: string;

  constructor(reason: AgentEndpointProblem, message: string, code = "EACCES") {
    super(message);
    this.name = "AgentEndpointError";
    this.reason = reason;
    this.code = code;
  }
}

const isWritableFolder = (dir: string): boolean => {
  try {
    accessSync(dir, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export interface SocketPathOptions {
  tempDir?: string;
  shortDir?: string;
  canUseDir?: (dir: string) => boolean;
  uid?: number;
}

/**
 * The socket for a data folder: in it, or, when that path is too long for a
 * socket, inside an owner-only per-user directory (`im-<uid>`) in the temporary
 * folder; when the temporary folder is too long as well (e.g. a redirected
 * TMPDIR), in `/tmp/im-<uid>` if that fits and is writable (#3598, #2049).
 */
export function agentSocketPath(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  options?: SocketPathOptions,
): string {
  const id = createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 16);
  if (platform === "win32") return `\\\\.\\pipe\\incarnamind-agents-${id}`;
  const inDataFolder = join(dataDir, "agents.sock");
  if (Buffer.byteLength(inDataFolder) <= MAX_SOCKET_PATH_BYTES) return inDataFolder;
  const uid = options?.uid ?? process.getuid?.();
  const fallbackLeaf =
    uid !== undefined ? join(`im-${uid}`, `incarnamind-${id}.sock`) : `incarnamind-${id}.sock`;
  const inTemp = join(options?.tempDir ?? tmpdir(), fallbackLeaf);
  if (Buffer.byteLength(inTemp) <= MAX_SOCKET_PATH_BYTES) return inTemp;
  const shortDir = options?.shortDir ?? "/tmp";
  const inShort = join(shortDir, fallbackLeaf);
  const canUse = options?.canUseDir ?? isWritableFolder;
  if (Buffer.byteLength(inShort) <= MAX_SOCKET_PATH_BYTES && canUse(shortDir)) return inShort;
  return inTemp;
}

/**
 * Whether a Windows DACL SDDL string is protected (`P`) and grants Allow ACEs
 * exclusively to `ownerSid` (no Everyone, Users, Authenticated Users or other accounts).
 */
export function isOwnerOnlyWindowsDacl(daclSddl: string, ownerSid: string): boolean {
  if (!SID_RE.test(ownerSid)) return false;
  const match = DACL_SDDL_RE.exec(daclSddl.trim());
  if (!match) return false;
  const flags = match[1] ?? "";
  const acesRaw = match[2] ?? "";
  if (!flags.includes("P")) return false;
  const aces = acesRaw.match(/\([^)]*\)/g);
  if (!aces || aces.length === 0) return false;
  let allowCount = 0;
  const expected = ownerSid.toUpperCase();
  for (const ace of aces) {
    const parts = ace.slice(1, -1).split(";");
    if (parts.length !== 6) return false;
    const type = (parts[0] ?? "").toUpperCase();
    const trustee = (parts[5] ?? "").toUpperCase();
    if (type === "A") {
      if (trustee !== expected) return false;
      allowCount += 1;
    }
  }
  return allowCount > 0;
}

export interface WindowsPipeProbe {
  status: "ok" | "not-open" | "untrusted";
  code?: number;
  currentSid?: string;
  ownerSid?: string;
  dacl?: string;
}

export function evaluateWindowsPipeProbe(probe: WindowsPipeProbe): "ok" | "not-open" | "untrusted" {
  if (probe.status === "not-open") return "not-open";
  if (probe.status !== "ok") return "untrusted";
  if (!probe.currentSid || !probe.ownerSid || !probe.dacl) return "untrusted";
  if (probe.ownerSid.toUpperCase() !== probe.currentSid.toUpperCase()) return "untrusted";
  return isOwnerOnlyWindowsDacl(probe.dacl, probe.currentSid) ? "ok" : "untrusted";
}

const WINDOWS_PINVOKE_CSHARP = `
using System;
using System.Runtime.InteropServices;

public static class IncarnaMindPipeAcl {
  public const int SE_FILE_OBJECT = 1;
  public const uint OWNER_SECURITY_INFORMATION = 0x00000001;
  public const uint DACL_SECURITY_INFORMATION = 0x00000004;
  public const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
  public const uint SDDL_REVISION_1 = 1;

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
    string sddl,
    uint revision,
    out IntPtr securityDescriptor,
    out uint size
  );

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool GetSecurityDescriptorDacl(
    IntPtr securityDescriptor,
    out bool daclPresent,
    out IntPtr dacl,
    out bool daclDefaulted
  );

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  public static extern uint SetNamedSecurityInfoW(
    string objectName,
    int objectType,
    uint securityInfo,
    IntPtr owner,
    IntPtr group,
    IntPtr dacl,
    IntPtr sacl
  );

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  public static extern uint GetNamedSecurityInfoW(
    string objectName,
    int objectType,
    uint securityInfo,
    out IntPtr owner,
    out IntPtr group,
    out IntPtr dacl,
    out IntPtr sacl,
    out IntPtr securityDescriptor
  );

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr stringSid);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
    IntPtr securityDescriptor,
    uint revision,
    uint securityInfo,
    out IntPtr stringSd,
    out uint stringSdLen
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr LocalFree(IntPtr mem);

  public static uint LockOwnerOnly(string pipePath, string ownerSid) {
    string sddl = string.Format("D:P(A;;GA;;;{0})", ownerSid);
    IntPtr sd = IntPtr.Zero;
    uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, out sd, out size)) {
      return (uint)Marshal.GetLastWin32Error();
    }
    try {
      bool present;
      IntPtr dacl;
      bool defaulted;
      if (!GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted) || !present) {
        return 1338;
      }
      return SetNamedSecurityInfoW(
        pipePath,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        IntPtr.Zero,
        IntPtr.Zero,
        dacl,
        IntPtr.Zero
      );
    } finally {
      if (sd != IntPtr.Zero) LocalFree(sd);
    }
  }

  public static string[] Probe(string pipePath) {
    IntPtr owner = IntPtr.Zero;
    IntPtr group = IntPtr.Zero;
    IntPtr dacl = IntPtr.Zero;
    IntPtr sacl = IntPtr.Zero;
    IntPtr sd = IntPtr.Zero;
    uint rc = GetNamedSecurityInfoW(
      pipePath,
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      out owner,
      out group,
      out dacl,
      out sacl,
      out sd
    );
    if (rc != 0) {
      return new string[] { rc.ToString(), "", "" };
    }
    IntPtr ownerStrPtr = IntPtr.Zero;
    IntPtr daclStrPtr = IntPtr.Zero;
    try {
      string ownerStr = "";
      if (owner != IntPtr.Zero && ConvertSidToStringSidW(owner, out ownerStrPtr)) {
        ownerStr = Marshal.PtrToStringUni(ownerStrPtr) ?? "";
      }
      string daclStr = "";
      uint daclLen;
      if (ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, out daclStrPtr, out daclLen)) {
        daclStr = Marshal.PtrToStringUni(daclStrPtr) ?? "";
      }
      return new string[] { "0", ownerStr, daclStr };
    } finally {
      if (ownerStrPtr != IntPtr.Zero) LocalFree(ownerStrPtr);
      if (daclStrPtr != IntPtr.Zero) LocalFree(daclStrPtr);
      if (sd != IntPtr.Zero) LocalFree(sd);
    }
  }
}
`;

export function buildWindowsPipeLockScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$pipe = $env:INCARNAMIND_PIPE_PATH",
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    `Add-Type -TypeDefinition @'\n${WINDOWS_PINVOKE_CSHARP}\n'@`,
    "$rc = [IncarnaMindPipeAcl]::LockOwnerOnly($pipe, $sid)",
    "if ($rc -ne 0) { @{ status = 'untrusted'; code = [int]$rc; currentSid = $sid } | ConvertTo-Json -Compress; exit 0 }",
    "$p = [IncarnaMindPipeAcl]::Probe($pipe)",
    "$prc = [int]$p[0]",
    "if ($prc -ne 0) { @{ status = 'untrusted'; code = $prc; currentSid = $sid } | ConvertTo-Json -Compress; exit 0 }",
    "@{ status = 'ok'; code = 0; currentSid = $sid; ownerSid = $p[1]; dacl = $p[2] } | ConvertTo-Json -Compress",
  ].join("\n");
}

export function buildWindowsPipeVerifyScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$pipe = $env:INCARNAMIND_PIPE_PATH",
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    `Add-Type -TypeDefinition @'\n${WINDOWS_PINVOKE_CSHARP}\n'@`,
    "$p = [IncarnaMindPipeAcl]::Probe($pipe)",
    "$rc = [int]$p[0]",
    "if ($rc -eq 2) { @{ status = 'not-open'; code = 2 } | ConvertTo-Json -Compress; exit 0 }",
    "if ($rc -ne 0) { @{ status = 'untrusted'; code = $rc } | ConvertTo-Json -Compress; exit 0 }",
    "@{ status = 'ok'; code = 0; currentSid = $sid; ownerSid = $p[1]; dacl = $p[2] } | ConvertTo-Json -Compress",
  ].join("\n");
}

/** Subprocess environment for Windows pipe ACL helpers: carries the pipe path, never any pairing token. */
export function sanitizedWindowsPipeEnv(
  pipePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, INCARNAMIND_PIPE_PATH: pipePath };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === AGENT_TOKEN_ENV) delete env[key];
  }
  return env;
}

function powerShellExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.SystemRoot
    ? join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

async function runWindowsPipeScript(pipePath: string, script: string): Promise<WindowsPipeProbe> {
  if (!WINDOWS_PIPE_RE.test(pipePath)) return { status: "untrusted" };
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync(
    powerShellExecutable(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    {
      env: sanitizedWindowsPipeEnv(pipePath),
      timeout: WINDOWS_PIPE_HELPER_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const parsed: unknown = JSON.parse(stdout.trim());
  if (typeof parsed !== "object" || parsed === null) return { status: "untrusted" };
  const record = parsed as Record<string, unknown>;
  const status =
    record.status === "ok" || record.status === "not-open" ? record.status : "untrusted";
  return {
    status,
    ...(typeof record.code === "number" && { code: record.code }),
    ...(typeof record.currentSid === "string" && { currentSid: record.currentSid }),
    ...(typeof record.ownerSid === "string" && { ownerSid: record.ownerSid }),
    ...(typeof record.dacl === "string" && { dacl: record.dacl }),
  };
}

export interface WindowsPipeSecurityOps {
  lock(pipePath: string): Promise<WindowsPipeProbe>;
  verify(pipePath: string): Promise<WindowsPipeProbe>;
}

const defaultWindowsPipeOps: WindowsPipeSecurityOps = {
  lock: (pipePath) => runWindowsPipeScript(pipePath, buildWindowsPipeLockScript()),
  verify: (pipePath) => runWindowsPipeScript(pipePath, buildWindowsPipeVerifyScript()),
};

export interface UnixEndpointOps {
  uid?: number;
  gid?: number;
  lstat?: (
    path: string,
  ) => Promise<Pick<Stats, "isDirectory" | "isSocket" | "isSymbolicLink" | "uid" | "gid" | "mode">>;
  stat?: (path: string) => Promise<Pick<Stats, "isDirectory" | "uid" | "mode">>;
  mkdir?: (path: string, mode: number) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
}

export interface ListenForAgentsOptions {
  unix?: UnixEndpointOps;
  windows?: WindowsPipeSecurityOps;
  /** Test hook to supply a custom net server when exercising Windows pipe flows off Windows. */
  createServer?: (onSocket: (socket: Socket) => void) => Server;
}

export interface AgentListener {
  readonly path: string;
  close(): Promise<void>;
}

/** Whether something is listening on the socket now. */
function answers(path: string): Promise<boolean> {
  return new Promise((done) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      done(true);
    });
    probe.once("error", () => done(false));
  });
}

function listenOn(server: Server, path: string): Promise<void> {
  return new Promise((done, fail) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      fail(error);
    };
    const onListening = () => {
      server.off("error", onError);
      done();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function closeServer(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  return new Promise((done) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => done());
  });
}

/**
 * Walks ancestors above `dir` up to `/` to verify no intermediate directory can
 * be modified by another OS account (unless protected by root + sticky bit, as
 * `/tmp` is). Returns whether an ancestor is already strictly private (0700) to
 * the current user.
 */
async function verifyUnixAncestors(
  dir: string,
  ops: Required<Pick<UnixEndpointOps, "lstat" | "stat">> & { uid: number | undefined },
): Promise<{ underPrivateOwnerDir: boolean }> {
  if (ops.uid === undefined) return { underPrivateOwnerDir: false };
  let underPrivateOwnerDir = false;
  let current = dirname(resolve(dir));
  for (;;) {
    let info: Pick<Stats, "isDirectory" | "isSocket" | "isSymbolicLink" | "uid" | "gid" | "mode">;
    try {
      info = await ops.lstat(current);
    } catch {
      throw new AgentEndpointError("untrusted", "Agent socket ancestor directory is unreadable.");
    }
    let dirStat: Pick<Stats, "isDirectory" | "uid" | "mode"> = info;
    if (!info.isDirectory()) {
      if (info.isSymbolicLink() && info.uid === 0) {
        dirStat = await ops.stat(current);
        if (!dirStat.isDirectory() || dirStat.uid !== 0) {
          throw new AgentEndpointError("untrusted", "Agent socket ancestor symlink is untrusted.");
        }
      } else {
        throw new AgentEndpointError(
          "untrusted",
          "Agent socket ancestor is not a trusted directory.",
        );
      }
    }
    if (dirStat.uid !== 0 && dirStat.uid !== ops.uid) {
      throw new AgentEndpointError(
        "untrusted",
        "An ancestor of the agent socket directory is owned by another account.",
      );
    }
    const sticky = (dirStat.mode & 0o1000) !== 0;
    if ((dirStat.mode & 0o022) !== 0 && !(dirStat.uid === 0 && sticky)) {
      throw new AgentEndpointError(
        "untrusted",
        "An ancestor of the agent socket directory is writable by other accounts.",
      );
    }
    if (dirStat.uid === ops.uid && (dirStat.mode & 0o077) === 0) {
      underPrivateOwnerDir = true;
    }
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  return { underPrivateOwnerDir };
}

async function prepareAndVerifyUnixParent(
  socketPath: string,
  ops: Required<Pick<UnixEndpointOps, "lstat" | "stat" | "mkdir" | "chmod">> & {
    uid: number | undefined;
    gid: number | undefined;
  },
): Promise<void> {
  const parentDir = dirname(socketPath);
  const parentName = basename(parentDir);
  const socketName = basename(socketPath);
  const perUserMatch = FALLBACK_SOCKET_RE.test(socketName)
    ? PER_USER_DIR_RE.exec(parentName)
    : null;
  const isPerUserDir = perUserMatch !== null;
  if (isPerUserDir && ops.uid !== undefined && Number(perUserMatch[1]) !== ops.uid) {
    throw new AgentEndpointError(
      "untrusted",
      "Agent socket directory belongs to a different account.",
    );
  }
  const { underPrivateOwnerDir } = await verifyUnixAncestors(parentDir, ops);
  if (isPerUserDir) {
    try {
      await ops.mkdir(parentDir, 0o700);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
  }
  const parentStat = await ops.lstat(parentDir);
  if (!parentStat.isDirectory()) {
    // macOS links `/tmp` -> `private/tmp` (root-owned symlink to a root-owned sticky directory).
    if (!isPerUserDir && parentStat.isSymbolicLink() && parentStat.uid === 0) {
      const target = await ops.stat(parentDir);
      if (target.isDirectory() && target.uid === 0 && (target.mode & 0o1000) !== 0) return;
    }
    throw new AgentEndpointError("untrusted", "Agent socket parent is not a trusted directory.");
  }
  if (ops.uid === undefined) return;
  if (parentStat.uid !== ops.uid) {
    if (!isPerUserDir && parentStat.uid === 0 && (parentStat.mode & 0o1000) !== 0) return;
    throw new AgentEndpointError(
      "untrusted",
      "Agent socket parent directory is owned by another account.",
    );
  }
  if (isPerUserDir) {
    if ((parentStat.mode & 0o077) !== 0) {
      await ops.chmod(parentDir, 0o700);
      const checked = await ops.lstat(parentDir);
      if (!checked.isDirectory() || checked.uid !== ops.uid || (checked.mode & 0o077) !== 0) {
        throw new AgentEndpointError(
          "untrusted",
          "Agent socket fallback directory is not private to this account.",
        );
      }
    }
    return;
  }
  if ((parentStat.mode & 0o002) !== 0) {
    throw new AgentEndpointError("untrusted", "Agent socket parent directory is world-writable.");
  }
  if ((parentStat.mode & 0o020) !== 0 && !underPrivateOwnerDir) {
    throw new AgentEndpointError(
      "untrusted",
      "Agent socket parent directory is group-writable outside a private owner directory.",
    );
  }
}

async function verifyExistingUnixSocketOwner(
  socketPath: string,
  lstatFn: NonNullable<UnixEndpointOps["lstat"]>,
  uid: number | undefined,
): Promise<boolean> {
  let existing: Pick<Stats, "isDirectory" | "isSocket" | "isSymbolicLink" | "uid" | "gid" | "mode">;
  try {
    existing = await lstatFn(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!existing.isSocket() || (uid !== undefined && existing.uid !== uid)) {
    throw new AgentEndpointError(
      "untrusted",
      "Agent socket path is occupied by an untrusted file or another account.",
    );
  }
  return true;
}

/**
 * Listens on `path`, handing each connection to `onConnection`. Enforces account
 * ownership on both Unix sockets and Windows named pipes (#2049). A stale
 * same-account Unix socket left by an app that quit without closing it is
 * replaced; an endpoint occupied by another copy or another account is left
 * alone and this rejects.
 */
export async function listenForAgents(
  path: string,
  onConnection: (socket: Socket) => void,
  options?: ListenForAgentsOptions,
): Promise<AgentListener> {
  const windows = isWindowsPipe(path);
  // Tests on Unix sometimes override `process.platform = "win32"` to verify Windows settings quoting;
  // only invoke Win32 named-pipe DACL hardening on actual Windows or when a test injects `options.windows`.
  const windowsDacl = windows && (options?.windows !== undefined || osType() === "Windows_NT");
  if (!isSocketPathUsable(path)) {
    throw new AgentEndpointError(
      windows ? "untrusted" : "too-long",
      windows
        ? "Agent pipe name is invalid."
        : `Agent socket path exceeds ${MAX_SOCKET_PATH_BYTES} bytes.`,
      windows ? "EINVAL" : "ENAMETOOLONG",
    );
  }

  const unixOps = {
    uid: options?.unix?.uid ?? process.getuid?.(),
    gid: options?.unix?.gid ?? process.getgid?.(),
    lstat: options?.unix?.lstat ?? ((target: string) => lstat(target)),
    stat: options?.unix?.stat ?? ((target: string) => stat(target)),
    mkdir:
      options?.unix?.mkdir ??
      (async (target: string, mode: number) => {
        await mkdir(target, { mode });
      }),
    chmod: options?.unix?.chmod ?? ((target: string, mode: number) => chmod(target, mode)),
  };
  const winOps = options?.windows ?? defaultWindowsPipeOps;

  if (!windows) {
    await prepareAndVerifyUnixParent(path, unixOps);
    await verifyExistingUnixSocketOwner(path, unixOps.lstat, unixOps.uid);
  }

  let ready = false;
  const sockets = new Set<Socket>();
  const makeServer = options?.createServer ?? createServer;
  const server = makeServer((socket) => {
    if (!ready) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });

  if (windows) {
    try {
      await listenOn(server, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (windowsDacl && (code === "EADDRINUSE" || code === "EACCES")) {
        let verdict: "ok" | "not-open" | "untrusted" = "untrusted";
        try {
          verdict = evaluateWindowsPipeProbe(await winOps.verify(path));
        } catch {
          verdict = "untrusted";
        }
        throw new AgentEndpointError(
          verdict === "ok" ? "occupied" : "untrusted",
          verdict === "ok"
            ? "Agent named pipe is already in use by another instance."
            : "Agent named pipe is occupied by another account or is not private.",
          code,
        );
      }
      throw error;
    }
    if (windowsDacl) {
      try {
        const probe = await winOps.lock(path);
        if (evaluateWindowsPipeProbe(probe) !== "ok") {
          throw new AgentEndpointError(
            "untrusted",
            "Couldn't restrict the Windows named pipe to the current account.",
          );
        }
      } catch (error) {
        await closeServer(server, sockets);
        if (error instanceof AgentEndpointError) throw error;
        throw new AgentEndpointError(
          "unavailable",
          "Couldn't apply owner-only access to the Windows named pipe.",
        );
      }
    }
    ready = true;
    return {
      path,
      close: () => closeServer(server, sockets),
    };
  }

  try {
    await listenOn(server, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") throw error;
    await verifyExistingUnixSocketOwner(path, unixOps.lstat, unixOps.uid);
    if (await answers(path)) {
      throw new AgentEndpointError(
        "occupied",
        "Agent socket is already in use by another instance.",
        "EADDRINUSE",
      );
    }
    await verifyExistingUnixSocketOwner(path, unixOps.lstat, unixOps.uid);
    await unlink(path).catch((unlinkError: NodeJS.ErrnoException) => {
      if (unlinkError.code !== "ENOENT") throw unlinkError;
    });
    await listenOn(server, path);
  }

  try {
    await unixOps.chmod(path, 0o600);
    const bound = await unixOps.lstat(path);
    if (
      !bound.isSocket() ||
      (unixOps.uid !== undefined && bound.uid !== unixOps.uid) ||
      (bound.mode & 0o077) !== 0
    ) {
      throw new AgentEndpointError(
        "untrusted",
        "Agent socket ownership or permissions could not be verified.",
      );
    }
  } catch (error) {
    await closeServer(server, sockets);
    if (error instanceof AgentEndpointError) throw error;
    throw new AgentEndpointError("unavailable", "Couldn't secure the agent socket.");
  }

  ready = true;
  return {
    path,
    close: () => closeServer(server, sockets),
  };
}
