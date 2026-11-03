import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Connector } from "../../src/core";
import { createLoginShellProcesses } from "../../src/main/processes";
import {
  isRunning,
  logFileIn,
  NODE,
  serverLog,
  serverStarts,
  TIDE_SERVER,
  testEnvironment,
  testProcesses,
  tideServer,
  waitForState,
} from "../helpers/connectors";
import {
  createMemoryKeychain,
  createTempDataFolder,
  LOCAL_FETCH,
  queryDatabase,
  startCore,
} from "../helpers/core";

/** A core that starts processes with the test's own environment (plus `env`). */
async function setUp(env: Record<string, string> = {}) {
  const dataDir = await createTempDataFolder();
  const keychain = createMemoryKeychain();
  const core = startCore(dataDir, {
    keychain,
    processes: testProcesses(env),
    connectorFetch: LOCAL_FETCH,
  });
  return { core, dataDir, keychain, logFile: logFileIn(dataDir) };
}

/** Every value stored in every table, as text: where a secret must never turn up. */
function everythingStored(dataDir: string): string {
  const tables = queryDatabase<{ name: string }>(
    dataDir,
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  return tables
    .map(({ name }) => JSON.stringify(queryDatabase(dataDir, `SELECT * FROM "${name}"`)))
    .join("\n");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("Adding Connectors", { timeout: 30_000 }, () => {
  test("a Connector added from its command, arguments and environment starts, connects and lists its Tools", async () => {
    const { core, logFile } = await setUp();
    const changes: Connector[][] = [];
    core.on("connectors.changed", (list) => changes.push(list));

    const added = await core.addConnector(tideServer(logFile));

    expect(added).toEqual({
      id: expect.stringMatching(UUID),
      name: "Tides",
      transport: "stdio",
      command: NODE,
      args: [TIDE_SERVER],
      env: ["MCP_TEST_LOG", "TIDE_TOKEN"],
      enabled: true,
      state: "connecting",
      error: null,
      tools: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const ready = await waitForState(core, added.id, "ready");
    expect(ready.tools).toEqual([
      {
        name: "lookup_tide",
        title: "Look up the tides",
        description: "The times of high water at a harbour today.",
        readOnly: true,
      },
      {
        name: "book_boat",
        title: null,
        description: "Books a boat trip from a harbour.",
        readOnly: false,
      },
    ]);
    // Each state change was pushed, ending with "ready".
    expect(changes.map((list) => list[0]?.state)).toEqual(["connecting", "ready"]);
    // The server got its environment.
    const [start] = await serverLog(logFile);
    expect(start).toMatchObject({ event: "start", env: { TIDE_TOKEN: "tide-secret-123" } });
  });

  test("a Connector's environment goes to the keychain, never the database, which keeps the sync-ready rules", async () => {
    const { core, dataDir, keychain, logFile } = await setUp();

    const added = await core.addConnector(tideServer(logFile));
    await waitForState(core, added.id, "ready");

    expect(JSON.parse(keychain.secrets.get(`connector:${added.id}:env`) ?? "{}")).toEqual({
      MCP_TEST_LOG: logFile,
      TIDE_TOKEN: "tide-secret-123",
    });
    expect(everythingStored(dataDir)).not.toContain("tide-secret-123");
    const [row] = queryDatabase<Record<string, unknown>>(dataDir, "SELECT * FROM connectors");
    expect(row).toEqual({
      id: added.id,
      name: "Tides",
      transport: "stdio",
      config: JSON.stringify({
        command: NODE,
        args: [TIDE_SERVER],
        env: ["MCP_TEST_LOG", "TIDE_TOKEN"],
      }),
      enabled: 1,
      created_at: expect.any(String),
      updated_at: expect.any(String),
      deleted_at: null,
    });
  });

  test("names are unique, ignoring case, and what's added is checked", async () => {
    const { core, logFile } = await setUp();
    await core.addConnector(tideServer(logFile));

    await expect(core.addConnector(tideServer(logFile, { name: " tides " }))).rejects.toThrow(
      /already exists/,
    );
    await expect(core.addConnector({ name: "", command: "npx" })).rejects.toThrow(/name/);
    await expect(core.addConnector({ name: "X", command: "  " })).rejects.toThrow(/command/);
    await expect(
      core.addConnector({ name: "X", command: "npx", env: { "BAD NAME": "1" } }),
    ).rejects.toThrow(/environment variable name/);
    expect((await core.listConnectors()).map((each) => each.name)).toEqual(["Tides"]);
  });

  test("when the keychain can't store the environment safely, nothing is added", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      keychain: createMemoryKeychain("unavailable"),
      processes: testProcesses(),
    });

    await expect(core.addConnector(tideServer(logFileIn(dataDir)))).rejects.toThrow(
      /can't be saved|encrypt/,
    );
    expect(await core.listConnectors()).toEqual([]);
  });
});

describe("Importing an mcpServers configuration", { timeout: 30_000 }, () => {
  const configuration = (logFile: string) =>
    JSON.stringify({
      mcpServers: {
        tides: {
          command: NODE,
          args: [TIDE_SERVER],
          env: { MCP_TEST_LOG: logFile, TIDE_TOKEN: "imported-secret" },
        },
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_imported" },
        },
        linear: { url: "https://mcp.linear.app/sse" },
        broken: { args: ["--no-command"] },
        Existing: { command: "uvx", args: ["mcp-server-fetch"] },
      },
    });

  test("shows what will be added first, then adds it; secrets go to the keychain", async () => {
    // No npx on this PATH, so the GitHub server can't download anything.
    const empty = await createTempDataFolder();
    const { core, dataDir, keychain, logFile } = await setUp({ PATH: empty });
    await core.addConnector({ name: "existing", command: "uvx", args: ["mcp-server-fetch"] });

    const preview = await core.previewConnectorImport(configuration(logFile));

    expect(preview).toEqual([
      {
        name: "tides",
        command: NODE,
        args: [TIDE_SERVER],
        env: ["MCP_TEST_LOG", "TIDE_TOKEN"],
        action: "add",
      },
      {
        name: "github",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
        action: "add",
      },
      {
        name: "linear",
        command: null,
        args: [],
        env: [],
        url: "https://mcp.linear.app/sse",
        action: "add",
        headers: [],
        connection: "http",
      },
      { name: "broken", command: null, args: [], env: [], action: "invalid" },
      { name: "Existing", command: "uvx", args: ["mcp-server-fetch"], env: [], action: "exists" },
    ]);
    // Previewing adds nothing.
    expect((await core.listConnectors()).map((each) => each.name)).toEqual(["existing"]);

    const result = await core.importConnectors(configuration(logFile));

    expect(result.added.map((each) => each.name)).toEqual(["tides", "github", "linear"]);
    expect(result.skipped.map((each) => [each.name, each.action])).toEqual([
      ["broken", "invalid"],
      ["Existing", "exists"],
    ]);
    const [tides, github] = result.added as [Connector, Connector];
    await waitForState(core, tides.id, "ready");
    expect(await serverLog(logFile)).toEqual([
      expect.objectContaining({
        event: "start",
        env: expect.objectContaining({ TIDE_TOKEN: "imported-secret" }),
      }),
    ]);
    // npx isn't on this PATH: the error names what to install.
    expect((await waitForState(core, github.id, "error")).error).toEqual({
      kind: "missing-command",
      command: "npx",
      install: "Node.js",
      message: "npx not found: install Node.js.",
      retrying: false,
    });
    expect(keychain.secrets.get(`connector:${github.id}:env`)).toContain("ghp_imported");
    const stored = everythingStored(dataDir);
    expect(stored).not.toContain("ghp_imported");
    expect(stored).not.toContain("imported-secret");
  });

  test("Cursor's configuration, and the servers pasted without mcpServers around them, are read too", async () => {
    const { core } = await setUp();
    const cursor = {
      mcpServers: {
        fetch: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
        remote: { type: "streamable-http", url: "https://example.com/mcp" },
        events: { type: "sse", url: "https://example.com/events" },
        keyed: { url: "https://example.com/mcp", headers: { Authorization: "Bearer k" } },
      },
    };
    const bare = { fetch: { command: "uvx", args: ["mcp-server-fetch"], env: { PORT: 8080 } } };

    expect(
      (await core.previewConnectorImport(JSON.stringify(cursor))).map((each) => each.action),
    ).toEqual(["add", "add", "add", "add"]);
    expect(await core.previewConnectorImport(JSON.stringify(bare))).toEqual([
      { name: "fetch", command: "uvx", args: ["mcp-server-fetch"], env: ["PORT"], action: "add" },
    ]);
  });

  test("text that isn't a configuration is refused, saying why", async () => {
    const { core } = await setUp();

    await expect(core.previewConnectorImport("{ mcpServers: ")).rejects.toThrow(/isn’t valid JSON/);
    await expect(core.previewConnectorImport('{"theme": "dark"}')).rejects.toThrow(
      /No MCP servers found/,
    );
    await expect(core.importConnectors('{"mcpServers": {}}')).rejects.toThrow(/No MCP servers/);
    expect(await core.listConnectors()).toEqual([]);
  });
});

