/**
 * Held-out near copies for the check's judge (#1765, #1766, #1708): Documents of their own, in
 * English and Chinese, and sentences that copy one of their clauses but change its period, change
 * its duty (must, should, may, can, shall, must not; 必须, 应该, 可以, 应当, 不得), or state flat a
 * rule the Document holds on a condition (only if, unless, provided that, after notice, subject to
 * approval; 只有…才, 除非, 前提是, 经…同意后). Beside them, true copies and true paraphrases of the
 * same clauses, so the run counts what the check still backs.
 *
 * Written and committed before any run of the check on them. None is a sentence of another set, of
 * a test's fixture or of an example in the check's instructions, and none is to be used as one.
 * This file is not edited after its commit: a further case goes in a file of its own, committed
 * before the run that first reads it. Edited once, on 2026-11-05, only to rename two Documents
 * whose invented names were a real school's and close to a real allotment society's; nothing else
 * changed, and their English cases are measured on `main` again first.
 *
 * The bars, fixed before the first run (`nearCopyHeldout.live.test.ts` runs them):
 * - Decoys: no check of a decoy is Supported, on Claude Haiku 5.5 and on Claude Sonnet 5.5, in
 *   either language. Any other result passes (Contradicted, the partly-supported card, Not found).
 * - Positives: in each language and on each model, as many checks Supported as on `main` with the
 *   same number of checks, less at most 1 in 14.
 * - The repeated-checks sets that hold sentences the Documents state (eval/repeats: `en`, `zh`,
 *   their controls, the duty paraphrases, the licence's faithful sentences, the periods sets and
 *   the word-for-word sets): as many checks Supported on each expected-Supported sentence as on
 *   `main`, less at most 1 in 20 checks of a set; and in the conflict sets as many Contradicted,
 *   less at most 1 in 20.
 */

export type NearCopyKind = "period" | "duty" | "condition" | "copy" | "paraphrase";

export interface NearCopyDocument {
  key: string;
  file: string;
  title: string;
  clauses: readonly string[];
}

export interface NearCopyCase {
  key: string;
  kind: NearCopyKind;
  /** The Document whose clause it copies. */
  document: string;
  text: string;
  /** A decoy changes the clause and must never be Supported; a positive states it and should be. */
  decoy: boolean;
}

export interface NearCopySet {
  language: "en" | "zh-CN";
  documents: readonly NearCopyDocument[];
  cases: readonly NearCopyCase[];
}

const decoy =
  (kind: NearCopyKind) =>
  (key: string, document: string, text: string): NearCopyCase => ({
    key,
    kind,
    document,
    text,
    decoy: true,
  });

const positive =
  (kind: NearCopyKind) =>
  (key: string, document: string, text: string): NearCopyCase => ({
    key,
    kind,
    document,
    text,
    decoy: false,
  });

const period = decoy("period");
const duty = decoy("duty");
const condition = decoy("condition");
const copy = positive("copy");
const paraphrase = positive("paraphrase");

