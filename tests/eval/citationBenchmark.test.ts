/**
 * The citation benchmark's scorers, cost cap, scan, judges and results page
 * (#1999), each with a known hit and a known miss. No model, no network.
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { type CitationQuestion, loadCitationSet } from "../../eval/citations/checkSet";
import { capProblem, estimate, priceOf } from "../../eval/citations/cost";
import { finalVerdict, type Judgement, readVerdict } from "../../eval/citations/judges";
import { resultsPage } from "../../eval/citations/results";
import type { CitationsRun, RunAnswer, RunCitation } from "../../eval/citations/runs";
import { keptAnswers, noTokens, resumeProblem, spentUsd } from "../../eval/citations/runs";
import { decodeJsonEscapes, heldSecrets, scanText } from "../../eval/citations/scan";
import {
  type FinalVerdict,
  figureRight,
  numbersIn,
  quoteFound,
  scoreRun,
} from "../../eval/citations/scorers";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const PAGES = [
  {
    page: 1,
    text: "Statement of Net Cost\nDepartment of Health and Human Services 1,875.6 161.2 1,714.4",
  },
  { page: 2, text: "Department of Defense 1,082.5 52.3 1,030.2" },
];

const citation = (overrides: Partial<RunCitation> = {}): RunCitation => ({
  sentence: "Health and Human Services reports a gross cost of $1,875.6 billion.",
  quote: "Department of Health and Human Services 1,875.6 161.2 1,714.4",
  document: "treasury",
  documentName: "Treasury",
  pageFrom: 1,
  pageTo: 1,
  check: "found",
  checkReason: null,
  passageText: PAGES[0]?.text ?? "",
  passagePages: [1, 1],
  ...overrides,
});

const QUESTION: CitationQuestion = {
  id: "en-014",
  kind: "table-figure",
  language: "en",
  crossLingual: false,
  about: ["treasury"],
  question: "What gross cost does HHS report?",
  answer: "$1,875.6 billion.",
  quotes: [
    {
      document: "treasury",
      pages: [1, 1],
      quote: "Department of Health and Human Services 1,875.6",
    },
  ],
  figures: [{ value: 1875.6, unit: "billions of dollars", tolerance: 0.05 }],
  checked: "2026-10-26",
};

const SUPERSEDED: CitationQuestion = {
  id: "zh-055",
  kind: "superseded",
  language: "zh",
  crossLingual: false,
  about: ["revision", "communique"],
  question: "以最新的数据为准，2023年中国的国内生产总值是多少？",
  answer: "1,294,272亿元。",
  quotes: [
    { document: "revision", pages: [1, 1], quote: "修订后，2023年国内生产总值为1294272亿元" },
  ],
  figures: [{ value: 1294272, unit: "亿元", tolerance: 0.5 }],
  decoy: {
    document: "communique",
    pages: [1, 1],
    quote: "全年国内生产总值1260582亿元",
    value: 1260582,
    unit: "亿元",
  },
  checked: "2026-10-26",
};

const answerOf = (text: string, overrides: Partial<RunAnswer> = {}): RunAnswer => ({
  questionId: QUESTION.id,
  kind: QUESTION.kind,
  crossLingual: false,
  question: QUESTION.question,
  askedAt: "2026-10-29T00:00:00.000Z",
  status: "done",
  error: null,
  text,
  sentences: [{ text: text.replace(/\[\^\d+\]/g, "").trim(), cited: true }],
  citations: [],
  figures: [],
  searches: [],
  check: { kind: "off" },
  tokens: { answer: noTokens(), check: noTokens() },
  usd: { answer: null, check: null },
  seconds: { answer: 1, check: 0 },
  ...overrides,
});

const runOf = (answers: RunAnswer[]): CitationsRun => ({
  benchmark: "IncarnaMind citation benchmark",
  set: { version: 1, questions: "q", documents: "d" },
  model: { kind: "ollama", modelId: "m", endpoint: null, service: null, label: "ollama/m" },
  language: "en",
  settings: {
    check: true,
    answerTimeoutMs: 1,
    rerankDepth: null,
    maxPassages: null,
    numCtx: null,
    citing: null,
    price: null,
  },
  app: { version: "0", commit: "abc" },
  host: { platform: "test", cpu: "test", node: "test" },
  startedAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
  documents: [],
  answers,
  retriedUsd: 0,
  stopped: null,
});

const judged = (verdict: Judgement["verdict"]): Judgement => ({
  key: "k",
  verdict,
  reason: "",
  judge: "j",
  prompt: "p",
  at: "2026-10-29T00:00:00.000Z",
  tokens: noTokens(),
  usd: null,
});

describe("The citation benchmark (#1999)", () => {
  test("quote found: a quote at its Location is found, one on another page isn't", () => {
    expect(quoteFound(citation(), PAGES)).toBe(true);
    expect(quoteFound(citation({ pageFrom: 2, pageTo: 2 }), PAGES)).toBe(false);
    expect(quoteFound(citation({ quote: "Department of Energy 52.0" }), PAGES)).toBe(false);
    expect(quoteFound(citation({ document: null }), PAGES)).toBe(false);
    // A Location is one Unit or two consecutive ones: a wider range holds no quote.
    const wide = [...PAGES, { page: 3, text: "Notes" }];
    expect(quoteFound(citation({ pageFrom: 1, pageTo: 3 }), wide)).toBe(false);
    expect(quoteFound(citation({ pageFrom: 1, pageTo: 2 }), wide)).toBe(true);
  });

  test("numbers are read with their scale words, in English and Chinese", () => {
    const read = (text: string) =>
      numbersIn(text).map(({ value, scale }) => Math.round(value * scale * 100) / 100);
    expect(read("$1.6 trillion to 43 million borrowers")).toEqual([1.6e12, 43e6]);
    expect(read("1,349,084亿元，比上年增长5.0%")).toEqual([1349084e8, 5]);
    expect(read("in FY2023 the 2 billions[^1]")).toEqual([2e9]);
  });

  test("figure right: the figure at another scale is right, a wrong one and the superseded one instead are not", () => {
    expect(figureRight(QUESTION, answerOf("A gross cost of $1,875.6 billion [^1].."))?.right).toBe(
      true,
    );
    expect(figureRight(QUESTION, answerOf("About $1.88 trillion."))?.right).toBe(true);
    const wrong = figureRight(QUESTION, answerOf("A gross cost of $1,714.4 billion."));
    expect(wrong).toMatchObject({ right: false, givesDecoyInstead: false });
    expect(wrong?.sentences).toEqual(["A gross cost of $1,714.4 billion."]);
    expect(figureRight(QUESTION, answerOf("About $2 trillion."))?.right).toBe(false);

    expect(figureRight(SUPERSEDED, answerOf("修订后为129.4万亿元。"))?.right).toBe(true);
    expect(
      figureRight(SUPERSEDED, answerOf("修订后为1,294,272亿元；初步核算数1,260,582亿元已被取代。")),
    ).toMatchObject({ right: true, givesDecoyInstead: false });
    expect(figureRight(SUPERSEDED, answerOf("2023年国内生产总值为1,260,582亿元。"))).toMatchObject({
      right: false,
      givesDecoyInstead: true,
    });
  });

  test("figure right holds for every reference answer in the set", async () => {
    const set = await loadCitationSet(ROOT);
    const wrong = set.questions
      .map((question) => ({
        id: question.id,
        result: figureRight(question, { text: question.answer, sentences: [] }),
      }))
      .filter(({ result }) => result !== null && !result.right)
      .map(({ id }) => id);
    expect(wrong).toEqual([]);
  });

  test("supported: agreement stands, a disagreement waits for a person, who settles it", () => {
    const settled = { verdict: "not supported" as const, why: "w", date: "2026-10-29" };
    expect(finalVerdict(judged("supported"), judged("supported"), undefined)).toBe("supported");
    expect(finalVerdict(judged("not supported"), judged("not supported"), undefined)).toBe(
      "not supported",
    );
    expect(finalVerdict(judged("supported"), judged("not supported"), undefined)).toBe("unsettled");
    expect(finalVerdict(judged("supported"), judged("not supported"), settled)).toBe(
      "not supported",
    );
    expect(finalVerdict(judged("supported"), undefined, undefined)).toBe("unjudged");
    expect(readVerdict('{"verdict": "not supported", "reason": "another year"}')).toEqual({
      verdict: "not supported",
      reason: "another year",
    });
    expect(readVerdict("Reasoning… so: supported").verdict).toBe("supported");
    expect(readVerdict("I can't tell.").verdict).toBe("unread");
    expect(readVerdict('{"verdict": "partially supported"}').verdict).toBe("unread");
  });

  test("with the check: what it catches of each miss, what it lets through, and its own false alarms", () => {
    const questions = new Map([[QUESTION.id, QUESTION]]);
    const sentence = "A gross cost of $1,714.4 billion.";
    const caught = answerOf(sentence, {
      citations: [
        citation({ sentence, quote: "a quote nowhere in the Document", check: "not-found" }),
      ],
    });
    const letThrough = answerOf("The cost was $1,875.6 billion.", {
      questionId: "en-015",
      citations: [citation({ sentence: "The cost was $1,875.6 billion." })],
      check: {
        kind: "checked",
        sentences: [
          {
            sentence: "The cost was $1,875.6 billion.",
            outcome: "supported",
            says: null,
            quote: null,
            failure: null,
          },
        ],
      },
    });
    const flagged = answerOf("A gross cost of $1,875.6 billion.", {
      questionId: "en-016",
      citations: [citation({ sentence: "A gross cost of $1,875.6 billion.", check: "not-found" })],
    });
    const verdicts: Record<string, FinalVerdict> = {
      "en-014#1": "supported",
      "en-015#1": "not supported",
      "en-016#1": "supported",
    };
    const score = scoreRun(
      "ollama-m.en.json",
      runOf([caught, letThrough, flagged]),
      new Map([
        ...questions,
        ["en-015", { ...QUESTION, id: "en-015" }],
        ["en-016", { ...QUESTION, id: "en-016" }],
      ]),
      () => PAGES,
      (key) => verdicts[key] ?? "unjudged",
      75,
    );
    expect(score.quoteFound).toBe(2);
    expect(score.supported).toMatchObject({ supported: 2, judged: 3 });
    expect(score.figureRight).toEqual({ right: 2, scored: 3 });
    expect(
      score.misses.map(({ questionId, kind, caughtBy }) => [questionId, kind, caughtBy]),
    ).toEqual([
      ["en-014", "quote", "citation check"],
      ["en-014", "figure", "citation check"],
      ["en-015", "support", null],
    ]);
    expect(score.withTheCheck).toMatchObject({
      misses: 3,
      caught: 2,
      falseQuoteNotFound: 1,
      notChecked: 2,
      sentencesNotChecked: 0,
    });
  });

  test("a resumed run keeps what was paid for, asks a failed Answer again, and refuses another model's file", () => {
    const failed = answerOf("", {
      questionId: "en-015",
      status: "failed",
      usd: { answer: 0.01, check: null },
    });
    const run = {
      ...runOf([answerOf("Done.", { usd: { answer: 0.02, check: 0.03 } }), failed]),
      retriedUsd: 0.5,
    };
    expect(keptAnswers(run).map((answer) => answer.questionId)).toEqual(["en-014"]);
    expect(spentUsd(run)).toBeCloseTo(0.56);
    expect(resumeProblem(run, run)).toBeNull();
    const other = { ...run.model, label: "anthropic/claude-haiku-5-5" };
    expect(resumeProblem(run, { ...run, model: other })).toMatch(/it is .*'s/);
    expect(resumeProblem(run, { ...run, app: { ...run.app, commit: "def" } })).toMatch(
      /commit abc/,
    );
    expect(resumeProblem(run, { ...run, settings: { ...run.settings, check: false } })).toMatch(
      /other settings/,
    );
  });

  test("the cost cap: a paid model needs a cap and stops before passing it; one on this computer needs none", () => {
    const haiku = { kind: "anthropic" as const, modelId: "claude-haiku-5-5" };
    const price = priceOf(haiku);
    expect(price).not.toBeNull();
    const planned = estimate(haiku, 150, { check: true, judges: [] });
    expect(planned.runUsd).toBeGreaterThan(0);
    expect(planned.mostUsd).toBeGreaterThan(planned.runUsd);
    const next = { usd: 1, what: "the next Question may cost up to" };
    expect(capProblem(null, price, 0, next)).toMatch(/set a cap/);
    expect(capProblem(10, price, 9.5, next)).toBe(
      "The cap is $10.00: $9.50 spent, and the next Question may cost up to $1.00.",
    );
    expect(capProblem(10, price, 2, next)).toBeNull();
    expect(priceOf({ kind: "ollama", modelId: "qwen3.5:4b" })).toBeNull();
    expect(capProblem(null, null, 0, { usd: 0, what: "" })).toBeNull();
  });

  test("the scan: keys, held keys, addresses and home paths are found; an allowed address isn't", () => {
    const key = ["sk", "ant", "api03", "x".repeat(40)].join("-");
    const held = `held${"y".repeat(20)}`;
    const text = [
      `the key ${key}`,
      "write to someone@example.org",
      "call +44 20 7946 0958",
      `saved in ${["", "Users", "someone", "notes"].join("/")}`,
      `the value ${held}`,
      "a figure of 1,349,084 and 13.2% and page 140",
    ].join("\n");
    const kinds = scanText(text, "file", { secrets: [held] }).map(({ kind, line }) => [kind, line]);
    expect(kinds).toEqual([
      ["api-key", 1],
      ["held-key", 5],
      ["email", 2],
      ["phone", 3],
      ["home-path", 4],
    ]);
    const allowed = new Set([createHash("sha256").update("someone@example.org").digest("hex")]);
    expect(scanText("write to someone@example.org", "file", { allowed })).toEqual([]);
    expect(heldSecrets({ SOME_API_KEY: held, PATH: "/bin:/usr/bin:/usr/local/bin" })).toEqual([
      held,
    ]);
  });

  test("the scan reads a JSON file's escapes as its reader does, and keeps their lines", () => {
    const json = [
      "{",
      '  "a": "fine",',
      '  "b": "Bearer abcdefghijklmnopqrs\\/t and pio\\u0040example.org"',
      "}",
    ].join("\n");
    const decoded = decodeJsonEscapes(json);
    expect(decoded.text).toContain("Bearer abcdefghijklmnopqrs/t and pio@example.org");
    const lineOf = (index: number) => json.slice(0, decoded.at[index]).split("\n").length;
    expect(
      scanText(decoded.text, "run.json", { lineOf }).map(({ kind, line }) => [kind, line]),
    ).toEqual([
      ["api-key", 3],
      ["email", 3],
    ]);
  });

  test("the results page leads with the misses, and every number in its tables links to a run", () => {
    const score = scoreRun(
      "ollama-m.en.json",
      runOf([answerOf("A gross cost of $1,714.4 billion.")]),
      new Map([[QUESTION.id, QUESTION]]),
      () => PAGES,
      () => "unjudged",
      75,
    );
    const page = resultsPage({
      scores: [score],
      notPublished: new Map([
        ["Answered fewer than the 75 Questions of its language", ["ollama-m.en.json"]],
      ]),
      judges: {},
      unsettled: {},
      set: { version: 1, questions: "q" },
      runs: {},
    });
    const headings = page.split("\n").filter((line) => line.startsWith("## "));
    expect(headings[0]).toBe("## The misses");
    expect(page).toContain("A pipeline check, not published numbers");
    const cells = page
      .split("\n")
      .filter((line) => line.startsWith("| ollama/m"))
      .flatMap((line) =>
        line
          .split("|")
          .slice(3, -1)
          .map((each) => each.trim()),
      );
    const unlinked = cells.filter(
      (each) => /\d/.test(each) && !each.includes("](ollama-m.en.json)"),
    );
    expect(unlinked.filter((each) => !each.includes("commit") && !each.includes("app "))).toEqual(
      [],
    );
  });
});
