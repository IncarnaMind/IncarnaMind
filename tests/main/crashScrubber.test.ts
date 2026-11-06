import type { Breadcrumb, ErrorEvent, EventHint } from "@sentry/electron/main";
import { describe, expect, test } from "vitest";
import {
  createScrubber,
  EMAIL,
  IP_ADDRESS,
  MAX_MESSAGE_LENGTH,
  PATH,
  REDACTED,
} from "../../src/main/crashScrubber";

/** A Mac whose User keeps the data folder on an external disk. */
const MAC = createScrubber({
  homeDir: "/Users/alice",
  dataDir: "/Volumes/Work Disk/IncarnaMind data",
  others: ["/private/var/folders/x1/abc123/T"],
});
const WINDOWS = createScrubber({
  homeDir: "C:\\Users\\Alice Smith",
  dataDir: "C:\\Users\\Alice Smith\\AppData\\Roaming\\IncarnaMind",
});

/** Words from the User's content and identity that must never be in a report. */
const SECRETS = [
  "alice",
  "Alice",
  "Smith",
  "Work Disk",
  "IncarnaMind data",
  "Divorce",
  "Quarterly",
  "merger",
  "patient",
  "季度",
  "Bob",
  "salaries",
  "sk-proj",
  "hunter2",
  "MacBook",
  "Europe/London",
  "192.168",
  "fe80",
];

function expectNoSecrets(value: unknown) {
  const json = JSON.stringify(value);
  for (const secret of SECRETS) expect(json, `"${secret}" leaked`).not.toContain(secret);
}

/** An event as Sentry builds it for an error in the main process, before scrubbing. */
function mainProcessError(message: string): ErrorEvent {
  return {
    type: undefined,
    event_id: "0f0e0d0c0b0a09080706050403020100",
    timestamp: 1_791_000_000,
    platform: "node",
    level: "error",
    release: "IncarnaMind@0.1.0",
    environment: "production",
    server_name: "Alices-MacBook-Pro",
    sdk: { name: "sentry.javascript.electron", version: "8.1.0" },
    user: { id: "alice", email: "alice@example.com", ip_address: "192.168.1.20" },
    request: { url: "file:///Users/alice/index.html", data: "Quarterly revenue fell" },
    extra: { documentText: "Quarterly revenue fell after the merger" },
    modules: { "/Users/alice/node_modules/x": "1.0.0" },
    exception: {
      values: [
        {
          type: "Error",
          value: message,
          mechanism: { type: "onunhandledrejection", handled: false, data: { text: "Divorce" } },
          stacktrace: {
            frames: [
              {
                filename: "node:internal/process/task_queues",
                function: "process.processTicksAndRejections",
                lineno: 105,
                colno: 5,
                in_app: false,
              },
              {
                filename: "app:///out/main/index.js",
                abs_path: "app:///out/main/index.js",
                module: "index",
                function: "extractText",
                lineno: 812,
                colno: 11,
                in_app: true,
                context_line: 'const text = "Quarterly revenue fell";',
                pre_context: ["// Divorce papers"],
                post_context: ["// the merger"],
                vars: {
                  text: "Quarterly revenue fell after the merger",
                  name: "Divorce papers.pdf",
                },
              },
              {
                filename: "/Users/alice/Library/Application Support/IncarnaMind/skills/x.js",
                abs_path: "/Users/alice/Library/Application Support/IncarnaMind/skills/x.js",
                lineno: 3,
              },
            ],
          },
        },
      ],
    },
    breadcrumbs: [
      { category: "console", level: "log", message: "Indexed Divorce papers.pdf", timestamp: 1 },
      { category: "ui.click", message: 'button[aria-label="Rename Divorce papers"]', timestamp: 2 },
      { category: "ui.input", message: "div.ProseMirror", timestamp: 3 },
      {
        category: "http",
        data: { url: "https://api.example.com/search?q=Divorce", method: "GET" },
        timestamp: 4,
      },
      { category: "sentry.event", message: "Error: Quarterly revenue fell", timestamp: 5 },
      {
        type: "ui",
        category: "electron",
        message: "browser-window.focus",
        data: {
          id: 1,
          url: "file:///Users/alice/Applications/IncarnaMind.app/index.html",
          title: "Divorce papers",
        },
        timestamp: 6,
      },
      {
        type: "process",
        category: "child-process",
        level: "fatal",
        message: "'Utility' process exited with 'crashed'",
        data: { type: "Utility", reason: "crashed", exitCode: 11, name: "Divorce papers" },
        timestamp: 7,
      },
    ],
    contexts: {
      os: { name: "macOS", version: "26.1", kernel_version: "25.5.0" },
      app: { app_name: "IncarnaMind", app_version: "0.1.0", app_memory: 1234 },
      device: {
        arch: "arm64",
        family: "Desktop",
        processor_count: 12,
        memory_size: 34_359_738_368,
        name: "Alices-MacBook-Pro",
        boot_time: "x",
      },
      culture: { locale: "en-GB", timezone: "Europe/London" },
      runtime: { name: "Electron", version: "44.5.1" },
      browser: { name: "Chrome" },
      chrome: { name: "Chrome", type: "runtime", version: "140.0.7339.80" },
      node: { name: "Node", type: "runtime", version: "22.14.0" },
      trace: { trace_id: "abc", span_id: "def" },
      custom: { note: "Quarterly revenue fell" },
    },
    tags: { "event.origin": "electron", "event.process": "browser" },
    debug_meta: {
      images: [
        {
          type: "macho",
          code_file: "/Users/alice/Applications/IncarnaMind.app/Contents/MacOS/IncarnaMind",
          debug_id: "1234",
          image_addr: "0x1000",
        },
      ],
    },
  } as ErrorEvent;
}

