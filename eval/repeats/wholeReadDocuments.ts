/**
 * The long agreements `npm run eval:whole-read` reads (README.md): a residential lease with its
 * building services, invented for the evaluation, in English and in Chinese, about 40,000 and
 * 120,000 tokens long. Three clauses each settle sentences of ./wholeReadCases: one early, one in
 * the middle and one late. Each is worded unlike the sentences, and clauses that share their words
 * (other deposits, other 15 kg and 3.5% limits) come before it, so a search ranks it below what a
 * check is handed. The rest is clauses made from a fixed seed, so a run reads the same text.
 */
import type { PdfPage } from "../../tests/helpers/pdf";

export type WholeReadLanguage = "en" | "zh-CN";
export type WholeReadSize = 40 | 120;

/** Where a clause sits, as a share of the agreement's clauses. */
export const PLACES = { early: 0.06, middle: 0.5, late: 0.94 } as const;
export type Place = keyof typeof PLACES;

interface Words {
  title: readonly string[];
  heading(section: number): string;
  clause(next: () => number, number: string): string;
  targets: Readonly<Record<Place, (number: string) => string>>;
  /** Clauses that share each target's sentences' words, about other things: one in every few clauses. */
  lookalikes: Readonly<Record<Place, (next: () => number, number: string) => string>>;
  /** Characters a line holds, and lines a page. */
  line: number;
  lines: number;
  /** About how many tokens a clause is. */
  clauseTokens: number;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const pick = <T>(next: () => number, from: readonly T[]): T =>
  from[Math.floor(next() * from.length)] as T;

const EN_PROVIDERS = [
  "Managing Agent",
  "Landlord's surveyor",
  "building contractor",
  "Facilities Manager",
  "lift engineer",
  "cleaning contractor",
];
const EN_ASSETS = [
  "fire alarm panel",
  "emergency lighting",
  "lift car",
  "entry phone system",
  "roof drains",
  "water booster pumps",
  "bin store ventilation",
  "door closers",
  "CCTV cameras",
  "sprinkler valves",
  "communal boiler",
  "gutters",
];
const EN_AREAS = [
  "the east stairwell",
  "the basement car park",
  "the roof terrace",
  "the cycle store",
  "the refuse store",
  "the ground-floor lobby",
  "the plant room",
  "the courtyard garden",
  "the first-floor corridor",
  "the laundry room",
  "the visitors' parking bays",
  "the post room",
];
const EN_RECIPIENTS = [
  "Tenant",
  "residents' association",
  "Landlord",
  "building insurer",
  "fire safety officer",
];
const EN_RECORDS = [
  "maintenance logs",
  "inspection certificates",
  "insurance schedules",
  "cleaning rotas",
  "contractor invoices",
  "risk assessments",
];
const EN_SERVICES = [
  "window cleaning",
  "landscaping",
  "out-of-hours security",
  "lift maintenance",
  "gutter clearing",
  "fire door checks",
  "communal electricity",
];
const EN_ITEMS = [
  "furniture",
  "bicycles",
  "refuse sacks",
  "building materials",
  "garden waste",
  "packaging",
];
const EN_FREQUENCIES = [
  "every month",
  "every quarter",
  "twice a year",
  "every six weeks",
  "every two months",
];
const EN_HEADINGS = [
  "Maintenance of the shared parts",
  "Inspections and reports",
  "Service charge",
  "Access and security",
  "Cleaning and lighting",
  "Records and information",
  "Contractors",
  "Use of the shared parts",
];

const ENGLISH: Words = {
  title: [
    "RESIDENTIAL LEASE AND BUILDING SERVICES AGREEMENT",
    "Harbourside Court, Flat 12",
    "This agreement is made between Calder Estates Ltd (the Landlord) and Priya Raman (the Tenant).",
    "It sets out the tenancy of the Premises and the services the Landlord provides to the building.",
  ],
  heading: (section) => `${section}. ${EN_HEADINGS[(section - 1) % EN_HEADINGS.length]}`,
  clause(next, number) {
    const provider = pick(next, EN_PROVIDERS);
    const asset = pick(next, EN_ASSETS);
    const area = pick(next, EN_AREAS);
    const recipient = pick(next, EN_RECIPIENTS);
    const days = pick(next, [3, 5, 7, 10, 14]);
    const hours = pick(next, [4, 12, 24, 48]);
    switch (Math.floor(next() * 8)) {
      case 0:
        return `${number} The ${provider} shall inspect the ${asset} serving ${area} ${pick(next, EN_FREQUENCIES)} and shall give the ${recipient} a written report within ${days} working days of each visit.`;
      case 1:
        return `${number} If the ${asset} in ${area} fails, the ${provider} shall attend within ${hours} hours of being told of it and shall keep a record of the fault, the work done and the parts replaced.`;
      case 2:
        return `${number} The cost of ${pick(next, EN_SERVICES)} for ${area} is shared among the flats in proportion to their floor area and is shown as a separate line in the annual statement of account.`;
      case 3:
        return `${number} The ${recipient} may ask the ${provider} for copies of the ${pick(next, EN_RECORDS)} relating to ${area}, and the ${provider} shall supply them within ${days} working days without charge.`;
      case 4:
        return `${number} No ${pick(next, EN_ITEMS)} may be left in ${area} for more than ${hours} hours; the ${provider} may remove anything left there after giving ${pick(next, ["24 hours'", "48 hours'", "seven days'"])} notice by email.`;
      case 5:
        return `${number} The ${provider} shall keep ${area} clean and lit, and shall replace failed lamps in ${area} within ${days} days of a fault being reported through the residents' portal.`;
      case 6:
        return `${number} Access to ${area} is by fob between ${pick(next, ["7:00", "7:30", "8:00"])} and ${pick(next, ["20:00", "21:00", "22:00"])}; outside those hours the ${recipient} must ask the ${provider} at least ${hours} hours in advance.`;
      default:
        return `${number} The ${provider} shall test the ${asset} in ${area} at least once every ${pick(next, [3, 6, 12])} months and keep the certificate on the building file for ${pick(next, [3, 5, 6])} years.`;
    }
  },
  targets: {
    early: (number) =>
      `${number} The Tenant may house a single companion animal of up to fifteen kilograms; any further one requires the Landlord's prior written approval.`,
    middle: (number) =>
      `${number} The Rent may be revised on each anniversary of the Commencement Date, by no more than three and a half per cent of the amount then payable.`,
    late: (number) =>
      `${number} The Landlord shall hand back the sum lodged at the start of the tenancy, less amounts properly withheld for damage or arrears, within twenty-one days after the Tenant gives up possession.`,
  },
  lookalikes: {
    early: (next, number) =>
      pick(next, [
        `${number} Parcels weighing more than 15 kg are not accepted by the post room and must be collected from the courier's depot.`,
        `${number} The pet relief area in the courtyard garden is cleaned every morning by the cleaning contractor.`,
        `${number} Pet food deliveries are left in the post room and must be collected within 24 hours.`,
        `${number} Bags of garden waste weighing more than 15 kg must be taken to the green waste bin by the tenant who filled them.`,
        `${number} The pet washing tap in the cycle store is turned off between November and March to protect the pipes.`,
        `${number} No single item weighing more than 15 kg may be carried in the lift without a trolley.`,
        `${number} Animals other than assistance dogs are not allowed in the laundry room or on the roof terrace.`,
        `${number} The cleaning contractor removes animal waste from the courtyard garden twice a day.`,
      ]),
    middle: (next, number) =>
      pick(next, [
        `${number} The rent for a parking space is reviewed every year, and any rise is notified to the tenant ${pick(next, [14, 28, 30])} days before it applies.`,
        `${number} The rent for a storage locker is reviewed each April and may rise by up to ${pick(next, [2, 3, 4])} per cent at each review.`,
        `${number} The rent for the guest suite is set by the Managing Agent each year and shown in the residents' handbook.`,
        `${number} The service charge budget may not rise by more than ${pick(next, ["3.5%", "4%", "5%"])} in a year without a residents' meeting.`,
        `${number} The parking permit fee is reviewed each year and may rise by up to 3.5 per cent at each review.`,
        `${number} Rent for a bicycle locker is paid quarterly in advance and reviewed once a year by the Managing Agent.`,
        `${number} The rent for an electric vehicle charging bay is revised on each anniversary of its allocation.`,
        `${number} Any increase in the rent for a storage locker takes effect on the first day of the next quarter.`,
        `${number} Rent paid late carries interest at 3.5 per cent above the base rate until it is paid.`,
      ]),
    late: (next, number) =>
      pick(next, [
        `${number} The key fob deposit of 40 pounds is refunded within 21 days after the fob is handed back to the concierge.`,
        `${number} The parking bay deposit is repaid within 21 days after the tenant gives up the bay and returns its permit.`,
        `${number} The deposit for the guest suite is returned within ${pick(next, [7, 14, 21])} days after the booking ends, less the cost of any cleaning.`,
        `${number} A tenant moving out must return every key and fob, and the Managing Agent records the meter readings on that day.`,
        `${number} The storage locker deposit is returned within ${pick(next, [14, 21, 28])} days after the locker is emptied and its key returned.`,
        `${number} The deposit paid for a removal lift booking is returned within 21 days after the move, unless the lift was damaged.`,
        `${number} The security bond for a contractor's access pass is repaid within 21 days after the work ends.`,
      ]),
  },
  line: 92,
  lines: 48,
  clauseTokens: 42,
};

const ZH_PROVIDERS = [
  "物业管理公司",
  "出租方委托的测量师",
  "维修承包商",
  "设施经理",
  "电梯维保工程师",
  "保洁承包商",
];
const ZH_ASSETS = [
  "火灾报警主机",
  "应急照明",
  "电梯轿厢",
  "楼宇对讲系统",
  "屋面排水口",
  "二次供水加压泵",
  "垃圾房通风设备",
  "闭门器",
  "监控摄像头",
  "喷淋阀门",
  "公共锅炉",
  "天沟",
];
const ZH_AREAS = [
  "东侧楼梯间",
  "地下停车场",
  "屋顶露台",
  "自行车库",
  "垃圾房",
  "一楼大堂",
  "设备间",
  "庭院花园",
  "二楼走廊",
  "洗衣房",
  "访客停车位",
  "收发室",
];
const ZH_RECIPIENTS = ["承租方", "业主委员会", "出租方", "楼宇保险人", "消防安全负责人"];
const ZH_RECORDS = ["维修记录", "检验证书", "保险明细", "保洁排班表", "承包商发票", "风险评估报告"];
const ZH_SERVICES = [
  "外窗清洁",
  "绿化养护",
  "夜间安保",
  "电梯维保",
  "天沟清理",
  "防火门检查",
  "公共用电",
];
const ZH_ITEMS = ["家具", "自行车", "垃圾袋", "建筑材料", "园艺垃圾", "包装材料"];
const ZH_FREQUENCIES = ["每月一次", "每季度一次", "每半年一次", "每六周一次", "每两个月一次"];
const ZH_HEADINGS = [
  "共用部位的维修",
  "检查与报告",
  "物业服务费",
  "出入与安保",
  "保洁与照明",
  "记录与资料",
  "承包商",
  "共用部位的使用",
];

const CHINESE: Words = {
  title: [
    "住宅租赁及楼宇服务合同",
    "海港苑 12 室",
    "本合同由卡尔德置业有限公司（出租方）与王思雨（承租方）订立。",
    "本合同约定房屋的租赁事项，以及出租方为整栋楼宇提供的服务。",
  ],
  heading: (section) => `第${section}条 ${ZH_HEADINGS[(section - 1) % ZH_HEADINGS.length]}`,
  clause(next, number) {
    const provider = pick(next, ZH_PROVIDERS);
    const asset = pick(next, ZH_ASSETS);
    const area = pick(next, ZH_AREAS);
    const recipient = pick(next, ZH_RECIPIENTS);
    const days = pick(next, [3, 5, 7, 10, 14]);
    const hours = pick(next, [4, 12, 24, 48]);
    switch (Math.floor(next() * 8)) {
      case 0:
        return `${number} ${provider}应${pick(next, ZH_FREQUENCIES)}检查服务于${area}的${asset}，并在每次检查后${days}个工作日内向${recipient}提交书面报告。`;
      case 1:
        return `${number} ${area}的${asset}发生故障的，${provider}应在接到通知后${hours}小时内到场，并记录故障情况、所做工作和更换的部件。`;
      case 2:
        return `${number} ${area}的${pick(next, ZH_SERVICES)}费用按各户建筑面积比例分摊，并在年度账目中单列一项。`;
      case 3:
        return `${number} ${recipient}可向${provider}索取与${area}有关的${pick(next, ZH_RECORDS)}复印件，${provider}应在${days}个工作日内免费提供。`;
      case 4:
        return `${number} 任何${pick(next, ZH_ITEMS)}不得在${area}存放超过${hours}小时；${provider}通过电子邮件提前${pick(next, ["二十四小时", "四十八小时", "七天"])}通知后，可清走存放的物品。`;
      case 5:
        return `${number} ${provider}应保持${area}清洁、照明正常，并在住户平台报修后${days}天内更换${area}损坏的灯具。`;
      case 6:
        return `${number} ${area}凭门禁卡在${pick(next, ["七点", "七点半", "八点"])}至${pick(next, ["二十点", "二十一点", "二十二点"])}之间进出；其他时间${recipient}须至少提前${hours}小时向${provider}申请。`;
      default:
        return `${number} ${provider}应至少每${pick(next, [3, 6, 12])}个月对${area}的${asset}进行一次检测，检测证书在楼宇档案中保存${pick(next, [3, 5, 6])}年。`;
    }
  },
  targets: {
    early: (number) =>
      `${number} 承租方可在房屋内饲养伴侣动物一只，体重以十五公斤为限；再多饲养须事先取得出租方书面同意。`,
    middle: (number) =>
      `${number} 于起租日每满一周年时，房屋使用费重新核定一次，每次上浮不得超过当时应付金额的百分之三点五。`,
    late: (number) =>
      `${number} 承租方交还房屋后二十一日内，出租方应返还起租时交存的保证金，但可扣除因损坏或欠费依约应扣的款项。`,
  },
  lookalikes: {
    early: (next, number) =>
      pick(next, [
        `${number} 收发室不代收重量超过15公斤的包裹，此类包裹须到快递网点自取。`,
        `${number} 庭院花园内的宠物便溺区由保洁承包商每天早上清理。`,
        `${number} 宠物食品快递存放在收发室，须在24小时内取走。`,
        `${number} 重量超过15公斤的园艺垃圾袋，须由装袋的住户自行送到绿化垃圾桶。`,
        `${number} 自行车库内的宠物冲洗水龙头在十一月至次年三月关闭，以防管道冻裂。`,
        `${number} 重量超过15公斤的单件物品，不得不用推车而直接搬入电梯。`,
        `${number} 除导盲犬外，任何动物不得进入洗衣房和屋顶露台。`,
        `${number} 保洁承包商每天两次清理庭院花园内的动物粪便。`,
        `${number} 庭院花园的锦鲤池由绿化承包商负责饲养和喂食。`,
      ]),
    middle: (next, number) =>
      pick(next, [
        `${number} 车位租金每年调整一次，调整前${pick(next, [14, 28, 30])}日通知承租方。`,
        `${number} 储物柜租金每年四月调整，每次涨幅不超过${pick(next, [2, 3, 4])}%。`,
        `${number} 访客套房的租金由物业管理公司每年核定，并在住户手册中公布。`,
        `${number} 未经业主大会同意，物业服务费年度预算的涨幅不得超过${pick(next, ["3.5%", "4%", "5%"])}。`,
        `${number} 停车证费用每年调整一次，每次涨幅不超过3.5%。`,
        `${number} 自行车柜租金按季度预付，由物业管理公司每年调整一次。`,
        `${number} 充电车位的租金在每个分配周年日重新核定。`,
        `${number} 储物柜租金的上调自下一季度第一天起生效。`,
        `${number} 逾期支付的租金按基准利率加3.5%计收利息，直至付清。`,
      ]),
    late: (next, number) =>
      pick(next, [
        `${number} 门禁卡押金40元，在门禁卡交还门房后21日内退还。`,
        `${number} 车位押金在承租方退租车位并交回停车证后21日内退还。`,
        `${number} 访客套房押金在预订结束后${pick(next, [7, 14, 21])}日内退还，但扣除保洁费用。`,
        `${number} 承租方退租时须交还全部钥匙和门禁卡，物业管理公司当天记录水电表读数。`,
        `${number} 储物柜押金在储物柜清空并交还钥匙后${pick(next, [14, 21, 28])}日内退还。`,
        `${number} 搬家电梯预约押金在搬家后21日内退还，电梯有损坏的除外。`,
        `${number} 装修保证金在装修验收合格后21日内返还。`,
        `${number} 承包商出入证保证金在施工结束后21日内返还。`,
      ]),
  },
  line: 40,
  lines: 48,
  clauseTokens: 44,
};

/** Lines no longer than `width` characters: at spaces in English, anywhere in Chinese. */
function wrapped(text: string, width: number, chinese: boolean): string[] {
  if (chinese) {
    const lines: string[] = [];
    for (let at = 0; at < text.length; at += width) lines.push(text.slice(at, at + width));
    return lines;
  }
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Words of each target clause no other clause has: whether a Passage handed to the model holds it. */
export const CLAUSE_WORDS: Readonly<Record<WholeReadLanguage, Readonly<Record<Place, string>>>> = {
  en: {
    early: "companion animal of up to fifteen kilograms",
    middle: "by no more than three and a half per cent of the amount then payable",
    late: "sum lodged at the start of the tenancy",
  },
  "zh-CN": { early: "体重以十五公斤为限", middle: "百分之三点五", late: "起租时交存的保证金" },
};

export interface WholeReadDocument {
  language: WholeReadLanguage;
  size: WholeReadSize;
  file: string;
  pages: PdfPage[];
  /** The page each target clause is on. */
  targetPages: Readonly<Record<Place, number>>;
}

export function wholeReadDocument(
  language: WholeReadLanguage,
  size: WholeReadSize,
): WholeReadDocument {
  const words = language === "en" ? ENGLISH : CHINESE;
  const chinese = language === "zh-CN";
  const next = seeded(size * 7919 + (chinese ? 1 : 0));
  const clauses = Math.round((size * 1000) / words.clauseTokens);
  const at = {
    early: Math.round(clauses * PLACES.early),
    middle: Math.round(clauses * PLACES.middle),
    late: Math.round(clauses * PLACES.late),
  };
  const places: readonly Place[] = ["early", "middle", "late"];
  const lines: { text: string; target?: Place }[] = words.title.map((text) => ({ text }));
  let section = 0;
  let item = 0;
  for (let index = 0; index < clauses; index++) {
    if (index % 9 === 0) {
      section++;
      item = 0;
      lines.push({ text: words.heading(section) });
    }
    const number = () => `${section}.${++item}`;
    const target = places.find((place) => at[place] === index);
    // One clause in four is a look-alike, spread over the whole agreement, so a search that
    // ranks by the sentence's words fills its Passages with them.
    const lookalike = index % 4 === 2 ? places[Math.floor(index / 4) % places.length] : undefined;
    if (target) lines.push({ text: words.targets[target](number()), target });
    else if (lookalike) lines.push({ text: words.lookalikes[lookalike](next, number()) });
    else lines.push({ text: words.clause(next, number()) });
  }
  const pages: PdfPage[] = [];
  const targetPages: Partial<Record<Place, number>> = {};
  let page: string[] = [];
  const flush = () => {
    if (page.length === 0) return;
    pages.push(chinese ? { chineseLines: page } : { lines: page });
    page = [];
  };
  for (const { text, target } of lines) {
    const drawn = wrapped(text, words.line, chinese);
    if (page.length + drawn.length > words.lines) flush();
    if (target) targetPages[target] = pages.length + 1;
    page.push(...drawn);
  }
  flush();
  const { early, middle, late } = targetPages;
  if (early === undefined || middle === undefined || late === undefined) {
    throw new Error(`The ${language} agreement of ${size}k lost a target clause.`);
  }
  return {
    language,
    size,
    file:
      language === "en"
        ? `Harbourside Court lease and services (${size}k).pdf`
        : `海港苑租赁及服务合同（${size}k）.pdf`,
    pages,
    targetPages: { early, middle, late },
  };
}
