import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  keyboardTakesOver,
  onKeyboardTakesOver,
  pointerMayAsk,
  resetPointer,
  trackPointer,
} from "../../src/renderer/src/editor/pointerRest";

/*
 * Who holds a card when the keyboard's focus and the pointer both ask: the latest input wins (#3102).
 */

const at = (x: number, y: number, timeStamp: number, type = "pointermove", buttons = 0) => ({
  type,
  clientX: x,
  clientY: y,
  buttons,
  timeStamp,
});

const drop = vi.fn();
beforeEach(() => {
  resetPointer();
  drop.mockClear();
  onKeyboardTakesOver(drop);
});

describe("the keyboard taking a card from the pointer", () => {
  test("a pointer at rest loses the card it only rests over, and the control that took over is named", () => {
    trackPointer(at(40, 50, 0));
    const taker = {};
    keyboardTakesOver(taker, 1_000);
    expect(drop).toHaveBeenCalledWith(taker);
    expect(pointerMayAsk()).toBe(false);
  });

  test("the browser re-sending events to a pointer that hasn't moved gives it nothing back", () => {
    trackPointer(at(40, 50, 0));
    keyboardTakesOver({}, 1_000);
    trackPointer(at(40, 50, 1_100, "pointerover"));
    trackPointer(at(40, 50, 1_200, "pointermove"));
    expect(pointerMayAsk()).toBe(false);
  });

  test("one move takes the pointer's part back", () => {
    trackPointer(at(40, 50, 0));
    keyboardTakesOver({}, 1_000);
    trackPointer(at(41, 50, 1_300));
    expect(pointerMayAsk()).toBe(true);
  });

  test("a press takes it back too, and holds the card while it lasts", () => {
    trackPointer(at(40, 50, 0));
    keyboardTakesOver({}, 1_000);
    trackPointer(at(40, 50, 1_400, "pointerdown", 1));
    expect(pointerMayAsk()).toBe(true);
    drop.mockClear();
    keyboardTakesOver({}, 5_000);
    expect(drop).not.toHaveBeenCalled();
    trackPointer(at(40, 50, 5_100, "pointerup", 0));
    keyboardTakesOver({}, 9_000);
    expect(drop).toHaveBeenCalledTimes(1);
  });

  test("a pointer that is moving keeps its card", () => {
    trackPointer(at(40, 50, 980));
    keyboardTakesOver({}, 1_000);
    expect(drop).not.toHaveBeenCalled();
    expect(pointerMayAsk()).toBe(true);
  });

  test("a pointer never seen holds nothing, so the keyboard takes over without a fuss", () => {
    keyboardTakesOver({}, 1_000);
    expect(pointerMayAsk()).toBe(false);
  });
});
