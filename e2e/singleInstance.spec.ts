import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, expect, type Page, test } from "@playwright/test";
import { heldByAnotherCopy } from "../src/main/instanceLock";
import { APP_ARGS, homeEnv, KEYCHAIN_ARGS } from "../tests/helpers/home";
import { coreOf, createDataFolder, dismissChatSetup, launchApp, removeDataFolder } from "./app";
import { startAnotherCopy } from "./secondCopy";

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
  const again = await startAnotherCopy(app);
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
  const again = await startAnotherCopy(app);
  const [code] = await exited(again);
  expect(code).toBe(0);
  expect(app.windows()).toHaveLength(1);
  expect(await logOf(dataDir)).toContain("app.anotherCopyRunning");
  expect((await stat(join(dataDir, "instance.lock"))).size).toBe(0);
  expect((await stat(join(dataDir, "instance.owner"))).size).toBe(0);
  await app.close();
});

/** Starts a copy on `dataDir` outside Playwright, with what `launchApp` gives one; `args` go before the app's folder. */
function startCopy(
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): ChildProcess {
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).flatMap(([name, value]) => (value ? [[name, value]] : [])),
    ),
    ...homeEnv(home),
    TMPDIR: home,
    INCARNAMIND_DATA_DIR: dataDir,
    INCARNAMIND_TEST_HOOKS: "1",
    INCARNAMIND_TEST_EMBEDDER: "fake",
    INCARNAMIND_TEST_TRANSCRIBER: "fake",
    INCARNAMIND_TEST_AUDIO: "fake",
    INCARNAMIND_TEST_CONNECTOR_REGISTRY: "http://127.0.0.1:9",
    ...extraEnv,
  };
  delete (env as Record<string, string | undefined>).ELECTRON_RUN_AS_NODE;
  delete (env as Record<string, string | undefined>).INCARNAMIND_CHATGPT_PROFILE;
  delete (env as Record<string, string | undefined>).ELECTRON_RENDERER_URL;
  const electronPath = require("electron") as unknown as string;
  return spawn(
    electronPath,
    [...KEYCHAIN_ARGS, "--no-sandbox", ...args, resolve(__dirname, ".."), ...APP_ARGS],
    { env, stdio: "ignore", detached: true },
  );
}

