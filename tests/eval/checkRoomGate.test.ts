/**
 * The bars of the room gate (#2951) read from a scripted run: two Answers of one sentence each
 * checked on main's room twice and today's once.
 */
import { describe, expect, test } from "vitest";
import { roomGateSection } from "../../eval/speed/checkRoomGate";
import type { CheckRequest, FlowTimes } from "../../eval/speed/checkTimes";
import { fisherOneSided, signTestP } from "../../eval/speed/stats";
import type { WrittenItem } from "../../eval/speed/writtenCases";

describe("the gate's statistics", () => {
  test("the sign test's chance of so many pairs going one way", () => {
    expect(signTestP(22, 30)).toBeCloseTo(0.008062, 5);
    expect(signTestP(15, 30)).toBeCloseTo(0.572232, 5);
    expect(signTestP(6, 6)).toBeCloseTo(0.015625, 6);
    expect(signTestP(0, 0)).toBe(1);
  });

  test("Fisher's exact test, one-sided", () => {
    expect(fisherOneSided(3, 1, 1, 3)).toBeCloseTo(0.242857, 5);
    expect(fisherOneSided(10, 10, 66, 274)).toBeCloseTo(0.00301, 5);
    expect(fisherOneSided(18, 66, 66, 274)).toBeCloseTo(0.389906, 5);
    expect(fisherOneSided(0, 5, 10, 10)).toBeCloseTo(1, 9);
  });
});

const ITEMS: WrittenItem[] = [
  {
    id: "a",
    language: "en",
    library: "terms",
    kind: "copy",
    sentence: "A.",
    quote: "A.",
    expected: "stated",
  },
  {
    id: "b",
    language: "en",
    library: "terms",
    kind: "period",
    sentence: "B.",
    quote: "B.",
    expected: "not stated",
  },
];

/** A batch of one sentence on `arm`, carrying that arm's limit unless `limit` says otherwise. */
const batch = (
  arm: string,
  finishReason: string,
  { error = null, limit }: { error?: string | null; limit?: number } = {},
): CheckRequest => ({
  kind: "batch",
  sentences: [0],
  asked: 1,
  maxOutputTokens: limit ?? (arm === "today" ? 5_300 : 300),
  turn: 0,
  nudge: null,
  startMs: 0,
  firstByteMs: 0,
  firstReasoningMs: null,
  firstAnswerMs: 0,
  endMs: 1_000,
  searches: 0,
  inputTokens: 1_000,
  cachedInputTokens: 0,
  outputTokens: finishReason === "length" ? 300 : 200,
  reasoningTokens: null,
  finishReason,
  error,
});

const checked = (
  run: number,
  arm: string,
  verdict: string,
  {
    finishReason = "stop",
    error,
    limit,
    language = "en",
  }: {
    finishReason?: string;
    error?: string | null;
    limit?: number;
    language?: string;
  } = {},
): FlowTimes => ({
  flow: "answer",
  model: "anthropic/claude-haiku-5-5",
  language,
  run,
  answerSentences: 1,
  arm,
  load: 1,
  load15: 1,
  checkStartMs: 0,
  firstMarkMs: 2_000,
  firstVerdictMs: 2_000,
  doneMs: 2_000,
  landed: [{ sentence: 0, ms: 2_000, verdict }],
  requests: [batch(arm, finishReason, { error, ...(limit !== undefined && { limit }) })],
  reranks: [],
  rerankRepeats: { scored: 0, repeated: 0 },
  spentUsd: 0.001,
});

/** 88 Answers of one sentence each on the three arms, with so many cut on each. */
function eightyEight(cut: { main: number; second: number; today: number }) {
  return Array.from({ length: 88 }, (_, at) => [
    checked(at + 1, "main", "found", { finishReason: at < cut.main ? "length" : "stop" }),
    checked(at + 1, "main#2", "found", { finishReason: at < cut.second ? "length" : "stop" }),
    checked(at + 1, "today", "found", { finishReason: at < cut.today ? "length" : "stop" }),
  ]).flat();
}

