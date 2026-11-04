/**
 * Held-out sentences of two parts on the same Documents as `nearCopyHeldout.cases.ts` (#1765,
 * #1766, #1708), in the shape of a sentence the User corrects one part of: the first part is wrong
 * (another figure or period), the probe part copies a clause. In a positive the probe states its
 * clause, so it should read Supported however the first part reads; in a decoy it changes the
 * clause's period or duty or drops its condition, so it must never read Supported.
 *
 * Written and committed before any run of the check on them, after the first runs of the other
 * file and before any change to the check; none is a sentence of another set, of a test's fixture
 * or of an example in the check's instructions. Not edited after its commit. Bars: no probe of a
 * decoy Supported on Claude Haiku 5.5 and Claude Sonnet 5.5; the probes of the positives Supported
 * in as many checks as on `main`, less at most 1 in 12.
 */
import type { NearCopyKind } from "./nearCopyHeldout.cases";

export interface WalkShapeCase {
  key: string;
  kind: Exclude<NearCopyKind, "copy" | "paraphrase">;
  /** The Document of `nearCopyHeldout.cases.ts` whose clauses it copies. */
  document: string;
  /** The wrong part first, then the probe; together they are the sentence, with what joins them. */
  parts: readonly [string, string];
  sentence: string;
  decoy: boolean;
}

export interface WalkShapeSet {
  language: "en" | "zh-CN";
  cases: readonly WalkShapeCase[];
}

const walk =
  (decoy: boolean) =>
  (
    key: string,
    kind: WalkShapeCase["kind"],
    document: string,
    sentence: string,
    parts: readonly [string, string],
  ): WalkShapeCase => ({ key, kind, document, sentence, parts, decoy });

const states = walk(false);
const changes = walk(true);

