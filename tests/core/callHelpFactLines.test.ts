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
  // protects=today's instructions, and the evaluation's "as before" arm, are main's byte for byte (the hash is main's), for every button, language and Passages found ahead, so the trial compares main with the form and nothing else; fails_when=one byte of either differs; no_claim=what a model writes under them.
  test("today's form and the as-before arm send main's instructions, byte for byte", () => {
    const main = "464daefa8ebee8999a2b41e32fa744f942b1b56e76795d1ba76329e0ad384bf5";
    expect(hashOf()).toBe(main);
    expect(hashOf("as before")).toBe(main);
  });

  // protects=every button but readings and Check is asked in the form's text exactly as its development trial sent it (the hash is the trial's over those buttons), so the trial's rows stand for them; fails_when=one byte of one of their requests differs, or a reading's or Check's changes; no_claim=whether the wording works.
  test("the form sends its trial's text to every button but readings and Check", () => {
    const all = createHash("sha256");
    for (const state of STATES) {
      if (state.kind !== "check") all.update(textOf(state, "fact lines"));
    }
    expect(all.digest("hex")).toBe(
      "b82bcbfcb7dd21677ba6928808cbf0b8113b5979a12bb3acbc4ca474105f3123",
    );
    for (const state of STATES) {
      const changed = textOf(state, "fact lines") !== textOf(state);
      expect(changed).toBe(HELP_SHAPE[state.kind] !== "readings" && state.kind !== "check");
    }
  });

  // protects=the Check button's request is main's in both of the evaluation's arms, byte for byte, in every language and found state (the hash is main's over Check's), since its verdict went wrong on Claude Haiku 5.5 in the form; fails_when=one byte differs in either arm; no_claim=how a model answers it.
  test("Check is asked as on main in both arms", () => {
    const check = STATES.filter((state) => state.kind === "check");
    const hash = (form?: CallHelpForm) => {
      const all = createHash("sha256");
      for (const state of check) all.update(textOf(state, form));
      return all.digest("hex");
    };
    const main = "8a78c44d21501701249a920f5e9c64d391f892a5f17c450cbd699fd22332ec6c";
    expect(hash()).toBe(main);
    expect(hash("as before")).toBe(main);
    expect(hash("fact lines")).toBe(main);
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

  // protects=the line for what neither the Documents nor the call says goes to the eight buttons in the form that read the Documents and no other, Check, asked as on main, not among them, its example in the call's language; fails_when=a button that reads only the call or Check is given it, or one that reads the Documents isn't; no_claim=how often a model writes it.
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
    expect(given.sort()).toEqual(
      KINDS.filter((kind) => HELP_DOCUMENTS[kind] !== null && kind !== "check").sort(),
    );
    expect(given).toHaveLength(8);
  });

  // protects=in every example of the form a Citation sits only on a fact line, a line to say and a "→" line carry none, and an option resting on nothing shows no fact line, in both languages; fails_when=an example cites its line to say, its "→" line or its own line; no_claim=how a model copies them.
  test.each(["English", "Chinese"])(
    "its examples cite on fact lines only, in %s",
    (callLanguage) => {
      for (const kind of ["answer", "sum"] as const) {
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

describe("which lines of a reply are its own, never a model's working (#2778)", () => {
  const ownOf = (kind: MeetingHelpKind, text: string, form?: CallHelpForm) =>
    helpOwnLines(kind, text, form).map(({ from, to }) => text.slice(from, to));

  // protects=in the form, a fact line ("> ") and an own line ("= ") are the reply's own lines, as a "- " line is, so none is judged the model's working or taken back, in either width of mark; today's form and the as-before arm keep main's own lines exactly, a "> " or "= " line among a model's notes; fails_when=the form leaves a fact or own line to the judgement, or today's form or the as-before arm takes one as its own; no_claim=how the judgement decides the rest.
  test("a short-lines reply", () => {
    const text =
      "- The launch moves to 18 November [^1]\n> Dana confirms the date [^2]\n= Nothing was decided on the price\n＞ 上线推迟到 11 月 18 日 [^3]\n＝ 价格还没定";
    const main = ["- The launch moves to 18 November [^1]"];
    expect(ownOf("sum", text)).toEqual(main);
    expect(ownOf("sum", text, "as before")).toEqual(main);
    expect(ownOf("sum", text, "fact lines")).toEqual(text.split("\n"));
  });

  // protects=in the form, a fact line the model wrote after its option's "→" line or before the first option is still the reply's own, so it isn't taken back before the reader puts it into its option; today's form keeps main's spans; fails_when=such a line is left to the judgement in the form, or counted own today; no_claim=how often a model writes it so.
  test("an options reply with a fact line outside its option", () => {
    const text =
      "> Every roof is surveyed first [^1]\n★ We'll survey each roof\n→ moves to a survey\n> A survey takes two hours [^2]";
    expect(ownOf("ask", text)).toEqual(["★ We'll survey each roof\n→ moves to a survey"]);
    expect(ownOf("ask", text, "fact lines")).toEqual([
      "> Every roof is surveyed first [^1]",
      "★ We'll survey each roof\n→ moves to a survey",
      "> A survey takes two hours [^2]",
    ]);
  });
});
