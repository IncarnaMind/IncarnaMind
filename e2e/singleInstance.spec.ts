import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { isRecord } from "../src/core/errors";
import { MAPPED_WAL_RETRY_MS } from "../src/core/storage/node-sqlite";
import { heldByAnotherCopy } from "../src/main/instanceLock";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  forceQuit,
  launchApp,
  removeDataFolder,
} from "./app";
import {
  copiesWith,
  freePort,
  inCopyWindow,
  killCopies,
  lifecycleHomeEnv,
  prepareLifecycleApps,
  startLifecycleCopy,
  windowsOf,
} from "./lifecycle";
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
  await forceQuit(app);

  const next = await launchApp(dataDir);
  const minds = await (await coreOf(next.window)).evaluate(async (api) => api.listMinds());
  expect(minds.map((each) => each.title)).toEqual(["Kept"]);
  await next.app.close();
});

test("a Windows crash restart while an owned helper maps WAL shared memory says it couldn't start within its retry, and opens the saved text once the helper lets go (#2067)", async () => {
  test.skip(
    process.platform !== "win32" || !process.env.INCARNAMIND_PACKAGED_APP,
    "A genuine Windows packaged app is needed for the Windows file-mapping behavior.",
  );
  // A cold runner takes about a minute to start the first copy and the PowerShell mapping helper.
  test.setTimeout(180_000);
  const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
  const sharedMemory = join(dataDir, "incarnamind.db-shm");
  const boxes = join(home, "mapped-shm-boxes.jsonl");
  const instanceTrace = join(home, "mapped-shm-events.jsonl");
  const tag = `--incarnamind-smoke-copy=${randomUUID()}`;
  const first = await launchApp(dataDir, { home });
  let firstClosed = false;
  first.app.once("close", () => {
    firstClosed = true;
  });
  let mapper: ChildProcessWithoutNullStreams | undefined;
  let mapperClosed: Promise<void> | undefined;
  let successorPid: number | undefined;
  let successorError: string | undefined;
  let mapping: { pid: number; length: number; capacity: number } | undefined;
  let firstMain:
    | { pid: number; versions: NodeJS.ProcessVersions; packaged: boolean; dataDir: string }
    | undefined;
  const mapperOutput: string[] = [];
  const mapperErrors: string[] = [];
  const title = "Saved through a mapped WAL";
  const text = "This Note was saved before the crash.";
  try {
    firstMain = await first.app.evaluate(({ app }) => ({
      pid: process.pid,
      versions: process.versions,
      packaged: app.isPackaged,
      dataDir: app.getPath("userData"),
    }));
    expect(firstMain.packaged).toBe(true);
    expect(resolve(firstMain.dataDir).toLowerCase()).toBe(resolve(dataDir).toLowerCase());
    await dismissChatSetup(first.window);
    const noteId = await (await coreOf(first.window)).evaluate(async (api, title) => {
      const mind = await api.createMind({ title });
      await api.changeLayout("main", {
        type: "open",
        item: { kind: "mind", mindId: mind.id },
        where: { in: "place" },
      });
      return mind.id;
    }, title);
    const editor = first.window.getByTestId("mind-editor");
    await editor.fill(text);
    await expect(editor).toHaveText(text);
    expect(await (await coreOf(first.window)).evaluate((api) => api.saveChangesAgain())).toBeNull();
    expect((await stat(sharedMemory)).size).toBeGreaterThan(0);

    const mapperEnv: Record<string, string> = lifecycleHomeEnv(home);
    for (const [name, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"].includes(
          name.toUpperCase(),
        )
      )
        mapperEnv[name] = value;
    }
    mapperEnv.INCARNAMIND_TEST_MAPPED_SHM = sharedMemory;
    // No SQLite DMS lock: the extra mapping alone must not prevent crash recovery (#2022).
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$file = $env:INCARNAMIND_TEST_MAPPED_SHM
$stream = $null
$mapped = $null
$view = $null
try {
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, $share)
  $mapped = [System.IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($stream, [System.Management.Automation.Language.NullString]::Value, [long]0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite, [System.IO.HandleInheritability]::None, $true)
  $view = $mapped.CreateViewAccessor([long]0, [long]0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite)
  $null = $view.ReadByte(0)
  [Console]::Out.WriteLine((@{ event = 'mapped'; pid = $PID; file = $file; length = $stream.Length; capacity = $view.Capacity } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -ne 'release') { throw 'The mapping owner closed without releasing it.' }
} finally {
  if ($view) { $view.Dispose() }
  if ($mapped) { $mapped.Dispose() }
  if ($stream) { $stream.Dispose() }
}
`;
    mapper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: mapperEnv,
      windowsHide: true,
      stdio: "pipe",
    });
    const child = mapper;
    mapperClosed = new Promise((done) => child.once("close", () => done()));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => mapperErrors.push(data));
    child.stdin.on("error", (error) => {
      console.error("The owned WAL mapping helper could not receive its release", error);
    });
    const lines = createInterface({ input: child.stdout });
    const mappingReady = new Promise<{ pid: number; length: number; capacity: number }>(
      (done, fail) => {
        let ready = false;
        child.once("error", fail);
        child.once("close", (code, signal) => {
          if (!ready)
            fail(
              new Error(
                `The shared-memory mapper ended before mapping: ${code}/${signal}. ${mapperErrors.join("")}`,
              ),
            );
        });
        lines.on("line", (line) => {
          mapperOutput.push(line);
          if (ready) return;
          try {
            const value: unknown = JSON.parse(line.replace(/^\uFEFF/, ""));
            if (
              !isRecord(value) ||
              value.event !== "mapped" ||
              value.file !== sharedMemory ||
              typeof value.pid !== "number" ||
              value.pid !== child.pid ||
              typeof value.length !== "number" ||
              value.length <= 0 ||
              typeof value.capacity !== "number" ||
              value.capacity < value.length
            )
              throw new Error("The shared-memory mapper did not confirm its owned mapping.");
            ready = true;
            done({ pid: value.pid, length: value.length, capacity: value.capacity });
          } catch (error) {
            fail(error);
          }
        });
      },
    );
    const mapped = await mappingReady;
    mapping = mapped;

    expect(mapped.pid).not.toBe(firstMain.pid);
    await forceQuit(first.app);
    expect(
      heldByAnotherCopy(dataDir, (what, error) => {
        throw new Error(what, { cause: error });
      }),
    ).toBe(false);
    expect(mapper.exitCode).toBeNull();
    expect(mapper.signalCode).toBeNull();
    process.kill(mapped.pid, 0);
    // The released runtime's SQLite can't reopen WAL shared memory another process maps (#2067).
    const successor = startCopy(
      home,
      [tag, "-r", join(__dirname, "errorBoxes.cjs"), "-r", join(__dirname, "startDuringQuit.cjs")],
      {
        INCARNAMIND_TEST_ERROR_BOXES: boxes,
        INCARNAMIND_TEST_INSTANCE_TRACE: instanceTrace,
      },
    );
    successorPid = successor.pid;
    successor.once("error", (error) => {
      successorError = String(error);
    });
    if (successorPid === undefined) throw new Error("The replacement app has no process id.");
    await exited(successor);
    expect(successorError).toBeUndefined();
    expect(successor.signalCode).toBeNull();
    const traced = (await readFile(instanceTrace, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line))
      .filter(isRecord)
      .filter((event) => event.pid === successorPid);
    const at = (name: string) => {
      const event = traced.find((each) => each.event === name);
      if (typeof event?.monotonic !== "string")
        throw new Error(`The replacement app never traced ${name}.`);
      return BigInt(event.monotonic);
    };
    const givenUpMs = Number((at("before-quit") - at("sqlite-open")) / 1_000_000n);
    expect(givenUpMs).toBeLessThan(MAPPED_WAL_RETRY_MS + 1_000);
    expect(
      traced.filter(
        (event) =>
          event.event === "window-visibility" &&
          typeof event.visibleWindows === "number" &&
          event.visibleWindows > 0,
      ),
    ).toEqual([]);
    const shown = (await readFile(boxes, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(shown).toEqual([
      {
        title: "IncarnaMind couldn’t start",
        content:
          "Your data folder couldn’t be opened. Close this message, then open IncarnaMind again.\n\ndisk I/O error",
        ready: true,
      },
    ]);
    expect(copiesWith(tag)).toEqual([]);
    expect(
      heldByAnotherCopy(dataDir, (what, error) => {
        throw new Error(what, { cause: error });
      }),
    ).toBe(false);
    expect(mapper.exitCode).toBeNull();
    process.kill(mapped.pid, 0);

    mapper.stdin.end("release\n");
    await mapperClosed;
    expect(mapper.exitCode).toBe(0);
    const next = await launchApp(dataDir, { home });
    try {
      const core = await coreOf(next.window);
      expect(
        await core.evaluate(
          async (api, id) => (await api.listMinds()).find((mind) => mind.id === id),
          noteId,
        ),
      ).toMatchObject({ id: noteId, title });
      await core.evaluate(
        (api, id) =>
          api.changeLayout("main", {
            type: "open",
            item: { kind: "mind", mindId: id },
            where: { in: "place" },
          }),
        noteId,
      );
      await expect(next.window.getByTestId("mind-editor")).toHaveText(text);
    } finally {
      await next.app.close();
    }
  } finally {
    try {
      const path = test.info().outputPath("mapped-shm-restart.json");
      await writeFile(
        path,
        JSON.stringify({
          firstMain,
          successorPid,
          successorError,
          mapping,
          mapperOutput,
          mapperErrors,
          mapperExit: mapper && { code: mapper.exitCode, signal: mapper.signalCode },
          boxes: existsSync(boxes) ? await readFile(boxes, "utf8") : "",
          instanceTrace: existsSync(instanceTrace) ? await readFile(instanceTrace, "utf8") : "",
          log: await logOf(dataDir),
        }),
      );
      await test.info().attach("mapped-shm-restart", {
        path,
        contentType: "application/json",
      });
    } finally {
      if (mapper && mapperClosed) {
        if (mapper.exitCode === null && mapper.signalCode === null) {
          if (mapping) mapper.stdin.end("release\n");
          else mapper.kill("SIGKILL");
        }
        await mapperClosed;
      }
      await expect.poll(() => killCopies(tag), { timeout: 30_000 }).toEqual([]);
      if (!firstClosed) await forceQuit(first.app);
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
      if (mapping) expect(mapper?.exitCode).toBe(0);
    }
  }
});

test("a forced quit ends the real main even when the launcher is a different process", async () => {
  const { app } = await launchApp(dataDir);
  const launcher = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const processOf = app.process;
  let closed = false;
  app.once("close", () => {
    closed = true;
  });
  app.process = () => launcher;
  try {
    await forceQuit(app);
    expect(closed).toBe(true);
    expect(launcher.exitCode).toBeNull();
    expect(launcher.signalCode).toBeNull();
  } finally {
    app.process = processOf;
    if (launcher.exitCode === null && launcher.signalCode === null) {
      const gone = once(launcher, "exit");
      launcher.kill("SIGKILL");
      await gone;
    }
    if (!closed) await app.close();
  }
});

test("a live data owner receives the next start even after the native forwarding files disappear", async () => {
  test.skip(process.platform === "win32", "POSIX singleton files");
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await (await coreOf(window)).evaluate(async (api) =>
      api.createMind({ title: "Kept without native files" }),
    );
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
      await rm(join(dataDir, name), { force: true });
    const next = await startAnotherCopy(app);
    expect((await exited(next))[0]).toBe(0);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((each) => each.isVisible()),
        ),
      )
      .toEqual([true]);
    expect(await logOf(dataDir)).toContain("app.secondLaunch");
    expect(await (await coreOf(window)).evaluate((api) => api.listMinds())).toMatchObject([
      { title: "Kept without native files" },
    ]);
  } finally {
    await app.close();
  }
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

const startCopy = (home: string, args: string[], extraEnv: Record<string, string> = {}) =>
  startLifecycleCopy(dataDir, home, args, extraEnv);

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
 * Starts a copy, then `starts` more that ask for the data folder while it quits
 * (`startDuringQuit.cjs`), and waits until one copy is left, with one window. A start after that
 * must come to that window and quit.
 */
async function startWhileQuitting(
  how: "quit" | "quit-twice" | "crash" | "after-release",
  starts: number,
  { stallAgain = false, language = "en-US", crashTrial = 0 } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
  const boxes = join(home, "error-boxes.jsonl");
  const mark = join(home, "quit-started");
  const attempts = join(home, "startup-attempts.jsonl");
  const instanceTrace = join(home, "instance-events.jsonl");
  const tag = `--incarnamind-smoke-copy=${randomUUID()}`;
  const ports: number[] = [];
  const late = how === "after-release";
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
        INCARNAMIND_TEST_INSTANCE_TRACE: instanceTrace,
        ...extraEnv,
      },
    );
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
    const beforeFinalStart = (await logOf(dataDir)).length;
    const [code] = await exited(await start());
    expect(code).toBe(0);
    await expect
      .poll(async () => (await logOf(dataDir)).slice(beforeFinalStart))
      .toContain("app.secondLaunch");
    await expect.poll(left, { timeout: 30_000 }).toEqual({ copies: 1, windows: 1 });
    expect(existsSync(boxes)).toBe(false);
  } finally {
    try {
      const details = JSON.stringify({
        how,
        crashTrial,
        state: await left(),
        pids: copiesWith(tag),
        dataFolderHeld: heldByAnotherCopy(dataDir, (what, error) => {
          throw new Error(what, { cause: error });
        }),
        log: await logOf(dataDir).catch((error: unknown) => `Log unavailable: ${String(error)}`),
        events: existsSync(`${mark}.events`) ? await readFile(`${mark}.events`, "utf8") : "",
        attempts: existsSync(attempts) ? await readFile(attempts, "utf8") : "",
        instanceTrace: existsSync(instanceTrace) ? await readFile(instanceTrace, "utf8") : "",
      });
      const detailsFile = test
        .info()
        .outputPath(
          crashTrial
            ? `instance-events-crash-${crashTrial}-${randomUUID()}.json`
            : "instance-events.json",
        );
      await writeFile(detailsFile, details);
      await test.info().attach(`quit-${how}`, {
        path: detailsFile,
        contentType: "application/json",
      });
    } finally {
      await expect
        .poll(
          () => {
            return killCopies(tag);
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
  test.setTimeout(600_000);
  for (const how of ["quit", "quit", "quit-twice", "crash"] as const) {
    await test.step(how, () => startWhileQuitting(how, 1));
  }
});

test("five ordinary Windows crash starts keep one usable owner", async () => {
  test.skip(
    process.platform !== "win32",
    "The mapped-SHM runtime defect is Windows-specific (#2067).",
  );
  test.setTimeout(600_000);
  const trials: Record<string, unknown>[] = [];
  try {
    for (let trial = 1; trial <= 5; trial++) {
      const row: Record<string, unknown> = { trial, outcome: "started" };
      trials.push(row);
      try {
        await test.step(`crash ${trial}`, () =>
          startWhileQuitting("crash", 1, { crashTrial: trial }));
        row.outcome = "completed";
      } catch (error) {
        row.outcome = "failed";
        row.error = String(error);
        throw error;
      }
    }
  } finally {
    const report = test.info().outputPath("ordinary-crash-trials.json");
    await writeFile(report, JSON.stringify(trials, null, 2));
    await test
      .info()
      .attach("ordinary-crash-trials", { path: report, contentType: "application/json" });
  }
});

// protects=a double-click storm during a quit leaves one copy with one window (#1448);
// fails_when=one of the five starts is left with no window, or none of them opens.
test("five starts in a row while the app quits leave one window", async () => {
  test.setTimeout(300_000);
  await startWhileQuitting("quit", 5);
});

// protects=a start after the data lock is released but before Electron exits recovers a usable window (#1448); fails_when=the pre-lock snapshot misses the quitting copy and no recovery is armed.
test("a start during the old owner's exit waits for its data gate and opens the existing data", async () => {
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

for (const { language, succeeds, quitDelay } of [
  { language: "en", succeeds: true, quitDelay: 0 },
  { language: "en", succeeds: true, quitDelay: 6_000 },
] as const) {
  test(`an update ${succeeds ? "succeeds" : "fails after a second start"}, closes its owned core and reopens (${language}, quit delay ${quitDelay} ms)`, async () => {
    test.setTimeout(120_000);
    const home = await mkdtemp(join(tmpdir(), "incarnamind-update-"));
    const apps = await prepareLifecycleApps(home);
    const events = join(home, "events.jsonl");
    const tag = `--incarnamind-smoke-copy=${randomUUID()}`;
    const port = await freePort();
    const nextPort = await freePort();
    const startsEarly = succeeds && (process.platform === "linux" || quitDelay > 0);
    const windowPort = succeeds ? nextPort : port;
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
          INCARNAMIND_TEST_UPDATE_QUIT_DELAY: String(quitDelay),
          INCARNAMIND_TEST_UPDATE_FIRST: first ? "1" : "0",
          APPIMAGE: process.platform === "linux" ? require("electron") : "",
          ...apps.env,
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
              visibleWindows?: number;
              ready?: boolean;
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
        await writeFile(join(home, "fail"), "");
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
      const busy = recorded.filter((it) => it.kind === "startup-problem");
      expect(busy).toEqual(
        !succeeds ? [expect.objectContaining({ dataHeld: true, ready: true })] : [],
      );
      const install = recorded.find((it) => it.kind === "install");
      expect(install).toMatchObject({
        dataHeld: true,
        native: process.platform !== "linux" && quitDelay === 0,
      });
      if (quitDelay > 0)
        expect(recorded.find((it) => it.kind === "quit-delayed")).toMatchObject({ dataHeld: true });
      expect(recorded.filter((it) => it.kind === "problem")).toEqual(
        succeeds
          ? []
          : [
              expect.objectContaining({
                pid: old.pid,
                dataHeld: true,
                visibleWindows: 0,
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
        startsEarly
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
              return killCopies(tag);
            },
            { timeout: 30_000 },
          )
          .toEqual([]);
        await rm(home, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  });
}