describe("the room gate's section", () => {
  test("prints the limits each arm's batches carried", () => {
    const results = [
      checked(1, "main", "found"),
      checked(1, "main#2", "found"),
      checked(1, "today", "found"),
    ];

    expect(roomGateSection(results, () => ITEMS, null)).toContain(
      "- **The limits seen:** main: 1 sentences, 300 (1); main#2: 1 sentences, 300 (1); today: 1 sentences, 5300 (1).",
    );
  });

  test("a run in which a batch carried another limit than its arm's is void", () => {
    const results = [
      checked(1, "main", "found"),
      checked(1, "main#2", "found"),
      // The room for records alone, where today's arm should carry 5,300.
      checked(1, "today", "found", { limit: 300 }),
    ];

    expect(roomGateSection(results, () => ITEMS, null)).toContain(
      "**Void:** 1 batches carried a limit other than their arm's.",
    );
  });

  test("a run with a refused request is void", () => {
    const results = [
      checked(1, "main", "found"),
      checked(1, "main#2", "found", { error: "429 rate_limit_error" }),
      checked(1, "today", "found"),
    ];

    expect(roomGateSection(results, () => ITEMS, null)).toContain(
      "**Void:** 1 requests refused for the service's limit and 0 failed.",
    );
  });

  test.each([
    // Main's count is the mean of its arms rounded up: 19, a quarter 4.75.
    { cut: { main: 20, second: 18, today: 4 }, verdict: "holds" },
    { cut: { main: 20, second: 18, today: 5 }, verdict: "**fails**" },
    // Main's count 11, a quarter 2.75.
    { cut: { main: 12, second: 10, today: 3 }, verdict: "**fails**" },
    { cut: { main: 12, second: 10, today: 2 }, verdict: "holds" },
  ])(
    "cut-offs: today $cut.today of 88, main $cut.main and $cut.second: $verdict",
    ({ cut, verdict }) => {
      const section = roomGateSection(eightyEight(cut), () => ITEMS, null);

      expect(section).toContain(
        `The bar is at most 4 of 88 and at most a quarter of main's count: ${verdict}.`,
      );
    },
  );

  test.each([
    // Seven of seven untied pairs one way: p = 0.0078, under 0.01.
    { more: 7, verdict: "**fails**", p: "0.00781" },
    // Six of six: p = 0.0156.
    { more: 6, verdict: "holds", p: "0.0156" },
  ])(
    "verdicts: today Supported where main wasn't $more times and never the other way: $verdict",
    ({ more, verdict, p }) => {
      const results = Array.from({ length: more }, (_, at) => {
        const language = at % 2 ? "zh-CN" : "en";
        return [
          checked(at + 1, "main", "unsupported", { language }),
          checked(at + 1, "main#2", "unsupported", { language }),
          checked(at + 1, "today", "found", { language }),
        ];
      }).flat();

      const section = roomGateSection(results, () => ITEMS, null);

      expect(section).toContain(
        `today Supported where main wasn't ${more} times and the other way 0: one-sided sign test p = ${p}, the bar fails under 0.01: ${verdict}.`,
      );
      expect(section).toContain(`By language: en ${Math.ceil(more / 2)} and 0`);
    },
  );

  test("reads the judge's sentences where main cut them", () => {
    const results = [
      checked(1, "main", "found"),
      checked(1, "main#2", "found"),
      checked(1, "today", "found"),
      // The sentence its quote doesn't state: main cut it twice, today read it and didn't pass it.
      checked(2, "main", "not-checked", { finishReason: "length" }),
      checked(2, "main#2", "not-checked", { finishReason: "length" }),
      checked(2, "today", "unsupported"),
    ];

    const section = roomGateSection(results, () => ITEMS, new Set(["b"]));

    expect(section).toContain(
      "not readable: 1 of the sentences the judge lists fell in batches main cut and today read",
    );
    expect(section).not.toContain("Void");
  });
});
