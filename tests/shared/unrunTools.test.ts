import { describe, expect, test } from "vitest";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import {
  unbackedCommandLines,
  unbackedCommandNotes,
  unrunToolLines,
  unrunToolNotes,
} from "../../src/shared/unrunTools";

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

/*
 * The lines under a reply that still says it did something in the app that no call did (#2407),
 * in English and Chinese: what only the User changes is named as unchanged, with where they
 * change it, and any other command is said not to be all done.
 */

describe("The line under a reply that says it did something in the app", () => {
  // protects=Local mode, the keys, the spending cap, the approval rules, deleting for good, a Folder's wall, "Checked by me" and marking text as the User's each say they weren't changed or done, and where the User does it, without Try again, which would only be refused again; any other command says not everything was done, with Try again; in a fixed order, whatever order they come in; fails_when=one reads as done, a line is missing, or Try again is offered for what only the User changes; no_claim=none beyond protects.
  test("names what only the User changes, then any other command", () => {
    expect(
      unbackedCommandLines(en, {
        unbackedCommands: [
          "command",
          "authorship",
          "signOff",
          "wall",
          "permanent",
          "approvals",
          "spending",
          "keys",
          "privacy",
        ],
      }),
    ).toEqual([
      {
        what: "privacy",
        text: "“Keep everything on this computer” and what goes to cloud services weren’t changed. Only you can change them, in Settings › AI and Settings › Privacy",
        retry: false,
      },
      {
        what: "keys",
        text: "Keys and sign-ins weren’t changed. Only you can change them, in Settings › AI",
        retry: false,
      },
      {
        what: "spending",
        text: "The monthly spending cap wasn’t changed. Only you can change it, in Settings › AI",
        retry: false,
      },
      {
        what: "approvals",
        text: "What the assistant may do without asking wasn’t changed. Only you can change it, in Settings › Privacy",
        retry: false,
      },
      {
        what: "permanent",
        text: "Nothing was deleted for good. Only you can do that, in Recently deleted",
        retry: false,
      },
      {
        what: "wall",
        text: "Whether a Folder keeps its work inside it wasn’t changed. Only you can change it, in the Folder’s ⋯ menu",
        retry: false,
      },
      {
        what: "signOff",
        text: "Nothing was marked “Checked by me”. Only you can do that, on each Citation’s card",
        retry: false,
      },
      {
        what: "authorship",
        text: "No text was marked as yours. Only you can do that: select it and choose “Mark as mine”",
        retry: false,
      },
      {
        what: "command",
        text: "The assistant didn’t do everything in the app that this reply says it did",
        retry: true,
      },
    ]);
    expect(
      unbackedCommandLines(zh, { unbackedCommands: ["privacy", "command"] }).map((line) => [
        line.text,
        line.retry,
      ]),
    ).toEqual([
      [
        "“所有内容都留在这台电脑上”和哪些内容发送到云服务，都没有更改。只有你能在“设置 › AI”和“设置 › 隐私”里更改",
        false,
      ],
      ["助手没有在应用中完成这条回答说的全部操作", true],
    ]);
  });

  // protects=what Add to note puts into a Note keeps the line, as italic text after the Answer, so "I've turned on Local mode" never lands there unmarked; fails_when=the Note gets the claim without it; no_claim=none beyond protects.
  test("goes into a Note with the Answer", () => {
    expect(unbackedCommandNotes(zh, { unbackedCommands: ["keys"] })).toEqual([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "密钥和登录没有更改。只有你能在“设置 › AI”里更改",
            marks: [{ type: "italic" }],
          },
        ],
      },
    ]);
  });

  // protects=a reply with no such claim has no line; fails_when=one shows; no_claim=none beyond protects.
  test("is absent with no claim", () => {
    expect(unbackedCommandLines(en, {})).toEqual([]);
    expect(unbackedCommandLines(en, null)).toEqual([]);
    expect(unbackedCommandNotes(en, { unbackedCommands: [] })).toEqual([]);
    expect(unbackedCommandNotes(en, { unbackedCommands: ["spending"] })).toHaveLength(1);
  });
});
