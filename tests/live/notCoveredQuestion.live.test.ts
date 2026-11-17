/**
 * The question a check asks about a Supported reply's own "Not covered" line (#3197), alone, on a
 * real model: each item is a sentence, its quote, the quote's Passage and the note, with the side
 * its sentence is on (right or wrong), and is asked as the check asks it, several times over.
 *
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY and INCARNAMIND_LIVE_NOTED_ITEMS, a JSON file of
 * `{ case, side, sentence, quote, passage, noted }`. The model is INCARNAMIND_LIVE_ANTHROPIC_MODEL
 * (Claude Haiku 5.5 by default), INCARNAMIND_LIVE_RUNS the asks of each item (3), and
 * INCARNAMIND_LIVE_REPORT a file that keeps one JSON line for each ask: the item's case and side,
 * both answers, whether the ✓ would stand, the reply's failure if it had one, the seconds it took,
 * its tokens and their price in US dollars. The model skips its thinking, as a check's does, and
 * the asks go a few at a time: all at once, Haiku 5.5 refused some for their rate.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CHECK_TAGS,
  confirmParts,
  NOT_COVERED_INSTRUCTIONS,
  readNotCovered,
} from "../../src/core/answers/checks/prompt";
import { ANSWER_TEMPERATURE } from "../../src/core/answers/engine";
import { judge, lines } from "../../src/core/answers/judge";
import { costOf, inCurrency } from "../../src/core/cost/price";
import { catalogModel } from "../../src/core/providers/catalog";
import { createAiSdkChatModel } from "../../src/core/providers/models";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const ITEMS = process.env.INCARNAMIND_LIVE_NOTED_ITEMS;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 3) || 3;
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const AT_ONCE = 5;

interface Item {
  case: string;
  side: "right" | "wrong";
  sentence: string;
  quote: string;
  passage: string;
  noted: string;
}

describe.skipIf(!KEY || !ITEMS)("what a check's note names, asked alone", () => {
  // protects=the numbers a pull request gives for this question come from the request the check itself sends; fails_when=a request fails or the items file can't be read; no_claim=any bar on the answers, which the pull request states
  test("each item is asked as the check asks it", { timeout: 3_600_000 }, async () => {
    const items = JSON.parse(readFileSync(ITEMS ?? "", "utf8")) as Item[];
    const model = createAiSdkChatModel({
      kind: "anthropic",
      baseUrl: null,
      apiKey: KEY ?? null,
      modelId: MODEL,
      thinking: "off",
    });
    const price = catalogModel("anthropic", MODEL)?.price;
    let failed = 0;
    const asks = Array.from({ length: RUNS }, (_, index) =>
      items.map((item) => ({ item, run: index + 1 })),
    ).flat();
    for (let from = 0; from < asks.length; from += AT_ONCE) {
      await Promise.all(
        asks.slice(from, from + AT_ONCE).map(async ({ item, run }) => {
          const started = Date.now();
          const asked = await judge({
            model,
            question: { id: "not-covered", instructions: NOT_COVERED_INSTRUCTIONS },
            parts: confirmParts({
              claim: item.sentence,
              quote: item.quote,
              passage: item.passage,
              noted: item.noted,
            }),
            data: [...CHECK_TAGS, "reply"],
            reply: lines(readNotCovered),
            retries: 1,
            signal: new AbortController().signal,
            temperature: ANSWER_TEMPERATURE,
          });
          if (!asked.ok && asked.reason !== "unreadable") failed++;
          if (REPORT)
            appendFileSync(
              REPORT,
              `${JSON.stringify({
                case: item.case,
                side: item.side,
                run,
                ...(asked.ok
                  ? { ...asked.value, stands: !asked.value.said && !asked.value.limits }
                  : { failure: asked.reason, status: asked.error?.status, stands: false }),
                seconds: (Date.now() - started) / 1000,
                usage: asked.usage,
                priced:
                  price && asked.usage
                    ? inCurrency(
                        costOf(asked.usage, price, new Date(), { cacheWrites: true }),
                        price.currency,
                        "USD",
                      )
                    : null,
              })}\n`,
            );
        }),
      );
    }
    expect(failed).toBe(0);
  });
});
