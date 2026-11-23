import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test } from "@playwright/test";
import { agentSocketPath } from "../../src/core/agents/socket";
import type { AgentLaunch } from "../../src/core/api";
import {
  agentSocketAnswers,
  cursorLaunch,
  cursorSettingsFromGuide,
  legacyAgentClient,
  modernAgentClient,
  redactAgentKeys,
} from "../../tests/helpers/agentClients";
import { acceptPlainTextKeys, coreOf, dismissChatSetup, setWindowSize, writeNote } from "../app";
import { launchPackaged, packagedExecutable, packagedLogLines } from "./app";

test.use({ trace: "off" });
test.setTimeout(3 * 60_000);

let folders: string[] = [];
let dataFolder: string | null = null;
test.afterEach(async () => {
  const info = test.info();
  if (dataFolder && info.status !== info.expectedStatus) {
    const log = redactAgentKeys((await packagedLogLines(dataFolder, /./)).join("\n"));
    await mkdir(info.outputDir, { recursive: true });
    const path = info.outputPath("app.log");
    await writeFile(path, log);
    await info.attach("app-log", { path, contentType: "text/plain" });
    console.info(`Retained the failing app's data at ${dataFolder}`);
    folders = [];
    dataFolder = null;
    return;
  }
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
  folders = [];
  dataFolder = null;
});

/**
 * Runs the packaged shim with a protocol-matching opening JSON-RPC request and
 * returns the first JSON-RPC reply line and stderr, to verify the plain-word
 * refusal message even when a pinned 2026-07-28 SDK client wraps the error.
 */
