/**
 * Call help's form whose facts stand apart (#2847), behind the evaluation's switch until its trial:
 * an option is the line to say with no Citation, each fact it rests on a line of its own with its
 * Citation, then its "→" line; a short line is a fact or the reply's own. Today's form is unchanged.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  HELP_DOCUMENTS,
  helpOwnLines,
  meetingHelpInstructions,
} from "../../src/core/answers/meetingHelp";
import { type CallHelpForm, HELP_SHAPE, type MeetingHelpKind } from "../../src/shared/meetingHelp";

const KINDS = Object.keys(HELP_SHAPE) as MeetingHelpKind[];
const STATES = KINDS.flatMap((kind) =>
  (["English", "Chinese", null] as const).flatMap((callLanguage) =>
    (["en", "zh-CN"] as const).flatMap((language) =>
      [true, false].map((found) => ({ kind, callLanguage, language, found })),
    ),
  ),
);

const textOf = (state: (typeof STATES)[number], form?: CallHelpForm) =>
  meetingHelpInstructions(state.kind, {
    found: state.found,
    language: state.language,
    callLanguage: state.callLanguage,
    ...(form && { form }),
  });

const hashOf = (form?: CallHelpForm) => {
  const all = createHash("sha256");
  for (const state of STATES) all.update(textOf(state, form));
  return all.digest("hex");
};

/** The example lines a button's instructions give, between "For example:" and the next rule. */
function examples(kind: MeetingHelpKind, callLanguage: string): string[] {
  const text = meetingHelpInstructions(kind, {
    found: true,
    language: "en",
    callLanguage,
    form: "fact lines",
  });
  const from = text.indexOf("For example:\n") + "For example:\n".length;
  return text.slice(from, text.indexOf("\n- Base it on", from)).split("\n");
}

describe("the evaluation's switch", () => {
  // protects=today's instructions, and the evaluation's "as before" arm, are main's at 61615612f byte for byte, for every button, language and Passages found ahead, so the trial compares main with the form and nothing else; fails_when=one byte of either differs; no_claim=what a model writes under them.
  test("today's form and the as-before arm send main's instructions, byte for byte", () => {
    const main = "464daefa8ebee8999a2b41e32fa744f942b1b56e76795d1ba76329e0ad384bf5";
    expect(hashOf()).toBe(main);
    expect(hashOf("as before")).toBe(main);
  });

  // protects=the form's instructions are the text frozen for its trial, changed only by a new freeze; every button but the readings one is asked in it; fails_when=the form's text changes without its hash, or a reading's instructions change; no_claim=whether the wording works.
  test("the form sends its frozen text to every button but the readings one", () => {
    expect(hashOf("fact lines")).toBe(
      "1aa86c1e1040ef820219c5fa98834eb1b651b6f7b1715776b519a5018404b41b",
    );
    for (const state of STATES) {
      const changed = textOf(state, "fact lines") !== textOf(state);
      expect(changed).toBe(HELP_SHAPE[state.kind] !== "readings");
    }
  });
});

