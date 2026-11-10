import { describe, expect, test } from "vitest";
import { type MessageKey, translate } from "../../src/shared/i18n";

/** The panel's rows are drawn as no kind of control, so the words about them say "help". */
const WORDS: readonly (readonly [MessageKey, string, string])[] = [
  [
    "meetings.settings.panelBody",
    "While recording, a small panel floats above the meeting app with help for the call.",
    "录制时，一个小面板浮在会议应用上方，提供会中帮助。",
  ],
  [
    "meetings.template.title",
    "Template: adds help for this kind of meeting",
    "模板：为这类会议添加专门的帮助",
  ],
  ["meetings.help.none", "Ask for help first", "先请求一次帮助"],
  [
    "error.meeting.helpButton",
    "This meeting doesn’t have that kind of help.",
    "这场会议没有这项帮助。",
  ],
];

describe("the call-help words that once said buttons", () => {
  test.each(WORDS)("%s", (key, en, zh) => {
    expect(translate("en", key)).toBe(en);
    expect(translate("zh-CN", key)).toBe(zh);
  });
});
