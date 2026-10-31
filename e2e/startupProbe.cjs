// Probe for #2104, never merged: every gap of 100 ms or more in the main thread's event loop in
// the first 15 seconds of a start, and when the first window was shown.
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const { app } = require("electron");

const folder = process.env.INCARNAMIND_TEST_STARTUP_DIR;
if (!folder) throw new Error("A lifecycle fixture folder is required.");
const record = (kind, extra = {}) =>
  appendFileSync(
    join(folder, "events.jsonl"),
    `${JSON.stringify({ kind, at: new Date().toISOString(), pid: process.pid, t: Math.round(performance.now()), ...extra })}\n`,
  );

app.on("browser-window-created", (_event, window) => {
  window.once("show", () => record("probe-window-shown"));
});
let last = performance.now();
const sampler = setInterval(() => {
  const now = performance.now();
  const gap = now - last - 50;
  last = now;
  if (gap >= 100) record("probe-gap", { ms: Math.round(gap) });
}, 50);
sampler.unref();
setTimeout(() => clearInterval(sampler), 15_000).unref();