async function probePackagedShimRefusal(
  launch: AgentLaunch,
  protocol: "2025-11-25" | "2026-07-28",
): Promise<{ message: string; stderr: string }> {
  const child = spawn(launch.command, launch.args, {
    env: { ...process.env, ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
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
  const request =
    protocol === "2026-07-28"
      ? { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }
      : {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "packaged-test", version: "1.0.0" },
          },
        };
  try {
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for packaged shim refusal (stderr: ${stderr})`));
      }, 10_000);
      const finish = (value: string) => {
        clearTimeout(timer);
        child.stdout.off("data", check);
        resolve(value);
      };
      const check = () => {
        const nl = stdout.indexOf("\n");
        if (nl !== -1) finish(stdout.slice(0, nl).trim());
      };
      child.stdout.on("data", check);
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("close", () => finish(stdout.trim()));
      child.stdin.write(`${JSON.stringify(request)}\n`);
      check();
    });
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", () => resolve());
    });
    if (!line) throw new Error(`Packaged shim exited without a JSON-RPC reply (stderr: ${stderr})`);
    const parsed = JSON.parse(line) as { error?: { message?: string } };
    return { message: parsed.error?.message ?? "", stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

for (const [protocol, documents] of [
  ["2025-11-25", false],
  ["2025-11-25", true],
  ["2026-07-28", false],
  ["2026-07-28", true],
] as const) {
  test(`with Documents ${documents ? "present" : "missing"}, the packaged shim searches and checks Citations with ${protocol}, and refuses unpaired, paused and revoked access`, async () => {
    expect(existsSync(packagedExecutable)).toBe(true);
    const home = await mkdtemp(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "incarnamind-mcp-home-"),
    );
    const data = await mkdtemp(join(tmpdir(), "incarnamind-mcp-data-"));
    const sources = await mkdtemp(join(tmpdir(), "incarnamind-mcp-sources-"));
    folders = [home, data, sources];
    dataFolder = data;
    expect(existsSync(join(home, "Documents"))).toBe(false);
    const file = join(sources, "Tides.md");
    await writeFile(file, "Spring tides happen at new moon and full moon.");
    const app = await test.step(
      "Launch the packaged app",
      () => launchPackaged(home, data, { testHooks: true, documents }),
      { box: true },
    );
    const connect = protocol === "2026-07-28" ? modernAgentClient : legacyAgentClient;
    try {
      const window = await test.step("Reach the app window", () => app.firstWindow(), {
        box: true,
      });
      expect(existsSync(join(home, "Documents"))).toBe(documents);
      await setWindowSize(app, window, 900, 700);
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      const core = await coreOf(window);
      expect(await core.evaluate((bridge) => bridge.getAgents())).toMatchObject({
        enabled: false,
        pairings: [],
      });
      const folder = await core.evaluate((bridge) =>
        bridge.createLibraryGroup({ name: "Coast", description: "Tides" }),
      );
      const added = await core.evaluate(
        (bridge, input) => bridge.addDocuments([input.file], { groupId: input.folder }),
        { file, folder: folder.id },
      );
      await expect
        .poll(
          () =>
            core.evaluate(
              async (bridge, id) =>
                (await bridge.listDocuments())
                  .filter((document) => id.includes(document.id))
                  .map((document) => document.status),
              added.added,
            ),
          { timeout: 0 },
        )
        .toEqual(["ready"]);
      const hiddenFolder = await core.evaluate((bridge) =>
        bridge.createLibraryGroup({ name: "Private archive", description: "Not shared" }),
      );
      const hiddenFile = join(sources, "Private-tides.md");
      await writeFile(hiddenFile, "Spring tides have the private archive marker rosewood.");
      const hiddenAdded = await core.evaluate(
        (bridge, input) => bridge.addDocuments([input.file], { groupId: input.folder }),
        { file: hiddenFile, folder: hiddenFolder.id },
      );
      await expect
        .poll(
          () =>
            core.evaluate(
              async (bridge, id) =>
                (await bridge.listDocuments())
                  .filter((document) => id.includes(document.id))
                  .map((document) => document.status),
              hiddenAdded.added,
            ),
          { timeout: 0 },
        )
        .toEqual(["ready"]);
      await core.evaluate((bridge) => bridge.setAgentsEnabled(true));
      const connected = await core.evaluate(
        (bridge, id) => bridge.setUpAgent({ client: "codex", folderIds: [id] }),
        folder.id,
      );
      expect(
        await readFile(join(home, ".agents", "skills", "incarnamind", "SKILL.md"), "utf8"),
      ).toContain("name: incarnamind");
      const launch = await core.evaluate(
        (bridge, id) => bridge.getAgentLaunch(id),
        connected.pairing.id,
      );
      expect(await realpath(launch.command)).toBe(await realpath(packagedExecutable));
      const socket = launch.env.INCARNAMIND_AGENT_SOCKET ?? "";
      if (process.platform === "win32") {
        expect(socket.startsWith("\\\\.\\pipe\\")).toBe(true);
        expect(socket === agentSocketPath(data, "win32")).toBe(true);
      }
      expect(await agentSocketAnswers(socket)).toBe(true);
      if (process.platform !== "win32") expect((await stat(socket)).mode & 0o777).toBe(0o600);
      const settings = join(home, ".cursor", "mcp.json");
      await mkdir(join(home, ".cursor"), { recursive: true });
      await writeFile(settings, await cursorSettingsFromGuide(launch), { mode: 0o600 });
      const client = await test.step(
        "Complete the pairing and MCP handshake using the Cursor guide's file",
        async () => connect(cursorLaunch(JSON.parse(await readFile(settings, "utf8")))),
        { box: true },
      );
      try {
        const found = await client.callTool({
          name: "search",
          arguments: { query: "spring tides new moon" },
        });
        const output = found.structuredContent as { passages: { passageId: string }[] };
        const cited = await client.callTool({
          name: "cite",
          arguments: {
            citations: [
              {
                passageId: output.passages[0]?.passageId,
                quote: "Spring tides happen at new moon and full moon.",
              },
            ],
          },
        });
        const cite = (cited.structuredContent as { citations: { cite: string | null }[] })
          .citations[0]?.cite;
        expect(cite).toMatch(/^\[cite:[a-z0-9]{8}\]$/);
        const checked = await client.callTool({
          name: "check_citations",
          arguments: { text: `Spring tides come at new moon ${cite}.` },
        });
        expect(checked.structuredContent).toMatchObject({ citations: [{ check: "found" }] });
        const hidden = await client.callTool({
          name: "search",
          arguments: { query: "rosewood", folderIds: [hiddenFolder.id] },
        });
        expect(hidden.isError).toBe(true);
        await core.evaluate((bridge) => bridge.setLocalOnly(true));
        expect(
          (await client.callTool({ name: "search", arguments: { query: "spring tides" } })).isError,
        ).toBe(true);
        await core.evaluate((bridge) => bridge.setLocalOnly(false));
        await core.evaluate(
          (bridge, id) => bridge.updateAgent(id, { folderIds: [] }),
          connected.pairing.id,
        );
        expect(
          (await client.callTool({ name: "search", arguments: { query: "spring tides" } })).isError,
        ).toBe(true);
        const activity = await core.evaluate(
          (bridge, id) => bridge.listAgentActivity(id),
          connected.pairing.id,
        );
        expect(JSON.stringify(activity).includes(launch.env.INCARNAMIND_AGENT_TOKEN ?? "")).toBe(
          false,
        );
        await core.evaluate((bridge, id) => bridge.disconnectAgent(id), connected.pairing.id);
      } finally {
        await client.close();
      }
      const expectRefusedBeforeMcp = async (target: AgentLaunch) => {
        if (protocol === "2025-11-25") {
          await expect(connect(target)).rejects.toThrow(/no longer connected/);
        } else {
          await expect(connect(target)).rejects.toThrow();
        }
        const probed = await probePackagedShimRefusal(target, protocol);
        expect(probed.message).toMatch(/no longer connected/);
        const token = target.env.INCARNAMIND_AGENT_TOKEN ?? "";
        if (token) expect(probed.stderr).not.toContain(token);
      };
      await expectRefusedBeforeMcp(launch);
      await expectRefusedBeforeMcp({
        ...launch,
        env: { ...launch.env, INCARNAMIND_AGENT_TOKEN: "unpaired-test-agent" },
      });
      expect(existsSync(join(home, ".agents", "skills", "incarnamind", "SKILL.md"))).toBe(false);
      const log = (await packagedLogLines(data, /./)).join("\n");
      expect(log.includes(launch.env.INCARNAMIND_AGENT_TOKEN ?? "")).toBe(false);
    } finally {
      await app.close();
    }
  });
}

/** Whether a process with this id is still running. */
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/*
 * A check pressed with no model set up runs on the User's own Codex in the background (#3639): the
 * packaged app finds `codex` on the login shell's PATH and starts it, and Codex starts the packaged
 * shim from the settings it was given. A Node script stands in for Codex (e2e/fixtures/fakeCodex.mjs),
 * starting the shim in a process group of its own as Codex does. Its marks land through the shim,
 * and Stop ends Codex and the shim on each system: the process group on macOS and Linux, the
 * process tree on Windows.
 */
test("a check on the User's own Codex lands through the packaged shim, from a temporary folder with an & in its name, and Stop ends Codex and the shim", async () => {
  expect(existsSync(packagedExecutable)).toBe(true);
  const home = await mkdtemp(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "incarnamind-codex-home-"),
  );
  const data = await mkdtemp(join(tmpdir(), "incarnamind-codex-data-"));
  const sources = await mkdtemp(join(tmpdir(), "incarnamind-codex-sources-"));
  const bin = await mkdtemp(join(tmpdir(), "incarnamind-codex-bin-"));
  folders = [home, data, sources, bin];
  dataFolder = data;
  const fake = join(__dirname, "..", "fixtures", "fakeCodex.mjs");
  if (process.platform === "win32") {
    await writeFile(join(bin, "codex.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);
  } else {
    await writeFile(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    await chmod(join(bin, "codex"), 0o755);
  }
  const mode = join(bin, "mode");
  // A temporary folder whose name holds an &, which Windows' cmd.exe acts on: the run's folder is
  // in it, so every path Codex is given carries one, through npm's codex.cmd and its %*.
  const temp = join(home, "Temp", "Tom&Jerry");
  await mkdir(temp, { recursive: true });
  const file = join(sources, "Tides.md");
  await writeFile(file, "Spring tides happen at new moon and full moon.");
  const app = await test.step(
    "Launch the packaged app with a stand-in codex on its PATH",
    () =>
      launchPackaged(home, data, {
        testHooks: true,
        env: {
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          INCARNAMIND_TEST_OWN_AI_MODE_FILE: mode,
          TMPDIR: temp,
          TMP: temp,
          TEMP: temp,
        },
      }),
    { box: true },
  );
  try {
    const window = await app.firstWindow();
    await setWindowSize(app, window, 900, 700);
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    const core = await coreOf(window);
    const folder = await core.evaluate((bridge) =>
      bridge.createLibraryGroup({ name: "Coast", description: "Tides" }),
    );
    const added = await core.evaluate(
      (bridge, input) => bridge.addDocuments([input.file], { groupId: input.folder }),
      { file, folder: folder.id },
    );
    await expect
      .poll(async () =>
        (await core.evaluate((bridge) => bridge.listDocuments()))
          .filter((document) => added.added.includes(document.id))
          .map((document) => document.status),
      )
      .toEqual(["ready"]);
    await core.evaluate((bridge) => bridge.setAgentsEnabled(true));
    const codex = await core.evaluate(
      (bridge, id) =>
        bridge.connectAgent({ name: "ChatGPT app and Codex", client: "codex", folderIds: [id] }),
      folder.id,
    );
    const mindId = await writeNote(
      window,
      "Tide notes",
      [{ text: "Spring tides happen at new moon and full moon." }],
      { folderId: folder.id },
    );
    const reported = async () =>
      (await core.evaluate((bridge, id) => bridge.listAgentActivity(id), codex.pairing.id)).some(
        (activity) => activity.tool === "report_check" && activity.outcome === "done",
      );

    await test.step("A check lands through the packaged shim", async () => {
      await writeFile(mode, "check");
      expect(await core.evaluate((bridge, id) => bridge.checkWithOwnAi(id), mindId)).toMatchObject({
        kind: "started",
      });
      await expect.poll(reported, { timeout: 60_000 }).toBe(true);
    });

    await test.step("Stop ends Codex and the shim it started", async () => {
      await writeFile(mode, "wait");
      // Another Note: the first one's run may not have ended yet, and a Note runs one at a time.
      const other = await writeNote(
        window,
        "Tide notes, second draft",
        [{ text: "Neap tides come at the quarter moons." }],
        { folderId: folder.id },
      );
      expect(await core.evaluate((bridge, id) => bridge.checkWithOwnAi(id), other)).toMatchObject({
        kind: "started",
      });
      await expect.poll(() => existsSync(join(bin, "pids")), { timeout: 60_000 }).toBe(true);
      const pids = (await readFile(join(bin, "pids"), "utf8")).split(" ").map(Number);
      expect(pids.filter(running)).toEqual(pids);
      await core.evaluate((bridge, id) => bridge.stopOwnAiCheck(id), other);
      await expect.poll(() => pids.filter(running), { timeout: 10_000 }).toEqual([]);
    });
  } finally {
    await app.close();
  }
});