describe("Scrubbing crash reports", () => {
  test("an event keeps what helps fix the bug", () => {
    const event = MAC.event(mainProcessError("Cannot read properties of undefined (reading 'x')"));

    expect(event).toMatchObject({
      event_id: "0f0e0d0c0b0a09080706050403020100",
      timestamp: 1_791_000_000,
      level: "error",
      platform: "node",
      release: "IncarnaMind@0.1.0",
      environment: "production",
      sdk: { name: "sentry.javascript.electron" },
      tags: { "event.origin": "electron", "event.process": "browser" },
    });
    const [exception] = event.exception?.values ?? [];
    expect(exception?.type).toBe("Error");
    expect(exception?.value).toBe(`Cannot read properties of undefined (reading ${REDACTED})`);
    expect(exception?.mechanism).toEqual({ type: "onunhandledrejection", handled: false });
    expect(exception?.stacktrace?.frames).toEqual([
      {
        filename: "node:internal/process/task_queues",
        function: "process.processTicksAndRejections",
        lineno: 105,
        colno: 5,
        in_app: false,
      },
      {
        filename: "app:///out/main/index.js",
        abs_path: "app:///out/main/index.js",
        module: "index",
        function: "extractText",
        lineno: 812,
        colno: 11,
        in_app: true,
      },
      { filename: PATH, abs_path: PATH, lineno: 3 },
    ]);
    expect(event.contexts).toEqual({
      os: { name: "macOS", version: "26.1", kernel_version: "25.5.0" },
      app: { app_name: "IncarnaMind", app_version: "0.1.0" },
      device: {
        arch: "arm64",
        family: "Desktop",
        processor_count: 12,
        memory_size: 34_359_738_368,
      },
      runtime: { name: "Electron", version: "44.5.1" },
      browser: { name: "Chrome" },
      chrome: { name: "Chrome", type: "runtime", version: "140.0.7339.80" },
      node: { name: "Node", type: "runtime", version: "22.14.0" },
    });
  });

  test("the user, their IP address, the computer's name, request and extra data are dropped", () => {
    const event = MAC.event(mainProcessError("Something broke"));

    for (const field of ["user", "server_name", "request", "extra", "modules"]) {
      expect(event).not.toHaveProperty(field);
    }
    expectNoSecrets(event);
  });

  test("local variables, source lines and the mechanism's data are dropped from stack traces", () => {
    const frames = MAC.event(mainProcessError("x")).exception?.values?.[0]?.stacktrace?.frames;

    for (const frame of frames ?? []) {
      expect(frame).not.toHaveProperty("vars");
      expect(frame).not.toHaveProperty("context_line");
      expect(frame).not.toHaveProperty("pre_context");
      expect(frame).not.toHaveProperty("post_context");
    }
  });

  test.each([
    [
      "the data folder, quoted",
      "ENOENT: no such file or directory, open '/Volumes/Work Disk/IncarnaMind data/documents/3a7f.pdf'",
      `ENOENT: no such file or directory, open ${REDACTED}`,
    ],
    [
      "the data folder, unquoted, with spaces",
      "Couldn't open /Volumes/Work Disk/IncarnaMind data/incarnamind.db: locked",
      `Couldn't open ${PATH}`,
    ],
    [
      "a path in the home folder",
      "Couldn't read /Users/alice/Desktop/Divorce papers.pdf",
      `Couldn't read ${PATH}`,
    ],
    [
      "a path with an apostrophe",
      "open '/Users/alice/Bob's notes.md' failed",
      `open ${REDACTED} failed`,
    ],
    [
      "a quoted path, and the rest of the line stays",
      "Cannot find module '/Users/alice/Divorce.js' (imported from a Skill)",
      `Cannot find module ${REDACTED} (imported from a Skill)`,
    ],
    ["the home folder alone", "HOME is /Users/alice", `HOME is ${PATH}`],
    ["a path from ~", "Wrote ~/Documents/Divorce.md", `Wrote ${PATH}`],
    ["a Linux home folder", "Missing /home/alice/notes.md", `Missing ${PATH}`],
    [
      "the temp folder",
      "Spawn failed in /private/var/folders/x1/abc123/T/run-1",
      `Spawn failed in ${PATH}`,
    ],
    [
      "a file URL",
      "Not allowed to load file:///Users/alice/My%20Docs/Divorce.pdf here",
      `Not allowed to load ${PATH} here`,
    ],
  ])("a message loses %s", (_, message, expected) => {
    const event = MAC.event(mainProcessError(message));

    expect(event.exception?.values?.[0]?.value).toBe(expected);
    expectNoSecrets(event);
  });

  test.each([
    [
      "the data folder",
      "EPERM: operation not permitted, unlink 'C:\\Users\\Alice Smith\\AppData\\Roaming\\IncarnaMind\\incarnamind.db'",
      `EPERM: operation not permitted, unlink ${REDACTED}`,
    ],
    [
      "a path with spaces, unquoted",
      "Couldn't read C:\\Users\\Alice Smith\\Documents\\Divorce papers.pdf",
      `Couldn't read ${PATH}`,
    ],
    [
      "a path with forward slashes",
      "Couldn't read C:/Users/Alice Smith/Documents/Divorce.pdf",
      `Couldn't read ${PATH}`,
    ],
    [
      "a network share",
      "Copy failed: \\\\fileserver\\HR\\salaries 2026.xlsx",
      `Copy failed: ${PATH}`,
    ],
    ["another drive", "Open D:\\Work\\Divorce.pdf", `Open ${PATH}`],
  ])("on Windows, a message loses %s", (_, message, expected) => {
    const event = WINDOWS.event(mainProcessError(message));

    expect(event.exception?.values?.[0]?.value).toBe(expected);
    expectNoSecrets(event);
  });

  test("Windows paths in stack frames go too", () => {
    const input = mainProcessError("x");
    const frames = input.exception?.values?.[0]?.stacktrace?.frames ?? [];
    frames.push({
      filename: "C:\\Users\\Alice Smith\\AppData\\Local\\Temp\\skill-1\\run.js",
      lineno: 1,
    });

    const event = WINDOWS.event(input);

    expect(event.exception?.values?.[0]?.stacktrace?.frames?.at(-1)).toEqual({
      filename: PATH,
      lineno: 1,
    });
    expectNoSecrets(event);
  });

  test.each([
    [
      "a JSON parser quoting the text it failed on",
      "Unexpected token 'Q', \"Quarterly revenue fell after the merger\" is not valid JSON",
      `Unexpected token ${REDACTED}, ${REDACTED} is not valid JSON`,
    ],
    [
      "single quotes, not apostrophes",
      "Can't index 'Meeting notes with Bob' yet",
      `Can't index ${REDACTED} yet`,
    ],
    ["Chinese quotation marks", "无法解析“季度收入下降了百分之十二”", `无法解析${REDACTED}`],
    ["corner brackets", "无法解析「季度报告」", `无法解析${REDACTED}`],
    ["backticks", "Unknown block `Divorce papers`", `Unknown block ${REDACTED}`],
    [
      "everything after the first line",
      'Validation failed\n{"answer": "The patient was diagnosed with…"}',
      "Validation failed",
    ],
    [
      "an API key",
      "Incorrect API key provided: sk-proj-AbC123dEf456GhI789jKl012MnO345",
      `Incorrect API key provided: ${REDACTED}`,
    ],
    ["an e-mail address", "Signed in as alice@example.com", `Signed in as ${EMAIL}`],
    [
      "an IP address",
      "connect ECONNREFUSED 192.168.1.20:11434",
      `connect ECONNREFUSED ${IP_ADDRESS}:11434`,
    ],
    ["an IPv6 address", "Can't reach fe80::1ff:fe23:4567:890a", `Can't reach ${IP_ADDRESS}`],
    [
      "a URL's query, and its credentials",
      "GET https://bob:hunter2@api.example.com/v1/search?q=Divorce+papers#Quarterly failed",
      "GET https://api.example.com/v1/search failed",
    ],
  ])("a message loses %s", (_, message, expected) => {
    const event = MAC.event(mainProcessError(message));

    expect(event.exception?.values?.[0]?.value).toBe(expected);
    expectNoSecrets(event);
  });

  test("a long message is cut short", () => {
    const value = MAC.message(`Bad input: ${"word ".repeat(200)}`);

    expect(value).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(value.endsWith("…")).toBe(true);
  });

  test("a message without content is kept as it is", () => {
    const message = "Cannot read properties of undefined (reading x) at line 3/4";

    expect(MAC.message(message)).toBe(message);
  });

  test("log messages and fingerprints are scrubbed; log parameters are dropped", () => {
    const input = mainProcessError("x");
    input.message = "Indexing /Users/alice/Divorce.pdf failed";
    input.logentry = { message: 'Failed on "Quarterly revenue"', params: ["Divorce"] };
    input.fingerprint = ["{{ default }}", "/Users/alice/Divorce.pdf"];

    const event = MAC.event(input);

    expect(event.message).toBe(`Indexing ${PATH}`);
    expect(event.logentry).toEqual({ message: `Failed on ${REDACTED}` });
    expect(event.fingerprint).toEqual(["{{ default }}", PATH]);
    expectNoSecrets(event);
  });

  test("native images and threads lose their paths", () => {
    const input = mainProcessError("x");
    input.threads = {
      values: [
        {
          id: 1,
          name: "/Users/alice/Divorce.pdf worker",
          crashed: true,
          stacktrace: { frames: [{ filename: "/Users/alice/x.js", vars: { a: "Divorce" } }] },
        },
      ],
    };

    const event = MAC.event(input);

    expect(event.threads).toEqual({
      values: [{ id: 1, name: PATH, crashed: true, stacktrace: { frames: [{ filename: PATH }] } }],
    });
    expect(event.debug_meta).toEqual({
      images: [{ type: "macho", code_file: PATH, debug_id: "1234", image_addr: "0x1000" }],
    });
    expectNoSecrets(event);
  });

  test("attachments, such as screenshots and minidumps, are never sent", () => {
    const hint: EventHint = {
      attachments: [
        { filename: "screenshot.png", data: "png" },
        { filename: "minidump.dmp", data: "raw memory" },
      ],
    };

    MAC.event(mainProcessError("x"), hint);

    expect(hint.attachments).toEqual([]);
  });

  test("the event Sentry built is left as it was", () => {
    const input = mainProcessError("open '/Users/alice/Divorce.pdf'");
    const before = structuredClone(input);

    MAC.event(input);

    expect(input).toEqual(before);
  });
});