describe("the form's instructions", () => {
  // protects=an option's line to say carries no Citation and each fact it rests on, at most two, is a line of its own starting with "> " of at most 20 words, with its Citations; a short line is a fact with its Citations or the reply's own starting with "= " with none; fails_when=a line is missing or worded otherwise; no_claim=how a model follows it.
  test("options and short lines", () => {
    const options = textOf(
      { kind: "answer", callLanguage: "English", language: "en", found: true },
      "fact lines",
    );
    expect(options).toContain(
      'then each fact it rests on, at most two, each one sentence of at most 20 words on a line of its own starting with "> " and ending with its Citation markers',
    );
    expect(options).toContain("with no quotation marks around it and no Citation marker");
    expect(options).not.toContain("(the panel shows it as a quote)");
    const lines = textOf(
      { kind: "facts", callLanguage: "English", language: "en", found: true },
      "fact lines",
    );
    expect(lines).toContain(
      'a fact, starting with "> " and ending with its Citation markers, or a remark of your own, starting with "= " and with none.',
    );
  });

  // protects=the line for what neither the Documents nor the call says goes to the nine buttons that read the Documents and no other, its example in the call's language; fails_when=a button that reads only the call is given it, or one that reads the Documents isn't; no_claim=how often a model writes it.
  test.each(["English", "Chinese"])("the not-in-the-Documents line, in %s", (callLanguage) => {
    const example =
      callLanguage === "Chinese"
        ? '"= 文档没有提到价格是否含关税"'
        : '"= The Documents don\'t say whether the price includes customs duty"';
    const given = KINDS.filter((kind) =>
      meetingHelpInstructions(kind, {
        found: true,
        language: "en",
        callLanguage,
        form: "fact lines",
      }).includes(
        `- What neither the Documents nor the call says goes on a line starting with "= ", with no Citation marker: ${example}.`,
      ),
    );
    expect(given.sort()).toEqual(KINDS.filter((kind) => HELP_DOCUMENTS[kind] !== null).sort());
    expect(given).toHaveLength(9);
  });

  // protects=the check button checks the newest claim in three lines, the verdict its own line, what they said and what the Documents say fact lines each with its Citation, and where the Documents don't say the first line says so; fails_when=the task or its examples differ; no_claim=how a model follows it.
  test.each(["English", "Chinese"])("the check button, in %s", (callLanguage) => {
    const text = meetingHelpInstructions("check", {
      found: true,
      language: "en",
      callLanguage,
      form: "fact lines",
    });
    expect(text).toContain(
      'Check the newest claim in the transcript against the User\'s Documents, in three lines: your verdict, "Right." or "Wrong." (in Chinese "对。" or "不对。"); what they said, citing the call; and what the Documents say, citing them. If the Documents don\'t say, the first line says so instead of a verdict, and there is no third.',
    );
    const lines = examples("check", callLanguage);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^= (?:Wrong\.|不对。)$/);
    for (const line of lines.slice(1)) expect(line).toMatch(/^> .+ \[\^\d\]$/);
  });

  // protects=in every example of the form a Citation sits only on a fact line, a line to say and a "→" line carry none, and an option resting on nothing shows no fact line, in both languages; fails_when=an example cites its line to say, its "→" line or its own line; no_claim=how a model copies them.
  test.each(["English", "Chinese"])(
    "its examples cite on fact lines only, in %s",
    (callLanguage) => {
      for (const kind of ["answer", "sum", "check"] as const) {
        for (const line of examples(kind, callLanguage)) {
          if (line.includes("[^")) expect(line.startsWith("> ")).toBe(true);
        }
      }
      const option = examples("answer", callLanguage);
      expect(option.filter((line) => line.startsWith("> "))).toHaveLength(1);
      expect(option.filter((line) => line.startsWith("→ "))).toHaveLength(2);
    },
  );

  // protects=readings and "Am I leading them?" keep main's wording under the form; fails_when=either changes; no_claim=how a model reads them.
  test('readings and "Am I leading them?" keep main\'s wording', () => {
    for (const callLanguage of ["English", "Chinese"]) {
      const state = { found: true, language: "en" as const, callLanguage };
      expect(meetingHelpInstructions("want", { ...state, form: "fact lines" })).toBe(
        meetingHelpInstructions("want", state),
      );
      expect(meetingHelpInstructions("leading", { ...state, form: "fact lines" })).toContain(
        "Start with one short line that says whether it does and why",
      );
    }
  });
});

describe("a short line of the form is the reply's own line, never a model's working", () => {
  // protects=a fact line ("> ") and an own line ("= ") in a short-lines reply are the reply's own lines, as a "- " line is, so none is judged the model's working or taken back (#2778), in either width of mark; fails_when=a "> " or "= " line is left out of the reply's own lines; no_claim=how the judgement decides the rest.
  test("fact and own lines in either width", () => {
    const text =
      "> The launch moves to 18 November [^1]\n= Nothing was decided on the price\n＞ 上线推迟到 11 月 18 日 [^2]\n＝ 价格还没定";
    const own = helpOwnLines("sum", text).map(({ from, to }) => text.slice(from, to));
    expect(own).toEqual(text.split("\n"));
  });
});
