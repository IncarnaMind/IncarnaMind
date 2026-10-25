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
const HAS_NOTES = /笔记(?!本)/;
const NOTES_ALL = /笔记(?!本)/g;
const HAS_YOUR_TEXT = /你写的内容/;
const YOUR_TEXT = /\byour text\b/i;

/**
 * The uses of Mind still to rename, in the string values of each dictionary and
 * in the docs that define the unit. A string slice lowers its number by the
 * uses it renamed, and never raises one: a new interface string says Note.
 * Counts, not a key list, keep the slices that run in parallel to one line each.
 */
const MIND_LEFT: readonly { readonly name: string; readonly left: number }[] = [
  { name: "en", left: 174 },
  { name: "zh-CN", left: 173 },
  { name: "CONTEXT.md", left: 52 },
  { name: "docs/agents/zh-CN.md", left: 12 },
  { name: "README.md", left: 12 },
  { name: "README.zh-CN.md", left: 13 },
];

interface RetiredNote {
  readonly key: MessageKey;
  readonly old: number;
  readonly final: number;
  readonly englishOld: boolean;
}

/**
 * The retired Block-level Note. An entry stays here after its string is
 * rewritten: `old` is the 笔记 count while it still says the old word, `final`
 * the 笔记 count the finished wording has (one each time it names the Note), and
 * `englishOld` whether the old English says a note word at all. The entry then
 * guards the finished pair, so a key cannot leave the check by half-moving.
 */
const RETIRED_NOTE: readonly RetiredNote[] = [
  { key: "consent.data.blocks", old: 2, final: 1, englishOld: true },
  { key: "deleted.lost.mind", old: 1, final: 1, englishOld: true },
  { key: "deleted.lost.mind.one", old: 1, final: 0, englishOld: true },
  { key: "palette.group.notes", old: 1, final: 0, englishOld: true },
  { key: "palette.searching", old: 1, final: 0, englishOld: true },
  { key: "providers.readiness.no-provider", old: 1, final: 0, englishOld: true },
  { key: "providers.setup.body", old: 1, final: 0, englishOld: true },
  { key: "question.context.include", old: 1, final: 0, englishOld: false },
  { key: "skills.builtIn.mind-to-report", old: 1, final: 1, englishOld: true },
  { key: "skills.make.empty", old: 1, final: 1, englishOld: true },
];

/** A Meeting's notes, whose word a later slice decides. */
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

/** Already says 笔记 for the Note, with an English word that never said note. */
const CHINESE_ONLY: readonly MessageKey[] = ["history.reason.enhance"];

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
 * An inventory, not a conformance check: neither label is a dictionary key yet.
 * A later slice decides them, and adds the keys to the lists above when they
 * land. CONTEXT.md's Meeting definition keeps its Notes with them, asserted
 * below, so that word is not decided here either.
 */
const LATER_LABELS = [
  { english: "Notes", chinese: "笔记", where: "the Meetings Notes | Transcript tab" },
  { english: "Note", chinese: "笔记", where: "the call help quick Note | Ask field" },
] as const;

const DICTIONARIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en,
  "zh-CN": zhCN,
};

/** Normalized, so a CRLF checkout asserts the same text. */
const readDoc = (file: string): string =>
  readFileSync(join(ROOT, file), "utf8").replace(/\r\n?/g, "\n");

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

