import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEV_WATCHER, WATCHER_NAME } from "../../scripts/callWatcher.mjs";
import type { CallWatchProblem } from "../../src/core/api";
import { isRecordingEvent, streamsOfJson, streamsOfText } from "../../src/main/calls/pactl";
import {
  appsOfStreams,
  createCallWatcher,
  MAC_WATCHER,
  macCallApps,
  readMacLine,
  watchLines,
} from "../../src/main/calls/watcher";

const ours = { pids: () => new Set([4100, 4101]), bundles: ["com.incarnamind.app"] };

describe("macOS: Core Audio's processes running input", () => {
  test("a helper is its app's, IncarnaMind's own processes never count, and other programs are no call", () => {
    const line = JSON.stringify({
      exact: true,
      apps: [
        { pid: 210, bundle: "us.zoom.xos" },
        { pid: 211, bundle: "com.google.Chrome.helper" },
        { pid: 4101, bundle: "com.github.Electron.helper" },
        { pid: 300, bundle: "com.incarnamind.app.helper" },
        { pid: 301, bundle: "com.apple.VoiceMemos" },
        { pid: 302, bundle: "" },
      ],
    });
    expect(readMacLine(line, ours).apps.sort()).toEqual(["chrome", "zoom"]);
    expect(readMacLine('{"exact":true,"apps":[]}', ours)).toEqual({
      apps: [],
      exact: true,
      running: true,
    });
  });

  test("Chrome for Testing is Chrome, and Safari's pages use the microphone through WebKit", () => {
    const line = JSON.stringify({
      exact: true,
      apps: [
        { pid: 1, bundle: "com.google.chrome.for.testing.helper" },
        { pid: 2, bundle: "com.apple.WebKit.GPU" },
      ],
    });
    expect(readMacLine(line, ours).apps.sort()).toEqual(["chrome", "safari"]);
  });

  test("on macOS 12 and 13, switching to another app isn't the call app letting go; input stopping is", () => {
    const front = (bundle: string, running = true) =>
      readMacLine(
        JSON.stringify({ exact: false, running, apps: running ? [{ pid: 9, bundle }] : [] }),
        ours,
      );
    const inZoom = macCallApps([], front("us.zoom.xos"));
    expect(inZoom).toEqual(["zoom"]);
    // The User switches to IncarnaMind, then to Notes, while Zoom keeps the microphone.
    const inIncarnaMind = macCallApps(inZoom, front("com.incarnamind.app"));
    expect(macCallApps(inIncarnaMind, front("com.apple.Notes"))).toEqual(["zoom"]);
    expect(front("com.apple.Notes").exact).toBe(false);
    expect(macCallApps(inIncarnaMind, front("", false))).toEqual([]);
  });

  test("the build ships the watcher under the name the app runs", () => {
    expect(MAC_WATCHER).toBe(WATCHER_NAME);
  });

  // The watcher as the built app runs it: macOS only, once `npm run call-watcher` has built it.
  const built = DEV_WATCHER;
  test.runIf(process.platform === "darwin" && existsSync(built))(
    "the real watcher says what uses the microphone now, and exits when IncarnaMind closes its input",
    async () => {
      const child = spawn(built, [], { stdio: ["pipe", "pipe", "inherit"] });
      const first = await new Promise<string>((resolve) =>
        createInterface({ input: child.stdout }).once("line", resolve),
      );
      expect(JSON.parse(first)).toMatchObject({ exact: true, apps: expect.any(Array) });
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      child.stdin.end();
      expect(await exited).toBe(0);
    },
  );
});

