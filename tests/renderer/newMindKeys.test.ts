import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  forgetNewMindKeys,
  holdNewMindKeys,
  takeNewMindKeys,
} from "../../src/renderer/src/newMindKeys";

/*
 * The keys typed while ⌘T makes a Mind: letters are held for it, a modifier key is not a letter,
 * another field's keys are its own, and a Mind that is never made leaves nothing held (#2000).
 */

class FakeElement {
  dataset: Record<string, string> = {};
  style = { cssText: "" };
  tabIndex = 0;
  isConnected = true;
  isContentEditable = false;
  focus = vi.fn(() => {
    active = this;
  });
  remove = vi.fn();
  setAttribute = vi.fn();
  closest = () => null;
}

class FakeInput extends FakeElement {
  type = "text";
}

class FakeTextArea extends FakeElement {}

let active: FakeElement | null = null;
const listeners = new Map<string, (event: unknown) => void>();
const body = { append: vi.fn() };

interface Pressed {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target?: unknown;
  altGraph?: boolean;
}

function press(pressed: Pressed) {
  const event = {
    key: pressed.key,
    metaKey: pressed.metaKey ?? false,
    ctrlKey: pressed.ctrlKey ?? false,
    altKey: pressed.altKey ?? false,
    isComposing: pressed.isComposing ?? false,
    keyCode: pressed.keyCode ?? 0,
    target: pressed.target ?? null,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation: vi.fn(),
    getModifierState: () => pressed.altGraph ?? false,
  };
  listeners.get("keydown")?.(event);
  return event;
}

beforeEach(() => {
  active = null;
  listeners.clear();
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  });
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("HTMLInputElement", FakeInput);
  vi.stubGlobal("HTMLTextAreaElement", FakeTextArea);
  vi.stubGlobal("document", {
    activeElement: null,
    body,
    createElement: () => new FakeElement(),
    getElementById: () => null,
  });
  Object.defineProperty(globalThis.document, "activeElement", { get: () => active });
});

afterEach(() => {
  takeNewMindKeys();
  vi.unstubAllGlobals();
});

describe("the keys held while ⌘T makes a Mind", () => {
  test("holds letters, which the new Mind takes, and holds nothing once taken", () => {
    holdNewMindKeys();
    expect(press({ key: "a" }).prevented).toBe(true);
    expect(press({ key: "b" }).prevented).toBe(true);
    expect(press({ key: " " }).prevented).toBe(true);
    expect(takeNewMindKeys()).toBe("ab ");
    expect(takeNewMindKeys()).toBeNull();
  });

  test("lets a modifier key through and goes on holding the letters after it", () => {
    holdNewMindKeys();
    expect(press({ key: "Shift" }).prevented).toBe(false);
    expect(press({ key: "A" }).prevented).toBe(true);
    expect(takeNewMindKeys()).toBe("A");
  });

  test("stops holding when the person types in another field, and the Mind still takes what was held", () => {
    holdNewMindKeys();
    press({ key: "a" });
    const field = new FakeInput();
    expect(press({ key: "b", target: field }).prevented).toBe(false);
    expect(press({ key: "c", target: field }).prevented).toBe(false);
    expect(takeNewMindKeys()).toBe("a");
  });

  test("an input method's own keys are not held as letters", () => {
    holdNewMindKeys();
    press({ key: "a" });
    expect(press({ key: "Process", isComposing: true }).prevented).toBe(false);
    expect(takeNewMindKeys()).toBe("a");
  });

  test("a Mind that is never made leaves nothing held, and gives the focus back", () => {
    const editor = new FakeElement();
    active = editor;
    holdNewMindKeys();
    press({ key: "a" });
    forgetNewMindKeys();
    expect(takeNewMindKeys()).toBeNull();
    expect(editor.focus).toHaveBeenCalled();
  });
});
