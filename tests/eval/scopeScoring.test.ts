/**
 * The scope evaluation's Documents, sentences and scoring (eval/repeats).
 */
import { describe, expect, test } from "vitest";
import { passagesIn } from "../../eval/repeats/passagesHanded";
import {
  isAgreement,
  OTHER_COUNTS,
  SCOPE_CASES,
  SCOPE_SETS,
  type ScopeLanguage,
} from "../../eval/repeats/scopeCases";
import {
  handsClause,
  placementEffects,
  type ScopeRow,
  summarise,
} from "../../eval/repeats/scopeScore";

const LANGUAGES: readonly ScopeLanguage[] = ["en", "zh-CN"];

const textOf = (
  pages: readonly { lines?: readonly string[]; chineseLines?: readonly string[] }[],
) => pages.flatMap((page) => [...(page.lines ?? []), ...(page.chineseLines ?? [])]).join(" ");

const ENGLISH = SCOPE_SETS.en.sentences;

const row = (
  caseId: string,
  repeat: number,
  key: string,
  outcome: ScopeRow["outcome"],
  handed: ScopeRow["handed"] = [],
): ScopeRow => {
  const sentence = ENGLISH.find((each) => each.key === key);
  if (!sentence) throw new Error(`No sentence ${key}`);
  const [placement, others] = caseId.split("-");
  return {
    repeat,
    sentence: sentence.text,
    outcome,
    says: null,
    covered: null,
    uncovered: null,
    quote: null,
    failure: null,
    caseId,
    language: "en",
    placement: placement === "filed" ? "filed" : "unfiled",
    others: Number(others),
    model: "anthropic/claude-haiku-5-5",
    key,
    expected: sentence.expected,
    clause: sentence.clause,
    handed,
  };
};

describe("the scope cases' Documents", () => {
  test("add up to the cases' counts, each a different file, in English and Chinese", () => {
    expect(OTHER_COUNTS).toEqual([5, 20]);
    expect(SCOPE_CASES.map((each) => each.id)).toEqual([
      "unfiled-5",
      "filed-5",
      "scoped-5",
      "unfiled-20",
      "filed-20",
      "scoped-20",
      "zh-unfiled-5",
      "zh-filed-5",
      "zh-scoped-5",
      "zh-unfiled-20",
      "zh-filed-20",
      "zh-scoped-20",
      "unfiled-no-agreements-17",
    ]);
    for (const language of LANGUAGES) {
      const { agreement, others } = SCOPE_SETS[language];
      expect(others).toHaveLength(20);
      expect(new Set([agreement.file, ...others.map((each) => each.file)]).size).toBe(21);
    }
  });

  test("hold two employment agreements among the first five and three among all, none for any sentence", () => {
    for (const language of LANGUAGES) {
      const { agreement, others, sentences } = SCOPE_SETS[language];
      const contracts = (count: number) => others.slice(0, count).filter(isAgreement);
      expect(contracts(5)).toHaveLength(2);
      expect(contracts(20)).toHaveLength(3);
      for (const sentence of sentences) {
        if (sentence.clause === null) continue;
        expect(textOf(agreement.pages).toLowerCase()).toContain(sentence.clause);
        for (const other of others) {
          expect(textOf(other.pages).toLowerCase()).not.toContain(sentence.clause);
        }
      }
    }
  });

  test("never state what the sentences the agreement doesn't state say", () => {
    const everything = (language: ScopeLanguage) =>
      SCOPE_SETS[language].others.map((each) => textOf(each.pages).toLowerCase()).join(" ");
    for (const phrase of [
      "car allowance",
      "mondays and fridays",
      "30 days a year",
      "30 working days",
      "two days a week",
      "27 working days",
      "three months' written notice",
    ]) {
      expect(everything("en")).not.toContain(phrase);
    }
    for (const phrase of [
      "交通补贴",
      "周一和周五",
      "15天",
      "每周可在家工作两天",
      "年休假10天",
      "三个月书面通知",
    ]) {
      expect(everything("zh-CN")).not.toContain(phrase);
    }
  });

  test("leave 17 Documents once the other agreements are left out", () => {
    const control = SCOPE_CASES.find((each) => each.withoutAgreements);
    expect(control?.others).toBe(17);
    expect(SCOPE_SETS.en.others.filter((each) => !isAgreement(each))).toHaveLength(17);
  });

  test("keep the sentences of the repeats' sets: two the agreement states, two it doesn't", () => {
    for (const language of LANGUAGES) {
      expect(SCOPE_SETS[language].sentences.map((each) => [each.key, each.expected])).toEqual([
        ["notice", "supported"],
        ["own-words", "supported"],
        ["car", "unsupported"],
        ["holiday", "contradicted-or-unsupported"],
      ]);
    }
  });
});

describe("the Passages handed over", () => {
  test("are read from the search Tool's result with the Document each is from", () => {
    const output = [
      '<passage id="P1" document="Employment Agreement - T. Okoro" date="2027" pages="1-2">',
      "3. Hours and place of work",
      "The Employee may work from home two days a week, agreed in advance with the manager.",
      "</passage>",
      '<passage id="P2" document="Remote Working Policy" pages="1">',
      "employees may work remotely up to three days a week.",
      "</passage>",
    ].join("\n");
    const handed = passagesIn(output);
    expect(handed.map((each) => each.document)).toEqual([
      "Employment Agreement - T. Okoro",
      "Remote Working Policy",
    ]);
    const own = ENGLISH.find((each) => each.key === "own-words");
    expect(handsClause({ clause: own?.clause ?? null, handed })).toBe(true);
    expect(handsClause({ clause: own?.clause ?? null, handed: handed.slice(1) })).toBe(false);
    expect(handsClause({ clause: null, handed })).toBeNull();
  });
});

describe("the scope scoring", () => {
  test("count a faithful sentence that isn't Supported and a sentence not in the Document that is", () => {
    const right = [{ document: "Agreement", text: "Entitled to 27 working days of paid\nholiday" }];
    const [summary] = summarise([
      row("unfiled-20", 1, "notice", "supported"),
      row("unfiled-20", 1, "own-words", "absent"),
      row("unfiled-20", 1, "car", "absent"),
      row("unfiled-20", 1, "holiday", "contradicted", right),
      row("unfiled-20", 2, "notice", "partly"),
      row("unfiled-20", 2, "own-words", "supported"),
      row("unfiled-20", 2, "car", "supported"),
      row("unfiled-20", 2, "holiday", "supported", right),
    ]);

    expect(summary?.falseUnsupported).toEqual({ wrong: 2, total: 4 });
    expect(summary?.falseSupported).toEqual({ wrong: 2, total: 4 });
    expect(summary?.wrongWithClause).toEqual({ wrong: 1, total: 3 });
    expect(summary?.misses.map((each) => [each.repeat, each.key])).toEqual([
      [1, "own-words"],
      [2, "notice"],
      [2, "car"],
      [2, "holiday"],
    ]);
  });

  test("compare the placements in points of the false Unsupported rate", () => {
    const summaries = summarise([
      row("unfiled-5", 1, "notice", "supported"),
      row("unfiled-5", 1, "own-words", "absent"),
      row("filed-5", 1, "notice", "supported"),
      row("filed-5", 1, "own-words", "supported"),
    ]);
    expect(placementEffects(summaries)).toMatchObject([
      { others: 5, unfiled: { wrong: 1, total: 2 }, filed: { wrong: 0, total: 2 }, points: 50 },
    ]);
  });
});
