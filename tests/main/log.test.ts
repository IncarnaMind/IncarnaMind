import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createScrubber } from "../../src/main/crashScrubber";
import {
  createFileLogger,
  createLogFile,
  LOG_FILE,
  logConsole,
  logFileNames,
  logWindowError,
} from "../../src/main/log";

async function createLogsFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "incarnamind-logs-"));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

/** Every entry in the log's files, oldest first. */
async function entriesIn(folder: string): Promise<string[]> {
  const entries: string[] = [];
  for (const name of logFileNames().reverse()) {
    const text = await readFile(join(folder, name), "utf8").catch(() => "");
    entries.push(...text.split("\n").filter(Boolean));
  }
  return entries;
}

const HOME = "/Users/alice";
const APP = "/Applications/IncarnaMind.app/Contents/Resources/app.asar";
const scrubber = createScrubber({
  homeDir: HOME,
  dataDir: `${HOME}/Library/Application Support/IncarnaMind`,
});
const AT = new Date("2026-10-07T09:30:00.000Z");

/** A logger writing to a fresh folder, at a fixed time. */
async function startLogger() {
  const folder = await createLogsFolder();
  const logger = createFileLogger({
    file: createLogFile({ directory: folder }),
    scrubber,
    appPath: APP,
    now: () => AT,
  });
  const text = () => readFile(join(folder, LOG_FILE), "utf8");
  return { logger, folder, text };
}

// The User's content and secrets, as errors might quote them.
const DOCUMENT_TEXT = "the merger closes on Friday";
const QUESTION = "Which codeword did Northwind choose?";
const API_KEY = "sk-proj-4f9b2c7e1d8a6053b2e9f4c1a7d0e3b5";
const SECRETS = ["merger", "Northwind", "codeword", "4f9b2c7e", "alice", "Secret plan"];

