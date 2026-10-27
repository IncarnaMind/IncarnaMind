import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  afterPaint,
  createSettling,
  SHOWN_AFTER_MS,
  SHOWN_AT_LEAST_MS,
} from "../../src/renderer/src/settling";

describe("What has been there long enough to show, and shows long enough", () => {
  let heard: string[][];
  const settling = () => createSettling((shown) => heard.push([...shown].sort()));
  beforeEach(() => {
    vi.useFakeTimers();
    heard = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // protects=a wait shorter than the limit shows nothing, so nothing flashes in; fails_when=a short wait shows for an instant; no_claim=the limit's size, which DESIGN.md › Feel sets.
  test("a wait that ends sooner than the limit is never shown", () => {
    const wait = settling();
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS - 1);
    wait.update([]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS * 2);
    expect(heard).toEqual([]);
  });

  // protects=once shown, a wait stays at least its minimum, so a wait that ends just after it showed doesn't flash out; fails_when=it goes the moment its work ends; no_claim=none beyond protects.
  test("one that is shown stays at least its minimum, from when it showed", () => {
    const wait = settling();
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS);
    expect(heard).toEqual([["processing"]]);
    vi.advanceTimersByTime(50);
    wait.update([]);
    vi.advanceTimersByTime(SHOWN_AT_LEAST_MS - 51);
    expect(heard).toEqual([["processing"]]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual([["processing"], []]);
  });

  test("one that has lasted past its minimum goes at once when its work ends", () => {
    const wait = settling();
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS + SHOWN_AT_LEAST_MS);
    wait.update([]);
    expect(heard).toEqual([["processing"], []]);
  });

  // protects=work that carries on from one wait to the next never leaves the row empty between them; fails_when=the next wait waits its own limit while the row sits blank, or the old one lingers beside the new; no_claim=none beyond protects.
  test("a wait that comes while another shows takes its place at once", () => {
    const wait = settling();
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS);
    wait.update(["tagging"]);
    expect(heard).toEqual([["processing"], ["tagging"]]);
    vi.advanceTimersByTime(SHOWN_AT_LEAST_MS * 2);
    expect(heard).toEqual([["processing"], ["tagging"]]);
  });

  test("while one is kept on screen, the one that returns is the one still shown", () => {
    const wait = settling();
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS);
    wait.update([]);
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AT_LEAST_MS * 2);
    expect(heard).toEqual([["processing"]]);
  });

  test("a change in what else is there doesn't start it again", () => {
    const wait = settling();
    wait.update(["processing"]);
    vi.advanceTimersByTime(200);
    wait.update(["processing", "tagging"]);
    vi.advanceTimersByTime(100);
    expect(heard).toEqual([["processing"]]);
    vi.advanceTimersByTime(200);
    expect(heard).toEqual([["processing"], ["processing", "tagging"]]);
  });

  test("stopped, nothing more is heard", () => {
    const wait = settling();
    wait.update(["processing"]);
    wait.stop();
    vi.advanceTimersByTime(SHOWN_AFTER_MS * 2);
    expect(heard).toEqual([]);
  });
});

/*
 * Counted from the drawing (`drawnIsTold`). A thing is announced (A), drawn (D), its work ends
 * (E, "left") and it goes (H); the cases are the orders of A, D and E, with the drawing late
 * (under and over the minimum) and with something else taking its place.
 *
 * | Order                              | Drawing | It goes                                        |
 * | A, D, E                            | late    | D + 500, or at E if that is later              |
 * | A, E, D                            | under 500 after A | D + 500                               |
 * | A, E, D                            | over 500 after A  | D + 500, never before it is drawn     |
 * | A, E, back, D, E                   | late    | D + 500 from the last E, or at once if past    |
 * | A, E, another shown, D             | any     | at once when the other shows; never again      |
 * | A, D, E, another shown             | any     | at once when the other shows                   |
 * | A, E, no D                         | none    | never (until stopped)                          |
 * | D with nothing undrawn, D twice    | any     | no effect; the first drawing counts            |
 */