const ENGLISH: NearCopySet = {
  language: "en",
  documents: [
    {
      key: "library",
      file: "Brackenmoor Library rules.md",
      title: "Brackenmoor Library: members' rules",
      clauses: [
        "The library posts its events calendar online every month.",
        "Members may borrow up to six books at a time.",
        "Members must return reference books on the day they borrow them.",
        "A member may renew a loan online only if no other member has reserved the book.",
      ],
    },
    {
      key: "rowing",
      file: "Tidewell Rowing Club rules.md",
      title: "Tidewell Rowing Club: club rules",
      clauses: [
        "The committee publishes the river safety report every quarter.",
        "Crews should record each outing in the boathouse log.",
        "Juniors may take out a single scull only when a coach is on the bank.",
        "The club can lend a boat to a visiting crew.",
      ],
    },
    {
      key: "software",
      file: "Ostrander licence terms.md",
      title: "Ostrander Software: licence terms",
      clauses: [
        "The licence fee is invoiced once per annum.",
        "The Customer shall tell Ostrander about any security breach without delay.",
        "The Customer may install the software on a second computer, provided that both computers are used by the same person.",
        "Ostrander may suspend the licence after giving the Customer written notice.",
      ],
    },
    {
      key: "school",
      file: "Quenmarrow Primary handbook.md",
      title: "Quenmarrow Primary School: parents' handbook",
      clauses: [
        "The school sends a newsletter home every week.",
        "Parents must tell the school office on the morning of any absence.",
        "Pupils may leave the grounds at lunchtime only with written permission from a parent.",
        "Pupils should bring a water bottle every day.",
      ],
    },
    {
      key: "coworking",
      file: "Penhallow house rules.md",
      title: "Penhallow Co-working: house rules",
      clauses: [
        "Members are billed for meeting rooms each calendar month.",
        "Meeting rooms cost 25 pounds per hour.",
        "Members may bring a guest, unless the event space is booked for a private function.",
        "The front desk can hold parcels for members.",
      ],
    },
    {
      key: "water",
      file: "Arden Valley Water charter.md",
      title: "Arden Valley Water: customer charter",
      clauses: [
        "Arden Valley Water publishes its water quality results every week.",
        "Customers must report a leak on their side of the meter.",
        "Arden Valley Water may enter a garden to read a meter after giving notice.",
        "Customers may pay their bill by direct debit.",
      ],
    },
    {
      key: "gallery",
      file: "Ravensmere Gallery loan agreement.md",
      title: "Ravensmere Gallery: loan agreement",
      clauses: [
        "Condition reports are made at the start and end of each loan.",
        "The Borrower must display the painting away from direct sunlight.",
        "Visitors must not photograph the painting.",
        "The Gallery will collect the painting at its own cost, unless the Borrower ends the loan early.",
      ],
    },
    {
      key: "allotments",
      file: "Thrennick Allotment Society rules.md",
      title: "Thrennick Allotment Society: plot holders' rules",
      clauses: [
        "Plot holders pay a water charge of 40 pounds per annum.",
        "The committee inspects every plot each month.",
        "Plot holders may keep hens, subject to the committee's approval.",
        "Plot holders shall keep the paths beside their plots clear.",
      ],
    },
    {
      key: "buses",
      file: "Corbridge Buses conditions of carriage.md",
      title: "Corbridge Buses: conditions of carriage",
      clauses: [
        "The annual season ticket runs for the financial year.",
        "Passengers should give up priority seats to wheelchair users.",
        "A driver may refuse to carry a passenger who is drunk.",
        "Children travel free when they are with a paying adult.",
      ],
    },
  ],
  cases: [
    period("week-for-month", "library", "The library posts its events calendar online every week."),
    period(
      "month-for-quarter",
      "rowing",
      "The committee publishes the river safety report every month.",
    ),
    period("month-for-annum", "software", "The licence fee is invoiced once per month."),
    period("term-for-week", "school", "The school sends a newsletter home every term."),
    period(
      "week-for-calendar-month",
      "coworking",
      "Members are billed for meeting rooms each week.",
    ),
    period("day-for-hour", "coworking", "Meeting rooms cost 25 pounds per day."),
    period(
      "day-for-week",
      "water",
      "Arden Valley Water publishes its water quality results every day.",
    ),
    period("year-for-month", "allotments", "The committee inspects every plot each year."),
    period(
      "month-for-annum-figure",
      "allotments",
      "Plot holders pay a water charge of 40 pounds per month.",
    ),
    period(
      "calendar-for-financial",
      "buses",
      "The annual season ticket runs for the calendar year.",
    ),
    duty(
      "should-for-must",
      "library",
      "Members should return reference books on the day they borrow them.",
    ),
    duty("must-for-should", "rowing", "Crews must record each outing in the boathouse log."),
    duty("shall-for-can", "rowing", "The club shall lend a boat to a visiting crew."),
    duty(
      "can-for-shall",
      "software",
      "The Customer can tell Ostrander about any security breach without delay.",
    ),
    duty("must-for-should-daily", "school", "Pupils must bring a water bottle every day."),
    duty("must-for-can", "coworking", "The front desk must hold parcels for members."),
    duty("may-for-must", "water", "Customers may report a leak on their side of the meter."),
    duty("should-not-for-must-not", "gallery", "Visitors should not photograph the painting."),
    duty("must-for-may", "buses", "A driver must refuse to carry a passenger who is drunk."),
    condition("only-if-reserved", "library", "A member may renew a loan online."),
    condition("only-when-coach", "rowing", "Juniors may take out a single scull."),
    condition(
      "provided-that",
      "software",
      "The Customer may install the software on a second computer.",
    ),
    condition("after-written-notice", "software", "Ostrander may suspend the licence."),
    condition("only-with-permission", "school", "Pupils may leave the grounds at lunchtime."),
    condition("unless-booked", "coworking", "Members may bring a guest."),
    condition("after-notice", "water", "Arden Valley Water may enter a garden to read a meter."),
    condition(
      "unless-ended-early",
      "gallery",
      "The Gallery will collect the painting at its own cost.",
    ),
    condition("subject-to-approval", "allotments", "Plot holders may keep hens."),
    copy("six-books", "library", "Members may borrow up to six books at a time."),
    paraphrase("monthly", "library", "The library puts its events calendar online once a month."),
    paraphrase(
      "required-to",
      "library",
      "Members are required to return reference books on the day they borrow them.",
    ),
    paraphrase(
      "only-if-coach",
      "rowing",
      "Juniors may take out a single scull only if a coach is on the bank.",
    ),
    paraphrase("once-a-year", "software", "Ostrander invoices the licence fee once a year."),
    paraphrase(
      "must-for-shall",
      "software",
      "The Customer must tell Ostrander about any security breach without delay.",
    ),
    paraphrase("weekly", "school", "The school sends a newsletter home weekly."),
    paraphrase(
      "except-when-booked",
      "coworking",
      "Members can bring a guest except when the event space is booked for a private function.",
    ),
    copy("hourly-rate", "coworking", "Meeting rooms cost 25 pounds per hour."),
    copy("report-leak", "water", "Customers must report a leak on their side of the meter."),
    copy("no-photographs", "gallery", "Visitors must not photograph the painting."),
    paraphrase(
      "forty-a-year",
      "allotments",
      "Plot holders pay a water charge of 40 pounds a year.",
    ),
    copy(
      "hens-approval",
      "allotments",
      "Plot holders may keep hens, subject to the committee's approval.",
    ),
    paraphrase(
      "ought-to",
      "buses",
      "Passengers ought to give up priority seats to wheelchair users.",
    ),
  ],
};

