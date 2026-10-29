import { afterEach, describe, expect, test, vi } from "vitest";
import type { WindowCommandRequest } from "../../src/core";
import { createEventHub } from "../../src/core/events";
import { createWindowCommands, WINDOW_ANSWER_MS } from "../../src/core/windowCommands";

const request = (clientId: string): Omit<WindowCommandRequest, "requestId"> => ({
  answerId: "answer",
  toolCallId: "call",
  run: "run",
  command: "mind.check",
  targets: [],
  mindId: null,
  clientId,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("The core's wait for a window's command (#1421)", () => {
  // protects=a window that never answers leaves the command not done once its time is up, in the interface's words, and its late answer is refused; fails_when=the wait has no end, or the late answer counts; no_claim=how long a real command takes.
  test("one not answered in time wasn't done, and a late answer is refused", async () => {
    vi.useFakeTimers();
    const events = createEventHub();
    const sent: string[] = [];
    events.on("command.windowRun", ({ requestId }) => sent.push(requestId));
    const windows = createWindowCommands(events);

    const waiting = windows.run(request("window"), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(WINDOW_ANSWER_MS);

    await expect(waiting).resolves.toEqual({
      ran: false,
      why: expect.stringContaining("didn't answer"),
      wording: { key: "commands.window.unanswered", values: { command: "mind.check" } },
    });
    expect(windows.answer(sent[0], { ran: true, changed: false })).toBe(false);
  });

  // protects=a window gone settles only what it was asked, and an answer in time still counts; fails_when=another window's request is settled, or a timely answer is refused; no_claim=the shell's events.
  test("a window gone settles its own requests only", async () => {
    const events = createEventHub();
    const sent: string[] = [];
    events.on("command.windowRun", ({ requestId }) => sent.push(requestId));
    const windows = createWindowCommands(events);
    const signal = new AbortController().signal;

    const closing = windows.run(request("closing"), signal);
    const staying = windows.run(request("staying"), signal);
    windows.forget("closing");

    await expect(closing).resolves.toMatchObject({ ran: false });
    expect(windows.answer(sent[1], { ran: true, changed: false })).toBe(true);
    await expect(staying).resolves.toEqual({ ran: true, changed: false });
  });
});
