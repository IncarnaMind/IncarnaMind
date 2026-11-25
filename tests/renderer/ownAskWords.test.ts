/**
 * The words of the lasting answer on the card for a question of the User's own AI (#3653): one
 * thing it grants is the button's words; several are a short button and every one of them, whole,
 * under it. And the plain words the line above the input says while it acts (#3762).
 */
import { describe, expect, test } from "vitest";
import type { NoteAction, NoteSuggested } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { lastingWords, ownDoingWords } from "../../src/renderer/src/components/noteAsk/ownAskWords";
import { translate } from "../../src/shared/i18n";

const said = (language: Language, suggested: NoteSuggested[]) =>
  lastingWords((key, params) => translate(language, key, params), language, suggested);

const COMMANDS: NoteSuggested = {
  kind: "rules",
  kept: "conversation",
  rules: [{ kind: "commands", start: "python3 late_crossings.py" }],
};
const EDITS: NoteSuggested = { kind: "mode", kept: "request", mode: "acceptEdits" };
const FOLDER: NoteSuggested = { kind: "folders", kept: "request", folders: [""] };

describe("the lasting answer's words", () => {
  // protects=one grant is the button's own words, whole, with nothing under it; fails_when=a single "Allow all edits" gets a second line, or its words are cut
  test.each([
    ["en", "Allow all edits for this request"],
    ["zh-CN", "本次请求内允许所有修改"],
  ] as const)("one grant, %s", (language, label) => {
    expect(said(language, [EDITS])).toEqual({ label, grants: null });
  });

  // protects=two or three grants make a short button saying the widest place they are kept, and every grant, whole and in Claude Code's order, in the line under it; fails_when=a grant is dropped, cut, or only in a tooltip, or the button claims a narrower place than one of its grants
  test.each([
    [
      "en",
      [EDITS, COMMANDS],
      "Don’t ask again in this conversation",
      "Don’t ask again for python3 late_crossings.py commands in this conversation; allow all edits for this request",
    ],
    [
      "en",
      [FOLDER, EDITS, COMMANDS],
      "Don’t ask again in this conversation",
      "Don’t ask again for python3 late_crossings.py commands in this conversation; allow all edits for this request; allow access to this conversation’s folder for this request",
    ],
    [
      "en",
      [EDITS, FOLDER],
      "Don’t ask again for this request",
      "Allow all edits for this request; allow access to this conversation’s folder for this request",
    ],
    [
      "en",
      [EDITS, { ...COMMANDS, kept: "everywhere" }],
      "Don’t ask again anywhere",
      "Don’t ask again for python3 late_crossings.py commands anywhere; allow all edits for this request",
    ],
    [
      "zh-CN",
      [FOLDER, EDITS, COMMANDS],
      "本对话内不再询问",
      "本对话内不再询问：python3 late_crossings.py 命令；本次请求内允许所有修改；本次请求内允许访问：这个对话的文件夹",
    ],
  ] as const)("several grants, %s", (language, suggested, label, grants) => {
    expect(said(language, [...suggested])).toEqual({ label, grants });
  });
});

/** One step of each kind, as Claude Code's own tools name what they act on. */
const STEPS: NoteAction[] = [
  { kind: "command", value: "python3 late_crossings.py --crossing 07:40 > late.md" },
  { kind: "write", value: "/Users/dana/Kestrel Bay/drafts/late-crossings.md" },
  { kind: "change", value: "/Users/dana/Documents/board/ferry-review.md" },
  { kind: "read", value: "/Users/dana/Documents/timetable-2026.csv" },
  {
    kind: "web",
    value: "https://kestrelbay-harbour.example/notices",
    host: "kestrelbay-harbour.example",
  },
  { kind: "search", value: "Kestrel Bay ferry second ramp 2027" },
  { kind: "tool", value: "search_tickets", server: "ferry-data" },
  { kind: "skill", value: "meeting-sales" },
  { kind: "other", value: "ToolSearch" },
];

describe("the line above the input while the User's AI uses a tool of its own", () => {
  // protects=the working line says what kind of thing the AI does in plain words, in both languages, and never the command, path, address, query, server or tool it names (#3762); fails_when=a raw command, file path, web address, tool or server name shows on the line
  test.each(["en", "zh-CN"] as const)("names none of what the step acts on, %s", (language) => {
    const words = STEPS.map((step) => ({
      step,
      said: ownDoingWords((key, params) => translate(language, key, params), step),
    }));
    for (const { step, said } of words) {
      expect(said).not.toBe("");
      expect(said).not.toContain(step.value);
      for (const named of [step.server, step.host]) if (named) expect(said).not.toContain(named);
      expect(said).not.toMatch(/[/\\{}]|\.md|\.csv|_/);
    }
    expect(words.map(({ said }) => said)).toEqual(
      language === "en"
        ? [
            "Running a command",
            "Writing a file",
            "Changing a file",
            "Reading a file",
            "Opening a web page",
            "Searching the web",
            "Using a tool",
            "Using a skill",
            "Using a tool",
          ]
        : [
            "正在运行命令",
            "正在写入文件",
            "正在修改文件",
            "正在读取文件",
            "正在打开网页",
            "正在联网搜索",
            "正在调用工具",
            "正在使用技能",
            "正在调用工具",
          ],
    );
  });
});
