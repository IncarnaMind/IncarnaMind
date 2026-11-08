import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, test } from "vitest";
import { CALL_WATCHER } from "../../scripts/callWatcher";
import { isRecordingEvent, streamsOfJson, streamsOfText } from "../../src/main/calls/pactl";
import {
  appsOfMacLine,
  appsOfStreams,
  appsOfWindowsLine,
  MAC_WATCHER,
} from "../../src/main/calls/watcher";
import { windowsWatchScript } from "../../src/main/calls/windowsScript";

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
    expect(appsOfMacLine(line, ours).sort()).toEqual(["chrome", "zoom"]);
    expect(appsOfMacLine('{"exact":true,"apps":[]}', ours)).toEqual([]);
  });

  test("Chrome for Testing is Chrome, and Safari's pages use the microphone through WebKit", () => {
    const line = JSON.stringify({
      exact: true,
      apps: [
        { pid: 1, bundle: "com.google.chrome.for.testing.helper" },
        { pid: 2, bundle: "com.apple.WebKit.GPU" },
      ],
    });
    expect(appsOfMacLine(line, ours).sort()).toEqual(["chrome", "safari"]);
  });

  test("the build ships the watcher under the name the app runs", () => {
    expect(MAC_WATCHER).toBe(CALL_WATCHER);
  });

  // The watcher as the built app runs it: macOS only, once `npm run build` has compiled it.
  const built = join(__dirname, "..", "..", "resources", "call-watcher", MAC_WATCHER);
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

describe("Windows: the per-app record of microphone use", () => {
  test("programs by their path, packaged apps by their family name", () => {
    const line = JSON.stringify({
      apps: [
        "C:#Program Files#Zoom#bin#Zoom.exe",
        "MSTeams_8wekyb3d8bbwe",
        "C:#Users#ana#AppData#Local#Programs#IncarnaMind#IncarnaMind.exe",
        "Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe",
        "C:#Program Files#Google#Chrome#Application#chrome.exe",
      ],
    });
    expect(appsOfWindowsLine(line).sort()).toEqual(["chrome", "teams", "zoom"]);
    expect(appsOfWindowsLine('{"apps":[]}')).toEqual([]);
  });

  test("the script asks for a parent process", () => {
    expect(() => windowsWatchScript(0)).toThrow();
    expect(windowsWatchScript(4100)).toContain("GetProcessById(4100)");
  });

  // GitHub's Ubuntu runners have PowerShell 7: the script must at least parse as PowerShell.
  const pwsh = spawnSync("pwsh", ["-v"]).status === 0;
  test.runIf(pwsh)("the script is PowerShell that parses", () => {
    const parse = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$errors); $errors.Count",
      ],
      { input: windowsWatchScript(4100), encoding: "utf8" },
    );
    expect(parse.stdout.trim()).toBe("0");
  });
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
