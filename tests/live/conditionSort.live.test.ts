/**
 * How a Note's sort splits a sentence that states a right or a duty with its condition (#3257), on
 * a real model: the sort's own request, as Check this Note sends it, for each sentence alone and
 * for a language's sentences together in one request, several times over. A sentence split at its
 * condition has each half checked as a part, and the half without the condition is Unsupported.
 *
 * Two sets, each written and committed before any request to it; none is a sentence of the sort's
 * instructions or of the example sets. The first (fit) found the shape that is split: a
 * requirement clause that trails the right after a comma. The second (fresh) holds only that shape
 * and was committed before any change to the sort's rules was tried, which the first set is for.
 * `control` ones say what a sort should do with no condition: two independent facts or duties
 * are two parts, one fact is one, and a figure set beside another ("…, down from …") is sorted as
 * `main` sorts it: a rule for conditions must not reach a comparison.
 *
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY. The model is INCARNAMIND_LIVE_ANTHROPIC_MODEL
 * (Claude Haiku 5.5 by default), INCARNAMIND_LIVE_SETS the sets (fit,fresh by default),
 * INCARNAMIND_LIVE_RUNS the sorts of each layout (5), and
 * INCARNAMIND_LIVE_REPORT a file that keeps one JSON line for each sentence of each request: its
 * set, id, shape and layout, the parts the reply gave it in its own words, the request's failure if it
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
const SETS = (process.env.INCARNAMIND_LIVE_SETS ?? "fit,fresh").split(",");
const AT_ONCE = 5;

interface Sentence {
  id: string;
  shape: string;
  text: string;
}

const FIT_ENGLISH: Sentence[] = [
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
  {
    id: "en-p1",
    shape: "control, comparison",
    text: "Footfall was 12,400 in May, down from 13,900 in April.",
  },
  {
    id: "en-p2",
    shape: "control, comparison",
    text: "The average wait was 18 minutes, compared with 25 minutes last winter.",
  },
  {
    id: "en-p3",
    shape: "control, comparison",
    text: "The team closed 46 tickets this week, up from 31 the week before.",
  },
  {
    id: "en-p4",
    shape: "control, comparison",
    text: "Rainfall reached 88 mm in March, higher than the 61 mm of a year earlier.",
  },
];

const FIT_CHINESE: Sentence[] = [
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
  {
    id: "zh-p1",
    shape: "control, comparison",
    text: "五月客流量为 12,400 人次，低于四月的 13,900 人次。",
  },
  {
    id: "zh-p2",
    shape: "control, comparison",
    text: "平均等候时间为 18 分钟，少于去年冬季的 25 分钟。",
  },
  {
    id: "zh-p3",
    shape: "control, comparison",
    text: "本周团队关闭了 46 张工单，高于上周的 31 张。",
  },
  {
    id: "zh-p4",
    shape: "control, comparison",
    text: "三月降雨量达 88 毫米，较上年同期的 61 毫米有所增加。",
  },
];

const FRESH_ENGLISH: Sentence[] = [
  {
    id: "en-f1",
    shape: "trailing provided",
    text: "Couriers may leave parcels at the gatehouse, provided the guard signs for them.",
  },
  {
    id: "en-f2",
    shape: "trailing provided that",
    text: "Interns may attend client meetings, provided that a partner is in the room.",
  },
  {
    id: "en-f3",
    shape: "trailing on condition that",
    text: "The hall may be hired for private events, on condition that the caretaker locks up afterwards.",
  },
  {
    id: "en-f4",
    shape: "trailing provided, a duty",
    text: "Suppliers must deliver within five working days, provided the order is confirmed by noon.",
  },
  {
    id: "en-f5",
    shape: "trailing provided, a fact",
    text: "The grant covers travel costs, provided receipts are submitted within a month.",
  },
  {
    id: "en-f6",
    shape: "trailing provided",
    text: "Students may resit the exam once, provided the tutor recommends it.",
  },
  {
    id: "en-g1",
    shape: "control, two duties",
    text: "Staff must wear a badge, and visitors must sign in at reception.",
  },
  {
    id: "en-g2",
    shape: "control, two facts",
    text: "The warehouse closed in March, and the office moved in June.",
  },
  {
    id: "en-g3",
    shape: "control, a right and a duty",
    text: "Members may book the court online, and guests must pay at the desk.",
  },
  {
    id: "en-g4",
    shape: "control, no condition",
    text: "Couriers may leave parcels at the gatehouse.",
  },
];

const FRESH_CHINESE: Sentence[] = [
  { id: "zh-f1", shape: "trailing 须", text: "快递员可将包裹留在门卫室，须由保安签收。" },
  { id: "zh-f2", shape: "trailing 但须", text: "实习生可以参加客户会议，但须有合伙人在场。" },
  { id: "zh-f3", shape: "trailing 须经", text: "礼堂可出租用于私人活动，须经管理员事先同意。" },
  { id: "zh-f4", shape: "trailing 须", text: "访客可在地下车库停车，须先在前台领取通行证。" },
  {
    id: "zh-f5",
    shape: "trailing 但须, a fact",
    text: "补助金涵盖差旅费，但须在一个月内提交票据。",
  },
  { id: "zh-f6", shape: "trailing 须经", text: "员工可调休一天，须经部门负责人批准。" },
  { id: "zh-g1", shape: "control, two duties", text: "员工须佩戴工牌，访客须在前台登记。" },
  { id: "zh-g2", shape: "control, two facts", text: "仓库于三月关闭，办公室于六月搬迁。" },
  {
    id: "zh-g3",
    shape: "control, a right and a duty",
    text: "会员可在线预订场地，访客须在前台付费。",
  },
  { id: "zh-g4", shape: "control, no condition", text: "快递员可将包裹留在门卫室。" },
];

const LISTS = [
  { set: "fit", sentences: FIT_ENGLISH },
  { set: "fit", sentences: FIT_CHINESE },
  { set: "fresh", sentences: FRESH_ENGLISH },
  { set: "fresh", sentences: FRESH_CHINESE },
].filter((list) => SETS.includes(list.set));

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
    const requests = Array.from({ length: RUNS }, (_, index) =>
      LISTS.flatMap(({ set, sentences }) => [
        ...sentences.map((sentence) => ({
          set,
          layout: "alone",
          run: index + 1,
          batch: [sentence],
        })),
        { set, layout: "together", run: index + 1, batch: sentences },
      ]),
    ).flat();
    let failed = 0;
    for (let from = 0; from < requests.length; from += AT_ONCE) {
      await Promise.all(
        requests.slice(from, from + AT_ONCE).map(async ({ set, layout, run, batch }) => {
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
                set,
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
