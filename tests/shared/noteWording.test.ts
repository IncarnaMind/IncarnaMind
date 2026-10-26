import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { en } from "../../src/shared/i18n/en";
import type { MessageKey } from "../../src/shared/i18n/types";
import { zhCN } from "../../src/shared/i18n/zh-CN";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const MIND = /\bMinds?\b/g;
const ONE_MIND = /\bMinds?\b/;
const NOTE = /\bnotes?\b/i;
const HAS_NOTES = /笔记(?!本)/;
const NOTES_ALL = /笔记(?!本)/g;
const HAS_YOUR_TEXT = /你写的内容/;
const YOUR_TEXT = /\byour text\b/i;

/**
 * Every file whose words the User or a contributor reads. None says Mind: the
 * place the User writes is a Note (笔记), and only the product's name keeps the
 * letters, which the word boundary leaves out. A new string says Note.
 */
const NO_MIND: readonly string[] = [
  "en",
  "zh-CN",
  "CONTEXT.md",
  "docs/agents/zh-CN.md",
  "README.md",
  "README.zh-CN.md",
  "AGENTS.md",
  ".github/pull_request_template.md",
  "docs/privacy.md",
  "docs/agents.md",
  "docs/agents.zh-CN.md",
  "docs/agents/interaction.md",
  "docs/agents/testing.md",
  "docs/code-signing-policy.md",
  "docs/development.md",
  "docs/releasing.md",
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
  { key: "question.context.include", old: 1, final: 0, englishOld: false },
  { key: "skills.builtIn.mind-to-report", old: 1, final: 1, englishOld: true },
  { key: "skills.make.empty", old: 1, final: 1, englishOld: true },
];

/**
 * The strings that name the Note, or write notes as an activity: English says a
 * note word and Chinese says 笔记, wherever in the string they sit.
 */
const NOTE_FOR_MIND: readonly MessageKey[] = [
  "answer.add",
  "command.answer.addToNote",
  "command.viewer.selection.addToNote",
  "comparison.back",
  "consent.data.live-transcript",
  "meetings.audio.confirm",
  "meetings.cantRecord.notes",
  "meetings.command.addLine",
  "meetings.fill.failed",
  "meetings.fill.filled",
  "meetings.fill.filling",
  "meetings.fill.fillingLocal",
  "meetings.fill.notify",
  "meetings.fill.question.notes",
  "meetings.fill.question.sections",
  "meetings.fill.undoName",
  "meetings.fill.waiting",
  "meetings.help.addCommand",
  "meetings.help.addToNotes",
  "meetings.help.added",
  "meetings.mark.noNote",
  "meetings.start.dismiss",
  "meetings.start.noticeText",
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

/**
 * A note here is something else: Word's notes, speaker notes, a style's name,
 * or the activity of taking notes in a ⌘K keyword list.
 */
const ANOTHER_NOTE: readonly MessageKey[] = [
  "citation.note",
  "citationStyle.chicago-notes",
  "citationStyle.form.note",
  "export.html.notes",
  "location.section.notes",
  "meetings.record.keywords",
  "share.page.notes",
  "viewer.slide.notes",
  "wordImport.keptChange.content",
];

/**
 * The two labels a later screen adds. This slice decided them: a Meeting's
 * notes are its Note, the same Note as everywhere else, so both read Note and
 * no plural, beside 笔记 for the tab and for the quick field.
 */
const MEETING_LABELS = [
  { english: "Note", chinese: "笔记", where: "the Meetings Note | Transcript tab" },
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

describe("the word the interface uses", () => {
  test("no interface string says Mind: the place the User writes is a Note", () => {
    const says = Object.entries(DICTIONARIES).flatMap(([name, dictionary]) =>
      Object.entries(dictionary)
        .filter(([, value]) => ONE_MIND.test(value))
        .map(([key]) => `${name}:${key}`),
    );
    expect(says, "a string says Mind where the word is Note").toEqual([]);
  });

  test("the product's name still says IncarnaMind, which the check lets through", () => {
    expect(en["privacy.intro"]).toContain("IncarnaMind");
    expect(ONE_MIND.test("IncarnaMind")).toBe(false);
  });

  test.each(NO_MIND)("%s says Note, never Mind", (name) => {
    const found = count(textOf(name), MIND);
    expect(found, `${name}: ${found} uses of Mind, none allowed`).toBe(0);
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
    ]);
    const oneSided = (Object.keys(en) as MessageKey[]).filter(
      (key) => NOTE.test(en[key]) !== HAS_NOTES.test(zhCN[key]),
    );
    expect(
      oneSided.filter((key) => !listed.has(key)),
      "a key whose two languages disagree must be classified in this file",
    ).toEqual([]);
  });

  test("a string that says note for the Note keeps it in both languages", () => {
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

describe("the Meeting's Note", () => {
  test("the Meetings Note | Transcript tab and the call help Note | Ask field read Note", () => {
    expect(MEETING_LABELS.map((label) => [label.english, label.chinese])).toEqual([
      ["Note", "笔记"],
      ["Note", "笔记"],
    ]);
    expect(MEETING_LABELS.map((label) => label.where)).toEqual([
      "the Meetings Note | Transcript tab",
      "the call help quick Note | Ask field",
    ]);
  });

  test("the Meeting definition says the Note written during it", () => {
    expect(readDoc("CONTEXT.md")).toContain("a Transcript and the Note written during it");
  });

  test("the Library preset for minutes is Documents, not a Note", () => {
    expect(en["library.preset.meetings"]).toBe("Meeting minutes");
    expect(zhCN["library.preset.meetings"]).toBe("会议纪要");
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

  test("docs/agents/zh-CN.md gives 笔记 to Note and counts it with 篇", () => {
    const text = readDoc("docs/agents/zh-CN.md");
    expect(text).toContain("| Note | 笔记 |");
    expect(text).toContain("| Your text | 你写的内容 |");
    expect(text).toContain('"3 篇笔记"');
    expect(text).toContain("笔记（3）");
    expect(text).not.toContain("| Mind | Mind |");
    expect(text).not.toContain("Mind takes no plural");
  });

  test("the READMEs define the unit as a Note", () => {
    expect(readDoc("README.md")).toContain("A Note is a notebook for one topic.");
    expect(readDoc("README.zh-CN.md")).toContain("一篇笔记就是为一个主题准备的笔记本");
  });
});