describe("What is announced stays its minimum from when it is drawn", () => {
  let heard: string[][];
  const settling = () =>
    createSettling((shown) => heard.push([...shown].sort()), { drawnIsTold: true });
  beforeEach(() => {
    vi.useFakeTimers();
    heard = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // protects=a wait that a busy page draws late still stays its minimum from the drawing, when its work ends after it is drawn; fails_when=the minimum counts from the announcement; no_claim=how late a page draws.
  test("announced, drawn late, then its work ends: it goes a minimum after the drawing", () => {
    const wait = settling();
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS);
    vi.advanceTimersByTime(120);
    wait.drawn();
    vi.advanceTimersByTime(80);
    wait.update([]);
    vi.advanceTimersByTime(SHOWN_AT_LEAST_MS - 80 - 1);
    expect(heard).toEqual([["processing"]]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual([["processing"], []]);
  });

  test("its work ending after the minimum has passed from the drawing: it goes at once", () => {
    const wait = settling();
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS);
    wait.drawn();
    vi.advanceTimersByTime(SHOWN_AT_LEAST_MS);
    wait.update([]);
    expect(heard).toEqual([["processing"], []]);
  });

  // protects=a wait whose work ends before it is drawn goes a minimum after the drawing, however late the drawing comes, and is not hidden unseen; fails_when=it goes a minimum after the announcement, so it is hidden before it is drawn or shown for less; no_claim=none beyond protects.
  test.each([
    ["under the minimum after the announcement", 120],
    ["over the minimum after the announcement", SHOWN_AT_LEAST_MS + 700],
  ])("announced, its work ends, drawn %s: it goes a minimum after the drawing", (_when, late) => {
    const wait = settling();
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS);
    vi.advanceTimersByTime(50);
    wait.update([]);
    vi.advanceTimersByTime(late);
    expect(heard).toEqual([["processing"]]);
    wait.drawn();
    vi.advanceTimersByTime(SHOWN_AT_LEAST_MS - 1);
    expect(heard).toEqual([["processing"]]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual([["processing"], []]);
  });

  test("its work ends and comes back before it is drawn: it stays, and counts from the drawing once it ends again", () => {
    const wait = settling();
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS);
    wait.update([]);
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AT_LEAST_MS * 2);
    wait.drawn();
    vi.advanceTimersByTime(100);
    expect(heard).toEqual([["processing"]]);
    wait.update([]);
    vi.advanceTimersByTime(SHOWN_AT_LEAST_MS - 100 - 1);
    expect(heard).toEqual([["processing"]]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual([["processing"], []]);
  });

  // protects=what is only being kept on screen gives way at once to what takes its place, drawn or not; fails_when=a kept wait outlives the one that took its place, or goes again on its own; no_claim=none beyond protects.
  test.each([
    ["not yet drawn", false],
    ["drawn", true],
  ])(
    "a wait kept on screen, %s, gives way when another shows, and is never heard again",
    (_state, wasDrawn) => {
      const wait = settling();
      wait.update(["processing"]);
      vi.advanceTimersByTime(SHOWN_AFTER_MS);
      if (wasDrawn) wait.drawn();
      wait.update([]);
      wait.update(["tagging"]);
      expect(heard).toEqual([["processing"], ["tagging"]]);
      wait.drawn();
      vi.advanceTimersByTime(SHOWN_AT_LEAST_MS * 3);
      expect(heard).toEqual([["processing"], ["tagging"]]);
    },
  );

  test("one never drawn that has ended is kept, until stopped, and then nothing more is heard", () => {
    const wait = settling();
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS);
    wait.update([]);
    vi.advanceTimersByTime(SHOWN_AT_LEAST_MS * 10);
    expect(heard).toEqual([["processing"]]);
    wait.stop();
    wait.drawn();
    vi.advanceTimersByTime(SHOWN_AT_LEAST_MS * 10);
    expect(heard).toEqual([["processing"]]);
  });

  test("a drawing with nothing to draw does nothing, and a second one doesn't count again", () => {
    const wait = settling();
    wait.drawn();
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS);
    vi.advanceTimersByTime(100);
    wait.drawn();
    vi.advanceTimersByTime(200);
    wait.drawn();
    vi.advanceTimersByTime(50);
    wait.update([]);
    vi.advanceTimersByTime(SHOWN_AT_LEAST_MS - 250 - 1);
    expect(heard).toEqual([["processing"]]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual([["processing"], []]);
  });

  // protects=a caller that never says when it is drawn counts from the announcement, as before; fails_when=`drawn` changes what a caller that doesn't use it sees; no_claim=none beyond protects.
  test("without `drawnIsTold` the minimum counts from the announcement and `drawn` changes nothing", () => {
    const wait = createSettling((shown) => heard.push([...shown].sort()));
    wait.update(["processing"]);
    vi.advanceTimersByTime(SHOWN_AFTER_MS);
    vi.advanceTimersByTime(120);
    wait.drawn();
    wait.update([]);
    vi.advanceTimersByTime(SHOWN_AT_LEAST_MS - 120 - 1);
    expect(heard).toEqual([["processing"]]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual([["processing"], []]);
  });
});

describe("The frame after a change draws it: done in the second frame, cancelled in either", () => {
  let frames: Map<number, () => void>;
  let next: number;
  const runFrame = () => {
    const now = [...frames.entries()];
    frames.clear();
    for (const [, callback] of now) callback();
  };
  beforeEach(() => {
    frames = new Map();
    next = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.set(next, callback);
      return next++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // protects=the acknowledgement comes in the second frame, after the one that draws the change; fails_when=it comes in the first frame, before layout and paint; no_claim=none beyond protects.
  test("done is not called in the first frame, but in the second", () => {
    const done = vi.fn();
    afterPaint(done);
    runFrame();
    expect(done).not.toHaveBeenCalled();
    runFrame();
    expect(done).toHaveBeenCalledTimes(1);
    runFrame();
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("cancelled before the first frame, or between the two, it is never called", () => {
    const early = vi.fn();
    afterPaint(early)();
    const between = vi.fn();
    const cancelBetween = afterPaint(between);
    runFrame();
    cancelBetween();
    runFrame();
    runFrame();
    expect(early).not.toHaveBeenCalled();
    expect(between).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  test("a change that comes between the two frames takes over: only its acknowledgement is heard, two frames after it", () => {
    const first = vi.fn();
    const cancelFirst = afterPaint(first);
    runFrame();
    cancelFirst();
    const second = vi.fn();
    afterPaint(second);
    runFrame();
    expect(second).not.toHaveBeenCalled();
    runFrame();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
