/**
 * Changes to the held-out near copies, written 2026-11-04 after the first runs on `main` and an
 * audit of their labels, before any change to the check (#1766, #1708, #1765). The three earlier
 * files are not edited: a case this file withdraws stays there and is no longer run.
 *
 * - Withdrawn, with what takes their place: the English positive "Ostrander invoices the licence
 *   fee once a year." names who invoices where its clause names nobody; three English decoys swap
 *   in a weaker frequency ("every term" for every week, "each year" for each month), which stays
 *   true in plain English. Their places take the passive and "once a …".
 * - Added: the fifth near copy reported on #1708 ("Quillowgarth replaces any machine that breaks
 *   down." against "…, unless the Hirer caused the fault."), and in each language the families the
 *   first files lacked: a condition the clause doesn't have, a condition changed (another trigger
 *   or approver, "unless" turned into "only if", the condition negated), a dropped condition in
 *   other words, and positives that keep a duty or condition on another act, state the condition
 *   in other words or order, or put the duty in other words.
 * - The ruling on #1708 (2026-11-04): a condition that limits when a right or duty applies (notice
 *   first, consent, agreement in advance, only if, unless, except, subject to) is part of the
 *   claim, and a sentence that drops one is Unsupported; procedure that doesn't limit the right is
 *   not a condition. So the notice decoys stay decoys.
 * - Copied as text from the held-out set of #2501, as recall probes: its four true sentences of two
 *   parts (a wrong first part, a probe its own one-line Document states), each on that Document.
 * - In this set 应当 is a duty (as 必须 is) and 应该 is advice, as in drafting; 得 (děi) is a duty.
 *
 * The bars as amended, fixed before the first run of this file: a decoy that ends Not checked is
 * counted apart from the decoys, by family, and may be Not checked in at most one check more than
 * on `main`; no positive item is Supported in fewer of its 3 Haiku 5.5 checks than on `main` less 1,
 * beside the overall bar of each file; a two-part case whose probe ends without a part counts as
 * Not checked. The added cases are measured on the check before the fix first.
 *
 * Edited once, on 2026-11-04 after its first runs: the invented hire company of the fifth near copy
 * is renamed, as its first name was a real hire firm's; that case is measured on `main` again first.
 */
import type { NearCopyCase, NearCopyDocument, NearCopyKind } from "./nearCopyHeldout.cases";

/** A case of this file: `twoPart` gives the wrong part and the probe of a sentence of two parts. */
export interface AmendedCase extends Omit<NearCopyCase, "kind"> {
  kind: NearCopyKind | "added-condition" | "changed-condition" | "duty-elsewhere";
  twoPart?: readonly [string, string];
  /** A near copy reported on an issue: a known miss, outside the held-out bars. */
  reported?: true;
}

export interface AmendedSet {
  language: "en" | "zh-CN";
  /** Keys of the earlier files' cases no longer run; a two-part case's key starts "walk-". */
  withdrawn: readonly string[];
  documents: readonly NearCopyDocument[];
  cases: readonly AmendedCase[];
}

const of =
  (kind: AmendedCase["kind"], decoy: boolean) =>
  (key: string, document: string, text: string, twoPart?: readonly [string, string]) => ({
    key,
    kind,
    document,
    text,
    decoy,
    ...(twoPart && { twoPart }),
  });