describe("Linux: PulseAudio's recording streams", () => {
  const json = JSON.stringify([
    {
      index: 41,
      corked: false,
      properties: {
        "application.name": "ZOOM VoiceEngine",
        "application.process.binary": "zoom",
        "application.process.id": "8812",
      },
    },
    {
      index: 42,
      corked: true,
      properties: { "application.name": "Slack", "application.process.binary": "slack" },
    },
    {
      index: 43,
      corked: false,
      properties: {
        "application.name": "Chromium",
        "application.process.binary": "chromium",
        "application.process.id": "4100",
      },
    },
    {
      index: 44,
      corked: false,
      properties: { "application.name": "PulseAudio Volume Control" },
    },
  ]);

  test("a corked stream isn't recording, and IncarnaMind's own stream never counts", () => {
    const streams = streamsOfJson(json);
    expect(streams).toHaveLength(3);
    expect(appsOfStreams(streams, ours)).toEqual(["zoom"]);
  });

  test("older pactl's text says the same", () => {
    const text = [
      "Source Output #41",
      "\tDriver: protocol-native.c",
      "\tCorked: no",
      "\tProperties:",
      '\t\tapplication.name = "ZOOM VoiceEngine"',
      '\t\tapplication.process.id = "8812"',
      '\t\tapplication.process.binary = "zoom"',
      "",
      "Source Output #42",
      "\tCorked: yes",
      "\tProperties:",
      '\t\tapplication.process.binary = "slack"',
      "",
      "Source Output #43",
      "\tCorked: no",
      "\tProperties:",
      '\t\tapplication.name = "Firefox"',
      "",
    ].join("\n");
    expect(appsOfStreams(streamsOfText(text), ours).sort()).toEqual(["firefox", "zoom"]);
  });

  test("only a recording stream's events lead to reading the streams again", () => {
    expect(isRecordingEvent("Event 'new' on source-output #41")).toBe(true);
    expect(isRecordingEvent("Event 'remove' on source-output #41")).toBe(true);
    expect(isRecordingEvent("Event 'change' on sink-input #12")).toBe(false);
  });
});

/** A watcher process that a test ends, and says lines for. */
function fakeChild(): ChildProcess & { say(line: string): void; end(): void } {
  const child = new EventEmitter() as ChildProcess & { say(line: string): void; end(): void };
  const stdout = new PassThrough();
  Object.assign(child, {
    stdout,
    stderr: new PassThrough(),
    kill: () => true,
    say: (line: string) => stdout.write(`${line}\n`),
    end: () => child.emit("exit", 1, null),
  });
  return child;
}

const quiet = { info() {}, warn() {}, error() {} };

describe("A watcher that stops by itself", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("says nothing about the microphone, is started again after waits that double, and rests after six stops in a row", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const children: ReturnType<typeof fakeChild>[] = [];
    const heard: string[] = [];
    const problems: CallWatchProblem[] = [];
    const clock = 0;
    watchLines({
      log: quiet,
      listener: {
        apps: (ids) => heard.push(ids.join(",")),
        problem: (problem) => problems.push(problem),
      },
      start: () => {
        const child = fakeChild();
        children.push(child);
        return child;
      },
      read: (line) => heard.push(line),
      missing: "unavailable",
      now: () => clock,
    });
    children[0]?.say("zoom");
    await new Promise((resolve) => setImmediate(resolve));
    children[0]?.end();
    expect(heard).toEqual(["zoom"]);

    const waits: number[] = [];
    for (let stop = 1; stop < 6; stop += 1) {
      const started = children.length;
      let waited = 0;
      while (children.length === started) {
        vi.advanceTimersByTime(1000);
        waited += 1000;
      }
      waits.push(waited);
      children.at(-1)?.end();
    }
    expect(waits).toEqual([5000, 10_000, 20_000, 40_000, 80_000]);
    expect(problems).toEqual(["unavailable"]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(children).toHaveLength(6);
    expect(heard).toEqual(["zoom"]);
  });

  test("starts the waits over after a healthy spell", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const children: ReturnType<typeof fakeChild>[] = [];
    let clock = 0;
    watchLines({
      log: quiet,
      listener: { apps: () => undefined, problem: () => undefined },
      start: () => {
        const child = fakeChild();
        children.push(child);
        return child;
      },
      read: () => undefined,
      missing: "unavailable",
      now: () => clock,
    });
    children[0]?.end();
    vi.advanceTimersByTime(5000);
    children[1]?.end();
    vi.advanceTimersByTime(10_000);
    expect(children).toHaveLength(3);
    clock += 61_000;
    children[2]?.end();
    vi.advanceTimersByTime(5000);
    expect(children).toHaveLength(4);
  });

  test("Windows has no watcher yet, and says so", () => {
    const problems: CallWatchProblem[] = [];
    createCallWatcher({ log: quiet, platform: "win32", own: ours, macWatcher: null }).watch({
      apps: () => undefined,
      problem: (problem) => problems.push(problem),
    });
    expect(problems).toEqual(["not-on-windows"]);
  });
});
