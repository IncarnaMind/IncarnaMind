import { beforeEach, describe, expect, test, vi } from "vitest";
import type { askFirstAgent } from "../../src/renderer/src/askYourAi";
import type { checkFromAssistant } from "../../src/renderer/src/mindCheck";
import type { askInNote, NoteAsk } from "../../src/renderer/src/ownAiInNote";

/*
 * Write notes (#3762): the meeting's Note asks its own AI, as its input does, and checks what it
 * wrote in the same press, once, only when the request landed with changes; an AI reached only
 * through its own app gets the request by its link, with the meeting.
 */

type Asks = { byMind: Readonly<Record<string, Partial<NoteAsk>>> };

const asks = vi.hoisted(() => {
  let state: Asks = { byMind: {} };
  const listeners = new Set<(next: Asks) => void>();
  return {
    getState: () => state,
    setState(next: Asks) {
      state = next;
      for (const listener of [...listeners]) listener(state);
    },
    subscribe(listener: (next: Asks) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listeners,
  };
});
const ask = vi.hoisted(() => vi.fn<typeof askInNote>());
const link = vi.hoisted(() => vi.fn<typeof askFirstAgent>());
const check = vi.hoisted(() => vi.fn<typeof checkFromAssistant>());
const reportError = vi.hoisted(() => vi.fn());
vi.mock("../../src/renderer/src/core", () => ({ core: {} }));
vi.mock("../../src/renderer/src/ownAiInNote", () => ({ askInNote: ask, useNoteAsks: asks }));
vi.mock("../../src/renderer/src/askYourAi", () => ({ askFirstAgent: link }));
vi.mock("../../src/renderer/src/mindCheck", () => ({ checkFromAssistant: check }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: { getState: () => ({ reportError }) },
}));

const { writeMeetingNotes } = await import("../../src/renderer/src/writeMeetingNotes");

const meeting = { id: "meeting", mindId: "mind", stoppedAt: "2026-11-25T10:00:00.000Z" };
const WORDS = "Write the notes of this call.";

/** The Note's request as the core tells it: `turnId` in `state`, having changed `changed` paragraphs. */
const told = (turnId: string, state: NoteAsk["state"], changed = 0) =>
  asks.setState({ byMind: { [meeting.mindId]: { turnId, state, changed } } });

/** Write notes pressed, its request started as turn "turn", and waiting for it to end. */
async function pressed() {
  ask.mockImplementation(async () => {
    told("turn", "working");
    return "started";
  });
  const press = writeMeetingNotes(meeting, WORDS);
  await vi.waitFor(() => expect(asks.listeners.size).toBe(1));
  return { press };
}

beforeEach(() => {
  vi.clearAllMocks();
  asks.setState({ byMind: {} });
  asks.listeners.clear();
  check.mockResolvedValue(undefined);
  link.mockResolvedValue("asked");
});

describe("Write notes", () => {
  // protects=Write notes asks the Note's own AI as its input does, with nothing selected, waits for the request to land, and runs the Check once when it landed with changes, however often the core tells of it after; an earlier request's end doesn't count (#3762); fails_when=the Check runs before the notes are written, twice, or never, or the request goes elsewhere
  test("a request that lands with changes runs the Check once", async () => {
    const { press } = await pressed();
    expect(ask).toHaveBeenCalledWith(meeting.mindId, {
      words: WORDS,
      quote: "",
      selection: null,
      caret: "",
    });
    // An earlier request's end, and this one still working, end nothing.
    told("earlier", "landed", 3);
    told("turn", "working");
    expect(asks.listeners.size).toBe(1);
    expect(check).not.toHaveBeenCalled();

    told("turn", "landed", 2);
    expect(await press).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(meeting.mindId);
    // It no longer listens: the core telling of it again runs nothing more.
    expect(asks.listeners.size).toBe(0);
    told("turn", "landed", 2);
    expect(check).toHaveBeenCalledTimes(1);
    expect(link).not.toHaveBeenCalled();
  });

  // protects=a request that lands with no change runs no Check: there is nothing new to check (#3762); fails_when=the Check runs over notes the AI didn't write
  test("a request that lands with no change runs no Check", async () => {
    const { press } = await pressed();
    told("turn", "landed", 0);
    expect(await press).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  // protects=a request that failed or was stopped runs no Check, and the press still counts as sent: its line says what happened (#3762); fails_when=the Check runs after a failed or stopped request, or the press waits on forever
  test.each(["failed", "stopped"] as const)("a request %s runs no Check", async (state) => {
    const { press } = await pressed();
    told("turn", state, 2);
    expect(await press).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  // protects=a request that has already ended when the press reads it is taken as it ended (#3762); fails_when=the press waits for an end the core told before it listened
  test("a request that has already landed when it is read is checked at once", async () => {
    ask.mockImplementation(async () => {
      told("turn", "landed", 1);
      return "started";
    });
    expect(await writeMeetingNotes(meeting, WORDS)).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  // protects=a Check that can't start is said where the window says problems, never swallowed (#3762); fails_when=the failure is lost, or fails the press
  test("a Check that can't start is reported", async () => {
    const failure = new Error("The Check couldn't start.");
    check.mockRejectedValue(failure);
    const { press } = await pressed();
    told("turn", "landed", 1);
    expect(await press).toBe(true);
    expect(reportError).toHaveBeenCalledWith(failure);
  });

  // protects=an AI that can't run the request here gets it by its link, as the Note's input sends one, with the meeting, and no Check runs; the press is sent only when the link was asked (#3762); fails_when=Write notes says nothing while the User's AI could take it by its link, or loses the meeting it is for
  test.each([
    ["asked", true],
    ["none", false],
  ] as const)("“link” asks by the link with the meeting: %s", async (answer, sent) => {
    ask.mockResolvedValue("link");
    link.mockResolvedValue(answer);
    expect(await writeMeetingNotes(meeting, WORDS)).toBe(sent);
    expect(link).toHaveBeenCalledWith(meeting.mindId, { kind: "meeting", meetingId: meeting.id });
    expect(check).not.toHaveBeenCalled();
  });

  // protects=a request refused at once ("problem") isn't sent: the line above the input says why and what to do, and nothing else runs (#3762); fails_when=Write notes reports it sent, asks by the link, or runs the Check
  test("“problem” is not sent, and nothing else runs", async () => {
    ask.mockResolvedValue("problem");
    expect(await writeMeetingNotes(meeting, WORDS)).toBe(false);
    expect(link).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });
});