describe("Scrubbing breadcrumbs", () => {
  test("only app lifecycle and child-process breadcrumbs are kept, without their content", () => {
    const event = MAC.event(mainProcessError("x"));

    expect(event.breadcrumbs).toEqual([
      {
        type: "ui",
        category: "electron",
        message: "browser-window.focus",
        data: { id: 1 },
        timestamp: 6,
      },
      {
        type: "process",
        category: "child-process",
        level: "fatal",
        // Sentry's own message: the process type and the reason are Electron's.
        message: "'Utility' process exited with 'crashed'",
        data: { type: "Utility", reason: "crashed", exitCode: 11 },
        timestamp: 7,
      },
    ]);
  });

  test.each<[string, Breadcrumb]>([
    ["console output", { category: "console", message: "Indexed Divorce papers.pdf" }],
    ["clicks", { category: "ui.click", message: 'button[title="Divorce papers"]' }],
    ["keypresses", { category: "ui.input", message: "div.ProseMirror" }],
    ["requests", { category: "fetch", data: { url: "https://x.example/?q=Divorce" } }],
    ["navigation", { category: "navigation", data: { from: "/", to: "/Divorce" } }],
    ["Node child processes", { category: "child_process", data: { spawnfile: "/Users/alice/x" } }],
    ["earlier events", { category: "sentry.event", message: "Error: Quarterly revenue" }],
    ["anything without a category", { message: "Divorce" }],
  ])("%s are dropped as they happen", (_, breadcrumb) => {
    expect(MAC.breadcrumb(breadcrumb)).toBeNull();
  });
});
