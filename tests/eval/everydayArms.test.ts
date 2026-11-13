/**
 * Reading #3019 step 3's bars from both arms' everyday reports (eval/everyday/arms.ts): a void run
 * is refused, and each bar is read against main as the plan states it.
 */
import { describe, expect, test } from "vitest";
import { type ArmRun, readArms, unmatchedArms, voidReasons } from "../../eval/everyday/arms";
import type { CaseResult } from "../../eval/everyday/asking";
import type { SentenceSupport } from "../../eval/everyday/support";

const usage = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
};

const sentence = (
  verdict: SentenceSupport["verdict"],
  rest: Partial<SentenceSupport> = {},
): SentenceSupport => ({
  sentence: "Shorter routes speed training.",
  verdict,
  reason: verdict === "not-checked" ? "no-evidence" : null,
  detail: null,
  unsupported: null,
  cites: [{ documentName: "Weighted Keys Shorter Paths", quote: "a shorter route" }],
  parts: [],
  asked: { requests: [usage] },
  ...(verdict === "supported" && { unstated: null }),
  ...rest,
});

const answer = (
  support: SentenceSupport[],
  rest: Partial<CaseResult> = {},
  id = "research-attention-long",
): CaseResult => ({
  id,
  language: "en",
  request: "Does self-attention handle very long sequences better?",
  model: "anthropic/claude-haiku-5-5",
  failures: [],
  reply: "Shorter routes speed training[^1].",
  page: "",
  removed: [],
  rewritten: [],
  copies: 0,
  pointersLeft: 0,
  calls: [],
  changes: [],
  seconds: 10,
  answeredSeconds: 5,
  error: null,
  usage,
  droppedMarkers: 0,
  asks: { again: 0, coverage: 0, citations: 0 },
  support,
  claims: null,
  checkSeconds: 4,
  notFound: [],
  answering: [1_000],
  ...rest,
});

const arm = (folder: string, results: CaseResult[]): ArmRun[] => [{ folder, results }];

/** n Supported and m Unsupported sentences in one Answer. */
const judged = (n: number, m: number) =>
  answer([
    ...Array.from({ length: n }, () => sentence("supported")),
    ...Array.from({ length: m }, () => sentence("unsupported")),
  ]);

const read = (main: CaseResult[], branch: CaseResult[]) =>
  readArms(arm("main", main), arm("branch", branch), (each) => each.inputTokens / 1_000_000);

describe("A void run", () => {
  // protects=a request that didn't run, or a check, a part or a figure the provider refused, failed or let time out, voids its run, each named by its report and request, and no bar is read while one does; a check that is Not checked for want of evidence voids nothing; fails_when=a void run's numbers are read, or an ordinary Not checked is taken for a void; no_claim=none beyond protects.
  test("is refused, and no bar is read", () => {
    const timedOut = sentence("not-checked", { reason: "timed-out" });
    const refusedPart = sentence("not-checked", {
      parts: [
        {
          text: "Shorter routes",
          kind: "fact",
          verdict: "not-checked",
          reason: "rate-limit",
          detail: null,
          unsupported: null,
          evidence: [],
          figures: [],
        },
      ],
    });
    const runs = arm("branch", [
      answer([timedOut, refusedPart]),
      answer([], { error: "provider: 529", support: null }, "research-gpt3-energy"),
      answer([sentence("not-checked")]),
    ]);
    expect(voidReasons(runs)).toEqual([
      "branch: research-attention-long: a check timed-out: Shorter routes speed training.",
      "branch: research-attention-long: a check rate-limit: Shorter routes speed training.",
      "branch: research-gpt3-energy: didn't run: provider: 529",
    ]);
    const reading = readArms(arm("main", [judged(1, 0)]), runs, () => 0);
    expect(reading.voided).toHaveLength(3);
    expect(reading.lines.join("\n")).not.toContain("## 1.");
  });

  // protects=a try the provider refused or failed voids its run though a retry then answered the request, so a run is read only with no failed try at all; fails_when=a retried failure leaves the run read; no_claim=how the provider retries.
  test("is refused when a try failed, though a retry answered", () => {
    const runs: ArmRun[] = [
      { folder: "branch", results: [judged(1, 0)], failedTries: ["APICallError 529"] },
    ];
    expect(voidReasons(runs)).toEqual([
      "branch: a request's try failed, though a retry answered: APICallError 529",
    ]);
    expect(readArms(arm("main", [judged(1, 0)]), runs, () => 0).voided).toHaveLength(1);
  });
});

describe("Arms that don't hold the same Answers", () => {
  // protects=the bars are read only when both arms hold the same research Answers by request, model and language, and each difference is named with its two counts; fails_when=an arm with fewer or other requests is read against the other; no_claim=none beyond protects.
  test("are not compared", () => {
    const main = [judged(1, 0), judged(1, 0)];
    const branch = [judged(1, 0), answer([sentence("supported")], { language: "zh-CN" })];
    expect(unmatchedArms(arm("main", main), arm("branch", branch))).toEqual([
      "research-attention-long, anthropic/claude-haiku-5-5, en: main 2, branch 1",
      "research-attention-long, anthropic/claude-haiku-5-5, zh-CN: main 0, branch 1",
    ]);
    const reading = read(main, branch);
    expect(reading.unmatched).toHaveLength(2);
    expect(reading.lines.join("\n")).not.toContain("## 1.");
  });
});