describe("Connector status and errors", { timeout: 30_000 }, () => {
  test("a command that isn't installed gives a plain-language error naming what to install", async () => {
    const empty = await createTempDataFolder();
    const { core } = await setUp({ PATH: empty });

    const npx = await core.addConnector({ name: "GitHub", command: "npx", args: ["-y", "x"] });
    const uvx = await core.addConnector({ name: "Fetch", command: "uvx", args: ["mcp-fetch"] });
    const other = await core.addConnector({ name: "Mine", command: "tide-cli-not-installed" });

    expect((await waitForState(core, npx.id, "error")).error?.message).toBe(
      "npx not found: install Node.js.",
    );
    expect((await waitForState(core, uvx.id, "error")).error).toMatchObject({
      kind: "missing-command",
      command: "uvx",
      install: "uv",
    });
    expect((await waitForState(core, other.id, "error")).error).toEqual({
      kind: "missing-command",
      command: "tide-cli-not-installed",
      install: null,
      message:
        "tide-cli-not-installed not found: check that it is installed, or give its full path.",
      retrying: false,
    });
  });

  test("a script whose runtime isn't installed names the runtime", async () => {
    const dir = await createTempDataFolder();
    const script = join(dir, "server");
    await writeFile(script, "#!/usr/bin/env tide-runtime-not-installed\n", { mode: 0o755 });
    const { core } = await setUp();

    const added = await core.addConnector({ name: "Script", command: script });

    expect((await waitForState(core, added.id, "error")).error).toMatchObject({
      kind: "missing-command",
      command: "tide-runtime-not-installed",
    });
  });

  test("a process that exits says why, from its exit code and error output, and is started again", async () => {
    const { core, dataDir } = await setUp();
    const starts = join(dataDir, "starts.log");
    const exits = [
      `require("node:fs").appendFileSync(${JSON.stringify(starts)}, "x");`,
      'console.error("TIDE_TOKEN is missing");',
      "process.exit(3);",
    ].join(" ");

    const added = await core.addConnector({ name: "Broken", command: NODE, args: ["-e", exits] });

    const failed = await waitForState(core, added.id, "error");
    expect(failed.error).toEqual({
      kind: "stopped",
      command: null,
      install: null,
      message: "Its process exited with code 3.\nTIDE_TOKEN is missing",
      retrying: true,
    });
    // It is started again after a short wait.
    await vi.waitFor(
      async () => expect((await readFile(starts, "utf8")).length).toBeGreaterThanOrEqual(2),
      { timeout: 10_000, interval: 50 },
    );
  });

  test("a Connector that crashes is restarted, and is ready again", async () => {
    const { core, logFile } = await setUp();
    const added = await core.addConnector(tideServer(logFile));
    await waitForState(core, added.id, "ready");
    const [first] = await serverStarts(logFile);

    process.kill(first as number, "SIGKILL");

    const crashed = await waitForState(core, added.id, "error");
    expect(crashed.error).toMatchObject({
      kind: "stopped",
      message: expect.stringContaining("SIGKILL"),
      retrying: true,
    });
    await waitForState(core, added.id, "ready");
    const starts = await serverStarts(logFile);
    expect(starts).toHaveLength(2);
    expect(starts[1]).not.toBe(first);
  });

  test("turning a Connector off stops its process; turning it on starts it again", async () => {
    const { core, logFile } = await setUp();
    const added = await core.addConnector(tideServer(logFile));
    await waitForState(core, added.id, "ready");
    const [pid] = (await serverStarts(logFile)) as [number];

    const off = await core.setConnectorEnabled(added.id, false);

    expect(off).toMatchObject({ enabled: false, state: "off", error: null, tools: null });
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false), { timeout: 10_000 });

    const on = await core.setConnectorEnabled(added.id, true);
    expect(on).toMatchObject({ enabled: true, state: "connecting" });
    await waitForState(core, added.id, "ready");
    const starts = await serverStarts(logFile);
    expect(starts).toHaveLength(2);
    expect(isRunning(starts[1] as number)).toBe(true);
  });

  test("restarting a Connector starts it afresh", async () => {
    const empty = await createTempDataFolder();
    const { core } = await setUp({ PATH: empty });
    const added = await core.addConnector({ name: "GitHub", command: "npx" });
    await waitForState(core, added.id, "error");

    expect((await core.restartConnector(added.id)).state).toBe("connecting");
    await waitForState(core, added.id, "error");

    await core.setConnectorEnabled(added.id, false);
    await expect(core.restartConnector(added.id)).rejects.toThrow(/Turn the Connector on/);
  });

  test("deleting a Connector stops it, removes its environment from the keychain, and keeps a soft-deleted row", async () => {
    const { core, dataDir, keychain, logFile } = await setUp();
    const added = await core.addConnector(tideServer(logFile));
    await waitForState(core, added.id, "ready");
    const [pid] = (await serverStarts(logFile)) as [number];

    await core.deleteConnector(added.id);

    expect(await core.listConnectors()).toEqual([]);
    expect(keychain.secrets.has(`connector:${added.id}:env`)).toBe(false);
    expect(queryDatabase(dataDir, "SELECT deleted_at FROM connectors")).toEqual([
      { deleted_at: expect.any(String) },
    ]);
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false), { timeout: 10_000 });
    await expect(core.deleteConnector(added.id)).rejects.toThrow(/doesn’t exist/);
    // The name is free again.
    await core.addConnector(tideServer(logFile));
  });
});