// protects=a data folder another copy keeps busy starts nothing and says so, in a box the User
// sees on Linux too (#1493); fails_when=the box is asked for before `ready`, when Linux only
// writes it to stderr, or isn't asked for, or the core starts.
test("a data folder kept busy by a stuck copy starts nothing, and says so once the app is ready", async () => {
  test.setTimeout(90_000);
  const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
  const boxes = join(home, "error-boxes.jsonl");
  // A copy stopped between its two locks: it holds instance.lock and not instance.owner.
  const stuck = new DatabaseSync(join(dataDir, "instance.lock"));
  stuck.exec("PRAGMA locking_mode = EXCLUSIVE");
  stuck.exec("BEGIN EXCLUSIVE");
  const copy = startCopy(home, ["-r", join(__dirname, "errorBoxes.cjs")], {
    INCARNAMIND_TEST_ERROR_BOXES: boxes,
  });
  try {
    const [code] = await exited(copy);
    expect(code).toBe(0);
    const shown = (await readFile(boxes, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(shown).toEqual([
      {
        title: "IncarnaMind couldn’t start",
        content:
          "IncarnaMind couldn’t open its data folder. Another copy may still be starting. Try again in a moment.",
        ready: true,
      },
    ]);
    expect(await logOf(dataDir)).toContain("app.dataFolderBusy");
    expect(existsSync(join(dataDir, "incarnamind.db"))).toBe(false);
  } finally {
    stuck.close();
    if (copy.exitCode === null && copy.signalCode === null) {
      const gone = once(copy, "exit");
      copy.kill("SIGKILL");
      await gone;
    }
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  }
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

async function inCopyWindow(port: number | undefined, use: (window: Page) => Promise<void>) {
  if (port === undefined) throw new Error("The copy has no DevTools port.");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const window = browser.contexts()[0]?.pages()[0];
    if (!window) throw new Error("The copy has no window.");
    await window.getByTestId("plus-menu").waitFor();
    await use(window);
  } finally {
    await browser.close();
  }
}

// protects=a double-click on the app's icon leaves one window; fails_when=a second start, arriving
// while the first is still starting, makes a window of its own before the first makes its.
for (const gap of [0, 20, 40, 60, 80]) {
  test(`two starts ${gap} ms apart leave one copy with one window`, async () => {
    test.setTimeout(120_000);
    const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
    const start = (port: number) => startCopy(home, [`--remote-debugging-port=${port}`]);
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
      );
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

/**
 * The copies started with this switch, and those they started again: main processes only, or
 * with `relaunching` the helpers waiting to start one too.
 */
function copiesWith(tag: string, relaunching = false): number[] {
  const listing = execFileSync("ps", ["-A", "-ww", "-o", "pid=", "-o", "args="], {
    encoding: "utf8",
  });
  return listing.split("\n").flatMap((line) => {
    const [, pid, args = ""] = line.trim().match(/^(\d+)\s+(.*)$/) ?? [];
    const main = !args.includes("--type=") || (relaunching && args.includes("--type=relauncher"));
    return pid && args.includes(tag) && main ? [Number(pid)] : [];
  });
}

const killAll = (pids: number[]) => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
};

/**
 * Starts a copy, then `starts` more that ask for the data folder while it quits
 * (`startDuringQuit.cjs`), and waits until one copy is left, with one window. A start after that
 * must come to that window and quit.
 */
async function startWhileQuitting(
  how: "quit" | "quit-twice" | "crash" | "after-release",
  starts: number,
  { stallAgain = false, language = "en-US" } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
  const boxes = join(home, "error-boxes.jsonl");
  const mark = join(home, "quit-started");
  const attempts = join(home, "startup-attempts.jsonl");
  const tag = `--incarnamind-smoke-copy=${randomUUID()}`;
  const ports: number[] = [];
  const late = how === "after-release";
  const spawned: ChildProcess[] = [];
  const start = async (extraEnv: Record<string, string> = {}) => {
    const port = await freePort();
    ports.push(port);
    const copy = startCopy(
      home,
      [
        tag,
        `--remote-debugging-port=${port}`,
        ...["-r", join(__dirname, "errorBoxes.cjs"), "-r", join(__dirname, "startDuringQuit.cjs")],
      ],
      {
        INCARNAMIND_TEST_ERROR_BOXES: boxes,
        INCARNAMIND_TEST_ERROR_LANGUAGE: language,
        ...extraEnv,
      },
    );
    spawned.push(copy);
    return copy;
  };
  const left = async () => ({
    copies: copiesWith(tag).length,
    windows: (await Promise.all(ports.map(windowsOf))).reduce((sum, each) => sum + each, 0),
  });
  try {
    await start({ INCARNAMIND_TEST_QUIT_MARK: mark, INCARNAMIND_TEST_QUIT_ON_START: how });
    await expect.poll(() => windowsOf(ports[0] as number), { timeout: 60_000 }).toBe(1);
    if (late) {
      await inCopyWindow(ports[0], async (window) => {
        await (await coreOf(window)).evaluate((api) =>
          api.createMind({ title: "Kept during quit" }),
        );
      });
    }
    for (let index = 0; index < starts; index += 1) {
      await start({
        INCARNAMIND_TEST_QUIT_MARK: mark,
        ...(late && { INCARNAMIND_TEST_QUIT_AFTER_RELEASE: "1" }),
        ...(stallAgain && { INCARNAMIND_TEST_STALL_STARTUP: attempts }),
      });
    }
    if (stallAgain) {
      await expect.poll(left, { timeout: 20_000 }).toEqual({ copies: 0, windows: 0 });
      const tried = (await readFile(attempts, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { pid: number; args: string[] });
      expect(tried).toHaveLength(2);
      expect(tried[0]?.args).not.toContain("--started-again-after-stall");
      expect(tried[1]?.args).toContain("--started-again-after-stall");
      expect(tried[0]?.pid).not.toBe(tried[1]?.pid);
      const shown = (await readFile(boxes, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(shown).toEqual([
        {
          title: language === "zh-CN" ? "IncarnaMind 无法启动" : "IncarnaMind couldn’t start",
          content:
            language === "zh-CN"
              ? "另一个副本正在退出，IncarnaMind 无法打开窗口。数据未改动，请重新打开 IncarnaMind。"
              : "IncarnaMind couldn’t open its window while another copy was quitting. Your data is unchanged. Open IncarnaMind again.",
          ready: true,
        },
      ]);
      return;
    }
    await expect
      .poll(left, { timeout: late ? 20_000 : 90_000, message: "one copy is left, with a window" })
      .toEqual({ copies: 1, windows: 1 });

    if (late) {
      const winner = (await Promise.all(ports.map(windowsOf))).indexOf(1);
      await inCopyWindow(ports[winner], async (window) => {
        const minds = await (await coreOf(window)).evaluate((api) => api.listMinds());
        expect(minds.map((mind) => mind.title)).toEqual(["Kept during quit"]);
      });
    }
    const [code] = await exited(await start());
    expect(code).toBe(0);
    await expect.poll(left, { timeout: 30_000 }).toEqual({ copies: 1, windows: 1 });
    expect(existsSync(boxes)).toBe(false);
  } finally {
    try {
      await test.info().attach(`quit-${how}`, {
        body: JSON.stringify({
          state: await left(),
          pids: copiesWith(tag),
          dataFolderHeld: heldByAnotherCopy(dataDir, (what, error) => {
            throw new Error(what, { cause: error });
          }),
          log: await logOf(dataDir).catch((error: unknown) => `Log unavailable: ${String(error)}`),
          events: existsSync(`${mark}.events`) ? await readFile(`${mark}.events`, "utf8") : "",
          attempts: existsSync(attempts) ? await readFile(attempts, "utf8") : "",
        }),
        contentType: "application/json",
      });
    } finally {
      await expect
        .poll(
          () => {
            killAll(copiesWith(tag, true));
            killAll(spawned.flatMap((copy) => (copy.pid ? [-copy.pid] : [])));
            return copiesWith(tag, true);
          },
          { timeout: 30_000 },
        )
        .toEqual([]);
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

// protects=a start that arrives while the app quits ends with one copy, with a window (#1448);
// fails_when=that start sits with no window and holds the data folder, so every later start
// quits, or it hands over to the quitting copy and nothing opens.
test("starts while the app quits, crashes or quits twice each end with one window", async () => {
  test.skip(process.platform === "win32", "lists the copies with ps");
  test.setTimeout(600_000);
  for (const how of ["quit", "quit", "quit-twice", "crash"] as const) {
    await test.step(how, () => startWhileQuitting(how, 1));
  }
});

// protects=a double-click storm during a quit leaves one copy with one window (#1448);
// fails_when=one of the five starts is left with no window, or none of them opens.
test("five starts in a row while the app quits leave one window", async () => {
  test.skip(process.platform === "win32", "lists the copies with ps");
  test.setTimeout(300_000);
  await startWhileQuitting("quit", 5);
});

// protects=a start after the data lock is released but before Electron exits recovers a usable window (#1448); fails_when=the pre-lock snapshot misses the quitting copy and no recovery is armed.
test("a start after data-lock release during quit opens a usable window with the existing data", async () => {
  test.skip(process.platform === "win32", "lists the copies with ps");
  await startWhileQuitting("after-release", 1);
  const next = await launchApp(dataDir);
  try {
    const minds = await (await coreOf(next.window)).evaluate((api) => api.listMinds());
    expect(minds.map((mind) => mind.title)).toEqual(["Kept during quit"]);
  } finally {
    await next.app.close();
  }
});

for (const language of ["en-US", "zh-CN"]) {
  test(`a real startup retry that also stalls shows a plain problem and frees the data folder (${language})`, async () => {
    test.skip(process.platform !== "darwin", "the native ready stall is specific to macOS");
    await startWhileQuitting("after-release", 1, { stallAgain: true, language });
    const next = await launchApp(dataDir);
    try {
      const minds = await (await coreOf(next.window)).evaluate((api) => api.listMinds());
      expect(minds.map((mind) => mind.title)).toEqual(["Kept during quit"]);
    } finally {
      await next.app.close();
    }
  });
}

for (const { language, succeeds } of [
  { language: "en", succeeds: false },
  { language: "zh-CN", succeeds: false },
  { language: "en", succeeds: true },
] as const) {
  test(`an update ${succeeds ? "succeeds" : "fails after a second start"}, closes its owned core and reopens (${language})`, async () => {
    test.skip(process.platform === "win32", "lists the copies with ps");
    test.setTimeout(120_000);
    const home = await mkdtemp(join(tmpdir(), "incarnamind-update-"));
    const events = join(home, "events.jsonl");
    const tag = `--incarnamind-smoke-copy=${randomUUID()}`;
    const port = await freePort();
    const nextPort = await freePort();
    const windowPort = succeeds && process.platform === "linux" ? nextPort : port;
    const start = (first: boolean, debugPort: number) => {
      const copy = startCopy(
        home,
        [tag, `--remote-debugging-port=${debugPort}`, "-r", join(__dirname, "updateFailure.cjs")],
        {
          INCARNAMIND_TEST_HOOKS: "0",
          INCARNAMIND_TEST_UPDATE_FOLDER: home,
          INCARNAMIND_TEST_UPDATE_APP: resolve(__dirname, ".."),
          INCARNAMIND_TEST_UPDATE_NEXT_PORT: String(nextPort),
          INCARNAMIND_TEST_UPDATE_SUCCEEDS: succeeds ? "1" : "0",
          INCARNAMIND_TEST_UPDATE_FIRST: first ? "1" : "0",
          APPIMAGE: process.platform === "linux" ? require("electron") : "",
        },
      );
      return copy;
    };
    const entries = async () =>
      (await readFile(events, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              kind: string;
              pid: number;
              native: boolean;
              dataHeld?: boolean;
              first?: boolean;
              args?: string[];
              options?: { args?: string[]; message?: string; detail?: string; buttons?: string[] };
            },
        );
    try {
      const old = start(true, port);
      await expect.poll(() => windowsOf(port), { timeout: 60_000 }).toBe(1);
      await inCopyWindow(port, async (window) => {
        await (await coreOf(window)).evaluate(async (api, value) => {
          await api.updateSettings({ user: { language: value } });
          await api.createMind({ title: "Kept after failed update" });
        }, language);
      });
      const gone = exited(old);
      await writeFile(join(home, "begin"), "");
      await expect.poll(() => existsSync(join(home, "installing"))).toBe(true);
      if (!succeeds) {
        const second = start(false, await freePort());
        expect((await exited(second))[0]).toBe(0);
        if (process.platform === "linux") await writeFile(join(home, "fail"), "");
      }
      expect((await gone)[0]).toBe(0);
      await expect
        .poll(
          async () => ({
            copies: copiesWith(tag).length,
            windows: await windowsOf(windowPort),
          }),
          { timeout: 30_000 },
        )
        .toEqual({ copies: 1, windows: 1 });
      const recorded = await entries();
      const install = recorded.find((it) => it.kind === "install");
      expect(install).toMatchObject({ dataHeld: true, native: process.platform !== "linux" });
      expect(recorded.filter((it) => it.kind === "problem")).toEqual(
        succeeds
          ? []
          : [
              expect.objectContaining({
                pid: old.pid,
                dataHeld: true,
                options: expect.objectContaining({
                  message: language === "en" ? "The update couldn’t be installed" : "未能安装更新",
                  detail:
                    language === "en"
                      ? "IncarnaMind will reopen when you close this message. You can install the update later."
                      : "关闭此提示后，IncarnaMind 会重新打开。之后可以再安装更新。",
                  buttons: [language === "en" ? "Reopen IncarnaMind" : "重新打开 IncarnaMind"],
                }),
              }),
            ],
      );
      expect(recorded.filter((it) => it.kind === "relaunch")).toEqual(
        succeeds && process.platform === "linux"
          ? []
          : [
              expect.objectContaining({
                pid: old.pid,
                dataHeld: true,
                options: expect.objectContaining({
                  args: succeeds
                    ? expect.not.arrayContaining(["--started-again-after-stall"])
                    : expect.arrayContaining(["--started-again-after-stall"]),
                }),
              }),
            ],
      );
      const fresh = recorded.filter(
        (it) =>
          it.kind === "start" &&
          it.pid !== old.pid &&
          (succeeds || it.args?.includes("--started-again-after-stall")),
      );
      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.pid).not.toBe(old.pid);
      if (!succeeds && process.platform !== "linux")
        expect(await logOf(dataDir)).toContain("app.reopenAfterQuit reopens=false");
      await inCopyWindow(windowPort, async (window) => {
        const minds = await (await coreOf(window)).evaluate((api) => api.listMinds());
        expect(minds.map((mind) => mind.title)).toEqual(["Kept after failed update"]);
      });
      expect((await exited(start(false, await freePort())))[0]).toBe(0);
      expect(await windowsOf(windowPort)).toBe(1);
    } finally {
      try {
        await test.info().attach(`update-failure-${language}`, {
          body: JSON.stringify({
            events: existsSync(events) ? await entries() : [],
            log: await logOf(dataDir).catch((error: unknown) => String(error)),
          }),
          contentType: "application/json",
        });
      } finally {
        await expect
          .poll(
            () => {
              killAll(copiesWith(tag, true));
              return copiesWith(tag, true);
            },
            { timeout: 30_000 },
          )
          .toEqual([]);
        await rm(home, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  });
}
