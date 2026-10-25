import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { en } from "../../src/shared/i18n/en";
import type { MessageKey } from "../../src/shared/i18n/types";
import { zhCN } from "../../src/shared/i18n/zh-CN";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const MIND = /\bMinds?\b/g;
const NOTE = /\bnotes?\b/i;
const HAS_NOTES = /笔记/;
const YOUR_TEXT = /你写的内容/;

/**
 * The uses of Mind still to rename, in the string values of each dictionary and
 * in the docs that define the unit. A string slice lowers its number by the
 * uses it renamed, and never raises one: a new interface string says Note.
 * Counts, not a key list, keep the slices that run in parallel to one line each.
 */
const MIND_LEFT: readonly { readonly name: string; readonly left: number }[] = [
  { name: "en", left: 173 },
  { name: "zh-CN", left: 172 },
  { name: "CONTEXT.md", left: 52 },
  { name: "docs/agents/zh-CN.md", left: 12 },
  { name: "README.md", left: 12 },
  { name: "README.zh-CN.md", left: 13 },
];

/**
 * The retired Block-level Note, still in today's strings. `notes` is how often
 * 笔记 appears today: a later slice changes the string to "your text" /
 * 你写的内容, and English and Chinese move together. A Mind renamed to 笔记 in
 * one of these strings raises the count, so the string is resolved whole.
 */
const RETIRED_NOTE: readonly { readonly key: MessageKey; readonly notes: number }[] = [
  { key: "consent.data.blocks", notes: 2 },
  { key: "deleted.lost.mind", notes: 1 },
  { key: "deleted.lost.mind.one", notes: 1 },
  { key: "palette.group.notes", notes: 1 },
  { key: "palette.searching", notes: 1 },
  { key: "providers.readiness.no-provider", notes: 1 },
  { key: "providers.setup.body", notes: 1 },
  { key: "skills.builtIn.mind-to-report", notes: 1 },
  { key: "skills.make.empty", notes: 1 },
];

/** A Meeting's notes, whose word the design owner decides in a later slice. */
const MEETING_NOTE: readonly { readonly key: MessageKey; readonly chinese: boolean }[] = [
  { key: "consent.data.live-transcript", chinese: true },
  { key: "library.preset.meetings", chinese: false },
  { key: "meetings.audio.confirm", chinese: true },
  { key: "meetings.cantRecord.notes", chinese: true },
  { key: "meetings.fill.failed", chinese: true },
  { key: "meetings.fill.filled", chinese: true },
  { key: "meetings.fill.filling", chinese: true },
  { key: "meetings.fill.fillingLocal", chinese: true },
  { key: "meetings.fill.notify", chinese: true },
  { key: "meetings.fill.question.notes", chinese: true },
  { key: "meetings.fill.question.sections", chinese: true },
  { key: "meetings.fill.undoName", chinese: true },
  { key: "meetings.fill.waiting", chinese: true },
  { key: "meetings.mark.noNote", chinese: true },
  { key: "meetings.record.keywords", chinese: false },
  { key: "meetings.start.noticeText", chinese: true },
];

/** Already says note for the Note (the old Mind), and 笔记 in Chinese. */
const NOTE_FOR_MIND: readonly MessageKey[] = [
  "answer.add",
  "command.answer.addToNote",
  "command.viewer.selection.addToNote",
  "comparison.back",
  "meetings.command.addLine",
  "meetings.help.addCommand",
  "meetings.help.addToNotes",
  "meetings.help.added",
  "meetings.start.dismiss",
  "proposal.arrived",
  "proposal.arrived.one",
  "transcript.addToNote",
  "transcript.addToNote.added",
  "transcript.addToNote.already",
  "transcript.addToNote.failed",
  "transcript.addToNote.line",
  "transcript.addToNote.undo",
  "transcript.line.hint",
  "viewer.selection.addToNote",
];

/** A note here is something else: Word's notes, speaker notes, a style's name. */
const ANOTHER_NOTE: readonly MessageKey[] = [
  "citation.note",
  "citationStyle.chicago-notes",
  "citationStyle.form.note",
  "export.html.notes",
  "location.section.notes",
  "share.page.notes",
  "viewer.slide.notes",
  "wordImport.keptChange.content",
];

/**
 * Two labels whose word is decided in a later slice, so they keep Notes / Note
 * and 笔记 and are not renamed here. When their keys land, that slice records
 * them in one of the lists above.
 */
const LATER_LABELS = [
  { english: "Notes", chinese: "笔记", where: "the Meetings Notes | Transcript tab" },
  { english: "Note", chinese: "笔记", where: "the call help quick Note | Ask field" },
] as const;

const DICTIONARIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en,
  "zh-CN": zhCN,
};

const readDoc = (file: string): string => readFileSync(join(ROOT, file), "utf8");

/** A word an _Avoid_ line names is not a use of it. */
const withoutAvoidLines = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("_Avoid_:"))
    .join("\n");

const textOf = (name: string): string => {
  const dictionary = DICTIONARIES[name];
  if (dictionary) return Object.values(dictionary).join("\n");
  return withoutAvoidLines(readDoc(name));
};

const count = (text: string, word: RegExp): number => text.match(word)?.length ?? 0;

describe("the interface word for a Mind", () => {
  test.each(MIND_LEFT)("$name keeps only the uses left to rename", ({ name, left }) => {
    const found = count(textOf(name), MIND);
    expect(
      found,
      `${name}: ${found} uses of Mind, ${left} allowed. A new string says Note; a slice that renamed uses lowers the number.`,
    ).toBe(left);
  });
});

describe("the retired Block-level Note", () => {
  test.each(RETIRED_NOTE)("$key moves to your text in both languages at once", ({ key, notes }) => {
    const retired = YOUR_TEXT.test(zhCN[key]);
    const stillOld = count(zhCN[key], /笔记/g) === notes && !retired;
    expect(NOTE.test(en[key]) ? stillOld : retired, key).toBe(true);
  });

  test("every string that says note is classified", () => {
    const listed = new Set<MessageKey>([
      ...ANOTHER_NOTE,
      ...NOTE_FOR_MIND,
      ...RETIRED_NOTE.map((entry) => entry.key),
      ...MEETING_NOTE.map((entry) => entry.key),
    ]);
    const found = (Object.keys(en) as MessageKey[]).filter((key) => NOTE.test(en[key]));
    expect(
      found.filter((key) => !listed.has(key)),
      "a new Note string must be classified in this file",
    ).toEqual([]);
    expect(found.length, "a listed string no longer says note, so remove it from the list").toBe(
      listed.size,
    );
  });

  test("a Meeting's notes keep their word on both sides until the owner decides", () => {
    for (const { key, chinese } of MEETING_NOTE) {
      expect(NOTE.test(en[key]), key).toBe(true);
      expect(HAS_NOTES.test(zhCN[key]), key).toBe(chinese);
    }
  });

  test("a string that already says note for the Note keeps it in both languages", () => {
    for (const key of NOTE_FOR_MIND) {
      expect(NOTE.test(en[key]), key).toBe(true);
      expect(zhCN[key]).toMatch(HAS_NOTES);
    }
  });

  test("a string whose note is another meaning stays so", () => {
    for (const key of ANOTHER_NOTE) expect(NOTE.test(en[key]), key).toBe(true);
  });
});

describe("the labels decided in a later slice", () => {
  test("the Meetings Notes | Transcript tab and the call help Note | Ask field are recorded", () => {
    expect(LATER_LABELS.map((label) => [label.english, label.chinese])).toEqual([
      ["Notes", "笔记"],
      ["Note", "笔记"],
    ]);
    expect(LATER_LABELS.map((label) => label.where)).toEqual([
      "the Meetings Notes | Transcript tab",
      "the call help quick Note | Ask field",
    ]);
  });
});

describe("the docs that define the unit", () => {
  test("CONTEXT.md defines Note and your text, and retires Mind", () => {
    const text = readDoc("CONTEXT.md");
    expect(text).toContain("**Note**:\nA notebook a User writes in");
    expect(text).toContain("The code, the data and the APIs keep the name `mind`");
    expect(text).toContain("**Your text**:\nA Block the User writes");
    expect(text).toContain("_Avoid_: Mind, session, chat");
    expect(text).toContain("_Avoid_: Note, text block");
    expect(text).not.toContain("**Mind**:");
  });

  test("docs/agents/zh-CN.md gives 笔记 to Note and 你写的内容 to your text", () => {
    const text = readDoc("docs/agents/zh-CN.md");
    expect(text).toContain("| Note | 笔记 |");
    expect(text).toContain("| Your text | 你写的内容 |");
    expect(text).not.toContain("| Mind | Mind |");
    expect(text).not.toContain("Mind takes no plural");
  });

  test("the READMEs define the unit as a Note", () => {
    expect(readDoc("README.md")).toContain("A Note is a notebook for one topic.");
    expect(readDoc("README.zh-CN.md")).toContain("一篇笔记就是为一个主题准备的笔记本");
  });
});
