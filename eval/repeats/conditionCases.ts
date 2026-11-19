/**
 * Held-out pairs for what a Document attaches to what it states (#3390): a tenancy and a market's
 * rules in each language, invented for the evaluation. Each pair is one rule written twice: in
 * `…-conditions` without the condition, limit, exception, party or period the Document attaches to
 * it, which says more than the Document and is never Supported; in `…-conditions-kept` with it, in
 * other words, which is Supported. The two halves are Notes of their own, so a kept sentence is
 * never above its twin as context. Written before any change to the check's instructions was run;
 * none is an example in them, nor a sentence of the other sets.
 *
 * - A condition dropped: the cat, of the Tenant by name; the late rent, of the Tenant.
 * - A limit or an exception dropped: ending early before the first year is out; parking on the
 *   first Saturday of the month.
 * - Another party: the covered hall, of every trader where the rules say it of some; the bicycle
 *   store, of the Guarantor by name where the tenancy says it of the Tenant.
 * - A period dropped: the Sunday trial; the summer hours.
 */
import type { LibraryDocument, RepeatSentence, RepeatSet } from "./cases";

const sentencesOf =
  (kind: RepeatSentence["kind"], expected: RepeatSentence["expected"]) =>
  (list: readonly (readonly [string, string])[]): RepeatSentence[] =>
    list.map(([key, text]) => ({ key, kind, expected, text }));

const dropped = sentencesOf("near-miss", "unsupported");
const kept = sentencesOf("paraphrase", "supported");

export const CONDITION_SETS_OF = {
  en: ["en-conditions", "en-conditions-kept"],
  zh: ["zh-conditions", "zh-conditions-kept"],
} as const;

