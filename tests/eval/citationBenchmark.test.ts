/**
 * The citation benchmark's scorers, cost cap, scan, judges and results page
 * (#1999), each with a known hit and a known miss. No model, no network.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { type CitationQuestion, loadCitationSet } from "../../eval/citations/checkSet";
import { capProblem, estimate, priceOf } from "../../eval/citations/cost";
import {
  finalVerdict,
  inputSha256,
  type Judge,
  type Judgement,
  judgeAll,
  judgeInputOf,
  judgementsFile,
  judgementsUsd,
  judgePairProblem,
  judgingUsd,
  leftFor,
  makerOf,
  modelJudge,
  PROMPT_SHA256,
  readJudgements,
  readVerdict,
} from "../../eval/citations/judges";
import { resultsPage } from "../../eval/citations/results";
import type { CitationsRun, RunAnswer, RunCitation } from "../../eval/citations/runs";
import { keptAnswers, noTokens, resumeProblem, spentUsd } from "../../eval/citations/runs";
import {
  ALLOWED_FILE,
  type Allowed,
  decodeJsonEscapes,
  decodePercent,
  heldSecrets,
  readDenyList,
  scanBenchmark,
  scanText,
} from "../../eval/citations/scan";
import { notPublishedBecause } from "../../eval/citations/score";
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
  input: "i",
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

  test("figure right: a minus sign written gives only a figure below zero; a direction in words gives either", () => {
    expect(figureRight(QUESTION, answerOf("A gross cost of −1,875.6 billion."))?.right).toBe(false);
    expect(figureRight(QUESTION, answerOf("A gross cost of -1,875.6 billion."))?.right).toBe(false);
    const fell = { ...QUESTION, figures: [{ value: -2.3, unit: "%", tolerance: 0.05 }] };
    expect(figureRight(fell, answerOf("Net cost fell 2.3%."))?.right).toBe(true);
    expect(figureRight(fell, answerOf("Net cost changed by -2.3%."))?.right).toBe(true);
    expect(figureRight(fell, answerOf("Net cost changed by -3.2%."))?.right).toBe(false);
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
    const settled = {
      verdict: "not supported" as const,
      input: "i",
      why: "w",
      date: "2026-10-29",
    };
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

    // A verdict asked again replaces the unreadable one, but both were paid for.
    const path = join(mkdtempSync(join(tmpdir(), "judgements-")), "run.judge.jsonl");
    const line = (verdict: Judgement["verdict"], usd: number) =>
      JSON.stringify({ ...judged(verdict), key: "en-014#1", usd });
    writeFileSync(path, `${line("unread", 0.01)}\n${line("supported", 0.02)}\n`);
    expect(readJudgements(path).get("en-014#1")?.verdict).toBe("supported");
    expect(judgementsUsd(path)).toBeCloseTo(0.03);
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
    // A run stopped during a Question still counts what that Question's requests cost.
    expect(spentUsd({ ...run, inProgress: { questionId: "en-016", usd: 0.04 } })).toBeCloseTo(0.6);
    expect(resumeProblem(run, run)).toBeNull();
    const other = { ...run.model, label: "anthropic/claude-haiku-5-5" };
    expect(resumeProblem(run, { ...run, model: other })).toMatch(/it is .*'s/);
    expect(resumeProblem(run, { ...run, app: { ...run.app, commit: "def" } })).toMatch(
      /commit abc/,
    );
    expect(resumeProblem(run, { ...run, settings: { ...run.settings, check: false } })).toMatch(
      /other settings/,
    );
    const elsewhere = { ...run.model, server: "a".repeat(64) };
    expect(resumeProblem(run, { ...run, model: elsewhere })).toMatch(/another server/);
    expect(resumeProblem(run, { ...run, set: { ...run.set, questions: "q2" } })).toMatch(
      /another version of the set/,
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
    const hash = createHash("sha256").update("someone@example.org").digest("hex");
    const allowed = (kind: string, sha256: string) => kind === "email" && sha256 === hash;
    expect(scanText("write to someone@example.org", "file", { allowed })).toEqual([]);
    expect(heldSecrets({ SOME_API_KEY: held, PATH: "/bin:/usr/bin:/usr/local/bin" })).toEqual([
      held,
    ]);
    expect(heldSecrets({ KIMI_KEY_2: held })).toEqual([held]);
  });

  test("the scan finds a home folder flattened into one folder's name, and not words that only look like one", () => {
    const kinds = (text: string) => scanText(text, "file").map(({ kind }) => kind);
    const flattened = ["", "private", "tmp", "tool-501", "-Users-someone-Desktop-x", "s"].join("/");
    expect(kinds(`the cache in ${flattened}`)).toEqual(["home-path"]);
    expect(kinds("kept in -home-someone-projects-x")).toEqual(["home-path"]);
    expect(kinds("C--Users-someone-AppData")).toEqual(["home-path"]);
    expect(kinds("a risk-owning team works from home on work-from-home-office days")).toEqual([]);
    expect(kinds("the -Users-Shared-x folder")).toEqual([]);
  });

  test("the scan reads percent-escapes as a URL's reader does, and scans as written what doesn't decode", () => {
    const kinds = (text: string, denied: string[] = []) =>
      scanText(text, "file", { denied }).map(({ kind, line }) => [kind, line]);
    expect(kinds("one\nmailto:someone%40example.org")).toEqual([["email", 2]]);
    expect(kinds("cache at %2FUsers%2Fsomeone%2Fnotes")).toEqual([["home-path", 1]]);
    expect(kinds("made for Project%20Kestrel", ["project kestrel"])).toEqual([["denied-word", 1]]);
    expect(kinds("broken %E2%82 escape then someone@example.org")).toEqual([["email", 1]]);
    expect(kinds("grew 13.2% and 5.0%, a 100%25 share")).toEqual([]);
    expect(decodePercent("a%2Fb%ZZ").text).toBe("a/b%ZZ");
  });

  test("decoding only adds findings: what the text shows as written is found too, and a path is read through a bad escape and a second escaping", () => {
    const kinds = (text: string, options: { denied?: string[]; secrets?: string[] } = {}) =>
      scanText(text, "file", options).map(({ kind }) => kind);
    const users = ["", "Users", ""].join("/");
    expect(kinds(`saved in ${users}%20x`)).toEqual(["home-path"]);
    expect(kinds("made by foo%41bar", { denied: ["foo%41bar"] })).toEqual(["denied-word"]);
    expect(kinds("cache at %FF%2FUsers%2Fsomeone%2Fnotes")).toEqual(["home-path"]);
    expect(kinds("cache at %252FUsers%252Fsomeone%252Fnotes")).toEqual(["home-path"]);
    const held = `held${"y".repeat(10)}@example`;
    expect(kinds(`the value held${"y".repeat(10)}%40example`, { secrets: [held] })).toEqual([
      "held-key",
    ]);
    // One address written plainly is one finding, not one for each reading.
    expect(kinds("write to someone@example.org")).toEqual(["email"]);
  });

  test("the scan reads a long unbroken run of letters in linear time", { timeout: 5_000 }, () => {
    const run = "ab1.".repeat(5_000 / 4);
    // The same 20 KB read as four short texts and as one long one, the best of five each.
    const timeOf = (texts: readonly string[]) =>
      Math.min(
        ...[0, 1, 2, 3, 4].map(() => {
          const started = performance.now();
          for (const text of texts) scanText(text, "file");
          return performance.now() - started;
        }),
      );
    timeOf([run]);
    const short = timeOf([run, run, run, run]);
    const long = timeOf([run.repeat(4)]);
    // Linear, the two take about as long; a quadratic rule takes four times as long on the long one.
    expect(long).toBeLessThan(short * 2.5);
  });

  test("a deny-list is read from outside the repository and fails when it is missing or empty", () => {
    const outside = mkdtempSync(join(tmpdir(), "deny-"));
    const list = join(outside, "words.txt");
    expect(() => readDenyList(list, ROOT)).toThrow(/doesn't exist/);
    writeFileSync(list, "# nothing but a comment\n\n");
    expect(() => readDenyList(list, ROOT)).toThrow(/holds no words/);
    writeFileSync(list, "# private names\nBluebird # a note\n  project kestrel \nissue#4\n");
    expect(readDenyList(list, ROOT)).toEqual(["Bluebird", "project kestrel", "issue#4"]);
    // Saved on Windows: a byte-order mark and CRLF line ends.
    writeFileSync(list, "\uFEFF# private names\r\nBluebird # a note\r\n  project kestrel \r\n");
    expect(readDenyList(list, ROOT)).toEqual(["Bluebird", "project kestrel"]);
    writeFileSync(list, "\uFEFF# only a comment\r\n\r\n");
    expect(() => readDenyList(list, ROOT)).toThrow(/holds no words/);
    writeFileSync(list, "# private names\nBluebird # a note\n  project kestrel \nissue#4\n");
    expect(() => readDenyList(join(ROOT, "eval/citations/words.txt"), ROOT)).toThrow(
      /inside the repository/,
    );
    const denied = readDenyList(list, ROOT);
    const kinds = (text: string) => scanText(text, "file", { denied }).map(({ kind }) => kind);
    expect(kinds("Notes from BLUEBIRD and Project Kestrel")).toEqual([
      "denied-word",
      "denied-word",
    ]);
    expect(kinds("a blue bird and a kestrel")).toEqual([]);
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
    // An authentication scheme's name is case-insensitive.
    const lower = `authorization: bearer ${"t".repeat(24)}`;
    expect(scanText(lower, "log.txt").map(({ kind }) => kind)).toEqual(["api-key"]);
  });

  test("a verdict holds for the Citation it read under today's prompt; a verdict is reserved at its most", async () => {
    const folder = mkdtempSync(join(tmpdir(), "judgements-"));
    let calls = 0;
    const judge: Judge = {
      id: "test/judge",
      kind: "anthropic",
      maker: "Test",
      price: null,
      mostUsd: () => 0,
      async judge() {
        calls++;
        return { verdict: "supported", reason: "", tokens: noTokens() };
      },
    };
    const log = () => {};
    const free = { capUsd: null, spentUsd: 0 };
    const path = join(folder, "run.judge.jsonl");
    const input = judgeInputOf(answerOf("x"), citation());
    await judgeAll(judge, [{ key: "en-014#1", input }], path, free, log);
    await judgeAll(judge, [{ key: "en-014#1", input }], path, free, log);
    expect(calls).toBe(1);
    // An Answer asked again on resume puts another Citation under the same key.
    const replaced = { ...input, sentence: "HHS reports a net cost of $1,714.4 billion." };
    await judgeAll(judge, [{ key: "en-014#1", input: replaced }], path, free, log);
    expect(calls).toBe(2);
    expect(readJudgements(path).get("en-014#1")?.input).toBe(inputSha256(replaced));
    const older = { ...judged("supported"), key: "en-014#2", input: inputSha256(input) };
    appendFileSync(path, `${JSON.stringify({ ...older, prompt: "an older prompt" })}\n`);
    await judgeAll(judge, [{ key: "en-014#2", input }], path, free, log);
    expect(calls).toBe(3);
    expect(readJudgements(path).get("en-014#2")?.prompt).toBe(PROMPT_SHA256);

    const haiku = modelJudge({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "test",
      baseUrl: null,
      endpoint: null,
      numCtx: null,
      citing: null,
    });
    const long = { ...input, passage: input.passage.repeat(300) };
    expect(haiku.mostUsd(long)).toBeGreaterThan(haiku.mostUsd(input) * 3);
    const priced: Judge = { ...judge, price: haiku.price, mostUsd: haiku.mostUsd };
    const cap = { capUsd: haiku.mostUsd(input) * 2, spentUsd: 0 };
    const stopped = await judgeAll(priced, [{ key: "en-015#1", input: long }], path, cap, log);
    expect(stopped.stopped).toMatch(/the next verdict may cost up to/);
    expect(calls).toBe(3);
  });

  test("judges come from two makers, neither the run's; a run keeps the pair that began on it; the cap counts all the judging", () => {
    expect(makerOf("claude-opus-5-5")).toBe(makerOf("anthropic/claude-sonnet-5-5"));
    expect(makerOf("gpt-6-luna")).toBe(makerOf("o4-mini"));
    expect(makerOf("qwen3.5:4b")).not.toBe(makerOf("deepseek-v4-pro"));
    expect(makerOf("openrouter/auto")).toBeNull();
    const judgeOf = (id: string): Judge => ({
      id,
      kind: "openrouter",
      maker: makerOf(id),
      price: null,
      mostUsd: () => 0,
      judge: async () => ({ verdict: "supported", reason: "", tokens: noTokens() }),
    });
    const runs = mkdtempSync(join(tmpdir(), "runs-"));
    const file = "anthropic-claude-haiku-5-5.en.json";
    const claudeAndGemini = [
      judgeOf("anthropic/claude-opus-5-5"),
      judgeOf("google/gemini-3.1-pro-preview"),
    ];
    expect(leftFor(runs, file, "claude-haiku-5-5", claudeAndGemini)).toMatch(/Anthropic's/);
    const pair = [judgeOf("openai/gpt-6.1-sol"), judgeOf("google/gemini-3.1-pro-preview")];
    expect(leftFor(runs, file, "claude-haiku-5-5", pair)).toBeNull();
    expect(judgePairProblem(pair)).toBeNull();
    // A router's alias may send to any maker's model, the run's own included.
    expect(judgePairProblem([judgeOf("openrouter/auto"), pair[1] as Judge])).toMatch(
      /router's alias/,
    );
    expect(
      judgePairProblem(claudeAndGemini.slice(0, 1).concat(judgeOf("claude-sonnet-5-5"))),
    ).toMatch(/both Anthropic's/);
    expect(leftFor(runs, "openrouter-auto.en.json", "openrouter/auto", pair)).toMatch(
      /can't be told/,
    );
    const standIns = ["scripted-words", "scripted-numbers"].map((id) => ({
      ...judgeOf(id),
      maker: null,
    }));
    expect(leftFor(runs, "scripted.en.json", "scripted", standIns)).toBeNull();

    mkdirSync(join(runs, "judgements"));
    const line = (judge: string, usd: number) =>
      `${JSON.stringify({ ...judged("supported"), judge, usd })}\n`;
    writeFileSync(judgementsFile(runs, file, "kimi/kimi-k2.6"), line("kimi/kimi-k2.6", 0.25));
    expect(leftFor(runs, file, "claude-haiku-5-5", pair)).toMatch(/kimi\/kimi-k2.6 began/);
    writeFileSync(judgementsFile(runs, "other.zh.json", "openai/gpt-6.1-sol"), line("o", 0.5));
    expect(judgingUsd(runs)).toBeCloseTo(0.75);
  });

  /** A repository with two of the set's Documents, the scanned page and a one-page text, to scan. */
  async function scanRoot() {
    const set = await loadCitationSet(ROOT);
    const listed = set.documents.filter((document) =>
      ["cia-reading-room-scan", "nbs-gdp-revision"].includes(document.key),
    );
    const [scanned, revision] = listed;
    if (!scanned || !revision) throw new Error("The set has lost a Document this test reads.");
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    for (const document of listed) {
      mkdirSync(dirname(join(root, document.path)), { recursive: true });
      copyFileSync(join(ROOT, document.path), join(root, document.path));
    }
    mkdirSync(join(root, "eval/citations/runs"), { recursive: true });
    writeFileSync(
      join(root, "eval/citations/documents.json"),
      JSON.stringify({ documents: listed }),
    );
    writeFileSync(join(root, "eval/citations/questions.jsonl"), "");
    const allow = (entries: Allowed[]) =>
      writeFileSync(join(root, ALLOWED_FILE), JSON.stringify(entries, null, 2));
    const pageRead = (sha256: string): Allowed => ({
      kind: "page-read",
      document: scanned.key,
      page: 1,
      sha256,
      why: "read",
    });
    const found = async (denied: readonly string[] = []) =>
      (await scanBenchmark(root, [join(root, "eval/citations")], { secrets: [], denied }))
        .map(({ file, kind }) => `${file} ${kind}`)
        .sort();
    const run = (name: string, text: string) =>
      writeFileSync(join(root, "eval/citations/runs", name), text);
    return { root, scanned, revision, allow, pageRead, found, run };
  }

  test("the scan reads its allowlist with no exceptions, lets an address through only where its Document prints it, and fails a page it can't read", async () => {
    const { scanned, revision, allow, pageRead, found, run } = await scanRoot();
    const address = "someone@example.org";
    run("run.en.json", JSON.stringify({ text: address }));
    const key = ["sk", "ant", "api03", "x".repeat(40)].join("-");
    allow([
      {
        kind: "email",
        sha256: createHash("sha256").update(address).digest("hex"),
        document: revision.key,
        why: `planted: ${key} and ${address}`,
      },
    ]);
    expect(await found()).toEqual(
      [
        `${ALLOWED_FILE} api-key`,
        `${ALLOWED_FILE} email`,
        `${ALLOWED_FILE} unused-allowance`,
        "eval/citations/runs/run.en.json email",
        `${scanned.path} unread-page`,
      ].sort(),
    );

    allow([pageRead(revision.sha256)]);
    expect(await found()).toEqual(
      [
        `${ALLOWED_FILE} unused-allowance`,
        "eval/citations/runs/run.en.json email",
        `${scanned.path} unread-page`,
      ].sort(),
    );
    run("run.en.json", "{}");
    allow([pageRead(scanned.sha256)]);
    expect(await found()).toEqual([]);
  });

  test("the scan refuses a file that isn't text and passes a JSON file without a finding", async () => {
    const { scanned, allow, pageRead, found, run } = await scanRoot();
    allow([pageRead(scanned.sha256)]);
    run("notes.json", JSON.stringify({ text: "a figure of 1,294,272 and nothing else" }));
    expect(await found()).toEqual([]);
    const refused = ["run.log", "run.json.gz", ".env", "page.html"];
    for (const name of refused) run(name, "anything");
    expect(await found()).toEqual(
      refused.map((name) => `eval/citations/runs/${name} unlisted-file`).sort(),
    );
  });

  test("the scan reads a JSON file's escapes as its reader does: an escaped address is found, other escapes pass", async () => {
    const { scanned, allow, pageRead, found, run } = await scanRoot();
    allow([pageRead(scanned.sha256)]);
    run("plain.json", '{"a": "a line\\nand a tab\\t and \\u0041"}');
    expect(await found()).toEqual([]);
    run("escaped.json", '{"a": "write to pio\\u0040example.org"}');
    expect(await found()).toEqual(["eval/citations/runs/escaped.json email"]);
  });

  test("the scan finds a listed Document whose file changed, and passes it unchanged", async () => {
    const { root, scanned, revision, allow, pageRead, found } = await scanRoot();
    allow([pageRead(scanned.sha256)]);
    expect(await found()).toEqual([]);
    const document = join(root, revision.path);
    writeFileSync(document, Buffer.concat([readFileSync(document), Buffer.from("\n")]));
    expect(await found()).toEqual([`${revision.path} changed-document`]);
  });

  test("the scan finds a word of the deny-list in a published file, and none it isn't given", async () => {
    const { scanned, allow, pageRead, found, run } = await scanRoot();
    allow([pageRead(scanned.sha256)]);
    run("notes.md", "Made for Project Kestrel.");
    expect(await found(["project kestrel"])).toEqual(["eval/citations/runs/notes.md denied-word"]);
    expect(await found(["bluebird"])).toEqual([]);
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

  test("the results page gives the set's whole SHA-256 and says which judges are scripted stand-ins", () => {
    const questions = "a".repeat(64);
    const pageWith = (judges: string[]) =>
      resultsPage({
        scores: [],
        notPublished: new Map(),
        judges: { "anthropic-claude-haiku-5-5.en.json": judges },
        unsettled: {},
        set: { version: 1, questions },
        runs: {},
      });
    const scripted = pageWith(["scripted-words", "scripted-numbers"]);
    expect(scripted).toContain(`SHA-256 \`${questions}\``);
    expect(scripted).not.toContain("model judges, with one fixed prompt");
    expect(scripted).toContain("two scripted stand-ins");
    expect(scripted).toContain("scripted-words (a scripted stand-in, no model)");
    const models = pageWith(["openai/gpt-6.1-sol", "google/gemini-3.1-pro-preview"]);
    expect(models).toContain("two model judges, with one fixed prompt,");
    expect(models).not.toContain("stand-in");
  });

  test("a run is published only whole: every Question answered, every Citation judged or settled, on today's set and text", () => {
    const run = {
      ...runOf([]),
      documents: [{ key: "treasury", name: "T", status: "ready", pages: 2, pagesSha256: "p" }],
    };
    const today = { set: run.set, pagesSha: new Map([["treasury", "p"]]) };
    const judges = ["openai/gpt-6.1-sol", "google/gemini-3.1-pro-preview"];
    const supported = { supported: 3, judged: 3, unsettled: 0, unjudged: 0 };
    const whole = { answers: 75, failed: 0, questions: 75, supported };
    const because = (
      score: typeof whole,
      options: { judges?: string[]; today?: typeof today } = {},
    ) => notPublishedBecause(run, score, options.judges ?? judges, options.today ?? today);
    expect(because(whole)).toEqual([]);
    expect(because({ ...whole, failed: 2 })).toEqual([
      "Answered fewer than the 75 Questions of its language, a failed or timed-out Answer not counted",
    ]);
    expect(because(whole, { judges: ["scripted-words", "scripted-numbers"] })).toEqual([
      "Judged by the scripted stand-ins, not by model judges",
    ]);
    expect(because(whole, { today: { ...today, set: { ...run.set, questions: "q2" } } })).toEqual([
      "Answered another version of the set",
    ]);
    expect(
      because(whole, { today: { ...today, pagesSha: new Map([["treasury", "p2"]]) } }),
    ).toEqual(["Made on a Document whose text the app now reads differently"]);
    const open =
      "Has Citations without both judges' verdicts, or with a disagreement no person has settled";
    expect(because({ ...whole, supported: { ...supported, unsettled: 1 } })).toEqual([open]);
    expect(because({ ...whole, supported: { ...supported, unjudged: 1 } })).toEqual([open]);
  });
});
