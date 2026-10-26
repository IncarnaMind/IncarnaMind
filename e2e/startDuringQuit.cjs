/**
 * Loaded before the app's main script (`electron -r <this file> <app>`) to start a copy while
 * another quits. Both are given INCARNAMIND_TEST_QUIT_MARK, a file that doesn't exist yet.
 *
 * - The copy started with INCARNAMIND_TEST_QUIT_ON_START quits, as ⌘Q would, once the next copy
 *   logs its start, and then writes the mark. `quit-twice` asks twice; `crash` dies outright next.
 * - Any other copy asks for Electron's lock only once the mark is there: inside that quit.
 *
 * A copy either of them opens again inherits neither.
 */
const {
  appendFileSync,
  existsSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  watch,
  writeFileSync,
} = require("node:fs");
const { dirname, join } = require("node:path");
const { app } = require("electron");

const trace = process.env.INCARNAMIND_TEST_INSTANCE_TRACE;
if (trace) {
  const folder = process.env.INCARNAMIND_DATA_DIR;
  const target = () => {
    try {
      return readlinkSync(join(folder, "SingletonLock"));
    } catch (error) {
      return error.code === "ENOENT" ? null : { error: error.code };
    }
  };
  const record = (event, extra = {}) =>
    appendFileSync(
      trace,
      `${JSON.stringify({
        pid: process.pid,
        time: new Date().toISOString(),
        monotonic: String(process.hrtime.bigint()),
        event,
        native: app.hasSingleInstanceLock(),
        target: target(),
        ...extra,
      })}\n`,
    );
  record("preload", { args: process.argv });
  for (const method of ["requestSingleInstanceLock", "releaseSingleInstanceLock"]) {
    const original = app[method].bind(app);
    app[method] = (...args) => {
      record(`${method}:before`);
      const result = original(...args);
      record(`${method}:after`, { result });
      return result;
    };
  }
  for (const event of [
    "second-instance",
    "will-finish-launching",
    "ready",
    "before-quit",
    "will-quit",
    "quit",
  ])
    app.on(event, () => record(event));
  process.on("exit", () => record("process.exit"));
  watch(folder, (_event, file) => {
    if (String(file).startsWith("Singleton")) record(`file:${file}`);
  }).unref();
}

const mark = process.env.INCARNAMIND_TEST_QUIT_MARK;
const how = process.env.INCARNAMIND_TEST_QUIT_ON_START;
const late = process.env.INCARNAMIND_TEST_QUIT_AFTER_RELEASE === "1";
const stalled = process.env.INCARNAMIND_TEST_STALL_STARTUP;
delete process.env.INCARNAMIND_TEST_QUIT_MARK;
delete process.env.INCARNAMIND_TEST_QUIT_ON_START;
delete process.env.INCARNAMIND_TEST_QUIT_AFTER_RELEASE;

if (stalled) {
  // The clean retry has no previous owner; hold its ready Promise to exercise that stall (#1448).
  appendFileSync(stalled, `${JSON.stringify({ pid: process.pid, args: process.argv })}\n`);
  app.whenReady = () => new Promise(() => undefined);
}

const waitFor = (file) => {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(file)) Atomics.wait(pause, 0, 0, 1);
};

if (mark) {
  for (const name of ["will-finish-launching", "ready", "before-quit", "will-quit", "quit"]) {
    app.on(name, () =>
      appendFileSync(
        `${mark}.events`,
        `${JSON.stringify({ pid: process.pid, name, ready: app.isReady(), lock: app.hasSingleInstanceLock() })}\n`,
      ),
    );
  }
}

if (mark && how === "after-release") {
  app.whenReady().then(() => {
    app.on("quit", () => {
      writeFileSync(mark, how);
      const requests = join(process.env.INCARNAMIND_DATA_DIR, "instance-requests");
      const pause = new Int32Array(new SharedArrayBuffer(4));
      while (
        !existsSync(requests) ||
        !readdirSync(requests).some((name) => name.endsWith(".request.json"))
      )
        Atomics.wait(pause, 0, 0, 1);
    });
    const watcher = watch(dirname(mark), () => {
      if (!existsSync(`${mark}.starting`)) return;
      watcher.close();
      app.quit();
    });
  });
} else if (mark && how) {
  const log = join(process.env.INCARNAMIND_DATA_DIR, "logs", "incarnamind.log");
  const starts = () => readFileSync(log, "utf8").split(" app.start ").length;
  app.whenReady().then(() => {
    const before = starts();
    const watcher = watch(log, () => {
      if (starts() === before) return;
      watcher.close();
      app.quit();
      if (how === "quit-twice") app.quit();
      writeFileSync(mark, how);
      if (how === "crash") setImmediate(() => process.kill(process.pid, "SIGKILL"));
    });
  });
} else if (mark) {
  if (late) {
    writeFileSync(`${mark}.starting`, "");
    waitFor(mark);
  }
  const ask = app.requestSingleInstanceLock.bind(app);
  app.requestSingleInstanceLock = (...args) => {
    waitFor(mark);
    if (late) writeFileSync(`${mark}.requesting`, "");
    return ask(...args);
  };
}