describe("The login-shell environment", { timeout: 30_000 }, () => {
  test("Connectors start with the User's login-shell environment", async () => {
    const dir = await createTempDataFolder();
    const shell = join(dir, "fake-shell");
    // Like `zsh -ilc <command>`: runs the User's profile, then the command.
    await writeFile(
      shell,
      [
        "#!/bin/sh",
        'echo "Welcome back! (from the profile)"',
        "export LOGIN_SHELL_MARKER=from-the-login-shell",
        'eval "$2"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      processes: createLoginShellProcesses({
        shell,
        platform: "darwin",
        env: testEnvironment({ LOGIN_SHELL_MARKER: "" }),
      }),
    });
    const logFile = logFileIn(dataDir);

    const added = await core.addConnector(tideServer(logFile));

    await waitForState(core, added.id, "ready");
    const [start] = await serverLog(logFile);
    expect(start).toMatchObject({ env: { LOGIN_SHELL_MARKER: "from-the-login-shell" } });
  });
});

describe("Connectors and restarts", { timeout: 30_000 }, () => {
  test("Connectors, their environments and whether they are on survive a restart; those on start with the app", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const logFile = logFileIn(dataDir);
    const offLog = logFileIn(dataDir, "off.log");
    const first = startCore(dataDir, { keychain, processes: testProcesses() });
    const on = await first.addConnector(tideServer(logFile));
    const off = await first.addConnector(tideServer(offLog, { name: "Spare tides" }));
    await waitForState(first, on.id, "ready");
    await waitForState(first, off.id, "ready");
    await first.setConnectorEnabled(off.id, false);
    const [pid] = (await serverStarts(logFile)) as [number];

    // Closing the core shuts its Connectors down.
    first.close();
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false), { timeout: 10_000 });

    const second = startCore(dataDir, { keychain, processes: testProcesses() });
    expect(
      (await second.listConnectors()).map((each) => ({
        name: each.name,
        enabled: each.enabled,
        env: each.transport === "stdio" ? each.env : null,
      })),
    ).toEqual([
      { name: "Spare tides", enabled: false, env: ["MCP_TEST_LOG", "TIDE_TOKEN"] },
      { name: "Tides", enabled: true, env: ["MCP_TEST_LOG", "TIDE_TOKEN"] },
    ]);
    const ready = await waitForState(second, on.id, "ready");
    expect(ready.tools?.map((tool) => tool.name)).toEqual(["lookup_tide", "book_boat"]);
    const starts = await serverLog(logFile);
    expect(starts.at(-1)).toMatchObject({ event: "start", env: { TIDE_TOKEN: "tide-secret-123" } });
    // The one turned off stays off: it didn't start again.
    expect(await serverStarts(offLog)).toHaveLength(1);
    expect((await second.listConnectors()).find((each) => each.id === off.id)?.state).toBe("off");
  });

  test("on a device whose keychain lacks a Connector's environment, it says so", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir, { processes: testProcesses() });
    const added = await first.addConnector(tideServer(logFileIn(dataDir)));
    await waitForState(first, added.id, "ready");
    first.close();

    const second = startCore(dataDir, {
      keychain: createMemoryKeychain(),
      processes: testProcesses(),
    });

    expect((await waitForState(second, added.id, "error")).error).toMatchObject({
      kind: "missing-secrets",
      retrying: false,
    });
  });
});

