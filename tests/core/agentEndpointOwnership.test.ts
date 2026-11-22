import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentEndpointError,
  agentSocketPath,
  buildWindowsPipeLockScript,
  buildWindowsPipeVerifyScript,
  evaluateWindowsPipeProbe,
  isOwnerOnlyWindowsDacl,
  listenForAgents,
  sanitizedWindowsPipeEnv,
  type WindowsPipeProbe,
} from "../../src/core/agents/socket";
import { AGENT_TOKEN_ENV } from "../../src/shared/agentSocket";
import { translate } from "../../src/shared/i18n";
import { legacyAgentClient } from "../helpers/agentClients";
import { agentsAdapter, buildAgentShim, startAgentsCore } from "../helpers/agents";
import { createTempDataFolder, startCore } from "../helpers/core";
import { scriptedModel } from "../helpers/models";

const isUnix = process.platform !== "win32";

/** Starts a decoy Unix socket server that records every connection and every byte sent to it. */
async function startDecoyUnixServer(path: string, mode?: number) {
  let connections = 0;
  const received: string[] = [];
  const accepted = new Set<Socket>();
  const server = createServer((socket) => {
    connections += 1;
    accepted.add(socket);
    socket.once("close", () => accepted.delete(socket));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => received.push(chunk));
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(path, () => done());
  });
  if (mode !== undefined) await chmod(path, mode);
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

/** A fake net.Server for exercising Windows named pipe startup flows on any OS. */
class FakePipeServer extends EventEmitter {
  closed = false;
  private onSocket: (socket: Socket) => void;
  private listenBehavior: (server: FakePipeServer, path: string) => void;

  constructor(
    onSocket: (socket: Socket) => void,
    listenBehavior: (server: FakePipeServer, path: string) => void,
  ) {
    super();
    this.onSocket = onSocket;
    this.listenBehavior = listenBehavior;
  }

  listen(path: string): this {
    queueMicrotask(() => this.listenBehavior(this, path));
    return this;
  }

  emitConnection(socket: Socket): void {
    this.onSocket(socket);
  }

  close(callback?: () => void): this {
    this.closed = true;
    callback?.();
    return this;
  }
}

