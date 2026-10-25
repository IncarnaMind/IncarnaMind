import { describe, expect, test } from "vitest";
import {
  defaultHelpKeys,
  HELP_SHORTCUTS,
  helpKeysOf,
  helpShortcutLabel,
  isGlobalKeys,
  isHelpKeys,
  isHelpShortcut,
} from "../../src/shared/meetingHelp";

describe("The shortcuts held during a call", () => {
  test("macOS has ⌃⌥ defaults: Pause my mic on M, which Teams' Ctrl+Shift+M and Unicode entry's Ctrl+Shift+U leave alone", () => {
    expect(defaultHelpKeys("mic", true)).toBe("Ctrl+Alt+M");
    expect(defaultHelpKeys("panel", true)).toBe("Ctrl+Alt+H");
    expect(defaultHelpKeys("say", true)).toBe("Ctrl+Alt+1");
    expect(defaultHelpKeys("check", true)).toBe("Ctrl+Alt+7");
    expect(isHelpShortcut("mic")).toBe(true);
    expect(helpShortcutLabel("mic")).toBe("meetings.mic.pause");
  });

  test("every macOS default is keys of its own a person can hold", () => {
    const keys = HELP_SHORTCUTS.map((shortcut) => defaultHelpKeys(shortcut, true));
    expect(new Set(keys).size).toBe(keys.length);
    for (const each of keys) expect(isGlobalKeys(each ?? ""), String(each)).toBe(true);
  });

  test("Windows and Linux have no default keys, so none is held until the User sets one", () => {
    for (const shortcut of HELP_SHORTCUTS) {
      expect(defaultHelpKeys(shortcut, false), shortcut).toBeNull();
      expect(helpKeysOf(shortcut, {}, false), shortcut).toBeNull();
    }
  });

  test("the User's own keys are kept on either kind of computer, or none at all", () => {
    expect(isHelpKeys({ mic: "Ctrl+Alt+F8" })).toBe(true);
    expect(isHelpKeys({ mic: "" })).toBe(true);
    expect(isHelpKeys({ mic: "Shift+M" })).toBe(false);
    for (const mac of [true, false]) {
      expect(helpKeysOf("mic", { mic: "Ctrl+Alt+F8" }, mac)).toBe("Ctrl+Alt+F8");
      expect(helpKeysOf("mic", { mic: "" }, mac)).toBeNull();
    }
    expect(helpKeysOf("mic", { mic: "Ctrl+Shift+9" }, false)).toBe("Ctrl+Shift+9");
    expect(helpKeysOf("mic", {}, true)).toBe("Ctrl+Alt+M");
    expect(helpKeysOf("say", { mic: "Ctrl+Alt+F8" }, false)).toBeNull();
  });
});