describe("the log file", () => {
  test("rotates at its size: the newest entries are kept in three files, the oldest dropped", async () => {
    const folder = await createLogsFolder();
    const file = createLogFile({ directory: folder, maxBytes: 1000, maxFiles: 3 });
    const entry = (index: number) => `entry ${String(index).padStart(3, "0")} ${"x".repeat(88)}`;

    for (let index = 1; index <= 60; index++) file.write(entry(index));

    expect((await readdir(folder)).sort()).toEqual(
      ["incarnamind.1.log", "incarnamind.2.log", "incarnamind.log"].sort(),
    );
    for (const name of logFileNames()) {
      expect((await stat(join(folder, name))).size).toBeLessThanOrEqual(1000);
    }
    const kept = await entriesIn(folder);
    // Nine 100-byte entries fit in each file: the last 27 or so remain, in order, none lost in between.
    expect(kept.at(-1)).toBe(entry(60));
    expect(kept.length).toBeGreaterThanOrEqual(19);
    const first = 60 - kept.length + 1;
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, index) => entry(first + index)));
    expect(kept).not.toContain(entry(1));
  });

  test("carries on a log from an earlier run, counting what it holds", async () => {
    const folder = await createLogsFolder();
    await writeFile(join(folder, LOG_FILE), `${"earlier ".repeat(124)}\n`); // 993 bytes
    const file = createLogFile({ directory: folder, maxBytes: 1000 });

    file.write("short"); // 999 bytes: still fits
    file.write("later");

    expect(await readFile(join(folder, "incarnamind.1.log"), "utf8")).toMatch(
      /^earlier.*\nshort\n$/,
    );
    expect(await readFile(join(folder, LOG_FILE), "utf8")).toBe("later\n");
  });

  test("never throws when it can't be written, and says so once", async () => {
    const folder = await createLogsFolder();
    const blocked = join(folder, "not-a-folder");
    await writeFile(blocked, "A file where the logs folder should be.");
    const reportError = vi.fn();
    const file = createLogFile({ directory: blocked, reportError });

    file.write("one");
    file.write("two");

    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("what the log says", () => {
  test("an event with its fields, on one line", async () => {
    const { logger, text } = await startLogger();

    logger.info("document.status", { documentId: "d-1", status: "ready", pages: 12, x: undefined });
    logger.warn("connector.failed", { errorKind: "missing-command", retrying: true });
    logger.error("window.crashed", { reason: "oom", exitCode: null, "bad key": "x" });

    expect((await text()).split("\n")).toEqual([
      "2026-10-07T09:30:00.000Z INFO  document.status documentId=d-1 status=ready pages=12",
      "2026-10-07T09:30:00.000Z WARN  connector.failed errorKind=missing-command retrying=true",
      "2026-10-07T09:30:00.000Z ERROR window.crashed reason=oom exitCode=null",
      "",
    ]);
  });

  test("an error keeps its type, a scrubbed first line and its frames, never the User's content", async () => {
    const { logger, text } = await startLogger();
    const error = new TypeError(
      `Couldn't read "${DOCUMENT_TEXT}" for alice@example.com with ${API_KEY}\n${QUESTION}`,
    ) as NodeJS.ErrnoException;
    error.code = "ERR_INVALID_ARG";
    error.stack = [
      `TypeError: Couldn't read "${DOCUMENT_TEXT}"`,
      `    at extract (${APP}/out/main/index.js:120:7)`,
      `    at file://${APP}/out/renderer/assets/index.js:3:9`,
      `    at open (${HOME}/Documents/Secret plan/reader.js:1:1)`,
    ].join("\n");

    logger.exception("main.uncaught", error, { origin: "uncaughtException" });

    const logged = await text();
    expect(logged).toBe(
      [
        '2026-10-07T09:30:00.000Z ERROR main.uncaught origin=uncaughtException error="TypeError [ERR_INVALID_ARG]: Couldn\'t read [redacted] for [email] with [redacted]"',
        "    at extract (app:///out/main/index.js:120:7)",
        "    at app:///out/renderer/assets/index.js:3:9",
        "    at open ([path])",
        "",
      ].join("\n"),
    );
    for (const secret of [...SECRETS, DOCUMENT_TEXT, QUESTION, API_KEY]) {
      expect(logged).not.toContain(secret);
    }
  });

  test("fields lose paths, e-mail addresses and URLs' queries", async () => {
    const { logger, text } = await startLogger();

    logger.info("event", {
      path: `${HOME}/Documents/Secret plan.pdf`,
      url: `https://api.example.com/v1?key=${API_KEY}`,
      who: "alice@example.com",
    });

    expect(await text()).toBe(
      "2026-10-07T09:30:00.000Z INFO  event path=[path] url=https://api.example.com/v1 who=[email]\n",
    );
  });

  test("what isn't an error or text is logged by its type alone", async () => {
    const { logger, text } = await startLogger();

    logger.exception("main.uncaught", { question: QUESTION, apiKey: API_KEY });

    expect(await text()).toBe('2026-10-07T09:30:00.000Z ERROR main.uncaught error="(object)"\n');
  });

  test("console errors and warnings still reach the console, and the log, scrubbed", async () => {
    const { logger, text } = await startLogger();
    const target = { error: vi.fn(), warn: vi.fn() };
    const restore = logConsole(logger, target);
    const failure = new Error(`The provider said "${QUESTION}"`);

    target.warn("The update check failed:", failure);
    target.error(`Skipped "${DOCUMENT_TEXT}"`, { apiKey: API_KEY });
    restore();
    target.error("After restoring, nothing is logged.");

    expect(target.warn).toHaveBeenCalledWith("The update check failed:", failure);
    const lines = (await text()).split("\n").filter((line) => !line.startsWith("    at "));
    expect(lines).toEqual([
      '2026-10-07T09:30:00.000Z WARN  console.warn message="The update check failed:" error="Error: The provider said [redacted]"',
      '2026-10-07T09:30:00.000Z ERROR console.error message="Skipped [redacted]"',
      "",
    ]);
  });

  test("an error a panel's boundary caught is named, says so, and keeps the component stack (#1500)", async () => {
    const { logger, text } = await startLogger();

    logWindowError(logger, {
      kind: "error",
      name: "Error",
      message: `The card failed on "${DOCUMENT_TEXT}"`,
      stack: `Error: ${DOCUMENT_TEXT}\n    at draw (file://${APP}/out/renderer/assets/editor.js:5:2)`,
      panel: "card",
      componentStack: `\n    at Editor (file://${APP}/out/renderer/assets/editor.js:9:4)\n    at PanelBoundary (file://${APP}/out/renderer/assets/index.js:1:1)`,
    });
    logWindowError(logger, {
      kind: "error",
      name: "Error",
      message: "x",
      stack: "",
      panel: "kitchen",
    });

    expect(await text()).toBe(
      [
        '2026-10-07T09:30:00.000Z ERROR window.panel-failed panel=card caught=boundary error="Error: The card failed on [redacted]"',
        "    at draw (app:///out/renderer/assets/editor.js:5:2)",
        "    component stack:",
        "    at Editor (app:///out/renderer/assets/editor.js:9:4)",
        "    at PanelBoundary (app:///out/renderer/assets/index.js:1:1)",
        // A panel name it doesn't know isn't taken: it is an error nothing caught.
        '2026-10-07T09:30:00.000Z ERROR window.uncaught kind=error error="Error: x"',
        "",
      ].join("\n"),
    );
  });

  test("an error from the window is logged like the main process's own", async () => {
    const { logger, text } = await startLogger();

    logWindowError(logger, {
      kind: "rejection",
      name: "RangeError",
      message: `Position out of range in "${DOCUMENT_TEXT}"`,
      stack: `RangeError: ${DOCUMENT_TEXT}\n    at resolve (file://${APP}/out/renderer/assets/editor.js:5:2)`,
    });
    logWindowError(logger, "not a report");

    expect(await text()).toBe(
      [
        '2026-10-07T09:30:00.000Z ERROR window.uncaught kind=rejection error="RangeError: Position out of range in [redacted]"',
        "    at resolve (app:///out/renderer/assets/editor.js:5:2)",
        '2026-10-07T09:30:00.000Z ERROR window.uncaught kind=error error="Error: "',
        "",
      ].join("\n"),
    );
  });
});
