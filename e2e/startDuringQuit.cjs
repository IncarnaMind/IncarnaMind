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
const { existsSync, readFileSync, watch, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { app } = require("electron");

const mark = process.env.INCARNAMIND_TEST_QUIT_MARK;
const how = process.env.INCARNAMIND_TEST_QUIT_ON_START;
delete process.env.INCARNAMIND_TEST_QUIT_MARK;
delete process.env.INCARNAMIND_TEST_QUIT_ON_START;

if (mark && how) {
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
  const ask = app.requestSingleInstanceLock.bind(app);
  app.requestSingleInstanceLock = (...args) => {
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(mark)) Atomics.wait(pause, 0, 0, 1);
    return ask(...args);
  };
}