describe("The bars against main", () => {
  // protects=the branch's Supported share of judged holds at main's less 12 points and fails below it; fails_when=the margin is left out, misapplied, or the Not checked are counted as judged; no_claim=whether 12 points is the right margin, which the plan settles.
  test.each([
    ["holds within 12 points", judged(9, 1), judged(8, 2), "holds"],
    ["holds at exactly 12 points", judged(25, 0), judged(22, 3), "holds"],
    ["fails beyond them", judged(9, 1), judged(7, 3), "**fails**"],
  ])("Supported share: %s", (_, main, branch, word) => {
    const reading = read(
      [main, answer([sentence("not-checked")])],
      [branch, answer([sentence("not-checked")])],
    );
    expect(reading.lines.join("\n")).toMatch(
      new RegExp(`less 12 points, [\\d.]+%: ${word.replace(/\*/g, "\\*")}\\.`),
    );
    expect(reading.failed.includes("1. Supported share")).toBe(word !== "holds");
  });

  // protects=the branch's ✓ the judge finds unstated must be no more than main's, each listed; a ✓ the judge never read leaves the bar not read; fails_when=more unstated ✓ on the branch pass, or an unjudged ✓ reads as stated; no_claim=how the judge reads.
  test("unstated ✓: no more than main's, and not read when a ✓ wasn't judged", () => {
    const unstated = sentence("supported", { unstated: "“only”" });
    expect(read([judged(2, 0)], [answer([unstated, sentence("supported")])]).failed).toContain(
      "2. Unstated ✓",
    );
    expect(read([answer([unstated])], [answer([unstated])]).lines.join("\n")).toContain(
      "Unstated ✓: the branch has 1, main 1: holds.",
    );
    const unjudged = sentence("supported", { unstated: undefined });
    expect(read([answer([unjudged])], [judged(1, 0)]).unread).toContain("2. Unstated ✓");
  });

  // protects=joined absence holds only under a tenth of main's count, nothing dropped allows two fewer Answers saying what wasn't found, and a marked sentence about the other Documents fails bar 5, in English and Chinese; fails_when=the counts mix the two kinds or the allowances are off by one; no_claim=how well the phrase rule finds them.
  test("C and the other Documents", () => {
    const gap = { sentence: "I didn't find the amount.", marked: false, otherDocuments: false };
    const joined = {
      sentence: "它提到了能源，但我读到的段落里没有具体数量。",
      marked: true,
      otherDocuments: false,
    };
    const other = {
      sentence: "None of the other Documents mention it.",
      marked: true,
      otherDocuments: true,
    };
    const saying = (notFound: CaseResult["notFound"]) =>
      answer([sentence("supported")], { notFound });
    const main = [
      ...Array.from({ length: 10 }, () => saying([joined])),
      ...Array.from({ length: 2 }, () => saying([gap])),
    ];
    const kept = read(main, [
      ...Array.from({ length: 10 }, () => saying([gap])),
      saying([]),
      saying([]),
    ]);
    expect(kept.failed).toEqual([]);
    const lost = read(main, [
      saying([joined]),
      ...Array.from({ length: 7 }, () => saying([gap])),
      saying([other]),
      ...Array.from({ length: 3 }, () => saying([])),
    ]);
    expect(lost.failed).toEqual([
      "4. Joined absence",
      "4. Nothing dropped",
      "5. Only this Document",
    ]);
  });

  // protects=the checks' cost is given for each arm though its bar is struck, and the answering requests' added input tokens are read per request against main's, every answering request counted apart; fails_when=the tokens added are read across different requests, or a request's cost is left out; no_claim=none beyond protects.
  test("the checks' cost, and the input tokens added to each answering request", () => {
    const twice = sentence("supported", { asked: { requests: [usage, usage] } });
    const reading = read(
      [
        answer([sentence("supported")], { answering: [1_000, 1_400] }),
        answer([sentence("supported")], { answering: [] }, "research-gpt3-energy"),
      ],
      [
        answer([twice], { answering: [1_090, 1_490] }),
        answer([twice], { answering: [] }, "research-gpt3-energy"),
      ],
    );
    const text = reading.lines.join("\n");
    expect(text).toContain("| branch | 2 | 4 | 2 | $4.0000 | $2.0000 | 4.0 s |");
    expect(reading.failed).toEqual([]);
    expect(text).toContain("| research-attention-long | 1000 | 1090 | 90 |");
    expect(text).toContain("A median of 90 input tokens added to each answering request.");
    expect(text).toContain(
      "Every answering request: 2 requests of 1200 input tokens on average on main, 2 requests of 1290 input tokens on average on the branch.",
    );
  });
});