const CHINESE: NearCopySet = {
  language: "zh-CN",
  documents: [
    {
      key: "gym",
      file: "苇塘社区健身中心会员须知.md",
      title: "苇塘社区健身中心会员须知",
      clauses: [
        "健身中心每月公布一次团体课程表。",
        "会员必须在使用后将器械放回原处。",
        "会员可以带一名访客入场，前提是访客已签署安全告知书。",
        "前台可以为会员代收快递。",
      ],
    },
    {
      key: "school",
      file: "松岭小学家长手册.md",
      title: "松岭小学家长手册",
      clauses: [
        "学校每周向家长发送一次校园简报。",
        "学生应该每天自带水杯。",
        "学生只有在家长书面同意后，才可以在午休时离开校园。",
        "家长须在孩子缺课当天上午告知班主任。",
      ],
    },
    {
      key: "software",
      file: "云杉软件许可条款.md",
      title: "云杉软件许可条款",
      clauses: [
        "许可费按年开具发票。",
        "客户应当在发现安全漏洞后立即通知云杉公司。",
        "客户可以在第二台电脑上安装本软件，前提是两台电脑由同一人使用。",
        "云杉公司在书面通知客户后，可以暂停许可。",
      ],
    },
    {
      key: "estate",
      file: "白鹭湾小区物业管理规约.md",
      title: "白鹭湾小区物业管理规约",
      clauses: [
        "物业公司每季度公示一次公共收支情况。",
        "业主不得在楼道内堆放杂物。",
        "业主经物业公司批准后，可以在露台搭建遮阳棚。",
        "物业公司可以为业主代管钥匙。",
      ],
    },
    {
      key: "library",
      file: "临河图书馆借阅规则.md",
      title: "临河图书馆借阅规则",
      clauses: [
        "读者每次最多可借六本书。",
        "工具书必须当天归还。",
        "除非该书已被其他读者预约，读者可以在网上续借。",
        "图书馆每周更新一次新书推荐。",
      ],
    },
    {
      key: "buses",
      file: "东川公交乘车守则.md",
      title: "东川公交乘车守则",
      clauses: [
        "年票按财政年度计算有效期。",
        "乘客应该给轮椅乘客让出爱心专座。",
        "司机可以拒载醉酒乘客。",
        "儿童由购票成人陪同时可以免费乘车。",
      ],
    },
    {
      key: "gallery",
      file: "鹿鸣美术馆借展协议.md",
      title: "鹿鸣美术馆借展协议",
      clauses: [
        "借展方必须将画作陈列在避免阳光直射的位置。",
        "观众不得拍摄该画作。",
        "除非借展方提前终止借展，美术馆将自费取回画作。",
        "每次借展开始和结束时各进行一次品相检查。",
      ],
    },
    {
      key: "garden",
      file: "北坡社区菜园章程.md",
      title: "北坡社区菜园章程",
      clauses: [
        "承包户每年缴纳用水费人民币三百元。",
        "管理委员会每月检查一次各地块。",
        "承包户经管理委员会同意后，可以饲养鸡。",
        "承包户应当保持地块旁的小路畅通。",
      ],
    },
    {
      key: "coworking",
      file: "枫桥共享办公空间守则.md",
      title: "枫桥共享办公空间守则",
      clauses: [
        "会议室费用按自然月结算。",
        "会议室每小时收费人民币八十元。",
        "会员可以带访客入内，除非活动区已被包场。",
        "会员不得在电话间过夜存放物品。",
      ],
    },
  ],
  cases: [
    period("week-for-month", "gym", "健身中心每周公布一次团体课程表。"),
    period("month-for-week", "school", "学校每月向家长发送一次校园简报。"),
    period("month-for-year", "software", "许可费按月开具发票。"),
    period("month-for-quarter", "estate", "物业公司每月公示一次公共收支情况。"),
    period("day-for-week", "library", "图书馆每天更新一次新书推荐。"),
    period("calendar-for-fiscal", "buses", "年票按自然年度计算有效期。"),
    period("year-for-month", "garden", "管理委员会每年检查一次各地块。"),
    period("month-for-year-figure", "garden", "承包户每月缴纳用水费人民币三百元。"),
    period("week-for-calendar-month", "coworking", "会议室费用按周结算。"),
    period("day-for-hour", "coworking", "会议室每天收费人民币八十元。"),
    duty("should-for-must", "gym", "会员应该在使用后将器械放回原处。"),
    duty("must-for-may", "gym", "前台必须为会员代收快递。"),
    duty("must-for-should", "school", "学生必须每天自带水杯。"),
    duty("may-for-shall", "software", "客户可以在发现安全漏洞后立即通知云杉公司。"),
    duty("shall-for-may", "estate", "物业公司应当为业主代管钥匙。"),
    duty("may-for-must", "library", "工具书可以当天归还。"),
    duty("must-for-should-seats", "buses", "乘客必须给轮椅乘客让出爱心专座。"),
    duty("must-for-may-refuse", "buses", "司机必须拒载醉酒乘客。"),
    duty("advice-for-prohibition", "gallery", "观众最好不要拍摄该画作。"),
    condition("provided-signed", "gym", "会员可以带一名访客入场。"),
    condition("only-with-consent", "school", "学生可以在午休时离开校园。"),
    condition("provided-same-person", "software", "客户可以在第二台电脑上安装本软件。"),
    condition("after-written-notice", "software", "云杉公司可以暂停许可。"),
    condition("after-approval", "estate", "业主可以在露台搭建遮阳棚。"),
    condition("unless-reserved", "library", "读者可以在网上续借。"),
    condition("unless-ended-early", "gallery", "美术馆将自费取回画作。"),
    condition("after-consent", "garden", "承包户可以饲养鸡。"),
    condition("unless-booked", "coworking", "会员可以带访客入内。"),
    copy("six-books", "library", "读者每次最多可借六本书。"),
    paraphrase("monthly", "gym", "健身中心按月公布团体课程表。"),
    paraphrase("xu-for-bixu", "gym", "会员使用器械后须放回原处。"),
    paraphrase(
      "only-with-consent-kept",
      "school",
      "学生须经家长书面同意，才可以在午休时离开校园。",
    ),
    paraphrase("once-a-year", "software", "许可费每年开一次发票。"),
    paraphrase("bixu-for-yingdang", "software", "客户发现安全漏洞后必须立即通知云杉公司。"),
    copy("no-clutter", "estate", "业主不得在楼道内堆放杂物。"),
    paraphrase("jinzhi-for-bude", "gallery", "观众禁止拍摄该画作。"),
    copy("hens-consent", "garden", "承包户经管理委员会同意后，可以饲养鸡。"),
    paraphrase("yearly-figure", "garden", "承包户的用水费为每年人民币三百元。"),
    copy("children-free", "buses", "儿童由购票成人陪同时可以免费乘车。"),
    paraphrase("youquan-for-keyi", "buses", "司机有权拒载醉酒乘客。"),
    paraphrase("unless-booked-kept", "coworking", "除非活动区已被包场，会员都可以带访客入内。"),
    copy("hourly-rate", "coworking", "会议室每小时收费人民币八十元。"),
  ],
};

export const NEAR_COPY_SETS: readonly NearCopySet[] = [ENGLISH, CHINESE];
