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

const batch = (finishReason: string, error: string | null = null): CheckRequest => ({
  kind: "batch",
  sentences: [0],
  asked: 1,
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

const checked = (run: number, arm: string, verdict: string, request: CheckRequest): FlowTimes => ({
  flow: "answer",
  model: "anthropic/claude-haiku-5-5",
  language: "en",
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
  requests: [request],
  reranks: [],
  rerankRepeats: { scored: 0, repeated: 0 },
  spentUsd: 0.001,
});

describe("the room gate's section", () => {
  test("counts today's cut-offs and main's, and reads the judge's sentences where main cut them", () => {
    const results = [
      checked(1, "main", "found", batch("stop")),
      checked(1, "main#2", "found", batch("stop")),
      checked(1, "today", "found", batch("stop")),
      // The sentence its quote doesn't state: main cut it twice, today read it and didn't pass it.
      checked(2, "main", "not-checked", batch("length")),
      checked(2, "main#2", "not-checked", batch("length")),
      checked(2, "today", "unsupported", batch("stop")),
    ];

    const section = roomGateSection(results, () => ITEMS, new Set(["b"]));

    expect(section).toContain("today 0 of 2 batches reached their room");
    expect(section).toContain("Main's arms: 1 of 2 and 1 of 2.");
    expect(section).toContain(
      "of 1 sentences, today Supported where main wasn't 0 times and the other way 0",
    );
    expect(section).toContain(
      "not readable: 1 of the sentences the judge lists fell in batches main cut and today read",
    );
    expect(section).not.toContain("Void");
  });

  test("a run with a refused request is void", () => {
    const results = [
      checked(1, "main", "found", batch("stop")),
      checked(1, "main#2", "found", batch("stop", "429 rate_limit_error")),
      checked(1, "today", "found", batch("stop")),
    ];

    expect(roomGateSection(results, () => ITEMS, null)).toContain(
      "**Void:** 1 requests refused for the service's limit and 0 failed.",
    );
  });
});
