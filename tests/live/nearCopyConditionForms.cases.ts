/**
 * Held-out near copies whose clauses write a condition in brackets, with a slash inside its words
 * ("and/or", a date) or as a prohibition put the other way round, and positives that put the same
 * duty in another word (#1766, #1708). Written and committed on 2026-11-05, before the change to how
 * a Condition line's sides are read, to the Duty line's rule for one rule put the other way round,
 * and to the ask for unread lines; on Documents of their own; measured on `main` first. Not edited
 * after its commit.
 *
 * The bars are the held-out file's: no decoy Supported, positives as on `main` less at most 1 in 14.
 */
import type { AmendedSet } from "./nearCopyAmended.cases";

const decoy = (key: string, kind: "duty" | "condition", text: string) => ({
  key,
  kind,
  document: "club",
  text,
  decoy: true,
});
const positive = (key: string, kind: "copy" | "paraphrase", text: string) => ({
  key,
  kind,
  document: "club",
  text,
  decoy: false,
});

export const CONDITION_FORMS_SETS: readonly AmendedSet[] = [
  {
    language: "en",
    withdrawn: [],
    documents: [
      {
        key: "club",
        file: "Tennis club rules.md",
        title: "Tennis club rules",
        clauses: [
          "Members may use the floodlit courts (provided that they book them at the clubhouse).",
          "Members may bring a dog onto the grounds if the groundsman and/or the secretary agrees.",
          "Members may pay the winter subscription in instalments until 31/1/2027 if they have no unpaid fees.",
          "Members must not leave the court gates open.",
          "Juniors must wear non-marking shoes on the indoor courts.",
          "Members may borrow a racket from the clubhouse.",
        ],
      },
    ],
    cases: [
      decoy("bracketed", "condition", "Members may use the floodlit courts."),
      decoy("and-or", "condition", "Members may bring a dog onto the grounds."),
      decoy(
        "dated",
        "condition",
        "Members may pay the winter subscription in instalments until 31/1/2027.",
      ),
      decoy("must-for-must-not", "duty", "Members must leave the court gates open."),
      positive(
        "bracketed-kept",
        "paraphrase",
        "Members may use the floodlit courts if they book them at the clubhouse.",
      ),
      positive(
        "and-or-kept",
        "copy",
        "Members may bring a dog onto the grounds if the groundsman and/or the secretary agrees.",
      ),
      positive(
        "dated-kept",
        "paraphrase",
        "Members with no unpaid fees may pay the winter subscription in instalments until 31/1/2027.",
      ),
      positive("other-way-round", "paraphrase", "Members must keep the court gates shut."),
      positive(
        "have-to",
        "paraphrase",
        "Juniors have to wear non-marking shoes on the indoor courts.",
      ),
      positive("can-for-may", "paraphrase", "Members can borrow a racket from the clubhouse."),
    ],
  },
  {
    language: "zh-CN",
    withdrawn: [],
    documents: [
      {
        key: "club",
        file: "网球俱乐部会员守则.md",
        title: "网球俱乐部会员守则",
        clauses: [
          "会员可以使用夜间照明球场（须先在会所预约）。",
          "经场地管理员和/或秘书同意，会员可以带狗进入场地。",
          "没有欠费的会员可以在2027/1/31前分期缴纳冬季会费。",
          "会员不得让球场门开着。",
          "青少年会员在室内球场必须穿不留痕的球鞋。",
          "会员可以从会所借用球拍。",
        ],
      },
    ],
    cases: [
      decoy("bracketed", "condition", "会员可以使用夜间照明球场。"),
      decoy("and-or", "condition", "会员可以带狗进入场地。"),
      decoy("dated", "condition", "会员可以在2027/1/31前分期缴纳冬季会费。"),
      decoy("must-for-must-not", "duty", "会员必须让球场门开着。"),
      positive("bracketed-kept", "paraphrase", "会员在会所预约后可以使用夜间照明球场。"),
      positive("and-or-kept", "copy", "经场地管理员和/或秘书同意，会员可以带狗进入场地。"),
      positive("dated-kept", "copy", "没有欠费的会员可以在2027/1/31前分期缴纳冬季会费。"),
      positive("other-way-round", "paraphrase", "会员必须把球场门关好。"),
      positive("have-to", "paraphrase", "青少年会员在室内球场须穿不留痕的球鞋。"),
      positive("can-for-may", "paraphrase", "会员能从会所借用球拍。"),
    ],
  },
];
