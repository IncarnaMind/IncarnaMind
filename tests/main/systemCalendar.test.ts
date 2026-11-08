import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCalendarHelper } from "../../scripts/calendarHelper.mjs";
import type { LogFields } from "../../src/core/adapters";

vi.mock("electron", () => ({ app: {}, shell: {} }));

const { createHelperCalendar, helperRunner, parseAccess, SystemCalendarNotAllowedError } =
  await import("../../src/main/systemCalendar");

const event = {
  calendarId: "work",
  id: "event-1",
  externalId: "uid-1@example.com",
  occurrence: null,
  title: "Aldermoor renewal call",
  start: "2026-11-09T14:00:00.000Z",
  end: "2026-11-09T14:30:00.000Z",
  allDay: false,
  status: "confirmed",
  attendees: [
    { name: "Priya Raman", email: "priya@aldermoor.example", self: false, status: "accepted" },
    { name: null, email: null, self: true, status: "accepted" },
  ],
  organizer: null,
  url: "https://meet.example.com/abc",
  location: null,
  notes: null,
};

function fakeHelper(answers: Record<string, { code: number | null; stdout: string }>) {
  const runs: { args: readonly string[]; limitMs: number | null }[] = [];
  const logged: { event: string; fields: LogFields | undefined }[] = [];
  const log = {
    info() {},
    warn: (name: string, fields?: LogFields) => logged.push({ event: name, fields }),
    error() {},
  };
  const calendar = createHelperCalendar({
    run: async (args, limitMs) => {
      runs.push({ args, limitMs });
      const answer = answers[args[0] ?? ""];
      if (!answer) throw new Error(`No answer for ${args[0]}`);
      return answer;
    },
    openSettings: async () => {},
    log,
  });
  return { calendar, runs, logged };
}

const ok = (value: object) => ({ code: 0, stdout: `${JSON.stringify(value)}\n` });

describe("The Mac's calendar through the helper (#190)", () => {
  it("reads whether it may, with `access` alone, which never shows the system's prompt", async () => {
    const { calendar, runs } = fakeHelper({ access: ok({ access: "not-asked" }) });
    expect(await calendar.access()).toBe("not-asked");
    expect(runs).toEqual([{ args: ["access"], limitMs: 10_000 }]);
  });

  it("asks with `request` only, and waits for the User however long they take", async () => {
    const { calendar, runs } = fakeHelper({ request: ok({ access: "denied" }) });
    expect(await calendar.requestAccess()).toBe("denied");
    expect(runs).toEqual([{ args: ["request"], limitMs: null }]);
  });

  it("reads the calendars and the events of those asked for, between two times", async () => {
    const { calendar, runs } = fakeHelper({
      calendars: ok({
        calendars: [{ id: "work", title: "Work", source: "iCloud", kind: "caldav" }],
      }),
      events: ok({ events: [event] }),
    });
    expect(await calendar.calendars()).toEqual([
      { id: "work", title: "Work", source: "iCloud", kind: "caldav" },
    ]);
    const from = "2026-11-08T00:00:00.000Z";
    const to = "2026-11-11T00:00:00.000Z";
    expect(await calendar.events({ from, to, calendarIds: ["work", "home"] })).toEqual([event]);
    expect(runs.at(-1)?.args).toEqual([
      "events",
      "--from",
      from,
      "--to",
      to,
      "--calendar",
      "work",
      "--calendar",
      "home",
    ]);
  });

  it("runs nothing for events when no calendar counts", async () => {
    const { calendar, runs } = fakeHelper({});
    expect(await calendar.events({ from: "a", to: "b", calendarIds: [] })).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("tells a refused access apart, so the core can say so on the calendar's row", async () => {
    const { calendar } = fakeHelper({ events: { code: 3, stdout: '{"error":"not-allowed"}' } });
    const refused = calendar.events({ from: "a", to: "b", calendarIds: ["work"] });
    await expect(refused).rejects.toBeInstanceOf(SystemCalendarNotAllowedError);
    await expect(refused).rejects.toMatchObject({ code: "not-allowed" });
  });

  it("says what the helper said when it failed, and when it didn't answer in time", async () => {
    const { calendar, logged } = fakeHelper({
      calendars: { code: 1, stdout: '{"error":"The calendar store is unavailable"}' },
      access: { code: null, stdout: "" },
    });
    await expect(calendar.calendars()).rejects.toThrow(/The calendar store is unavailable/);
    await expect(calendar.access()).rejects.toThrow(/didn't answer in time/);
    expect(logged.map((each) => each.event)).toEqual([
      "systemCalendar.failed",
      "systemCalendar.failed",
    ]);
  });

  it("refuses an answer it can't read, logging its size but never the User's events", async () => {
    const { calendar, logged } = fakeHelper({
      events: ok({ events: [{ ...event, status: "postponed" }] }),
    });
    await expect(calendar.events({ from: "a", to: "b", calendarIds: ["work"] })).rejects.toThrow(
      /answered something IncarnaMind can't read/,
    );
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain("Aldermoor");
    expect(logged[0]?.fields).toMatchObject({ command: "events", bytes: expect.any(Number) });
  });

  it("refuses an access answer that isn't one of the four", () => {
    expect(() => parseAccess({ access: "maybe" })).toThrow();
    expect(() => parseAccess("allowed")).toThrow();
    expect(parseAccess({ access: "restricted" })).toBe("restricted");
  });
});

describe.skipIf(process.platform === "win32")("Running the helper", () => {
  let folder = "";
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "incarnamind-calendar-helper-"));
  });
  afterEach(() => rm(folder, { recursive: true, force: true }));

  const script = async (body: string) => {
    const path = join(folder, "helper");
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return helperRunner(path);
  };

  it("gives its exit code with what it printed", async () => {
    const run = await script(`printf '{"error":"not-allowed"}'\nexit 3`);
    expect(await run(["events"], 10_000)).toEqual({ code: 3, stdout: '{"error":"not-allowed"}' });
  });

  it("stops one that hangs, with no exit code", async () => {
    const run = await script("exec sleep 30");
    expect(await run(["access"], 200)).toEqual({ code: null, stdout: "" });
  });

  it("rejects when there is no helper to start", async () => {
    await expect(helperRunner(join(folder, "missing"))(["access"], 10_000)).rejects.toThrow(
      /ENOENT/,
    );
  });
});

// Only `access`: the real helper is never asked to request access or read a calendar here, which
// would show the system's prompt or read the calendars of whoever runs the tests.
it.skipIf(process.platform !== "darwin")(
  "the real helper, built as the packager builds it, answers whether it may read",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "incarnamind-calendar-helper-"));
    try {
      const path = join(folder, "calendar-helper");
      expect(await buildCalendarHelper(path)).toBe(true);
      const { code, stdout } = await helperRunner(path)(["access"], 10_000);
      expect(code).toBe(0);
      expect(["allowed", "denied", "restricted", "not-asked"]).toContain(
        parseAccess(JSON.parse(stdout)),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
  120_000,
);