const stateOf = (
  english: string,
  chinese: string,
  entry: RetiredNote,
): "old" | "final" | "unfinished" => {
  const oldPair =
    NOTE.test(english) === entry.englishOld &&
    !YOUR_TEXT.test(english) &&
    !HAS_YOUR_TEXT.test(chinese) &&
    count(chinese, NOTES_ALL) === entry.old;
  if (oldPair) return "old";
  const finalPair =
    YOUR_TEXT.test(english) &&
    HAS_YOUR_TEXT.test(chinese) &&
    count(chinese, NOTES_ALL) === entry.final;
  return finalPair ? "final" : "unfinished";
};

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
  test.each(RETIRED_NOTE)("$key is the old Note, or fully your text in both languages", (entry) => {
    expect(
      stateOf(en[entry.key], zhCN[entry.key], entry),
      `${entry.key}: both languages stay the old Note, or both move to "your text" / 你写的内容, with 笔记 only where the wording names the Note`,
    ).not.toBe("unfinished");
  });

  test("one language moving alone is unfinished", () => {
    const entry: RetiredNote = {
      key: "palette.group.notes",
      old: 1,
      final: 0,
      englishOld: true,
    };
    expect(stateOf("In your notes", "笔记内容", entry)).toBe("old");
    expect(stateOf("In your text", "你写的内容", entry)).toBe("final");
    expect(stateOf("In your text", "笔记内容", entry)).toBe("unfinished");
    expect(stateOf("In your notes", "你写的内容", entry)).toBe("unfinished");
  });

  test("a leftover old 笔记 is unfinished, whatever the English says", () => {
    const entry: RetiredNote = {
      key: "palette.group.notes",
      old: 1,
      final: 0,
      englishOld: true,
    };
    expect(stateOf("In your text", "你写的内容和笔记", entry)).toBe("unfinished");
    expect(stateOf("In your notes", "你写的内容和笔记", entry)).toBe("unfinished");
  });

  test("the Chinese-only old Note needs the same finished pair", () => {
    const entry: RetiredNote = {
      key: "question.context.include",
      old: 1,
      final: 0,
      englishOld: false,
    };
    expect(stateOf("Include in Question context", "提问时包含此笔记", entry)).toBe("old");
    expect(stateOf("Include your text in Question context", "提问时包含你写的内容", entry)).toBe(
      "final",
    );
    expect(stateOf("Include your text in Question context", "提问时包含此笔记", entry)).toBe(
      "unfinished",
    );
    expect(stateOf("Include in Question context", "提问时包含你写的内容", entry)).toBe(
      "unfinished",
    );
  });

  test("both languages hold the same note word, or the key is classified", () => {
    const listed = new Set<MessageKey>([
      ...ANOTHER_NOTE,
      ...NOTE_FOR_MIND,
      ...CHINESE_ONLY,
      ...RETIRED_NOTE.map((entry) => entry.key),
      ...MEETING_NOTE.map((entry) => entry.key),
    ]);
    const oneSided = (Object.keys(en) as MessageKey[]).filter(
      (key) => NOTE.test(en[key]) !== HAS_NOTES.test(zhCN[key]),
    );
    expect(
      oneSided.filter((key) => !listed.has(key)),
      "a key whose two languages disagree must be classified in this file",
    ).toEqual([]);
  });

  test("a Meeting's notes keep their word on both sides until a later slice", () => {
    for (const { key, chinese } of MEETING_NOTE) {
      expect(NOTE.test(en[key]), key).toBe(true);
      expect(HAS_NOTES.test(zhCN[key]), key).toBe(chinese);
    }
  });

  test("a string that already says note for the Note keeps it in both languages", () => {
    for (const key of NOTE_FOR_MIND) {
      expect(NOTE.test(en[key]), key).toBe(true);
      expect(HAS_NOTES.test(zhCN[key]), key).toBe(true);
    }
  });

  test("a Chinese string that already says 笔记 for the Note keeps it", () => {
    for (const key of CHINESE_ONLY) {
      expect(NOTE.test(en[key]), key).toBe(false);
      expect(HAS_NOTES.test(zhCN[key]), key).toBe(true);
    }
  });

  test("a string whose note is another meaning keeps its other Chinese word", () => {
    for (const key of ANOTHER_NOTE) {
      expect(NOTE.test(en[key]), key).toBe(true);
      expect(HAS_NOTES.test(zhCN[key]), key).toBe(false);
    }
  });
});

describe("the labels deferred to a later slice (inventory)", () => {
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

  test("the Meeting definition's Notes stay deferred with the labels", () => {
    expect(readDoc("CONTEXT.md")).toContain("the Notes written during it");
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
