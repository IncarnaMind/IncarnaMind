import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = `Software\\IncarnaMind\\Tests\\CallWatcher-${randomUUID()}`;
const key = `HKCU\\${root}`;
const microphone = `${key}\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone`;
const teams = `${microphone}\\MSTeams_8wekyb3d8bbwe`;
const desktop = `${microphone}\\NonPackaged`;
const zoom = `${desktop}\\C:#Users#IsolatedFixture#Zoom.exe`;
const chrome = `${desktop}\\C:#Program Files#Google#Chrome#chrome.exe`;
const stopped = `${desktop}\\C:#Fixture#firefox.exe`;
const version = process.argv[2];
const testDirectory = process.argv[3];
const fixture = join(testDirectory, "Release", "call-watcher-fixture.exe");
const application = join(testDirectory, "app");
const add = (path, ...args) => run("reg.exe", ["add", path, ...args, "/f"]);
const remove = (path) => run("reg.exe", ["delete", path, "/f"]);
const time = (path, name, value, type = "REG_QWORD") =>
  add(path, "/v", `LastUsedTime${name}`, "/t", type, "/d", String(value));
const powershell = (...args) => run("pwsh", ["-NoLogo", "-NoProfile", ...args]);
const changes = [];

await add(`${key}\\Software`);
let child;
try {
  child = spawn(fixture, [root], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const exit = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  let latest = null;
  let exact = false;
  let received = 0;
  lines.on("line", (line) => {
    const snapshot = JSON.parse(line);
    assert.equal(typeof snapshot.exact, "boolean");
    assert.ok(snapshot.apps.every((app) => /^[A-Za-z0-9._-]+$/.test(app)));
    exact = snapshot.exact;
    if (exact) latest = [...snapshot.apps].sort();
    else assert.deepEqual(snapshot.apps, []);
    received += 1;
  });
  async function expectSnapshot(matches) {
    const started = performance.now();
    const signal = AbortSignal.timeout(5000);
    while (!matches()) await once(lines, "line", { signal });
    changes.push(Math.round(performance.now() - started));
  }
  const expectApps = (...expected) => {
    expected.sort();
    return expectSnapshot(() => exact && JSON.stringify(latest) === JSON.stringify(expected));
  };
  const cpu = async () => {
    const { stdout } = await powershell(
      "-Command",
      `[int] (Get-Process -Id ${child.pid}).TotalProcessorTime.TotalMilliseconds`,
    );
    assert.match(stdout.trim(), /^\d+$/);
    return Number(stdout.trim());
  };

  await expectApps();
  await time(teams, "Start", 20);
  await expectApps("MSTeams_8wekyb3d8bbwe");

  await time(zoom, "Stop", 1);
  await time(zoom, "Start", 20);
  await expectApps("MSTeams_8wekyb3d8bbwe", "Zoom.exe");

  await time(stopped, "Stop", 30);
  await time(stopped, "Start", 20);
  await time(chrome, "Stop", 0);
  await time(chrome, "Start", 20);
  await expectApps("MSTeams_8wekyb3d8bbwe", "Zoom.exe", "chrome.exe");

  for (const [name, value] of [
    ["Start", 20],
    ["Stop", 1],
  ]) {
    await time(zoom, name, value, "REG_SZ");
    await expectSnapshot(() => !exact);
    assert.deepEqual(latest, ["MSTeams_8wekyb3d8bbwe", "Zoom.exe", "chrome.exe"]);
    await time(zoom, name, value);
    await expectApps("MSTeams_8wekyb3d8bbwe", "Zoom.exe", "chrome.exe");
  }

  await time(teams, "Stop", 25);
  await expectApps("Zoom.exe", "chrome.exe");
  await remove(microphone);
  await expectApps();
  await time(teams, "Start", 40);
  await expectApps("MSTeams_8wekyb3d8bbwe");

  const started = performance.now();
  const cpuBefore = await cpu();
  const before = received;
  await delay(10_000);
  const idleCpuMs = (await cpu()) - cpuBefore;
  const idleElapsedMs = Math.round(performance.now() - started);
  assert.equal(received, before, "No registry change should produce no watcher snapshot");
  assert.ok(idleCpuMs <= 100, `The idle watcher used ${idleCpuMs} ms CPU`);

  child.stdin.end();
  const closed = await Promise.race([exit, delay(5000, ["did not exit"])]);
  assert.deepEqual(closed, [0, null]);

  const report = `Native registry test: ${changes.length} expected snapshots; longest post-write wait ${Math.max(...changes)} ms. Idle CPU ${idleCpuMs} ms over ${idleElapsedMs} ms; zero idle snapshots. Stdin EOF exited cleanly.`;
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
} finally {
  if (child?.exitCode === null) child.kill();
  await remove(key);
}

const verify = "./scripts/verifyWindowsCallWatcher.ps1";
const args = ["-File", verify, "-AppRoot", application, "-Version", version];
await powershell(...args);
const helper = join(application, "resources", "call-watcher.exe");
await run(process.execPath, ["scripts/callWatcher.mjs", helper]);
await assert.rejects(powershell(...args), /present in a build/);
await assert.rejects(powershell(...args, "-Expected"), /timestamped signature/);
await rm(helper);
await assert.rejects(powershell(...args, "-Expected"), /missing the call watcher/);
console.log(
  `Release gate: validates IncarnaMind version ${version} and rejects unsigned, missing and unexpected helpers.`,
);