export const CONDITION_DOCUMENTS: readonly LibraryDocument[] = [
  {
    language: "en",
    file: "Tenancy Agreement - Flat 3 Corran House.pdf",
    onlyFor: CONDITION_SETS_OF.en,
    pages: [
      {
        lines: [
          "TENANCY AGREEMENT",
          "This agreement is made between Ashgrove Lettings Ltd (the Landlord) and Ilse Varga (the Tenant).",
          "Bruno Kessel signs it as Guarantor.",
          "1. The flat",
          "The Landlord lets Flat 3, Corran House, to the Tenant from 1 March 2026 for two years.",
          "2. Rent",
          "The rent is 1,150 pounds a month, paid by standing order on the first day of each month.",
          "If the rent is paid more than 14 days late, the Tenant pays interest of 3% a year on the late amount.",
          "3. Pets",
          "The Tenant may keep one cat in the flat, provided the Landlord has given written consent first.",
          "4. Storage",
          "The Tenant may use the bicycle store in the basement.",
          "5. Ending early",
          "The Tenant may end this agreement early by giving two months' notice, but not before 1 March 2027.",
          "6. Guarantor",
          "The Guarantor pays any rent the Tenant has not paid within 30 days of the due date.",
        ],
      },
    ],
  },
  {
    language: "en",
    file: "Saltings Street Market - Rules for Traders 2026.pdf",
    onlyFor: CONDITION_SETS_OF.en,
    pages: [
      {
        lines: [
          "SALTINGS STREET MARKET - RULES FOR TRADERS 2026",
          "These rules are issued by the Market Office and apply to every trader with a pitch.",
          "1. Opening days",
          "The Market is open to traders on Fridays and Saturdays.",
          "As a trial, from 1 May to 31 October 2026, the Market is also open to traders on Sundays.",
          "In June and July, traders may stay at their pitches until 20:00.",
          "2. The covered hall",
          "Traders who sell only food they have grown or made themselves may use the covered hall.",
          "3. Vehicles",
          "Traders may park one vehicle behind their pitch, except on the first Saturday of each month, when the car park is closed.",
          "4. Waste",
          "Traders must take their waste to the recycling point before they leave.",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "房屋租赁合同 - 松岩苑302室.pdf",
    onlyFor: CONDITION_SETS_OF.zh,
    pages: [
      {
        chineseLines: [
          "房屋租赁合同",
          "出租方（甲方）：松岩置业有限公司　承租方（乙方）：沈语桐　担保人：柯一鸣",
          "第一条　甲方将松岩苑6栋302室出租给乙方，租期自2026年3月1日起共两年。",
          "第二条　月租金为人民币4,800元，乙方于每月1日通过银行转账支付。",
          "乙方逾期支付租金超过15日的，按逾期金额每日万分之五支付违约金。",
          "第三条　经甲方书面同意后，乙方可在房屋内饲养一只猫。",
          "第四条　乙方可使用地下室的自行车存放间。",
          "第五条　租期满一年后，乙方提前两个月书面通知甲方，可提前解除本合同。",
          "第六条　乙方逾期30日仍未支付的租金，由担保人代为支付。",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "柳湾夜市摊主管理规定（2026年）.pdf",
    onlyFor: CONDITION_SETS_OF.zh,
    pages: [
      {
        chineseLines: [
          "柳湾夜市摊主管理规定（2026年）",
          "本规定由夜市管理办公室制定，适用于所有持证摊主。",
          "一、营业时间：夜市每周五、周六晚对摊主开放。",
          "2026年5月1日至10月31日试行期间，夜市周日晚也对摊主开放。",
          "每年7月和8月，摊主可延长营业至次日凌晨1点。",
          "二、室内展棚：仅销售自制手工艺品的摊主可使用室内展棚。",
          "三、车辆：摊主可在摊位后方停放一辆车，但每月第一个周六停车场关闭，当日除外。",
          "四、卫生：摊主须在收摊后30分钟内清理摊位。",
        ],
      },
    ],
  },
];

export const CONDITION_SETS: readonly RepeatSet[] = [
  {
    id: "en-conditions",
    language: "en",
    mind: "Flat and market notes",
    sentences: dropped([
      ["cat", "Ilse Varga may keep a cat in her flat at Corran House."],
      ["late-rent", "The Tenant of Flat 3, Corran House, pays interest of 3% a year on the rent."],
      [
        "end-early",
        "The Tenant of Flat 3, Corran House, can end the tenancy on two months' notice.",
      ],
      ["parking", "Traders at Saltings Street Market may park one vehicle behind their pitch."],
      ["hall", "Traders at Saltings Street Market may use the covered hall."],
      ["bicycles", "Bruno Kessel may use the bicycle store in the basement of Corran House."],
      ["sundays", "Saltings Street Market is open to traders on Sundays."],
      ["late-hours", "Traders at Saltings Street Market may stay at their pitches until 20:00."],
    ]),
  },
  {
    id: "en-conditions-kept",
    language: "en",
    mind: "Flat and market notes, in full",
    sentences: kept([
      [
        "cat",
        "Ilse Varga may keep one cat in her flat at Corran House once the Landlord has agreed in writing.",
      ],
      [
        "late-rent",
        "When the rent for Flat 3, Corran House, is more than 14 days late, the Tenant pays interest of 3% a year on the amount overdue.",
      ],
      [
        "end-early",
        "From 1 March 2027 the Tenant of Flat 3, Corran House, can end the tenancy early on two months' notice.",
      ],
      [
        "parking",
        "Traders at Saltings Street Market may park a vehicle behind their pitch, but not on the first Saturday of the month.",
      ],
      [
        "hall",
        "At Saltings Street Market, traders who sell only food they grew or made themselves may use the covered hall.",
      ],
      ["bicycles", "Ilse Varga may use the bicycle store in the basement of Corran House."],
      [
        "sundays",
        "From 1 May to 31 October 2026, as a trial, Saltings Street Market is also open to traders on Sundays.",
      ],
      [
        "late-hours",
        "In June and July, traders at Saltings Street Market may stay at their pitches until 20:00.",
      ],
    ]),
  },
  {
    id: "zh-conditions",
    language: "zh-CN",
    mind: "租房与夜市笔记",
    sentences: dropped([
      ["cat", "沈语桐可以在松岩苑302室养一只猫。"],
      ["late-rent", "松岩苑302室的租客逾期付租，须按逾期金额每日万分之五支付违约金。"],
      ["end-early", "松岩苑302室的租客提前两个月书面通知，即可提前解除租赁合同。"],
      ["parking", "柳湾夜市的摊主可在摊位后方停放一辆车。"],
      ["hall", "柳湾夜市的摊主可以使用室内展棚。"],
      ["bicycles", "柯一鸣可以使用松岩苑地下室的自行车存放间。"],
      ["sundays", "柳湾夜市周日晚对摊主开放。"],
      ["late-hours", "柳湾夜市的摊主可延长营业至次日凌晨1点。"],
    ]),
  },
  {
    id: "zh-conditions-kept",
    language: "zh-CN",
    mind: "租房与夜市笔记（完整）",
    sentences: kept([
      ["cat", "经甲方书面同意，沈语桐可以在松岩苑302室养一只猫。"],
      ["late-rent", "松岩苑302室的租客逾期付租超过15日的，须按逾期金额每日万分之五支付违约金。"],
      ["end-early", "租期满一年后，松岩苑302室的租客提前两个月书面通知，即可提前解除租赁合同。"],
      ["parking", "柳湾夜市的摊主可在摊位后方停放一辆车，每月第一个周六除外。"],
      ["hall", "柳湾夜市只卖自制手工艺品的摊主可以使用室内展棚。"],
      ["bicycles", "沈语桐可以使用松岩苑地下室的自行车存放间。"],
      ["sundays", "2026年5月1日至10月31日试行期间，柳湾夜市周日晚也对摊主开放。"],
      ["late-hours", "每年7、8月，柳湾夜市的摊主可延长营业至次日凌晨1点。"],
    ]),
  },
];