export const WALK_SHAPE_SETS: readonly WalkShapeSet[] = [
  {
    language: "en",
    cases: [
      states(
        "billed-monthly",
        "period",
        "coworking",
        "Meeting rooms cost 30 pounds per hour, and members are billed for them each calendar month.",
        [
          "Meeting rooms cost 30 pounds per hour",
          "members are billed for them each calendar month",
        ],
      ),
      states(
        "inspected-monthly",
        "period",
        "allotments",
        "Plot holders pay a water charge of 50 pounds per annum, and the committee inspects every plot each month.",
        [
          "Plot holders pay a water charge of 50 pounds per annum",
          "the committee inspects every plot each month",
        ],
      ),
      states(
        "must-return",
        "duty",
        "library",
        "Members may borrow up to eight books at a time and must return reference books on the day they borrow them.",
        [
          "Members may borrow up to eight books at a time",
          "must return reference books on the day they borrow them",
        ],
      ),
      states(
        "should-record",
        "duty",
        "rowing",
        "The committee publishes the river safety report every month, and crews should record each outing in the boathouse log.",
        [
          "The committee publishes the river safety report every month",
          "crews should record each outing in the boathouse log",
        ],
      ),
      states(
        "same-person-kept",
        "condition",
        "software",
        "The licence fee is invoiced twice per annum, and the Customer may install the software on a second computer provided that both computers are used by the same person.",
        [
          "The licence fee is invoiced twice per annum",
          "the Customer may install the software on a second computer provided that both computers are used by the same person",
        ],
      ),
      states(
        "approval-kept",
        "condition",
        "allotments",
        "Plot holders pay a water charge of 50 pounds per annum and may keep hens, subject to the committee's approval.",
        [
          "Plot holders pay a water charge of 50 pounds per annum",
          "may keep hens, subject to the committee's approval",
        ],
      ),
      changes(
        "billed-weekly",
        "period",
        "coworking",
        "Meeting rooms cost 30 pounds per hour, and members are billed for them each week.",
        ["Meeting rooms cost 30 pounds per hour", "members are billed for them each week"],
      ),
      changes(
        "inspected-yearly",
        "period",
        "allotments",
        "Plot holders pay a water charge of 50 pounds per annum, and the committee inspects every plot each year.",
        [
          "Plot holders pay a water charge of 50 pounds per annum",
          "the committee inspects every plot each year",
        ],
      ),
      changes(
        "should-return",
        "duty",
        "library",
        "Members may borrow up to eight books at a time and should return reference books on the day they borrow them.",
        [
          "Members may borrow up to eight books at a time",
          "should return reference books on the day they borrow them",
        ],
      ),
      changes(
        "must-record",
        "duty",
        "rowing",
        "The committee publishes the river safety report every month, and crews must record each outing in the boathouse log.",
        [
          "The committee publishes the river safety report every month",
          "crews must record each outing in the boathouse log",
        ],
      ),
      changes(
        "same-person-dropped",
        "condition",
        "software",
        "The licence fee is invoiced twice per annum, and the Customer may install the software on a second computer.",
        [
          "The licence fee is invoiced twice per annum",
          "the Customer may install the software on a second computer",
        ],
      ),
      changes(
        "approval-dropped",
        "condition",
        "allotments",
        "Plot holders pay a water charge of 50 pounds per annum and may keep hens.",
        ["Plot holders pay a water charge of 50 pounds per annum", "may keep hens"],
      ),
    ],
  },
  {
    language: "zh-CN",
    cases: [
      states(
        "billed-monthly",
        "period",
        "coworking",
        "会议室每小时收费人民币一百元，费用按自然月结算。",
        ["会议室每小时收费人民币一百元", "费用按自然月结算"],
      ),
      states(
        "inspected-monthly",
        "period",
        "garden",
        "承包户每年缴纳用水费人民币五百元，管理委员会每月检查一次各地块。",
        ["承包户每年缴纳用水费人民币五百元", "管理委员会每月检查一次各地块"],
      ),
      states(
        "bixu-kept",
        "duty",
        "gym",
        "健身中心每周公布一次团体课程表，会员必须在使用后将器械放回原处。",
        ["健身中心每周公布一次团体课程表", "会员必须在使用后将器械放回原处"],
      ),
      states("bixu-return", "duty", "library", "读者每次最多可借八本书，工具书必须当天归还。", [
        "读者每次最多可借八本书",
        "工具书必须当天归还",
      ]),
      states(
        "same-person-kept",
        "condition",
        "software",
        "许可费按月开具发票，客户可以在第二台电脑上安装本软件，前提是两台电脑由同一人使用。",
        ["许可费按月开具发票", "客户可以在第二台电脑上安装本软件，前提是两台电脑由同一人使用"],
      ),
      states(
        "approval-kept",
        "condition",
        "estate",
        "物业公司每月公示一次公共收支情况，业主经物业公司批准后，可以在露台搭建遮阳棚。",
        ["物业公司每月公示一次公共收支情况", "业主经物业公司批准后，可以在露台搭建遮阳棚"],
      ),
      changes(
        "billed-weekly",
        "period",
        "coworking",
        "会议室每小时收费人民币一百元，费用按周结算。",
        ["会议室每小时收费人民币一百元", "费用按周结算"],
      ),
      changes(
        "inspected-yearly",
        "period",
        "garden",
        "承包户每年缴纳用水费人民币五百元，管理委员会每年检查一次各地块。",
        ["承包户每年缴纳用水费人民币五百元", "管理委员会每年检查一次各地块"],
      ),
      changes(
        "yinggai-for-bixu",
        "duty",
        "gym",
        "健身中心每周公布一次团体课程表，会员应该在使用后将器械放回原处。",
        ["健身中心每周公布一次团体课程表", "会员应该在使用后将器械放回原处"],
      ),
      changes("keyi-for-bixu", "duty", "library", "读者每次最多可借八本书，工具书可以当天归还。", [
        "读者每次最多可借八本书",
        "工具书可以当天归还",
      ]),
      changes(
        "same-person-dropped",
        "condition",
        "software",
        "许可费按月开具发票，客户可以在第二台电脑上安装本软件。",
        ["许可费按月开具发票", "客户可以在第二台电脑上安装本软件"],
      ),
      changes(
        "approval-dropped",
        "condition",
        "estate",
        "物业公司每月公示一次公共收支情况，业主可以在露台搭建遮阳棚。",
        ["物业公司每月公示一次公共收支情况", "业主可以在露台搭建遮阳棚"],
      ),
    ],
  },
];
