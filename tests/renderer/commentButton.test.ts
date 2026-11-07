import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  commentCommandName,
  commentKeyshortcuts,
} from "../../src/renderer/src/editor/commentButton";
import type { CommandId } from "../../src/shared/commands";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const t = (language: "en" | "zh-CN") => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

let shortcutLabel: (id: CommandId) => string;

beforeAll(async () => {
  // The registry reaches the store, which reads the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  const { commentCommands } = await import("../../src/renderer/src/commands/comments");
  const { commands } = await import("../../src/renderer/src/commands/registry");
  for (const command of commentCommands) commands.register(command);
  ({ shortcutLabel } = await import("../../src/renderer/src/commands/keymap"));
});

afterEach(() => vi.unstubAllGlobals());

describe("Comment in the selection menu (#328)", () => {
  test("its tooltip and accessible name carry the command's keys, in English and Chinese", () => {
    expect(commentCommandName(t("en"), "⌥⌘M")).toBe("Comment (⌥⌘M)");
    expect(commentCommandName(t("zh-CN"), "⌥⌘M")).toBe("批注（⌥⌘M）");
  });

  test("the keys the button shows are the comment command's own", () => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    expect(shortcutLabel("comment.add")).toBe(mac ? "⌥⌘M" : "Ctrl+Alt+M");
  });

  test("aria-keyshortcuts names the chord's keys, on macOS and elsewhere", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(commentKeyshortcuts()).toBe("Alt+Meta+M");
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(commentKeyshortcuts()).toBe("Control+Alt+M");
  });
});
