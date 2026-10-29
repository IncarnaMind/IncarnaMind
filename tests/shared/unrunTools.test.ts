import { describe, expect, test } from "vitest";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { unrunToolLines, unrunToolNotes } from "../../src/shared/unrunTools";

/*
 * The lines under a reply that still says a Tool calculated or searched when
 * none of its calls did (#1796), in English and Chinese: its figures are
 * unchecked, never said to be wrong.
 */

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

describe("The line under a reply that says a Tool ran when none did", () => {
  // protects=a calculation claimed with the Tool offered says the figures are unchecked, with Try again; with no Tool for the model, says it can't use one, with nothing to try again; fails_when=either says the figures are wrong, or offers Try again where it can't help; no_claim=none beyond protects.
  test("says the figures are unchecked, and why", () => {
    expect(unrunToolLines(en, { unrunTools: ["calculate"] })).toEqual([
      {
        tool: "calculate",
        text: "No calculation ran: IncarnaMind didn’t calculate the figures worked out in this reply, so they’re unchecked",
        retry: true,
      },
    ]);
    expect(unrunToolLines(zh, { unrunTools: ["calculate"], calculateUnavailable: true })).toEqual([
      {
        tool: "calculate",
        text: "未运行计算：这个模型无法调用 IncarnaMind 的计算工具，这条回答中算出的数字尚未核对",
        retry: false,
      },
    ]);
    const lines = [
      ...unrunToolLines(en, { unrunTools: ["calculate", "search"], calculateUnavailable: true }),
      ...unrunToolLines(zh, { unrunTools: ["calculate", "search"] }),
    ];
    expect(lines.map((line) => line.text).join(" ")).not.toMatch(/wrong|incorrect|错误|不正确/);
    expect(lines.filter((line) => line.tool === "search").map((line) => line.text)).toEqual([
      "No search ran: this reply wasn’t drawn from a search",
      "未运行搜索：这条回答不是根据搜索结果生成的",
    ]);
  });

  // protects=what Add to note puts into a Note keeps the line, as italic text after the Answer, so the claim never lands there unmarked; fails_when=the Note gets the claim without it; no_claim=none beyond protects.
  test("goes into a Note with the Answer", () => {
    expect(unrunToolNotes(zh, { unrunTools: ["calculate"] })).toEqual([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "未运行计算：这条回答中算出的数字不是 IncarnaMind 计算得出的，尚未核对",
            marks: [{ type: "italic" }],
          },
        ],
      },
    ]);
    expect(unrunToolNotes(en, null)).toEqual([]);
  });

  // protects=a reply with no such claim has no line; fails_when=one shows; no_claim=none beyond protects.
  test("is absent with no claim", () => {
    expect(unrunToolLines(en, null)).toEqual([]);
    expect(unrunToolLines(en, {})).toEqual([]);
  });
});