describe("outside-agent endpoint ownership (#2049)", () => {
  // protects=the standalone agent shim built for Claude bundles imports only Node built-ins so ownership checks never pull external chunks; fails_when=a bundler chunk import appears in the built shim
  it("keeps the built agent shim self-contained with only Node built-in imports", async () => {
    const shimPath = await buildAgentShim();
    const built = await readFile(shimPath, "utf8");
    const requires = [...built.matchAll(/require\((["'])([^"']+)\1\)/g)].map((m) => m[2] ?? "");
    expect(requires.length).toBeGreaterThan(0);
    for (const specifier of requires) {
      expect(specifier.startsWith("node:")).toBe(true);
    }
  });

  it("provides plain English and Simplified Chinese messages for untrusted endpoints", () => {
    const en = translate("en", "error.agent.socketUntrusted");
    const zh = translate("zh-CN", "error.agent.socketUntrusted");
    expect(en).toMatch(/another account|private to your account/i);
    expect(zh).toMatch(/其他账号|仅限当前账号/);
  });

  describe("Windows named pipe DACL and ownership rules", () => {
    // protects=only a protected DACL granting Allow ACEs solely to the current user SID passes ownership validation; fails_when=default DACLs, Everyone/Users ACEs, unprotected DACLs, or foreign SIDs are accepted
    it("accepts only owner-only protected DACLs and rejects permissive or foreign ones", () => {
      const me = "S-1-5-21-100-200-300-1001";
      const other = "S-1-5-21-100-200-300-1002";

      expect(isOwnerOnlyWindowsDacl(`D:P(A;;FA;;;${me})`, me)).toBe(true);
      expect(isOwnerOnlyWindowsDacl(`D:P(A;;GA;;;${me})`, me)).toBe(true);
      expect(isOwnerOnlyWindowsDacl(`D:PAI(A;;FA;;;${me})`, me)).toBe(true);

      // Unprotected DACL (missing P), Everyone (WD), Users (BU), Authenticated Users (AU), foreign SID, empty DACL
      expect(isOwnerOnlyWindowsDacl(`D:(A;;FA;;;${me})`, me)).toBe(false);
      expect(isOwnerOnlyWindowsDacl(`D:P(A;;FA;;;${me})(A;;GR;;;WD)`, me)).toBe(false);
      expect(isOwnerOnlyWindowsDacl(`D:P(A;;FA;;;${me})(A;;GRGW;;;BU)`, me)).toBe(false);
      expect(isOwnerOnlyWindowsDacl(`D:P(A;;FA;;;${me})(A;;GRGW;;;AU)`, me)).toBe(false);
      expect(isOwnerOnlyWindowsDacl(`D:P(A;;FA;;;${other})`, me)).toBe(false);
      expect(isOwnerOnlyWindowsDacl("D:P", me)).toBe(false);
      expect(isOwnerOnlyWindowsDacl(`D:P(A;;FA;;;${me})`, "not-a-sid")).toBe(false);

      expect(
        evaluateWindowsPipeProbe({
          status: "ok",
          currentSid: me,
          ownerSid: me,
          dacl: `D:P(A;;FA;;;${me})`,
        }),
      ).toBe("ok");
      expect(
        evaluateWindowsPipeProbe({
          status: "ok",
          currentSid: me,
          ownerSid: other,
          dacl: `D:P(A;;FA;;;${me})`,
        }),
      ).toBe("untrusted");
      expect(
        evaluateWindowsPipeProbe({
          status: "ok",
          currentSid: me,
          ownerSid: me,
          dacl: `D:P(A;;FA;;;${me})(A;;GR;;;WD)`,
        }),
      ).toBe("untrusted");
      expect(evaluateWindowsPipeProbe({ status: "not-open", code: 2 })).toBe("not-open");
      expect(evaluateWindowsPipeProbe({ status: "untrusted", code: 5 })).toBe("untrusted");
    });

    it("strips pairing tokens from Windows pipe helper environments and uses protected owner-only SDDL", () => {
      const pipe = "\\\\.\\pipe\\incarnamind-agents-0123456789abcdef";
      const env = sanitizedWindowsPipeEnv(pipe, {
        PATH: "C:\\Windows\\System32",
        [AGENT_TOKEN_ENV]: "im_super_secret_token_do_not_pass",
        incarnamind_agent_token: "im_lowercase_secret_do_not_pass",
      });
      expect(env.INCARNAMIND_PIPE_PATH).toBe(pipe);
      expect(env[AGENT_TOKEN_ENV]).toBeUndefined();
      expect(env.incarnamind_agent_token).toBeUndefined();

      const lockScript = buildWindowsPipeLockScript();
      expect(lockScript).toContain("SetNamedSecurityInfoW");
      expect(lockScript).toContain("PROTECTED_DACL_SECURITY_INFORMATION");
      expect(lockScript).toContain("D:P(A;;GA;;;{0})");
      expect(lockScript).toContain("LocalFree");

      const verifyScript = buildWindowsPipeVerifyScript();
      expect(verifyScript).toContain("GetNamedSecurityInfoW");
      expect(verifyScript).toContain("OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION");
      expect(verifyScript).toContain("LocalFree");
    });

    // protects=on Windows, server holds back connections until the owner-only DACL is locked, closes the pipe if locking fails, and classifies a foreign-occupied pipe as untrusted; fails_when=a default-DACL pipe stays open or serves early connections
    it("enforces owner-only DACL before serving connections and rejects occupied or untrusted Windows pipes", async () => {
      const me = "S-1-5-21-1-2-3-1001";
      const other = "S-1-5-21-1-2-3-1002";
      const pipe = "\\\\.\\pipe\\incarnamind-agents-abcdef0123456789";

      // 1. Early connection before DACL lock completes is destroyed; connection after lock is served.
      let releaseLock!: (probe: WindowsPipeProbe) => void;
      let fakeServer!: FakePipeServer;
      const served: Socket[] = [];
      const listening = listenForAgents(pipe, (s) => served.push(s), {
        createServer: (onSocket) => {
          fakeServer = new FakePipeServer(onSocket, (srv) => srv.emit("listening"));
          return fakeServer as unknown as Server;
        },
        windows: {
          lock: () =>
            new Promise<WindowsPipeProbe>((resolve) => {
              releaseLock = resolve;
            }),
          verify: async () => ({ status: "not-open" }),
        },
      });
      await new Promise((r) => setTimeout(r, 10));
      let earlyDestroyed = false;
      const earlySocket = Object.assign(new EventEmitter(), {
        destroy: () => {
          earlyDestroyed = true;
        },
      }) as unknown as Socket;
      fakeServer.emitConnection(earlySocket);
      expect(earlyDestroyed).toBe(true);
      expect(served).toHaveLength(0);

      releaseLock({ status: "ok", currentSid: me, ownerSid: me, dacl: `D:P(A;;FA;;;${me})` });
      const listener = await listening;
      const afterSocket = Object.assign(new EventEmitter(), {
        destroy: () => {},
      }) as unknown as Socket;
      fakeServer.emitConnection(afterSocket);
      expect(served).toEqual([afterSocket]);
      await listener.close();
      expect(fakeServer.closed).toBe(true);

      // 2. If DACL hardening returns a non-owner-only DACL, the server closes and rejects.
      let failedServer!: FakePipeServer;
      await expect(
        listenForAgents(pipe, () => {}, {
          createServer: (onSocket) => {
            failedServer = new FakePipeServer(onSocket, (srv) => srv.emit("listening"));
            return failedServer as unknown as Server;
          },
          windows: {
            lock: async () => ({
              status: "ok",
              currentSid: me,
              ownerSid: me,
              dacl: `D:(A;;FA;;;${me})(A;;GR;;;WD)`,
            }),
            verify: async () => ({ status: "untrusted" }),
          },
        }),
      ).rejects.toMatchObject({ name: "AgentEndpointError", reason: "untrusted" });
      expect(failedServer.closed).toBe(true);

      // 3. Pipe already occupied by another OS account (EACCES/EADDRINUSE + foreign owner) -> untrusted.
      await expect(
        listenForAgents(pipe, () => {}, {
          createServer: (onSocket) =>
            new FakePipeServer(onSocket, (srv) =>
              srv.emit("error", Object.assign(new Error("occupied"), { code: "EADDRINUSE" })),
            ) as unknown as Server,
          windows: {
            lock: async () => ({ status: "untrusted" }),
            verify: async () => ({
              status: "ok",
              currentSid: me,
              ownerSid: other,
              dacl: `D:P(A;;FA;;;${other})`,
            }),
          },
        }),
      ).rejects.toMatchObject({ name: "AgentEndpointError", reason: "untrusted" });

      // 4. Pipe already occupied by another copy under the same account -> occupied.
      await expect(
        listenForAgents(pipe, () => {}, {
          createServer: (onSocket) =>
            new FakePipeServer(onSocket, (srv) =>
              srv.emit("error", Object.assign(new Error("in use"), { code: "EADDRINUSE" })),
            ) as unknown as Server,
          windows: {
            lock: async () => ({ status: "untrusted" }),
            verify: async () => ({
              status: "ok",
              currentSid: me,
              ownerSid: me,
              dacl: `D:P(A;;FA;;;${me})`,
            }),
          },
        }),
      ).rejects.toMatchObject({ name: "AgentEndpointError", reason: "occupied" });
    });
  });

  describe.runIf(isUnix)("Unix sockets and Linux /tmp fallback ownership", () => {
    // protects=long Unix data paths use an owner-only 0700 per-user directory and 0600 socket, and same-account pairing + scoped search work; fails_when=fallback socket lands directly in shared /tmp or has group/world permissions
    it("places long-path fallback sockets inside a 0700 per-user directory and supports same-account pairing and search", async () => {
      const longRoot = await createTempDataFolder();
      const longData = join(longRoot, "a".repeat(45), "b".repeat(45), "data");
      const longTemp = join(longRoot, "t".repeat(45), "u".repeat(45), "tmp");
      const uid = process.getuid?.();
      const fallbackPath = agentSocketPath(longData, process.platform, { tempDir: longTemp });
      expect(fallbackPath).toMatch(new RegExp(`^/tmp/im-${uid}/incarnamind-[0-9a-f]{16}\\.sock$`));

      const base = await agentsAdapter(longData);
      if (!base) throw new Error("No agent adapter.");
      const core = startCore(longData, {
        agents: { ...base, socketPath: fallbackPath },
      });
      const folder = await core.createLibraryGroup({ name: "Harbour", description: "Tides" });
      await core.setAgentsEnabled(true);

      const dirStat = await lstat(dirname(fallbackPath));
      expect(dirStat.isDirectory()).toBe(true);
      expect(dirStat.uid).toBe(uid);
      expect(dirStat.mode & 0o077).toBe(0);

      const sockStat = await lstat(fallbackPath);
      expect(sockStat.isSocket()).toBe(true);
      expect(sockStat.uid).toBe(uid);
      expect(sockStat.mode & 0o077).toBe(0);

      const connected = await core.connectAgent({ name: "Claude Code", folderIds: [folder.id] });
      const client = await legacyAgentClient(connected.launch);
      const result = await client.callTool({ name: "list_minds", arguments: {} });
      expect(result.isError).not.toBe(true);
      await client.close();

      // Pre-#2049 client config carrying the legacy flat `/tmp/incarnamind-<id>.sock` path still
      // connects transparently to the migrated `/tmp/im-<uid>/incarnamind-<id>.sock` listener.
      const legacyFlatPath = join("/tmp", fallbackPath.split("/").at(-1) ?? "");
      const upgradedClient = await legacyAgentClient({
        ...connected.launch,
        env: { ...connected.launch.env, INCARNAMIND_AGENT_SOCKET: legacyFlatPath },
      });
      const upgradedResult = await upgradedClient.callTool({ name: "list_minds", arguments: {} });
      expect(upgradedResult.isError).not.toBe(true);
      await upgradedClient.close();

      core.close();

      // An ordinary data folder coincidentally named `im-<otherUid>` holding `agents.sock` is not
      // misclassified as a fallback directory.
      const ordinaryParent = await createTempDataFolder();
      const ordinaryData = join(ordinaryParent, `im-${(uid ?? 1000) + 1}`);
      await mkdir(ordinaryData, { mode: 0o700 });
      const ordinaryCore = startCore(ordinaryData, { agents: await agentsAdapter(ordinaryData) });
      await ordinaryCore.setAgentsEnabled(true);
      ordinaryCore.close();
    });

    // protects=when a pre-created endpoint is permissive (0666), a symlink to a decoy socket, or inside a world-writable/symlink directory, the shim refuses BEFORE connecting so zero pairing credentials leave the shim; fails_when=the decoy server receives any connection or token bytes
    it("refuses untrusted or pre-created endpoints in the shim before any pairing key leaves it", async () => {
      const dir = await createTempDataFolder();
      const shim = await buildAgentShim();
      const secretToken = "im_test_secret_token_never_send_12345";

      // Case 1: Pre-created listening socket with group/world-accessible permissions (0o666).
      const permissiveSock = join(dir, "permissive.sock");
      const decoy1 = await startDecoyUnixServer(permissiveSock, 0o666);
      try {
        await expect(
          legacyAgentClient({
            command: process.execPath,
            args: [shim],
            env: {
              INCARNAMIND_AGENT_SOCKET: permissiveSock,
              INCARNAMIND_AGENT_TOKEN: secretToken,
            },
          }),
        ).rejects.toThrow(/another account|isn't private|未发送配对密钥/i);
        expect(decoy1.connections).toBe(0);
        expect(decoy1.received).not.toContain(secretToken);
        expect(decoy1.received).toBe("");
      } finally {
        await decoy1.close();
      }

      // Case 2: Symlink at socket path pointing to a decoy listening socket (even if target is 0o600).
      const realDecoySock = join(dir, "real-decoy.sock");
      const symlinkSock = join(dir, "symlink.sock");
      const decoy2 = await startDecoyUnixServer(realDecoySock, 0o600);
      try {
        await symlink(realDecoySock, symlinkSock);
        await expect(
          legacyAgentClient({
            command: process.execPath,
            args: [shim],
            env: {
              INCARNAMIND_AGENT_SOCKET: symlinkSock,
              INCARNAMIND_AGENT_TOKEN: secretToken,
            },
          }),
        ).rejects.toThrow(/another account|isn't private|未发送配对密钥/i);
        expect(decoy2.connections).toBe(0);
        expect(decoy2.received).toBe("");
      } finally {
        await decoy2.close();
      }

      // Case 3: World-writable parent directory without sticky bit (0o777).
      const openDir = join(dir, "world-open");
      await mkdir(openDir, { mode: 0o777 });
      await chmod(openDir, 0o777);
      const sockInOpenDir = join(openDir, "agents.sock");
      const decoy3 = await startDecoyUnixServer(sockInOpenDir, 0o600);
      try {
        await expect(
          legacyAgentClient({
            command: process.execPath,
            args: [shim],
            env: {
              INCARNAMIND_AGENT_SOCKET: sockInOpenDir,
              INCARNAMIND_AGENT_TOKEN: secretToken,
            },
          }),
        ).rejects.toThrow(/another account|isn't private|未发送配对密钥/i);
        expect(decoy3.connections).toBe(0);
        expect(decoy3.received).toBe("");
      } finally {
        await decoy3.close();
      }

      // Case 4: Another user's per-user fallback directory name (im-<otherUid>).
      const wrongUid = (process.getuid?.() ?? 1000) + 1;
      const foreignFallbackDir = join(dir, `im-${wrongUid}`);
      await mkdir(foreignFallbackDir, { mode: 0o700 });
      const foreignFallbackSock = join(foreignFallbackDir, "incarnamind-0123456789abcdef.sock");
      const decoy4 = await startDecoyUnixServer(foreignFallbackSock, 0o600);
      try {
        await expect(
          legacyAgentClient({
            command: process.execPath,
            args: [shim],
            env: {
              INCARNAMIND_AGENT_SOCKET: foreignFallbackSock,
              INCARNAMIND_AGENT_TOKEN: secretToken,
            },
          }),
        ).rejects.toThrow(/another account|isn't private|未发送配对密钥/i);
        expect(decoy4.connections).toBe(0);
        expect(decoy4.received).toBe("");
      } finally {
        await decoy4.close();
      }

      // Case 5: World-writable ancestor above a 0700 child directory.
      const openAncestor = join(dir, "open-ancestor");
      await mkdir(openAncestor, { mode: 0o777 });
      await chmod(openAncestor, 0o777);
      const nestedChild = join(openAncestor, "private");
      await mkdir(nestedChild, { mode: 0o700 });
      const sockUnderOpenAncestor = join(nestedChild, "agents.sock");
      const decoy5 = await startDecoyUnixServer(sockUnderOpenAncestor, 0o600);
      try {
        await expect(
          legacyAgentClient({
            command: process.execPath,
            args: [shim],
            env: {
              INCARNAMIND_AGENT_SOCKET: sockUnderOpenAncestor,
              INCARNAMIND_AGENT_TOKEN: secretToken,
            },
          }),
        ).rejects.toThrow(/another account|isn't private|未发送配对密钥/i);
        expect(decoy5.connections).toBe(0);
        expect(decoy5.received).toBe("");
      } finally {
        await decoy5.close();
      }
    });

    // protects=the server refuses to bind over symlinks, regular files, world-writable parent dirs, or foreign-owned directories/sockets, surfacing a clear untrusted error without logging secrets; fails_when=server unlinks or binds over an untrusted path
    it("refuses to listen over symlinks, regular files, world-writable dirs, or foreign-owned endpoints", async () => {
      const dir = await createTempDataFolder();
      const base = await agentsAdapter(dir);
      if (!base) throw new Error("No agent adapter.");

      // Regular file squatting the socket path -> server refuses with socketUntrusted and leaves file untouched.
      const regularPath = join(dir, "agents.sock");
      await writeFile(regularPath, "squatted", "utf8");
      const core = startCore(dir, { agents: { ...base, socketPath: regularPath } });
      await expect(core.setAgentsEnabled(true)).rejects.toThrow(
        /held by another account|isn’t private to your account/i,
      );
      expect((await core.getAgents()).enabled).toBe(false);
      expect(await readFile(regularPath, "utf8")).toBe("squatted");
      core.close();

      // Symlink parent directory -> server refuses.
      const realSub = join(dir, "real-sub");
      await mkdir(realSub, { mode: 0o700 });
      const symSub = join(dir, "sym-sub");
      await symlink(realSub, symSub);
      await expect(listenForAgents(join(symSub, "agents.sock"), () => {})).rejects.toMatchObject({
        name: "AgentEndpointError",
        reason: "untrusted",
      });

      // Simulated second OS account owning the fallback /tmp/im-<uid> directory or socket.
      const uid = process.getuid?.() ?? 1000;
      const otherUid = uid + 1;
      const foreignFallback = `/tmp/im-${uid}/incarnamind-0123456789abcdef.sock`;
      await expect(
        listenForAgents(foreignFallback, () => {}, {
          unix: {
            uid,
            mkdir: async () => {},
            lstat: async (target) => {
              if (target === `/tmp/im-${uid}`) {
                return {
                  isDirectory: () => true,
                  isSocket: () => false,
                  isSymbolicLink: () => false,
                  uid: otherUid,
                  gid: otherUid,
                  mode: 0o40700,
                };
              }
              if (target === foreignFallback) {
                throw Object.assign(new Error("missing"), { code: "ENOENT" });
              }
              return lstat(target);
            },
          },
        }),
      ).rejects.toThrow(AgentEndpointError);

      const foreignSock = join(dir, "foreign.sock");
      await expect(
        listenForAgents(foreignSock, () => {}, {
          unix: {
            uid,
            lstat: async (target) => {
              if (target === foreignSock) {
                return {
                  isDirectory: () => false,
                  isSocket: () => true,
                  isSymbolicLink: () => false,
                  uid: otherUid,
                  gid: otherUid,
                  mode: 0o140600,
                };
              }
              return lstat(target);
            },
          },
        }),
      ).rejects.toMatchObject({ name: "AgentEndpointError", reason: "untrusted" });
    });

    // protects=ordinary pairing, restart after stale socket, Local mode, Disconnect, and zero token leaks remain intact after endpoint hardening; fails_when=stale same-account socket blocks restart or a pairing token leaks into logs
    it("preserves stale same-account restart, Local mode, Disconnect, and keeps pairing keys out of logs", async () => {
      const { core, dataDir, log } = await startAgentsCore(scriptedModel(() => ({ text: "ok" })));
      const folder = await core.createLibraryGroup({ name: "Coast", description: "Tides" });
      await core.setAgentsEnabled(true);
      const connected = await core.connectAgent({ name: "Claude Code", folderIds: [folder.id] });
      const token = connected.launch.env.INCARNAMIND_AGENT_TOKEN ?? "";
      expect(token.startsWith("im_")).toBe(true);

      // Local mode pauses access, then turning it off restores access.
      await core.setLocalOnly(true);
      const client = await legacyAgentClient(connected.launch);
      const paused = await client.callTool({ name: "list_minds", arguments: {} });
      expect(paused.isError).toBe(true);
      await core.setLocalOnly(false);
      const active = await client.callTool({ name: "list_minds", arguments: {} });
      expect(active.isError).not.toBe(true);
      await client.close();

      // Disconnect refuses further calls with the existing pairing key.
      await core.disconnectAgent(connected.pairing.id);
      const afterDisconnect = await legacyAgentClient(connected.launch);
      const refused = await afterDisconnect.callTool({ name: "list_minds", arguments: {} });
      expect(refused.isError).toBe(true);
      await afterDisconnect.close();

      core.close();

      // Wait for shutdown to remove its socket, then leave a real stale same-account socket behind
      // (as an ungraceful exit does) and verify restart cleanly replaces it.
      const sock = agentSocketPath(dataDir);
      await vi.waitFor(() => expect(existsSync(sock)).toBe(false));
      spawnSync(
        process.execPath,
        [
          "-e",
          `const net = require("node:net"); const s = net.createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, "SIGKILL"));`,
        ],
        { stdio: "ignore" },
      );
      expect((await lstat(sock)).isSocket()).toBe(true);

      const restarted = startCore(dataDir, { log, agents: await agentsAdapter(dataDir) });
      await restarted.setAgentsEnabled(true);
      const reconnected = await restarted.connectAgent({
        name: "Claude Code",
        folderIds: [folder.id],
      });
      const restartedClient = await legacyAgentClient(reconnected.launch);
      const listed = await restartedClient.callTool({ name: "list_minds", arguments: {} });
      expect(listed.isError).not.toBe(true);
      await restartedClient.close();
      restarted.close();

      // Pairing tokens never appear in logs.
      const allLogs = log.lines.join("\n");
      expect(allLogs).not.toContain(token);
      expect(allLogs).not.toContain(reconnected.launch.env.INCARNAMIND_AGENT_TOKEN ?? "");
    });
  });
});
