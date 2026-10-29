import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WindowCommandEnd, WindowCommandRequest } from "../../src/core";
import { createEventHub } from "../../src/core/events";
import {
  createWindowCommands,
  WINDOW_SETTLE_MS,
  WINDOW_START_MS,
} from "../../src/core/windowCommands";

/*
 * The core's wait for a window's command (#1421): the window says at once that the command
 * started, then how it ended. Only the start has a deadline; a long command, a Check of a long
 * Note or a recording waiting for the system's microphone permission, goes on and ends later.
 */

const request = (clientId: string): Omit<WindowCommandRequest, "requestId"> => ({
  answerId: "answer",
  toolCallId: "call",
  run: "run",
  command: "mind.check",
  targets: [],
  mindId: null,
  clientId,
});

function windowsOf() {
  const events = createEventHub();
  const sent: string[] = [];
  events.on("command.windowRun", ({ requestId }) => sent.push(requestId));
  const windows = createWindowCommands(events);
  const ended: WindowCommandEnd[] = [];
  const run = (clientId: string, signal = new AbortController().signal) =>
    windows.run(request(clientId), signal, (end) => ended.push(end));
  return { windows, sent, ended, run };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("The core's wait for a window's command (#1421)", () => {
  // protects=a window that never says the command started leaves it not done once its time is up, in the interface's words, and its late answer is refused; fails_when=the wait has no end, or the late answer counts; no_claim=how long a real window takes.
  test("one not started in time wasn't done, and a late answer is refused", async () => {
    const { windows, sent, run } = windowsOf();

    const waiting = run("window");
    await vi.advanceTimersByTimeAsync(WINDOW_START_MS);

    await expect(waiting).resolves.toEqual({
      ran: false,
      why: expect.stringContaining("didn't answer"),
      wording: { key: "commands.window.unanswered", values: { command: "mind.check" } },
    });
    expect(windows.answer(sent[0], { ran: true, changed: false })).toBe(false);
  });

  // protects=a run slower than the start's limit (a Check of 45 s) is started, not failed: its call returns while it goes on, and its end comes later and counts; fails_when=it is called not done while it runs, or its end is lost; no_claim=the Check itself.
  test("a Check that takes 45 s starts at once, and its end comes after its call", async () => {
    const { windows, sent, ended, run } = windowsOf();

    const call = run("window");
    expect(windows.answer(sent[0], { started: true })).toBe(true);
    await vi.advanceTimersByTimeAsync(WINDOW_SETTLE_MS);
    await expect(call).resolves.toEqual({ started: true });

    await vi.advanceTimersByTimeAsync(45_000 - WINDOW_SETTLE_MS);
    expect(ended).toEqual([]);
    expect(windows.answer(sent[0], { ran: true, changed: false })).toBe(true);
    expect(ended).toEqual([{ ran: true, changed: false }]);
  });

  // protects=a command that ends in a moment settles its call with how it ended; fails_when=it reads as still going on, or its end goes to the late path too; no_claim=what it did.
  test("one that ends in a moment settles its call with its end", async () => {
    const { windows, sent, ended, run } = windowsOf();

    const call = run("window");
    windows.answer(sent[0], { started: true });
    windows.answer(sent[0], { ran: true, changed: true });

    await expect(call).resolves.toEqual({ ran: true, changed: true });
    await vi.advanceTimersByTimeAsync(WINDOW_START_MS);
    expect(ended).toEqual([]);
  });

  // protects=a window gone before the command started leaves it not done; one gone while it runs says the window closed before it finished; another window's requests are left alone; fails_when=either waits on, or another window's request is settled; no_claim=the shell's events.
  test("a window gone before it starts, or while it runs, settles its own requests only", async () => {
    const { windows, sent, ended, run } = windowsOf();

    const before = run("closing");
    const running = run("closing");
    const staying = run("staying");
    windows.answer(sent[1], { started: true });
    await vi.advanceTimersByTimeAsync(WINDOW_SETTLE_MS);
    await expect(running).resolves.toEqual({ started: true });
    windows.forget("closing");

    await expect(before).resolves.toMatchObject({
      ran: false,
      wording: { key: "commands.window.unanswered" },
    });
    expect(ended).toEqual([
      expect.objectContaining({
        ran: false,
        wording: expect.objectContaining({ key: "commands.window.closed" }),
      }),
    ]);
    expect(windows.answer(sent[2], { ran: true, changed: false })).toBe(true);
    await expect(staying).resolves.toEqual({ ran: true, changed: false });
  });

  // protects=an Answer stopped after its command started still hears how the command ended; fails_when=the end is refused, or the stop is lost; no_claim=the Answer's own stop.
  test("stopped after it started, the command's end still comes", async () => {
    const { windows, sent, ended, run } = windowsOf();
    const stop = new AbortController();

    const call = run("window", stop.signal);
    windows.answer(sent[0], { started: true });
    stop.abort(new Error("Stopped."));

    await expect(call).rejects.toThrow("Stopped.");
    expect(windows.answer(sent[0], { ran: true, changed: false })).toBe(true);
    expect(ended).toEqual([{ ran: true, changed: false }]);
  });
});
