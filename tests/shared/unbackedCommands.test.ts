import { describe, expect, test } from "vitest";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { unbackedCommandLines, unbackedCommandNotes } from "../../src/shared/unbackedCommands";

/*
 * The lines under a reply that still says it did something in the app that no call did (#2407),
 * in English and Chinese: what only the User changes is named as unchanged, with where they
 * change it, and any other command is said not to be all done.
 */

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

describe("The line under a reply that says it did something in the app", () => {
  // protects=Local mode, the keys, the spending cap, the approval rules and deleting for good each say they weren't changed or done, and where the User does it, without Try again, which would only be refused again; any other command says not everything was done, with Try again; in a fixed order, whatever order they come in; fails_when=one reads as done, a line is missing, or Try again is offered for what only the User changes; no_claim=none beyond protects.
  test("names what only the User changes, then any other command", () => {
    expect(
      unbackedCommandLines(en, {
        unbackedCommands: ["command", "permanent", "approvals", "spending", "keys", "privacy"],
      }),
    ).toEqual([
      {
        what: "privacy",
        text: "“Keep everything on this computer” and what goes to cloud services weren’t changed. Only you can change them, in Settings › Privacy",
        retry: false,
      },
      {
        what: "keys",
        text: "Keys and sign-ins weren’t changed. Only you can change them, in Settings › Models",
        retry: false,
      },
      {
        what: "spending",
        text: "The monthly spending cap wasn’t changed. Only you can change it, in Settings › General",
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
        "未更改“所有内容都留在这台电脑上”和哪些内容发送到云服务。只有你能在“设置 › 隐私”里更改",
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
            text: "未更改密钥和登录。只有你能在“设置 › 模型”里更改",
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
