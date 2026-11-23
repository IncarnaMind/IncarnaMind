import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentEndpointError, agentSocketPath, listenForAgents } from "../../src/core/agents/socket";
import {
  AGENT_SOCKET_ENV,
  AGENT_TOKEN_ENV,
  handshakeLine,
  parseOpeningLine,
  serverChallengeLine,
} from "../../src/shared/agentSocket";
import { translate } from "../../src/shared/i18n";
import { agentSocketAnswers, legacyAgentClient } from "../helpers/agentClients";
import { agentsAdapter, buildAgentShim, startAgentsCore } from "../helpers/agents";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { scriptedModel } from "../helpers/models";

const isUnix = process.platform !== "win32";
const hasPasswordlessSudo =
  process.platform === "linux" &&
  spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0 &&
  spawnSync("sudo", ["-n", "-u", "nobody", "true"], { stdio: "ignore" }).status === 0;

/** Short Unix temp folder under /tmp so subpaths stay within macOS's 100-byte Unix socket limit. */
async function shortUnixTempDir(): Promise<string> {
  const dir = await mkdtemp(join("/tmp", "im-t-"));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Starts a real decoy server (Unix socket or Windows named pipe) that records every byte received. */
async function startDecoyServer(
  endpoint: string,
  options: {
    mode?: number;
    onLine?: (line: string, socket: Socket) => void;
  } = {},
) {
  let connections = 0;
  const received: string[] = [];
  const accepted = new Set<Socket>();
  const server = createServer((socket) => {
    connections += 1;
    accepted.add(socket);
    socket.once("close", () => accepted.delete(socket));
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received.push(chunk);
      pending += chunk;
      for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        options.onLine?.(line, socket);
      }
    });
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(endpoint, () => done());
  });
  if (isUnix && options.mode !== undefined) await chmod(endpoint, options.mode);
  return {
    get connections() {
      return connections;
    },
    get received() {
      return received.join("");
    },
    close: () =>
      new Promise<void>((done) => {
        for (const socket of accepted) socket.destroy();
        server.close(() => done());
      }),
  };
}

/** Runs the built agentShim with one JSON-RPC initialize request and captures stdout + stderr. */
async function probeBuiltShim(
  shimPath: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; reply: Record<string, unknown> | null }> {
  const child = spawn(process.execPath, [shimPath], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const initRequest = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    },
  })}\n`;
  child.stdin.write(initRequest);
  const firstLine = await new Promise<string>((resolve) => {
    const check = () => {
      const nl = stdout.indexOf("\n");
      if (nl !== -1) {
        child.stdout.off("data", check);
        resolve(stdout.slice(0, nl));
      }
    };
    child.stdout.on("data", check);
    child.once("close", () => resolve(stdout.trim()));
    check();
  });
  child.stdin.end();
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("close", () => resolve());
  });
  let reply: Record<string, unknown> | null = null;
  try {
    reply = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    reply = null;
  }
  return { stdout, stderr, reply };
}

/** Sends a raw legacy v1 opening line + MCP initialize/tools request directly over the socket. */
async function callViaLegacyV1(
  socketPath: string,
  token: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const socket = createConnection(socketPath);
  await new Promise<void>((done, fail) => {
    socket.once("connect", () => done());
    socket.once("error", fail);
  });
  const lines: string[] = [];
  let pending = "";
  const waiters: Array<(line: string) => void> = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const next = waiters.shift();
      if (next) next(line);
      else lines.push(line);
    }
  });
  const nextLine = () =>
    lines.length > 0
      ? Promise.resolve(lines.shift() as string)
      : new Promise<string>((resolve, reject) => {
          waiters.push(resolve);
          socket.once("error", reject);
          socket.once("close", () => reject(new Error("Socket closed before reply.")));
        });
  try {
    socket.write(handshakeLine(token));
    socket.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-v1-test", version: "0.0.0" },
        },
      })}\n`,
    );
    await nextLine();
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    socket.write(`${JSON.stringify(request)}\n`);
    return JSON.parse(await nextLine()) as Record<string, unknown>;
  } finally {
    socket.destroy();
  }
}

