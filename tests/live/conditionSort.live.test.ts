/**
 * How a Note's sort splits a sentence that states a right or a duty with its condition (#3257), on
 * a real model: the sort's own request, as Check this Note sends it, for each sentence alone and
 * for a language's sentences together in one request, several times over. A sentence split at its
 * condition has each half checked as a part, and the half without the condition is Unsupported.
 *
 * The sentences were written and committed before any request; none is a sentence of the sort's
 * instructions or of the example sets. `control` ones say what a sort should do with no
 * condition: two independent facts are two parts, one fact is one.
 *
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY. The model is INCARNAMIND_LIVE_ANTHROPIC_MODEL
 * (Claude Haiku 5.5 by default), INCARNAMIND_LIVE_RUNS the sorts of each layout (5), and
 * INCARNAMIND_LIVE_REPORT a file that keeps one JSON line for each sentence of each request: its
 * id, shape and layout, the parts the reply gave it in its own words, the request's failure if it
 * had one, and the request's price in US dollars on its first sentence's line.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  claimPartsOf,
  FIND_OWN_LIBRARY_CLAIMS_INSTRUCTIONS,
  findClaimsPrompt,
} from "../../src/core/answers/checks/claims";
import { ANSWER_TEMPERATURE } from "../../src/core/answers/engine";
import { json, judge } from "../../src/core/answers/judge";
import { costOf, inCurrency } from "../../src/core/cost/price";
import { catalogModel } from "../../src/core/providers/catalog";
import { createAiSdkChatModel } from "../../src/core/providers/models";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 5) || 5;
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const AT_ONCE = 5;

interface Sentence {
  id: string;
  shape: string;
  text: string;
}

const ENGLISH: Sentence[] = [
  {
    id: "en-t1",
    shape: "trailing provided",
    text: "Volunteers may borrow the minibus at weekends, provided the site manager signs the log.",
  },
  {
    id: "en-t2",
    shape: "trailing as long as",
    text: "Tenants may sublet a room, as long as the housing office approves the new occupant.",
  },
  {
    id: "en-t3",
    shape: "trailing if",
    text: "Members can cancel without a fee if they give thirty days' notice.",
  },
  {
    id: "en-t4",
    shape: "trailing unless",
    text: "The deposit is returned in full unless the room needs repainting.",
  },
  {
    id: "en-t5",
    shape: "trailing subject to",
    text: "Researchers may take samples off site, subject to the lab director's written consent.",
  },
  {
    id: "en-t6",
    shape: "trailing once",
    text: "New drivers may carry passengers once they have completed the safety course.",
  },
  {
    id: "en-l1",
    shape: "leading if",
    text: "If the client pays within ten days, the supplier gives a 2% discount.",
  },
  {
    id: "en-l2",
    shape: "leading only with",
    text: "Only with the bursar's approval may a society spend more than £300 on an event.",
  },
  {
    id: "en-l3",
    shape: "leading after",
    text: "After six months of service, employees may join the pension scheme.",
  },
  {
    id: "en-m1",
    shape: "middle",
    text: "Contractors, provided they hold a valid permit, may work on the roof.",
  },
  {
    id: "en-c1",
    shape: "control, two facts",
    text: "The library opens at nine, and the café opens at ten.",
  },
  {
    id: "en-c2",
    shape: "control, no condition",
    text: "Volunteers may borrow the minibus at weekends.",
  },
];

const CHINESE: Sentence[] = [
  {
    id: "zh-t1",
    shape: "trailing 须",
    text: "志愿者可在周末借用面包车，须由场地主管在登记簿上签字。",
  },
  { id: "zh-t2", shape: "trailing 但须", text: "租户可以转租一个房间，但须经房管处批准新住户。" },
  { id: "zh-t3", shape: "trailing 前提是", text: "会员可免费取消，前提是提前三十天通知。" },
  { id: "zh-t4", shape: "trailing 除非", text: "押金全额退还，除非房间需要重新粉刷。" },
  {
    id: "zh-t5",
    shape: "trailing 经…同意",
    text: "研究人员可将样本带离实验室，须经实验室主任书面同意。",
  },
  { id: "zh-t6", shape: "trailing 方可", text: "新司机完成安全培训后，方可搭载乘客。" },
  { id: "zh-l1", shape: "leading 如果", text: "如果客户在十日内付款，供应商给予2%的折扣。" },
  {
    id: "zh-l2",
    shape: "leading 只有…才",
    text: "只有经财务主管批准，社团才可在一次活动上花费超过3000元。",
  },
  { id: "zh-l3", shape: "leading …后", text: "入职满六个月后，员工可加入养老金计划。" },
  { id: "zh-m1", shape: "middle", text: "承包商在持有有效许可证的情况下可在屋顶作业。" },
  { id: "zh-c1", shape: "control, two facts", text: "图书馆九点开门，咖啡馆十点开门。" },
  { id: "zh-c2", shape: "control, no condition", text: "志愿者可在周末借用面包车。" },
];

describe.skipIf(!KEY)("a Note's sort of a sentence with its condition", () => {
  // protects=the count a pull request gives for how often the sort splits a sentence at its condition comes from the sort's own request; fails_when=a request fails or its reply can't be read; no_claim=any bar on the parts, which the pull request states
  test("each sentence is sorted alone and with its language's others", {
    timeout: 3_600_000,
  }, async () => {
    const model = createAiSdkChatModel({
      kind: "anthropic",
      baseUrl: null,
      apiKey: KEY ?? null,
      modelId: MODEL,
      thinking: "off",
    });
    const price = catalogModel("anthropic", MODEL)?.price;
    const requests = Array.from({ length: RUNS }, (_, index) => [
      ...[...ENGLISH, ...CHINESE].map((sentence) => ({
        layout: "alone",
        run: index + 1,
        batch: [sentence],
      })),
      { layout: "together", run: index + 1, batch: ENGLISH },
      { layout: "together", run: index + 1, batch: CHINESE },
    ]).flat();
    let failed = 0;
    for (let from = 0; from < requests.length; from += AT_ONCE) {
      await Promise.all(
        requests.slice(from, from + AT_ONCE).map(async ({ layout, run, batch }) => {
          const numbered = batch.map((sentence, index) => ({
            number: index + 1,
            text: sentence.text,
          }));
          const sorted = await judge({
            model,
            question: { id: "find-claims", instructions: FIND_OWN_LIBRARY_CLAIMS_INSTRUCTIONS },
            parts: [{ text: findClaimsPrompt(numbered) }],
            data: [],
            reply: json((value) => claimPartsOf(value, numbered)),
            retries: 1,
            signal: new AbortController().signal,
            temperature: ANSWER_TEMPERATURE,
          });
          if (!sorted.ok) failed++;
          const priced =
            price && sorted.usage
              ? inCurrency(
                  costOf(sorted.usage, price, new Date(), { cacheWrites: true }),
                  price.currency,
                  "USD",
                )
              : null;
          if (!REPORT) return;
          for (const [index, sentence] of batch.entries()) {
            const parts = sorted.ok ? sorted.value.get(index + 1) : undefined;
            appendFileSync(
              REPORT,
              `${JSON.stringify({
                id: sentence.id,
                shape: sentence.shape,
                layout,
                run,
                parts: parts?.map((part) => ({
                  kind: part.kind,
                  text: sentence.text.slice(part.span.start, part.span.end),
                })),
                ...(!sorted.ok && { failure: sorted.reason, status: sorted.error?.status }),
                priced: index === 0 ? priced : null,
              })}\n`,
            );
          }
        }),
      );
    }
    expect(failed).toBe(0);
  });
});
