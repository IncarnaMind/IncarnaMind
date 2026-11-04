import { describe, expect, test } from "vitest";
import {
  COMMENT_KEYSHORTCUTS,
  commentCommandName,
} from "../../src/renderer/src/editor/commentButton";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const t = (language: "en" | "zh-CN") => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

describe("Comment in the selection menu (#328)", () => {
  test("its tooltip and accessible name carry the command's keys, in English and Chinese", () => {
    expect(commentCommandName(t("en"), "⌥⌘M")).toBe("Comment (⌥⌘M)");
    expect(commentCommandName(t("zh-CN"), "⌥⌘M")).toBe("添加批注（⌥⌘M）");
  });

  test("aria-keyshortcuts spells the keys out, as ARIA wants them", () => {
    expect(COMMENT_KEYSHORTCUTS).toBe("Alt+Meta+M");
  });
});
