import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSettling, SHOWN_AFTER_MS, SHOWN_AT_LEAST_MS } from "../../src/renderer/src/settling";

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

  // protects=a wait that a busy page draws late still stays its minimum on screen, counted from the drawing, whether its work ends before or after it is drawn; fails_when=the minimum counts from when the wait was announced, so the User sees it for less; no_claim=how late a page draws.
  test.each([
    ["after", false],
    ["before", true],
  ])(
    "one drawn late stays its minimum from when it is drawn, its work ending %s the drawing",
    (_when, endsFirst) => {
      const wait = settling();
      wait.update(["processing"]);
      vi.advanceTimersByTime(SHOWN_AFTER_MS);
      expect(heard).toEqual([["processing"]]);
      if (endsFirst) wait.update([]);
      vi.advanceTimersByTime(120);
      wait.drawn();
      if (!endsFirst) wait.update([]);
      vi.advanceTimersByTime(SHOWN_AT_LEAST_MS - 1);
      expect(heard).toEqual([["processing"]]);
      vi.advanceTimersByTime(1);
      expect(heard).toEqual([["processing"], []]);
    },
  );

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
