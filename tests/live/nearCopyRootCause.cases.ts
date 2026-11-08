/**
 * Held-out near copies for the Duty and Condition lines' own words (#1766, #1708): a duty in
 * another word (shall, 应当), a prohibition put the other way round, and a deadline or manner
 * inside a duty left out (positives, by the ruling's third clause), beside the decoys they must not
 * let through: advice for a duty, the act reversed, a deadline that ends a right left out, and a
 * changed period. Written and committed on 2026-11-06, before the change to the Duty and Condition
 * lines that it measures, on Documents of their own, in English and Chinese. To be measured on
 * `main` first. Not edited after its commit.
 *
 * The bars are the held-out file's: no decoy Supported, positives as on `main` less at most 1 in 14.
 */
import type { AmendedSet } from "./nearCopyAmended.cases";

const decoy = (key: string, kind: "duty" | "condition" | "period", text: string) => ({
  key,
  kind,
  document: "library",
  text,
  decoy: true,
});
const positive = (key: string, text: string) => ({
  key,
  kind: "paraphrase" as const,
  document: "library",
  text,
  decoy: false,
});

export const ROOT_CAUSE_SETS: readonly AmendedSet[] = [
  {
    language: "en",
    withdrawn: [],
    documents: [
      {
        key: "library",
        file: "Community library rules.md",
        title: "Community library rules",
        clauses: [
          "Borrowers must return damaged books to the desk within three days.",
          "Borrowers must not leave bags in the reading room.",
          "Members shall keep the details on their library card up to date.",
          "Borrowers may renew a book online within two weeks of its due date.",
          "Members must make room bookings in writing.",
        ],
      },
    ],
    cases: [
      positive("deadline-inside-duty", "Borrowers must return damaged books to the desk."),
      positive(
        "prohibition-other-way-round",
        "Borrowers must keep their bags out of the reading room.",
      ),
      positive("shall-as-must", "Members must keep the details on their library card up to date."),
      positive("manner-inside-duty", "Members must make room bookings."),
      decoy("deadline-ends-right", "condition", "Borrowers may renew a book online."),
      decoy("act-reversed", "duty", "Borrowers must leave bags in the reading room."),
      decoy(
        "should-for-shall",
        "duty",
        "Members should keep the details on their library card up to date.",
      ),
      decoy(
        "deadline-changed",
        "period",
        "Borrowers must return damaged books to the desk within three weeks.",
      ),
    ],
  },
  {
    language: "zh-CN",
    withdrawn: [],
    documents: [
      {
        key: "library",
        file: "社区图书馆借阅规则.md",
        title: "社区图书馆借阅规则",
        clauses: [
          "借阅人应当在三日内将损坏的图书交回服务台。",
          "借阅人不得把包放在阅览室。",
          "会员应当及时更新借书证上的信息。",
          "借阅人可以在到期日后两周内在线续借。",
          "会员须以书面方式预约活动室。",
        ],
      },
    ],
    cases: [
      positive("deadline-inside-duty", "借阅人必须将损坏的图书交回服务台。"),
      positive("prohibition-other-way-round", "借阅人必须把包放在阅览室以外。"),
      positive("yingdang-as-must", "会员必须及时更新借书证上的信息。"),
      positive("manner-inside-duty", "会员须预约活动室。"),
      decoy("deadline-ends-right", "condition", "借阅人可以在线续借。"),
      decoy("act-reversed", "duty", "借阅人必须把包放在阅览室。"),
      decoy("yinggai-for-yingdang", "duty", "会员应该及时更新借书证上的信息。"),
      decoy("deadline-changed", "period", "借阅人应当在三周内将损坏的图书交回服务台。"),
    ],
  },
];