describe("Editing a local Connector", { timeout: 30_000 }, () => {
  test("a Connector added with its whole command line as the command is fixed by editing it, and keeps its environment", async () => {
    const { core, logFile, keychain } = await setUp();
    const broken = await core.addConnector({
      ...tideServer(logFile),
      command: `${NODE} ${TIDE_SERVER}`,
      args: [],
    });
    const failed = await waitForState(core, broken.id, "error");
    expect(failed.error?.kind).toBe("missing-command");

    // No environment given: the saved values stay, in the keychain.
    const edited = await core.editConnector(broken.id, {
      name: "Tide tables",
      command: NODE,
      args: [TIDE_SERVER],
    });
    expect(edited).toMatchObject({
      id: broken.id,
      name: "Tide tables",
      command: NODE,
      args: [TIDE_SERVER],
      env: ["MCP_TEST_LOG", "TIDE_TOKEN"],
    });
    const ready = await waitForState(core, broken.id, "ready");
    expect(ready.tools?.map((tool) => tool.name)).toEqual(["lookup_tide", "book_boat"]);
    expect([...keychain.secrets.values()].join("\n")).toContain("tide-secret-123");
  });

  test("a name another Connector has is refused, and a remote Connector's command can't be set", async () => {
    const { core, logFile } = await setUp();
    const tides = await core.addConnector(tideServer(logFile));
    const other = await core.addConnector({ ...tideServer(logFile), name: "Other" });
    await expect(
      core.editConnector(other.id, { name: "tides", command: NODE, args: [TIDE_SERVER] }),
    ).rejects.toThrow("A Connector named “tides” already exists.");
    // A server on this computer that isn't there: nothing goes over the network.
    const remote = await core.addConnector({ name: "Harbour", url: "http://127.0.0.1:9/mcp" });
    await expect(
      core.editConnector(remote.id, { name: "Harbour", command: NODE, args: [] }),
    ).rejects.toThrow("Only a local Connector's command can be changed.");
    expect((await core.listConnectors()).map((each) => each.name)).toEqual([
      "Harbour",
      "Other",
      "Tides",
    ]);
    await core.setConnectorEnabled(tides.id, false);
  });
});