export const AMENDED_SETS: readonly AmendedSet[] = [
  {
    language: "en",
    withdrawn: ["once-a-year", "term-for-week", "year-for-month", "walk-inspected-yearly"],
    documents: [
      {
        key: "tennis",
        file: "Kingsmere Tennis Club booking rules.md",
        title: "Kingsmere Tennis Club: booking rules",
        clauses: [
          "Members may book a court twice a week and must cancel unused bookings by noon.",
          "Up to two spare rackets may be borrowed from the desk, and each must be returned the same day.",
          "Members may store a bicycle in the shed, but must register it at the desk first.",
        ],
      },
      {
        key: "churn",
        file: "Churn note.md",
        title: "Churn note",
        clauses: ["Customer churn fell to 4.2 per cent after the onboarding redesign."],
      },
      {
        key: "harbour",
        file: "Harbour office note.md",
        title: "Harbour office note",
        clauses: ["The harbour office publishes the times of high water every year."],
      },
    ],
    cases: [
      of("paraphrase", false)(
        "invoiced-once-a-year",
        "software",
        "The licence fee is invoiced once a year.",
      ),
      of("period", true)(
        "once-a-term-for-week",
        "school",
        "The school sends a newsletter home once a term.",
      ),
      of("period", true)(
        "once-a-year-for-month",
        "allotments",
        "The committee inspects every plot once a year.",
      ),
      of("period", true)(
        "walk-inspected-once-a-year",
        "allotments",
        "Plot holders pay a water charge of 50 pounds per annum, and the committee inspects every plot once a year.",
        [
          "Plot holders pay a water charge of 50 pounds per annum",
          "the committee inspects every plot once a year",
        ],
      ),
      {
        ...of("condition", true)(
          "confirmed-unless-dropped",
          "hire",
          "Quillowgarth replaces any machine that breaks down.",
        ),
        reported: true,
      },
      of("added-condition", true)(
        "fees-paid",
        "library",
        "Members may borrow up to six books at a time if they have paid their annual fee.",
      ),
      of("added-condition", true)(
        "weekdays-only",
        "coworking",
        "The front desk can hold parcels for members only on weekdays.",
      ),
      of("added-condition", true)(
        "online-account",
        "water",
        "Customers may pay their bill by direct debit once they have set up an online account.",
      ),
      of("changed-condition", true)(
        "council-approval",
        "allotments",
        "Plot holders may keep hens, subject to the council's approval.",
      ),
      of("changed-condition", true)(
        "parent-on-bank",
        "rowing",
        "Juniors may take out a single scull only when a parent is on the bank.",
      ),
      of("changed-condition", true)(
        "only-if-booked",
        "coworking",
        "Members may bring a guest only if the event space is booked for a private function.",
      ),
      of("changed-condition", true)(
        "only-if-reserved-negated",
        "library",
        "A member may renew a loan online only if another member has reserved the book.",
      ),
      of("condition", true)(
        "free-to-bring-guests",
        "coworking",
        "Members are free to bring guests.",
      ),
      of("condition", true)(
        "allowed-to-take-scull",
        "rowing",
        "Juniors are allowed to take a single scull out.",
      ),
      of("condition", true)("hens-can-be-kept", "allotments", "Hens can be kept by plot holders."),
      of("duty-elsewhere", false)("book-twice", "tennis", "Members may book a court twice a week."),
      of("duty-elsewhere", false)(
        "spare-rackets",
        "tennis",
        "Up to two spare rackets may be borrowed from the desk.",
      ),
      of("duty-elsewhere", false)(
        "bicycle-registered",
        "tennis",
        "Members may store a bicycle in the shed once they have registered it at the desk.",
      ),
      of("paraphrase", false)(
        "if-coach-first",
        "rowing",
        "If a coach is on the bank, juniors may take out a single scull.",
      ),
      of("paraphrase", false)(
        "not-if-reserved",
        "library",
        "A member can renew a loan online, but not if another member has reserved the book.",
      ),
      of("paraphrase", false)(
        "unless-first",
        "coworking",
        "Unless the event space is booked for a private function, members may bring a guest.",
      ),
      of("paraphrase", false)(
        "have-to",
        "library",
        "Members have to return reference books on the day they borrow them.",
      ),
      of("paraphrase", false)(
        "obliged-to",
        "water",
        "Customers are obliged to report a leak on their side of the meter.",
      ),
      of("paraphrase", false)(
        "need-to",
        "allotments",
        "Plot holders need to keep the paths beside their plots clear.",
      ),
      of("paraphrase", false)(
        "entitled-to",
        "buses",
        "A driver is entitled to refuse to carry a passenger who is drunk.",
      ),
      of("paraphrase", false)(
        "allowed-to",
        "library",
        "Members are allowed to borrow up to six books at a time.",
      ),
      of("paraphrase", false)(
        "prohibited-from",
        "gallery",
        "Visitors are prohibited from photographing the painting.",
      ),
      of("period", false)(
        "part-judge-churn-timing",
        "churn",
        "Customer churn fell to 3.9 per cent after the onboarding redesign.",
        ["Customer churn fell to 3.9 per cent", "after the onboarding redesign"],
      ),
      of("period", false)(
        "part-judge-every-year",
        "harbour",
        "The harbour office publishes the tide tables every year.",
        ["The harbour office publishes the tide tables", "every year"],
      ),
    ],
  },
  {
    language: "zh-CN",
    withdrawn: [],
    documents: [
      {
        key: "tennis",
        file: "鹭洲网球俱乐部订场规则.md",
        title: "鹭洲网球俱乐部订场规则",
        clauses: [
          "会员每周可预订两次球场，未使用的预订须在中午前取消。",
          "前台最多可借出两支备用球拍，每支须于当天归还。",
          "会员可在棚内存放自行车，需事先在前台登记。",
        ],
      },
      {
        key: "churn",
        file: "客户流失说明.md",
        title: "客户流失说明",
        clauses: ["客户流失率在 2025 年第 2 季度降至 4.2%，时点在引导流程重新设计之后。"],
      },
      {
        key: "harbour",
        file: "港口办公室说明.md",
        title: "港口办公室说明",
        clauses: ["港口办公室每年公布一次高潮时间。"],
      },
    ],
    cases: [
      of("added-condition", true)(
        "card-one-year",
        "library",
        "读者办理借书证满一年后，每次最多可借六本书。",
      ),
      of("added-condition", true)("weekdays-only", "gym", "前台只有在工作日才可以为会员代收快递。"),
      of("added-condition", true)(
        "dispatcher-consent",
        "buses",
        "司机经调度员同意后，可以拒载醉酒乘客。",
      ),
      of("changed-condition", true)(
        "residents-committee",
        "estate",
        "业主经业主委员会批准后，可以在露台搭建遮阳棚。",
      ),
      of("changed-condition", true)(
        "fee-paid",
        "gym",
        "会员可以带一名访客入场，前提是访客已缴纳入场费。",
      ),
      of("changed-condition", true)(
        "only-if-booked",
        "coworking",
        "只有活动区已被包场时，会员才可以带访客入内。",
      ),
      of("changed-condition", true)(
        "only-if-reserved-negated",
        "library",
        "只有该书已被其他读者预约，读者才可以在网上续借。",
      ),
      of("condition", true)("renew-by-network", "library", "读者可以通过网络办理续借。"),
      of("condition", true)("bring-a-friend", "gym", "会员可以带朋友进场。"),
      of("condition", true)("can-keep-chickens", "garden", "承包户能养鸡。"),
      of("duty-elsewhere", false)("book-twice", "tennis", "会员每周可预订两次球场。"),
      of("duty-elsewhere", false)("spare-rackets", "tennis", "前台最多可借出两支备用球拍。"),
      of("duty-elsewhere", false)(
        "bicycle-registered",
        "tennis",
        "会员可在棚内存放自行车，需事先在前台登记。",
      ),
      of("paraphrase", false)(
        "consent-first",
        "school",
        "经家长书面同意后，学生才可以在午休时离开校园。",
      ),
      of("paraphrase", false)(
        "when-not-booked",
        "coworking",
        "活动区未被包场时，会员可以带访客入内。",
      ),
      of("paraphrase", false)(
        "same-person-first",
        "software",
        "两台电脑由同一人使用的，客户可以在第二台电脑上安装本软件。",
      ),
      of("paraphrase", false)("xu", "gym", "会员使用器械后需放回原处。"),
      of("paraphrase", false)("ying", "software", "客户发现安全漏洞后应立即通知云杉公司。"),
      of("paraphrase", false)("you-yiwu", "garden", "承包户有义务保持地块旁的小路畅通。"),
      of("paraphrase", false)("zhunxu", "buses", "儿童由购票成人陪同时准许免费乘车。"),
      of("paraphrase", false)("yanjin", "estate", "楼道内严禁业主堆放杂物。"),
      of("paraphrase", false)("buzhun", "gallery", "观众不准拍摄该画作。"),
      of("paraphrase", false)("dei", "library", "工具书得当天归还。"),
      of("period", false)(
        "part-judge-churn-timing",
        "churn",
        "客户流失率在 2025 年第 2 季度降至 3.9%，时点在引导流程重新设计之后。",
        ["客户流失率在 2025 年第 2 季度降至 3.9%", "时点在引导流程重新设计之后"],
      ),
      of("period", false)("part-judge-every-year", "harbour", "财务部每年公布一次高潮时间。", [
        "财务部",
        "每年公布一次高潮时间",
      ]),
    ],
  },
];
