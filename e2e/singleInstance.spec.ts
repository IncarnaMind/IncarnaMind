import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { APP_ARGS, homeEnv, KEYCHAIN_ARGS } from "../tests/helpers/home";
import { coreOf, createDataFolder, dismissChatSetup, launchApp, removeDataFolder } from "./app";

/*
 * One copy of the app to a data folder (#1352): a second start brings the first window forward and
 * quits without a window or a core of its own; a copy on another data folder is a copy of its own.
 */

let dataDir: string;
let otherDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  otherDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(otherDir);
});

const logOf = (folder: string) => readFile(join(folder, "logs", "incarnamind.log"), "utf8");

const exited = (child: ChildProcess) =>
  Promise.race([
    once(child, "exit") as Promise<[number | null]>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("The second start didn't quit.")), 30_000),
    ),
  ]);

test("a second start on the same data folder shows the first window and quits; another data folder gets a copy of its own", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const core = await coreOf(window);
  await core.evaluate(async (api) => api.createMind({ title: "Kept" }));

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
  const { execPath, argv, env } = await app.evaluate(() => ({
    execPath: process.execPath,
    argv: process.argv.slice(1),
    env: { ...process.env } as Record<string, string>,
  }));
  const again = spawn(execPath, argv, { env, stdio: "ignore" });
  const [code] = await exited(again);
  expect(code).toBe(0);

  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((each) => each.isVisible()),
      ),
    )
    .toEqual([true]);
  expect(app.windows()).toHaveLength(1);
  const log = await logOf(dataDir);
  expect(log).toContain("app.secondLaunch");
  expect(log).toContain("app.anotherCopyRunning");

  const other = await launchApp(otherDir);
  await dismissChatSetup(other.window);
  const others = await (await coreOf(other.window)).evaluate(async (api) => api.listMinds());
  expect(others).toEqual([]);
  await other.app.close();

  await app.close();
  const next = await launchApp(dataDir);
  const kept = await (await coreOf(next.window)).evaluate(async (api) => api.listMinds());
  expect(kept.map((each) => each.title)).toEqual(["Kept"]);
  await next.app.close();
});

test("a copy that was killed outright leaves the data folder free for the next start", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await (await coreOf(window)).evaluate(async (api) => api.createMind({ title: "Kept" }));
  const gone = once(app.process(), "exit");
  app.process().kill("SIGKILL");
  await gone;

  const next = await launchApp(dataDir);
  const minds = await (await coreOf(next.window)).evaluate(async (api) => api.listMinds());
  expect(minds.map((each) => each.title)).toEqual(["Kept"]);
  await next.app.close();
});

// protects=lock files left as text are emptied at start, so the folder's lock works again, and a second start quits; fails_when=the text stays in them (the lock is off for good); no_claim=the race over such files, which the unit test covers.
test("lock files that aren't databases are emptied, and the folder is locked all the same", async () => {
  const text = "not a database, only text that is long enough ".repeat(8);
  await writeFile(join(dataDir, "instance.lock"), text);
  await writeFile(join(dataDir, "instance.owner"), text);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const { execPath, argv, env } = await app.evaluate(() => ({
    execPath: process.execPath,
    argv: process.argv.slice(1),
    env: { ...process.env } as Record<string, string>,
  }));
  const again = spawn(execPath, argv, { env, stdio: "ignore" });
  const [code] = await exited(again);
  expect(code).toBe(0);
  expect(app.windows()).toHaveLength(1);
  expect(await logOf(dataDir)).toContain("app.anotherCopyRunning");
  expect((await stat(join(dataDir, "instance.lock"))).size).toBe(0);
  expect((await stat(join(dataDir, "instance.owner"))).size).toBe(0);
  await app.close();
});

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

/** How many windows the copy on this DevTools port has, 0 while it isn't listening yet. */
async function windowsOf(port: number): Promise<number> {
  try {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      type: string;
      url: string;
    }[];
    return targets.filter((each) => each.type === "page" && each.url.startsWith("file://")).length;
  } catch {
    return 0;
  }
}

// protects=a double-click on the app's icon leaves one window; fails_when=a second start, arriving
// while the first is still starting, makes a window of its own before the first makes its.
for (const gap of [0, 20, 40, 60, 80]) {
  test(`two starts ${gap} ms apart leave one copy with one window`, async () => {
    test.setTimeout(120_000);
    const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).flatMap(([name, value]) => (value ? [[name, value]] : [])),
      ),
      ...homeEnv(home),
      INCARNAMIND_DATA_DIR: dataDir,
      INCARNAMIND_TEST_HOOKS: "1",
      INCARNAMIND_TEST_EMBEDDER: "fake",
      INCARNAMIND_TEST_TRANSCRIBER: "fake",
      INCARNAMIND_TEST_AUDIO: "fake",
      INCARNAMIND_TEST_CONNECTOR_REGISTRY: "http://127.0.0.1:9",
    };
    delete (env as Record<string, string | undefined>).ELECTRON_RUN_AS_NODE;
    const electronPath = require("electron") as unknown as string;
    const start = (port: number) =>
      spawn(
        electronPath,
        [
          ...KEYCHAIN_ARGS,
          "--no-sandbox",
          `--remote-debugging-port=${port}`,
          resolve(__dirname, ".."),
          ...APP_ARGS,
        ],
        { env, stdio: "ignore" },
      );
    const ports = [await freePort(), await freePort()];
    const [a, b] = ports as [number, number];
    const first = start(a);
    await new Promise((done) => setTimeout(done, gap));
    const copies: ChildProcess[] = [first, start(b)];
    try {
      // Either may take the lock: the one that doesn't quits, and the other is the app.
      const loserIndex = await Promise.race(
        copies.map(async (copy, index) => {
          const [code] = await exited(copy);
          expect(code).toBe(0);
          return index;
        }),
      ).catch(async (error: Error) => {
        const log = await logOf(dataDir).catch(() => "(no log)");
        const windows = [await windowsOf(a), await windowsOf(b)];
        throw new Error(
          `${error.message} Windows of the two copies: ${windows.join(" and ")}.\n${log.split("\n").slice(-30).join("\n")}`,
        );
      });
      const winnerPort = loserIndex === 0 ? b : a;
      await expect.poll(() => windowsOf(winnerPort), { timeout: 60_000 }).toBeGreaterThan(0);
      await new Promise((done) => setTimeout(done, 2_000));
      expect(await windowsOf(winnerPort)).toBe(1);

      // However the two raced for Electron's lock, a start after them quits too.
      const later = start(await freePort());
      copies.push(later);
      const [laterCode] = await exited(later);
      expect(laterCode).toBe(0);
      expect(await windowsOf(winnerPort)).toBe(1);
    } finally {
      for (const copy of copies) copy.kill("SIGKILL");
      await Promise.all(
        copies.map((copy) =>
          copy.exitCode !== null || copy.signalCode !== null ? undefined : once(copy, "exit"),
        ),
      );
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
