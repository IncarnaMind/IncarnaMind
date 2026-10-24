/**
 * Loaded before the app's main script (`electron -r <this file> <app>`) in a copy started with
 * INCARNAMIND_TEST_QUIT_ON_START: once it is ready, the next copy's `app.start` in the data
 * folder's log quits it, as ⌘Q would, while that copy asks for the folder. `quit-twice` asks twice;
 * `crash` asks and then dies outright. A copy it opens again doesn't inherit the variable.
 */
const { readFileSync, watch } = require("node:fs");
const { join } = require("node:path");
const { app } = require("electron");

const how = process.env.INCARNAMIND_TEST_QUIT_ON_START;
delete process.env.INCARNAMIND_TEST_QUIT_ON_START;

if (how) {
  const log = join(process.env.INCARNAMIND_DATA_DIR, "logs", "incarnamind.log");
  const starts = () => readFileSync(log, "utf8").split(" app.start ").length;
  app.whenReady().then(() => {
    const before = starts();
    const watcher = watch(log, () => {
      if (starts() === before) return;
      watcher.close();
      app.quit();
      if (how === "quit-twice") app.quit();
      if (how === "crash") setImmediate(() => process.kill(process.pid, "SIGKILL"));
    });
  });
}
