import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createTip,
  TIP_DELAY_MS,
  TIP_LEAVE_MS,
  type TipHost,
} from "../../src/renderer/src/components/useTip";

describe("When a tip opens", () => {
  let made: ReturnType<typeof createTip>[];
  let focused: Set<number>;
  let held: Set<number>;
  let hovered: Set<number>;
  let heard: string[];

  /** A tip with a name, on a page where the trigger's pointer, focus and hold are the sets above. */
  function tip(id: number) {
    const host: TipHost = {
      hovered: () => hovered.has(id),
      focused: () => focused.has(id),
      held: () => held.has(id),
    };
    const each = createTip(host, (shown) => heard.push(`${id}:${shown ? "open" : "closed"}`));
    made.push(each);
    return each;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    made = [];
    focused = new Set();
    held = new Set();
    hovered = new Set();
    heard = [];
  });
  afterEach(() => {
    for (const each of made) each.dispose();
    vi.useRealTimers();
  });

  test("a pointer that passes over the trigger opens nothing, and the tip never comes after it has gone", () => {
    const info = tip(1);
    for (let move = 0; move < 8; move++) {
      info.point();
      vi.advanceTimersByTime(10);
    }
    info.leave();
    vi.advanceTimersByTime(TIP_DELAY_MS * 4);
    expect(heard).toEqual([]);
  });

  test("a pointer that rests on the trigger opens it after the wait", () => {
    const info = tip(1);
    info.point();
    vi.advanceTimersByTime(TIP_DELAY_MS - 1);
    expect(heard).toEqual([]);
    info.point();
    vi.advanceTimersByTime(1);
    expect(heard).toEqual(["1:open"]);
  });

  test("moving on the trigger while resting doesn't start the wait over", () => {
    const info = tip(1);
    info.point();
    vi.advanceTimersByTime(TIP_DELAY_MS - 100);
    info.point();
    vi.advanceTimersByTime(100);
    expect(heard).toEqual(["1:open"]);
  });

  test("the keyboard's focus and a click open it at once", () => {
    const focus = tip(1);
    focus.show();
    const click = tip(2);
    click.show();
    expect(heard).toEqual(["1:open", "2:open"]);
  });

  test("a click while the wait runs opens it once, at once", () => {
    const info = tip(1);
    info.point();
    vi.advanceTimersByTime(TIP_DELAY_MS / 2);
    info.show();
    expect(heard).toEqual(["1:open"]);
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(heard).toEqual(["1:open"]);
  });

  test("while one is open, moving onto another trigger opens that one at once", () => {
    const first = tip(1);
    const second = tip(2);
    first.point();
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(heard).toEqual(["1:open"]);
    first.leave();
    vi.advanceTimersByTime(TIP_LEAVE_MS / 2);
    second.point();
    expect(heard).toEqual(["1:open", "2:open"]);
    vi.advanceTimersByTime(TIP_LEAVE_MS);
    expect(heard).toEqual(["1:open", "2:open", "1:closed"]);
  });

  test("a tip opened by the keyboard lets the next trigger open at once as well", () => {
    const first = tip(1);
    const second = tip(2);
    first.show();
    second.point();
    expect(heard).toEqual(["1:open", "2:open"]);
  });

  test("once none is open, the next trigger waits again, and one passed over opens nothing", () => {
    const first = tip(1);
    const second = tip(2);
    first.point();
    vi.advanceTimersByTime(TIP_DELAY_MS);
    first.leave();
    vi.advanceTimersByTime(TIP_LEAVE_MS);
    expect(heard).toEqual(["1:open", "1:closed"]);

    second.point();
    vi.advanceTimersByTime(TIP_DELAY_MS - 1);
    expect(heard).toEqual(["1:open", "1:closed"]);
    second.leave();
    vi.advanceTimersByTime(TIP_DELAY_MS * 2);
    expect(heard).toEqual(["1:open", "1:closed"]);
    second.point();
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(heard).toEqual(["1:open", "1:closed", "2:open"]);
  });

  test("a trigger that goes while its tip is open, or while it waits, leaves no trace", () => {
    const open = tip(1);
    open.show();
    open.dispose();
    const waiting = tip(2);
    waiting.point();
    waiting.dispose();
    vi.advanceTimersByTime(TIP_DELAY_MS * 2);
    expect(heard).toEqual(["1:open"]);

    const next = tip(3);
    next.point();
    expect(heard).toEqual(["1:open"]);
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(heard).toEqual(["1:open", "3:open"]);
  });

  test("moving from the trigger onto the open tip keeps it open", () => {
    const info = tip(1);
    info.point();
    vi.advanceTimersByTime(TIP_DELAY_MS);
    info.leave();
    vi.advanceTimersByTime(TIP_LEAVE_MS / 2);
    info.point();
    vi.advanceTimersByTime(TIP_LEAVE_MS * 10);
    expect(heard).toEqual(["1:open"]);
    info.leave();
    vi.advanceTimersByTime(TIP_LEAVE_MS);
    expect(heard).toEqual(["1:open", "1:closed"]);
  });

  test("the focus, or a click's hold, keeps it when the pointer leaves", () => {
    const info = tip(1);
    info.point();
    vi.advanceTimersByTime(TIP_DELAY_MS);
    focused.add(1);
    info.leave();
    vi.advanceTimersByTime(TIP_LEAVE_MS * 3);
    expect(heard).toEqual(["1:open"]);
    focused.delete(1);
    held.add(1);
    info.leave();
    vi.advanceTimersByTime(TIP_LEAVE_MS * 3);
    expect(heard).toEqual(["1:open"]);
    held.delete(1);
    info.leave();
    vi.advanceTimersByTime(TIP_LEAVE_MS);
    expect(heard).toEqual(["1:open", "1:closed"]);
  });

  test("blur closes a tip nobody points at, and leaves one that is pointed at", () => {
    const keyboard = tip(1);
    keyboard.show();
    keyboard.blur();
    expect(heard).toEqual(["1:open", "1:closed"]);

    const pointed = tip(2);
    pointed.show();
    pointed.point();
    pointed.blur();
    expect(heard).toEqual(["1:open", "1:closed", "2:open"]);
  });

  test("after Esc a resting pointer doesn't open it again, a pointer that comes back does", () => {
    const info = tip(1);
    info.point();
    vi.advanceTimersByTime(TIP_DELAY_MS);
    hovered.add(1);
    info.close();
    info.point();
    vi.advanceTimersByTime(TIP_DELAY_MS * 2);
    expect(heard).toEqual(["1:open", "1:closed"]);

    hovered.delete(1);
    info.leave();
    info.point();
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(heard).toEqual(["1:open", "1:closed", "1:open"]);
  });
});
