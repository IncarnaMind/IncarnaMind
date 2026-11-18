/**
 * The decision model's sort of a Note's sentences (#3334), on the real model: every fact of the
 * fixed Notes and pairs has to score at or over the measured line, since a fact left out is a
 * check that never runs. How many of the writer's own remarks and views it leaves out is counted,
 * not judged: either a grey mark or none is right for those.
 *
 * Runs with an OpenRouter key in INCARNAMIND_LIVE_DECISION_KEY; writes its counts to
 * INCARNAMIND_LIVE_GATE_OUT when set.
 */
import { writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decisionLinesFor } from "../../src/core/answers/checks/decisionLines";
import { sortScore } from "../../src/core/answers/checks/decisionSort";
import { decisionEndpoint } from "../../src/core/providers/catalog/decisions";
import { askJev } from "../../src/core/providers/jev";
import { slots } from "../../src/core/runs/stop";
import { ADVICE, DUTY_PAIRS } from "./dutySentences.cases";
import { EVERYDAY_PAIRS } from "./everydaySentences.cases";
import { FIELD_PAIRS } from "./fieldSentences.cases";
import { JUDGEMENT_NOTES } from "./judgementSentences.cases";
import { REMARK_NOTES } from "./remarkSentences.cases";
import { linesOf, STRUCTURED_NOTES } from "./structuredNotes.cases";

const KEY = process.env.INCARNAMIND_LIVE_DECISION_KEY;
const OUT = process.env.INCARNAMIND_LIVE_GATE_OUT;
const HOST = "openrouter";
const MODEL = "perplexity/pplx-decider-v1.2";

interface Asked {
  set: string;
  sentence: string;
  fact: boolean;
}

const pairs = (set: string, all: readonly { right: string; wrong: string }[]): Asked[] =>
  all.flatMap(({ right, wrong }) => [
    { set, sentence: right, fact: true },
    { set, sentence: wrong, fact: true },
  ]);
const lines = (
  set: string,
  all: readonly { sentence: string; expected: "right" | "wrong" | "none" }[],
): Asked[] => all.map(({ sentence, expected }) => ({ set, sentence, fact: expected !== "none" }));

const ASKED: Asked[] = [
  ...lines(
    "remark and memo Notes",
    [...REMARK_NOTES, ...JUDGEMENT_NOTES].flatMap((note) => note.lines),
  ),
  ...lines("structured Notes", STRUCTURED_NOTES.flatMap(linesOf)),
  ...pairs("everyday pairs", EVERYDAY_PAIRS),
  ...pairs("field pairs", FIELD_PAIRS),
  ...pairs("duty pairs", DUTY_PAIRS),
  ...ADVICE.map(({ sentence }) => ({ set: "advice", sentence, fact: false })),
];

test.skipIf(!KEY)(
  "no fact is left out of the check by the decision model's sort",
  {
    timeout: 300_000,
  },
  async () => {
    const line = decisionLinesFor(HOST, MODEL)?.sort;
    const endpoint = decisionEndpoint(HOST, MODEL, { account: null, region: null });
    if (line === undefined || !endpoint || !KEY) throw new Error("The model has no sorting line.");
    const atOnce = slots(16);
    let failed = 0;
    const reader = {
      ask: (
        state: Record<string, unknown>,
        questions: Parameters<typeof askJev>[0]["questions"],
        signal: AbortSignal,
      ) =>
        atOnce.run(() =>
          askJev({
            baseUrl: endpoint.url,
            endpoint,
            apiKey: KEY,
            model: MODEL,
            state,
            questions,
            signal,
            retries: 1,
            timeoutMs: 15_000,
          }).catch(() => {
            failed += 1;
            return null;
          }),
        ),
    };
    const started = Date.now();
    const stop = new AbortController();
    const scored = await Promise.all(
      ASKED.map(async (asked) => ({
        ...asked,
        score: await sortScore(reader, asked.sentence, stop.signal),
      })),
    );
    const seconds = (Date.now() - started) / 1000;
    const sets = [...new Set(ASKED.map((each) => each.set))].map((set) => {
      const of = scored.filter((each) => each.set === set);
      const facts = of.filter((each) => each.fact);
      const others = of.filter((each) => !each.fact);
      const under = (all: typeof of) => all.filter((each) => (each.score ?? 1) < line).length;
      return {
        set,
        facts: facts.length,
        factsLeftOut: under(facts),
        ...(facts.length > 0 && { lowestFact: Math.min(...facts.map((each) => each.score ?? 1)) }),
        others: others.length,
        othersLeftOut: under(others),
      };
    });
    const report = { model: MODEL, line, requests: ASKED.length, failed, seconds, sets };
    if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    expect(failed).toBe(0);
    expect(sets.map(({ set, factsLeftOut }) => ({ set, factsLeftOut }))).toEqual(
      sets.map(({ set }) => ({ set, factsLeftOut: 0 })),
    );
  },
);
