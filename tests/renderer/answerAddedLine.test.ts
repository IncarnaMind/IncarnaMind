import { describe, expect, test } from "vitest";
import { answerAddedLine } from "../../src/renderer/src/answerAddedLine";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/**
 * What the line under an Answer says when the Answer went into a Note: a Note it made says
 * Wrote, a Note that was there says Added to, and a name that carries quotes of its own is not
 * wrapped in a second pair of the same marks (#1940, #2270).
 */

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

describe("the line under an Answer that went into a Note", () => {
  test("a Note the Answer made says Wrote, never Added to", () => {
    expect(answerAddedLine(true, "Harbour notes", null)(en)).toBe("Wrote “Harbour notes”");
    expect(answerAddedLine(true, "港口笔记", null)(zh)).toBe("已写入“港口笔记”");
  });

  test("a Note that was already there keeps Added to", () => {
    expect(answerAddedLine(false, "Harbour notes", null)(en)).toBe("Added to “Harbour notes”");
    expect(answerAddedLine(false, "港口笔记", null)(zh)).toBe("已添加到“港口笔记”");
  });

  test("a name that carries “ ” gets ‘ ’ around it, never a second pair of the same marks", () => {
    const name = "按“东门办公室租约”，房东与租户";
    expect(answerAddedLine(false, name, null)(zh)).toBe(`已添加到‘${name}’`);
    expect(answerAddedLine(true, name, null)(zh)).toBe(`已写入‘${name}’`);
    expect(answerAddedLine(true, "Say “no” first", null)(en)).toBe("Wrote ‘Say “no” first’");
  });

  test("Citations copied out of a walled Folder say so after the Note's name", () => {
    expect(answerAddedLine(true, "Harbour notes", "Client A")(en)).toBe(
      "Wrote “Harbour notes” · copied out of “Client A”",
    );
    expect(answerAddedLine(false, "港口笔记", "Client A")(zh)).toBe(
      "已添加到“港口笔记” · 从“Client A”中复制",
    );
  });

  test("an unnamed Note says the word for an untitled one", () => {
    expect(answerAddedLine(true, "", null)(en)).toBe("Wrote “Untitled”");
    expect(answerAddedLine(true, "", null)(zh)).toBe("已写入“未命名”");
  });
});
