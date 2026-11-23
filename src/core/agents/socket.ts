/**
 * Where outside agents' shims reach the running app (#351): a Unix domain
 * socket in the data folder (a named pipe on Windows), as the MCP security
 * guide advises for a local server, rather than an HTTP port a web page could
 * try. On both platforms, mutual HMAC challenge-response proves that the app
 * holds the pairing key before the shim authenticates (ADR-0036, #2049). On
 * Unix, fallback sockets also prefer $XDG_RUNTIME_DIR (0700) before a 0700
 * per-user directory (`im-<uid>`) in tmpdir or /tmp, and sockets are 0600 with
 * ownership checks. The core runs in the main process, so this listener does
 * too; it needs only Node built-ins (no child_process, no OS-specific helpers).
 */
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

/** The longest socket path every platform takes: macOS's limit is 104 bytes, Linux's 108. */
export const MAX_SOCKET_PATH_BYTES = 100;

const PER_USER_DIR_RE = /^im-(\d+)$/;
const FALLBACK_SOCKET_RE = /^incarnamind-[0-9a-f]{16}\.sock$/;
const WINDOWS_PIPE_RE = /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/;

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
  readonly path?: string;

  constructor(
    reason: AgentEndpointProblem,
    message: string,
    options: { code?: string; path?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AgentEndpointError";
    this.reason = reason;
    this.code = options.code ?? "EACCES";
    if (options.path !== undefined) this.path = options.path;
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

/** Whether `dir` (such as $XDG_RUNTIME_DIR) passes the same trust checks as `verifyUnixDirChain` and is a writable, user-owned 0700 directory. */
function isPrivateUserRuntimeDir(dir: string, uid: number | undefined): boolean {
  if (!isAbsolute(dir)) return false;
  try {
    if (uid !== undefined) {
      for (const step of prefixesFromRoot(dir)) {
        const stepInfo = lstatSync(step);
        if (stepInfo.isSymbolicLink() && stepInfo.uid !== 0 && stepInfo.uid !== uid) {
          return false;
        }
      }
    }
    const resolved = realpathSync(dir);
    if (uid !== undefined) {
      for (const step of prefixesFromRoot(resolved)) {
        const stepInfo = lstatSync(step);
        if (!stepInfo.isDirectory()) return false;
        if (stepInfo.uid !== 0 && stepInfo.uid !== uid) return false;
        if (stepInfo.uid === uid && (stepInfo.mode & 0o077) === 0) break;
        const sticky = (stepInfo.mode & 0o1000) !== 0;
        if ((stepInfo.mode & 0o002) !== 0 && !(stepInfo.uid === 0 && sticky)) return false;
      }
    }
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

export interface SocketPathOptions {
  runtimeDir?: string;
  tempDir?: string;
  shortDir?: string;
  canUseDir?: (dir: string) => boolean;
  canUseRuntimeDir?: (dir: string) => boolean;
  uid?: number;
}

/**
 * The socket for a data folder: in it, or, when that path is too long for a
 * socket, in $XDG_RUNTIME_DIR (user-owned 0700) first, then inside an
 * owner-only per-user directory (`im-<uid>`) in the temporary folder, then in
 * `/tmp/im-<uid>` if that fits and is writable (#3598, #2049, ADR-0036).
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
  const socketName = `incarnamind-${id}.sock`;
  const runtimeDir = options?.runtimeDir;
  if (runtimeDir) {
    const inRuntime = join(runtimeDir, socketName);
    const canUseRuntime =
      options?.canUseRuntimeDir ?? ((dir: string) => isPrivateUserRuntimeDir(dir, uid));
    if (Buffer.byteLength(inRuntime) <= MAX_SOCKET_PATH_BYTES && canUseRuntime(runtimeDir)) {
      return inRuntime;
    }
  }
  const fallbackLeaf = uid !== undefined ? join(`im-${uid}`, socketName) : socketName;
  const inTemp = join(options?.tempDir ?? tmpdir(), fallbackLeaf);
  if (Buffer.byteLength(inTemp) <= MAX_SOCKET_PATH_BYTES) return inTemp;
  const shortDir = options?.shortDir ?? "/tmp";
  const inShort = join(shortDir, fallbackLeaf);
  const canUse = options?.canUseDir ?? isWritableFolder;
  if (Buffer.byteLength(inShort) <= MAX_SOCKET_PATH_BYTES && canUse(shortDir)) return inShort;
  return inTemp;
}

/** Whether something is already listening on a Unix socket at `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((done) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      done(true);
    });
    probe.once("error", () => {
      probe.destroy();
      done(false);
    });
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

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  return new Promise((done) => {
    if (!server.listening) {
      done();
      return;
    }
    server.close(() => done());
  });
}

export interface AgentListener {
  readonly path: string;
  close(): Promise<void>;
}

type UnixStat = Pick<Stats, "isDirectory" | "isSocket" | "isSymbolicLink" | "uid" | "gid" | "mode">;

export interface UnixEndpointOps {
  uid?: number;
  lstat?: (path: string) => Promise<UnixStat>;
  realpath?: (path: string) => Promise<string>;
  mkdir?: (path: string, mode: number) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
}

export interface ListenForAgentsOptions {
  unix?: UnixEndpointOps;
  createServer?: typeof createServer;
}

/** Path prefixes from the root down to `target` (e.g. `/`, `/home`, `/home/alice`). */
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

/**
 * Verifies every directory along `dir` from `/` down, following symlinks owned
 * by root or the current account via `realpath`, and stopping at the first
 * directory owned by the current account with mode 0700 (ADR-0036).
 */
async function verifyUnixDirChain(
  dir: string,
  ops: Required<UnixEndpointOps>,
): Promise<{ resolved: string; insidePrivateOwnerDir: boolean }> {
  // Check any symlink along the lexical path before resolving: only root or this account may own it.
  for (const step of prefixesFromRoot(dir)) {
    let info: UnixStat;
    try {
      info = await ops.lstat(step);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new AgentEndpointError(
        code === "ENOENT" ? "unavailable" : "untrusted",
        `Couldn't inspect folder ${step}.`,
        {
          code,
          path: step,
          cause: error,
        },
      );
    }
    if (info.isSymbolicLink() && info.uid !== 0 && info.uid !== ops.uid) {
      throw new AgentEndpointError(
        "untrusted",
        `Folder ${step} is a symlink owned by another account.`,
        { path: step },
      );
    }
  }
  let resolved: string;
  try {
    resolved = await ops.realpath(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new AgentEndpointError(
      code === "ENOENT" ? "unavailable" : "untrusted",
      `Couldn't resolve folder ${dir}.`,
      {
        code,
        path: dir,
        cause: error,
      },
    );
  }
  for (const step of prefixesFromRoot(resolved)) {
    let info: UnixStat;
    try {
      info = await ops.lstat(step);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new AgentEndpointError(
        code === "ENOENT" ? "unavailable" : "untrusted",
        `Couldn't inspect folder ${step}.`,
        {
          code,
          path: step,
          cause: error,
        },
      );
    }
    if (!info.isDirectory()) {
      throw new AgentEndpointError("untrusted", `Expected ${step} to be a directory.`, {
        path: step,
      });
    }
    if (info.uid !== 0 && info.uid !== ops.uid) {
      throw new AgentEndpointError("untrusted", `Folder ${step} is owned by another account.`, {
        path: step,
      });
    }
    if (info.uid === ops.uid && (info.mode & 0o077) === 0) {
      return { resolved, insidePrivateOwnerDir: true };
    }
    const sticky = (info.mode & 0o1000) !== 0;
    if ((info.mode & 0o002) !== 0 && !(info.uid === 0 && sticky)) {
      throw new AgentEndpointError(
        "untrusted",
        `Folder ${step} is writable by other accounts on this computer.`,
        { path: step },
      );
    }
  }
  return { resolved, insidePrivateOwnerDir: false };
}

/**
 * Ensures the Unix socket's parent directory is safe to bind inside. For
 * per-user fallback directories (`im-<uid>`), requires a real directory owned by
 * this account with mode 0700 and verifies the chain above it. For other
 * directories (data folder or $XDG_RUNTIME_DIR), follows root/user symlinks
 * and walks from `/` stopping at the first user-owned 0700 directory.
 */
async function prepareAndVerifyUnixParent(
  socketPath: string,
  ops: Omit<Required<UnixEndpointOps>, "uid"> & { uid: number | undefined },
): Promise<void> {
  const parentDir = dirname(socketPath);
  const parentName = basename(parentDir);
  const socketName = basename(socketPath);
  const isFallbackSocket = FALLBACK_SOCKET_RE.test(socketName);
  const perUserMatch = isFallbackSocket ? PER_USER_DIR_RE.exec(parentName) : null;
  const isPerUserDir = perUserMatch !== null;
  if (isPerUserDir && ops.uid !== undefined && Number(perUserMatch[1]) !== ops.uid) {
    throw new AgentEndpointError(
      "untrusted",
      `Fallback folder ${parentDir} does not match this account.`,
      { path: parentDir },
    );
  }
  if (isPerUserDir) {
    if (ops.uid !== undefined) {
      await verifyUnixDirChain(dirname(parentDir), { ...ops, uid: ops.uid });
    }
    try {
      await ops.mkdir(parentDir, 0o700);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw new AgentEndpointError("unavailable", `Couldn't create folder ${parentDir}.`, {
          code,
          path: parentDir,
          cause: error,
        });
      }
    }
    let parentStat: UnixStat;
    try {
      parentStat = await ops.lstat(parentDir);
    } catch (error) {
      throw new AgentEndpointError("untrusted", `Couldn't inspect folder ${parentDir}.`, {
        path: parentDir,
        cause: error,
      });
    }
    if (!parentStat.isDirectory()) {
      throw new AgentEndpointError(
        "untrusted",
        `Fallback path ${parentDir} is not a real directory.`,
        { path: parentDir },
      );
    }
    if (ops.uid !== undefined && parentStat.uid !== ops.uid) {
      throw new AgentEndpointError(
        "untrusted",
        `Fallback folder ${parentDir} is owned by another account.`,
        { path: parentDir },
      );
    }
    if ((parentStat.mode & 0o077) !== 0) {
      try {
        await ops.chmod(parentDir, 0o700);
        const checked = await ops.lstat(parentDir);
        if (
          !checked.isDirectory() ||
          (ops.uid !== undefined && checked.uid !== ops.uid) ||
          (checked.mode & 0o077) !== 0
        ) {
          throw new AgentEndpointError(
            "untrusted",
            `Fallback folder ${parentDir} is not private to this account.`,
            { path: parentDir },
          );
        }
      } catch (error) {
        if (error instanceof AgentEndpointError) throw error;
        throw new AgentEndpointError(
          "untrusted",
          `Couldn't restrict permissions on ${parentDir}.`,
          { path: parentDir, cause: error },
        );
      }
    }
    return;
  }
  if (ops.uid === undefined) return;
  const { resolved, insidePrivateOwnerDir } = await verifyUnixDirChain(parentDir, {
    ...ops,
    uid: ops.uid,
  });
  if (isFallbackSocket && !insidePrivateOwnerDir) {
    throw new AgentEndpointError(
      "untrusted",
      `Fallback socket folder ${resolved} is not private to this account (mode 0700).`,
      { path: resolved },
    );
  }
}

async function verifyExistingUnixSocketOwner(
  socketPath: string,
  lstatFn: NonNullable<UnixEndpointOps["lstat"]>,
  uid: number | undefined,
): Promise<boolean> {
  let existing: UnixStat;
  try {
    existing = await lstatFn(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new AgentEndpointError("untrusted", `Couldn't inspect existing socket ${socketPath}.`, {
      path: socketPath,
      cause: error,
    });
  }
  if (!existing.isSocket() || (uid !== undefined && existing.uid !== uid)) {
    throw new AgentEndpointError(
      "untrusted",
      `Socket path ${socketPath} is occupied by an untrusted file or another account.`,
      { path: dirname(socketPath) },
    );
  }
  return true;
}

/**
 * Listens on `path`, handing each connection to `onConnection`. On Unix,
 * verifies parent folder safety and socket ownership/mode (0600); on Windows,
 * binds the named pipe directly (authentication is enforced by mutual HMAC
 * challenge-response in ADR-0036). A stale same-account Unix socket left by an
 * app that quit without closing it is replaced; an endpoint occupied by another
 * copy is left alone and this rejects.
 */
export async function listenForAgents(
  path: string,
  onConnection: (socket: Socket) => void,
  options?: ListenForAgentsOptions,
): Promise<AgentListener> {
  const windows = isWindowsPipe(path);
  if (!isSocketPathUsable(path)) {
    throw new AgentEndpointError(
      windows ? "untrusted" : "too-long",
      windows
        ? "Agent pipe name is invalid."
        : `Agent socket path exceeds ${MAX_SOCKET_PATH_BYTES} bytes.`,
      { code: windows ? "EINVAL" : "ENAMETOOLONG", path: dirname(path) },
    );
  }

  const unixOps = {
    uid: options?.unix?.uid ?? process.getuid?.(),
    lstat: options?.unix?.lstat ?? ((target: string) => lstat(target)),
    realpath: options?.unix?.realpath ?? ((target: string) => realpath(target)),
    mkdir:
      options?.unix?.mkdir ??
      (async (target: string, mode: number) => {
        await mkdir(target, { mode });
      }),
    chmod: options?.unix?.chmod ?? ((target: string, mode: number) => chmod(target, mode)),
  };

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
      if (code === "EADDRINUSE" || code === "EACCES") {
        throw new AgentEndpointError("occupied", `Agent named pipe ${path} is already in use.`, {
          code,
          path,
          cause: error,
        });
      }
      throw new AgentEndpointError("unavailable", `Couldn't open agent named pipe ${path}.`, {
        code,
        path,
        cause: error,
      });
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
    if (code !== "EADDRINUSE") {
      throw new AgentEndpointError("unavailable", `Couldn't open agent socket ${path}.`, {
        code,
        path: dirname(path),
        cause: error,
      });
    }
    await verifyExistingUnixSocketOwner(path, unixOps.lstat, unixOps.uid);
    if (await answers(path)) {
      throw new AgentEndpointError(
        "occupied",
        `Agent socket ${path} is already in use by another instance.`,
        { code: "EADDRINUSE", path: dirname(path), cause: error },
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
        `Agent socket ownership or permissions on ${path} could not be verified.`,
        { path: dirname(path) },
      );
    }
  } catch (error) {
    await closeServer(server, sockets);
    if (error instanceof AgentEndpointError) throw error;
    throw new AgentEndpointError("unavailable", `Couldn't secure the agent socket ${path}.`, {
      path: dirname(path),
      cause: error,
    });
  }

  ready = true;
  return {
    path,
    close: () => closeServer(server, sockets),
  };
}