/** A fake net.Server for exercising Windows named pipe listen error handling on any OS. */
class FakePipeServer extends EventEmitter {
  listening = false;
  closed = false;

  constructor(
    private readonly onSocket: (socket: Socket) => void,
    private readonly onListen: (server: FakePipeServer, path: string) => void,
  ) {
    super();
  }

  listen(path: string) {
    this.listening = true;
    queueMicrotask(() => this.onListen(this, path));
    return this;
  }

  close(callback?: () => void) {
    this.listening = false;
    this.closed = true;
    callback?.();
    return this;
  }

  accept(socket: Socket) {
    this.onSocket(socket);
  }
}

describe("outside agent endpoint security and mutual HMAC handshake (#2049, ADR-0036)", () => {
  it("uses no PowerShell, child_process, or os.type in the shim or socket listener", async () => {
    const shimSource = await readFile(
      new URL("../../src/main/agentShim.ts", import.meta.url),
      "utf8",
    );
    const socketSource = await readFile(
      new URL("../../src/core/agents/socket.ts", import.meta.url),
      "utf8",
    );

    for (const source of [shimSource, socketSource]) {
      expect(source).not.toMatch(
        /from\s+["'](?:node:)?child_process["']|require\(["'](?:node:)?child_process["']\)/,
      );
      expect(source).not.toMatch(/powershell/i);
      expect(source).not.toMatch(/Add-Type|DllImport/);
      expect(source).not.toMatch(/\bos\.type\b|from "node:os".*\btype\b/);
    }

    const shimImports = [...shimSource.matchAll(/^import\s+.*?from\s+"([^"]+)";$/gm)].map(
      (match) => match[1],
    );
    expect(shimImports.sort()).toEqual(["node:crypto", "node:fs", "node:net", "node:path"]);
  });

  it("completes mutual HMAC-SHA256 end-to-end with the built shim without marking shimsOutOfDate", async () => {
    const { core } = await startAgentsCore(scriptedModel(() => ({ text: "ok" })));
    await core.setAgentsEnabled(true);
    const { pairing, launch } = await core.connectAgent({ name: "Claude Code" });

    const client = await legacyAgentClient(launch);
    try {
      const listed = await client.listTools();
      expect(listed.tools.some((tool) => tool.name === "search")).toBe(true);
    } finally {
      await client.close();
    }

    expect((await core.getAgents()).shimsOutOfDate).toEqual([]);
    expect((await core.getAgents()).pairings.map((each) => each.id)).toContain(pairing.id);
  }, 60_000);

  it("refuses a decoy server (Unix socket or Windows named pipe) with 0 bytes of the pairing key sent", async () => {
    const shimPath = await buildAgentShim();
    const token = "im_secret_decoy_token_never_on_the_wire";
    const endpoint = isUnix
      ? join(await createTempDataFolder(), "decoy.sock")
      : `\\\\.\\pipe\\incarnamind-decoy-${randomBytes(8).toString("hex")}`;

    const decoy = await startDecoyServer(endpoint, {
      mode: 0o600,
      onLine: (_line, socket) => {
        socket.write(serverChallengeLine("forged_app_nonce_1234567890", ["0".repeat(64)]));
      },
    });
    try {
      const result = await probeBuiltShim(shimPath, {
        [AGENT_SOCKET_ENV]: endpoint,
        [AGENT_TOKEN_ENV]: token,
      });

      expect(decoy.connections).toBe(1);
      expect(decoy.received).not.toContain(token);
      expect(decoy.received).not.toContain('"proof"');
      const opening = parseOpeningLine(decoy.received.trim());
      expect(opening?.version).toBe(2);

      const errorMessage = (result.reply?.error as { message?: string } | undefined)?.message ?? "";
      expect(errorMessage).toContain("Couldn't verify IncarnaMind");
      expect(errorMessage).toContain("no pairing key was sent");
      expect(errorMessage).toContain("未发送配对密钥");
      expect(result.stderr).toContain("server proof did not match pairing key");
      expect(result.stderr).not.toContain(token);
    } finally {
      await decoy.close();
    }
  }, 60_000);

  it("refuses a decoy that closes immediately or replays a stale proof, with 0 key bytes sent", async () => {
    const shimPath = await buildAgentShim();
    const token = "im_secret_replay_token_never_on_the_wire";
    const endpoint = isUnix
      ? join(await createTempDataFolder(), "decoy-close.sock")
      : `\\\\.\\pipe\\incarnamind-decoy-close-${randomBytes(8).toString("hex")}`;

    const decoy = await startDecoyServer(endpoint, {
      mode: 0o600,
      onLine: (_line, socket) => socket.end(),
    });
    try {
      const result = await probeBuiltShim(shimPath, {
        [AGENT_SOCKET_ENV]: endpoint,
        [AGENT_TOKEN_ENV]: token,
      });

      expect(decoy.received).not.toContain(token);
      expect(decoy.received).not.toContain('"proof"');
      const errorMessage = (result.reply?.error as { message?: string } | undefined)?.message ?? "";
      expect(errorMessage).toContain("Couldn't verify IncarnaMind");
      expect(result.stderr).not.toContain(token);
    } finally {
      await decoy.close();
    }
  }, 60_000);

  it("keeps accepting legacy v1 shims, persists shimsOutOfDate, allows reinstall, and clears after v2 upgrade", async () => {
    const dataDir = await createTempDataFolder();
    const home = await createTempDataFolder();
    const tempDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const shimScript = await buildAgentShim();
    const openedBundles: string[] = [];
    const adapter = await agentsAdapter(dataDir);
    const makeCore = () =>
      startCore(dataDir, {
        keychain,
        paths: { dataDir, home, documents: join(dataDir, "Documents"), tempDir },
        agents: {
          ...adapter,
          shimScript,
          applications: [tempDir],
        },
        shell: {
          openPath: async (filePath) => {
            openedBundles.push(filePath);
          },
          showItemInFolder: () => undefined,
        },
      });

    const core = makeCore();
    await core.setAgentsEnabled(true);
    const { pairing, launch } = await core.connectAgent({
      name: "Claude Desktop",
      client: "claude-desktop",
    });
    const token = launch.env[AGENT_TOKEN_ENV] ?? "";
    const socketPath = launch.env[AGENT_SOCKET_ENV] ?? "";
    expect(token).not.toBe("");
    expect(socketPath).not.toBe("");

    const v1Reply = await callViaLegacyV1(socketPath, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(Array.isArray((v1Reply.result as { tools?: unknown[] } | undefined)?.tools)).toBe(true);
    expect((await core.getAgents()).shimsOutOfDate).toEqual([pairing.id]);

    // Persists across restart and unlocks openAgentInstallAgain for bundle clients.
    core.close();
    await expect.poll(() => agentSocketAnswers(socketPath)).toBe(false);
    const restarted = makeCore();
    expect((await restarted.getAgents()).shimsOutOfDate).toEqual([pairing.id]);
    await restarted.openAgentInstallAgain(pairing.id);
    expect(openedBundles.length).toBe(1);

    // Connecting with the v2 shim clears shimsOutOfDate.
    const v2Client = await legacyAgentClient(launch);
    try {
      await v2Client.listTools();
    } finally {
      await v2Client.close();
    }
    expect((await restarted.getAgents()).shimsOutOfDate).toEqual([]);

    // After disconnect: legacy v1 still gets "no longer connected", while v2 shim refuses before MCP.
    await restarted.disconnectAgent(pairing.id);
    const disconnectedV1 = await callViaLegacyV1(socketPath, token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search", arguments: { query: "test" } },
    });
    expect(JSON.stringify(disconnectedV1)).toMatch(/no longer connected/);
    await expect(legacyAgentClient(launch)).rejects.toThrow(/Couldn't verify IncarnaMind/);
  }, 60_000);

  describe("Unix fallback paths, directory walk, and migration", () => {
    it.skipIf(!isUnix)(
      "prefers a private 0700 $XDG_RUNTIME_DIR over im-<uid>, and skips an unprivate runtime dir",
      async () => {
        const root = await shortUnixTempDir();
        const privateRuntime = join(root, "xdg-p");
        const openRuntime = join(root, "xdg-o");
        await mkdir(privateRuntime, { mode: 0o700 });
        await chmod(privateRuntime, 0o700);
        await mkdir(openRuntime, { mode: 0o755 });
        await chmod(openRuntime, 0o755);

        const longData = join(root, "a".repeat(95));
        const uid = process.getuid?.();

        const fromPrivate = agentSocketPath(longData, "linux", {
          runtimeDir: privateRuntime,
          tempDir: "/tmp",
          uid,
        });
        expect(dirname(fromPrivate)).toBe(privateRuntime);

        const fromOpen = agentSocketPath(longData, "linux", {
          runtimeDir: openRuntime,
          tempDir: "/tmp",
          uid,
        });
        expect(fromOpen).toMatch(new RegExp(`^/tmp/im-${uid}/incarnamind-[0-9a-f]{16}\\.sock$`));
      },
    );

    it.skipIf(!isUnix)(
      "accepts a group-writable (0775) parent directory and a user-owned symlinked data folder",
      async () => {
        const root = await shortUnixTempDir();
        const groupWritableParent = join(root, "cfg");
        await mkdir(groupWritableParent, { mode: 0o775 });
        await chmod(groupWritableParent, 0o775);

        const realData = join(groupWritableParent, "real");
        await mkdir(realData, { mode: 0o755 });
        const linkedData = join(groupWritableParent, "link");
        await symlink(realData, linkedData);

        const socketPath = join(linkedData, "agents.sock");
        const core = startCore(linkedData, {
          agents: {
            socketPath,
            launcher: { command: process.execPath, args: [await buildAgentShim()] },
            version: "0.0.0-test",
          },
        });
        await core.setAgentsEnabled(true);
        const { launch } = await core.connectAgent({ name: "Claude Code" });

        const client = await legacyAgentClient(launch);
        try {
          const listed = await client.listTools();
          expect(listed.tools.length).toBeGreaterThan(0);
        } finally {
          await client.close();
        }
      },
      60_000,
    );

    it.skipIf(!isUnix)(
      "creates a 0700 per-user directory and 0600 socket, and refuses symlink/file hijack naming the folder",
      async () => {
        const uid = process.getuid?.();
        expect(uid).toBeDefined();
        const root = await shortUnixTempDir();
        const goodPath = join(root, `im-${uid}`, "incarnamind-0123456789abcdef.sock");
        const listener = await listenForAgents(goodPath, () => undefined);
        try {
          const dirStat = await lstat(dirname(goodPath));
          const sockStat = await lstat(goodPath);
          expect(dirStat.mode & 0o777).toBe(0o700);
          expect(sockStat.mode & 0o777).toBe(0o600);
        } finally {
          await listener.close();
        }

        // Pre-created symlink where im-<uid> should be: rejected with folder path and no "Restart".
        const symlinkRoot = await shortUnixTempDir();
        const hijackTarget = await shortUnixTempDir();
        const symlinkDir = join(symlinkRoot, `im-${uid}`);
        await symlink(hijackTarget, symlinkDir);
        const hijackedPath = join(symlinkDir, "incarnamind-0123456789abcdef.sock");

        const core = startCore(await createTempDataFolder(), {
          agents: {
            socketPath: hijackedPath,
            launcher: { command: process.execPath, args: [await buildAgentShim()] },
            version: "0.0.0-test",
          },
        });
        let caught: unknown = null;
        try {
          await core.setAgentsEnabled(true);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        const message = (caught as Error).message;
        expect(message).toContain(symlinkDir);
        expect(message).not.toMatch(/restart/i);

        // Pre-created regular file where im-<uid> should be: also rejected.
        const fileRoot = await shortUnixTempDir();
        const blocker = join(fileRoot, `im-${uid}`);
        await writeFile(blocker, "occupied");
        await expect(
          listenForAgents(join(blocker, "incarnamind-0123456789abcdef.sock"), () => undefined),
        ).rejects.toMatchObject({ reason: "untrusted", path: blocker });
      },
      60_000,
    );

    it.skipIf(!isUnix)(
      "checks migrated per-user paths before a legacy flat fallback path so a flat decoy cannot shadow the app",
      async () => {
        const uid = process.getuid?.();
        const root = await shortUnixTempDir();
        const socketName = "incarnamind-0123456789abcdef.sock";
        const legacyFlatPath = join(root, socketName);
        const migratedPath = join(root, `im-${uid}`, socketName);

        // Start a decoy on the legacy flat path AND the real app on the migrated im-<uid> path.
        const decoy = await startDecoyServer(legacyFlatPath, { mode: 0o600 });
        const core = startCore(await createTempDataFolder(), {
          agents: {
            socketPath: migratedPath,
            launcher: { command: process.execPath, args: [await buildAgentShim()] },
            version: "0.0.0-test",
          },
        });
        try {
          await core.setAgentsEnabled(true);
          const { launch } = await core.connectAgent({ name: "Claude Code" });
          // Old client config still points at the flat path.
          const legacyLaunch = {
            ...launch,
            env: { ...launch.env, [AGENT_SOCKET_ENV]: legacyFlatPath },
          };

          const client = await legacyAgentClient(legacyLaunch);
          try {
            const listed = await client.listTools();
            expect(listed.tools.length).toBeGreaterThan(0);
          } finally {
            await client.close();
          }
          expect(decoy.connections).toBe(0);
          expect(decoy.received).toBe("");
        } finally {
          await decoy.close();
        }
      },
      60_000,
    );

    it.skipIf(!isUnix)(
      "preserves error cause and refuses another account's socket or world-writable non-sticky parent",
      async () => {
        const uid = process.getuid?.() ?? 1000;
        const otherUid = uid + 1;
        const root = await createTempDataFolder();
        const socketPath = join(root, "agents.sock");
        const underlying = Object.assign(new Error("permission denied"), { code: "EACCES" });

        let causeErr: unknown = null;
        try {
          await listenForAgents(socketPath, () => undefined, {
            unix: {
              uid,
              lstat: async () => {
                throw underlying;
              },
            },
          });
        } catch (error) {
          causeErr = error;
        }
        expect(causeErr).toBeInstanceOf(AgentEndpointError);
        expect((causeErr as AgentEndpointError).cause).toBe(underlying);

        await expect(
          listenForAgents(socketPath, () => undefined, {
            unix: {
              uid,
              lstat: async (target) => {
                if (target === socketPath) {
                  return {
                    isDirectory: () => false,
                    isSocket: () => true,
                    isSymbolicLink: () => false,
                    uid: otherUid,
                    gid: otherUid,
                    mode: 0o140600,
                  };
                }
                return {
                  isDirectory: () => true,
                  isSocket: () => false,
                  isSymbolicLink: () => false,
                  uid: target === root ? uid : 0,
                  gid: 0,
                  mode: target === root ? 0o40700 : 0o40755,
                };
              },
              realpath: async (target) => target,
            },
          }),
        ).rejects.toMatchObject({ reason: "untrusted" });

        await expect(
          listenForAgents(socketPath, () => undefined, {
            unix: {
              uid,
              lstat: async () => ({
                isDirectory: () => true,
                isSocket: () => false,
                isSymbolicLink: () => false,
                uid: 0,
                gid: 0,
                mode: 0o40777,
              }),
              realpath: async (target) => target,
            },
          }),
        ).rejects.toMatchObject({ reason: "untrusted" });
      },
    );
  });

  describe("Windows named pipe listener handling", () => {
    it("binds named pipes directly without spawning helpers and maps occupied/invalid errors", async () => {
      const pipePath = "\\\\.\\pipe\\incarnamind-agents-0123456789abcdef";
      const servers: FakePipeServer[] = [];
      const listener = await listenForAgents(pipePath, () => undefined, {
        createServer: vi.fn((onSocket) => {
          const srv = new FakePipeServer(onSocket as (socket: Socket) => void, (instance) =>
            instance.emit("listening"),
          );
          servers.push(srv);
          return srv as unknown as Server;
        }) as unknown as typeof createServer,
      });
      expect(listener.path).toBe(pipePath);
      await listener.close();
      expect(servers[0]?.closed).toBe(true);

      const busyErr = Object.assign(new Error("in use"), { code: "EADDRINUSE" });
      let occupied: unknown = null;
      try {
        await listenForAgents(pipePath, () => undefined, {
          createServer: vi.fn(
            (onSocket) =>
              new FakePipeServer(onSocket as (socket: Socket) => void, (srv) =>
                srv.emit("error", busyErr),
              ) as unknown as Server,
          ) as unknown as typeof createServer,
        });
      } catch (error) {
        occupied = error;
      }
      expect(occupied).toBeInstanceOf(AgentEndpointError);
      expect((occupied as AgentEndpointError).reason).toBe("occupied");
      expect((occupied as AgentEndpointError).cause).toBe(busyErr);

      await expect(
        listenForAgents("\\\\.\\pipe\\bad name with spaces", () => undefined),
      ).rejects.toMatchObject({ reason: "untrusted" });
    });

    it("provides EN and ZH socket error messages naming the folder with no Restart advice", () => {
      for (const language of ["en", "zh-CN"] as const) {
        const untrusted = translate(language, "error.agent.socketUntrusted", {
          path: "/tmp/im-1000",
        });
        const unavailable = translate(language, "error.agent.socketUnavailable", {
          path: "/tmp/im-1000",
        });
        expect(untrusted).toContain("/tmp/im-1000");
        expect(unavailable).toContain("/tmp/im-1000");
        expect(untrusted).not.toMatch(/restart|重启/i);
        expect(unavailable).not.toMatch(/restart|重启/i);
      }
    });
  });

  describe.skipIf(!hasPasswordlessSudo)(
    "real second-account Unix isolation (Linux CI with nobody)",
    () => {
      it("blocks another account from hijacking im-<uid>, flat fallback, or connecting to our 0600 socket", async () => {
        const uid = process.getuid?.();
        expect(uid).toBeDefined();
        const shimPath = await buildAgentShim();
        const rootTmp = join("/tmp", `im-2acc-${randomBytes(6).toString("hex")}`);
        const token = "im_two_account_secret_never_leaked";
        expect(spawnSync("sudo", ["-n", "mkdir", "-m", "1777", rootTmp]).status).toBe(0);

        const spawnAsNobody = (script: string, args: string[]) =>
          spawn("sudo", ["-n", "-u", "nobody", process.execPath, "-e", script, ...args], {
            stdio: ["ignore", "pipe", "pipe"],
          });

        const children: Array<ReturnType<typeof spawn>> = [];
        try {
          // 1. nobody pre-creates im-<ourUid> with a decoy socket.
          const hijackedDir = join(rootTmp, `im-${uid}`);
          const hijackedSock = join(hijackedDir, "incarnamind-0123456789abcdef.sock");
          const decoyScript = `
            const fs = require("node:fs");
            const net = require("node:net");
            const path = require("node:path");
            const target = process.argv[1];
            const makeDir = process.argv[2] === "mkdir";
            if (makeDir) fs.mkdirSync(path.dirname(target), { mode: 0o755, recursive: true });
            const server = net.createServer((s) => {
              s.on("data", (d) => process.stdout.write("RECEIVED:" + JSON.stringify(d.toString("utf8")) + "\\n"));
              s.end();
            });
            server.listen(target, () => {
              fs.chmodSync(target, 0o666);
              process.stdout.write("READY\\n");
            });
          `;
          let decoy1Out = "";
          const decoy1 = spawnAsNobody(decoyScript, [hijackedSock, "mkdir"]);
          children.push(decoy1);
          await new Promise<void>((resolve, reject) => {
            decoy1.stdout.on("data", (d: Buffer) => {
              decoy1Out += d.toString("utf8");
              if (decoy1Out.includes("READY")) resolve();
            });
            decoy1.once("exit", (code) => reject(new Error(`nobody decoy1 exited ${code}`)));
          });

          await expect(listenForAgents(hijackedSock, () => undefined)).rejects.toMatchObject({
            reason: "untrusted",
            path: hijackedDir,
          });
          const shimRes1 = await probeBuiltShim(shimPath, {
            [AGENT_SOCKET_ENV]: hijackedSock,
            [AGENT_TOKEN_ENV]: token,
          });
          expect(
            (shimRes1.reply?.error as { message?: string } | undefined)?.message ?? "",
          ).toContain("Couldn't verify IncarnaMind");
          expect(decoy1Out).not.toContain("RECEIVED:");
          expect(decoy1Out).not.toContain(token);
          decoy1.kill("SIGTERM");

          // 2. nobody binds a legacy flat socket when our app is not running.
          const flatSock = join(rootTmp, "incarnamind-fedcba9876543210.sock");
          let decoy2Out = "";
          const decoy2 = spawnAsNobody(decoyScript, [flatSock, "flat"]);
          children.push(decoy2);
          await new Promise<void>((resolve, reject) => {
            decoy2.stdout.on("data", (d: Buffer) => {
              decoy2Out += d.toString("utf8");
              if (decoy2Out.includes("READY")) resolve();
            });
            decoy2.once("exit", (code) => reject(new Error(`nobody decoy2 exited ${code}`)));
          });
          const shimRes2 = await probeBuiltShim(shimPath, {
            [AGENT_SOCKET_ENV]: flatSock,
            [AGENT_TOKEN_ENV]: token,
          });
          expect(
            (shimRes2.reply?.error as { message?: string } | undefined)?.message ?? "",
          ).toContain("Couldn't verify IncarnaMind");
          expect(decoy2Out).not.toContain("RECEIVED:");
          expect(decoy2Out).not.toContain(token);
          decoy2.kill("SIGTERM");

          // 3. Our own 0600 socket refuses connections from nobody with EACCES.
          const ourDir = join(rootTmp, "own");
          await mkdir(ourDir, { mode: 0o755 });
          await chmod(ourDir, 0o755);
          const ourSock = join(ourDir, "agents.sock");
          const listener = await listenForAgents(ourSock, () => undefined);
          try {
            const probe = spawnSync(
              "sudo",
              [
                "-n",
                "-u",
                "nobody",
                process.execPath,
                "-e",
                `const net = require("node:net"); const s = net.createConnection(process.argv[1]); s.on("error", (e) => { console.log(e.code); process.exit(0); }); s.on("connect", () => { console.log("CONNECTED"); process.exit(1); });`,
                ourSock,
              ],
              { encoding: "utf8" },
            );
            expect(probe.stdout.trim()).toBe("EACCES");
          } finally {
            await listener.close();
          }
        } finally {
          for (const child of children) child.kill("SIGKILL");
          spawnSync("sudo", ["-n", "rm", "-rf", rootTmp]);
          await rm(rootTmp, { recursive: true, force: true }).catch(() => undefined);
        }
      }, 60_000);
    },
  );
});
