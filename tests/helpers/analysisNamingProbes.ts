/**
 * The development probes for the claim judge's naming of an Analysis's figure (#2378), on
 * Orders.csv's 40 orders: a sentence that gives a figure of one region's rows, and whether it names
 * that figure right, by the kind of wrong name it has. They are what the judge and its guard are
 * built against; the gate is the held-out set (`analysisNamingHeldOut.ts`), never these.
 */

export type Region = "Central" | "North" | "South" | "West";
export type How = "sum" | "mean" | "max" | "count";

export interface NamingFigure {
  region: Region;
  how: How;
  /** What the Analysis called it; the label template's when absent. */
  label?: string;
}

export interface NamingCase {
  name: string;
  language: "en" | "zh-CN";
  kind: string;
  /** Whether the sentence names every figure in it as its label and rows say. */
  right: boolean;
  figures: NamingFigure[];
  /** The Note's sentence, each figure's marker [=1], [=2] in order. */
  sentence: string;
}

export const REGIONS: readonly Region[] = ["Central", "North", "South", "West"];
export const ZH: Record<Region, string> = {
  Central: "中部",
  North: "北部",
  South: "南部",
  West: "西部",
};

export const LABELS: Record<"en" | "zh-CN", Record<How, (region: Region) => string>> = {
  en: {
    sum: (r) => `Total amount, ${r}`,
    mean: (r) => `Average amount, ${r}`,
    max: (r) => `Highest amount, ${r}`,
    count: (r) => `Number of orders, ${r}`,
  },
  "zh-CN": {
    sum: (r) => `${ZH[r]}地区金额合计`,
    mean: (r) => `${ZH[r]}地区平均金额`,
    max: (r) => `${ZH[r]}地区最高金额`,
    count: (r) => `${ZH[r]}地区订单数`,
  },
};

/** Right wordings of each measure, `{R}` the region and `{v}` the figure's marker. */
const RIGHT: Record<"en" | "zh-CN", Record<How, readonly string[]>> = {
  en: {
    sum: [
      "{R}'s total amount is {v}.",
      "The total amount for {R} came to {v}.",
      "In {R}, the total amount was {v}.",
      "{R} recorded a total amount of {v}.",
      "Orders from {R} had a total amount of {v}.",
      "The {R} region's total amount stands at {v}.",
    ],
    mean: [
      "{R}'s average amount is {v}.",
      "The average amount in {R} was {v}.",
      "Orders in {R} had an average amount of {v}.",
      "The {R} region's average amount is {v}.",
      "For {R}, the average amount of an order is {v}.",
      "An order from {R} has an average amount of {v}.",
    ],
    max: [
      "{R}'s highest amount is {v}.",
      "The highest amount in {R} was {v}.",
      "The {R} region's highest amount is {v}.",
      "For {R}, the highest amount on one order is {v}.",
      "{R} saw a highest amount of {v}.",
      "Among {R}'s orders, the highest amount is {v}.",
    ],
    count: [
      "The number of orders in {R} is {v}.",
      "{R}'s number of orders is {v}.",
      "The {R} region's number of orders stands at {v}.",
      "For {R}, the number of orders is {v}.",
      "{R} has {v} orders.",
    ],
  },
  "zh-CN": {
    sum: [
      "{R}地区金额合计为 {v}。",
      "{R}地区的金额合计是 {v}。",
      "在{R}地区，金额合计为 {v}。",
      "{R}地区订单金额合计 {v}。",
      "{R}地区全部订单的金额合计达到 {v}。",
      "就{R}地区而言，金额合计为 {v}。",
    ],
    mean: [
      "{R}地区平均金额为 {v}。",
      "{R}地区的平均金额是 {v}。",
      "在{R}地区，平均金额为 {v}。",
      "{R}地区订单的平均金额为 {v}。",
      "就{R}地区而言，平均金额是 {v}。",
      "{R}地区每笔订单平均金额 {v}。",
    ],
    max: [
      "{R}地区最高金额为 {v}。",
      "{R}地区的最高金额是 {v}。",
      "在{R}地区，最高金额为 {v}。",
      "{R}地区单笔订单的最高金额为 {v}。",
      "就{R}地区而言，最高金额达到 {v}。",
      "{R}地区各笔订单中最高金额为 {v}。",
    ],
    count: [
      "{R}地区订单数为 {v}。",
      "{R}地区的订单数是 {v}。",
      "在{R}地区，订单数为 {v}。",
      "{R}地区下单的订单数为 {v}。",
      "{R}地区共有 {v} 笔订单。",
    ],
  },
};

/** {R} is the figure's own region, {O} the other one the sentence gives it to. */
const ANOTHER_NAMED: Record<"en" | "zh-CN", readonly string[]> = {
  en: [
    "Unlike {R}, {O}'s total amount is {v}.",
    "{O}'s total amount of {v} is ahead of {R}'s.",
    "Compared with {R}, {O} has a total amount of {v}.",
    "{O}, not {R}, has a total amount of {v}.",
    "Beside {R}, {O}'s total amount is {v}.",
    "Of {R} and {O}, {O}'s total amount is {v}.",
  ],
  "zh-CN": [
    "与{R}地区相比，{O}地区金额合计为 {v}。",
    "{O}地区金额合计 {v}，领先于{R}地区。",
    "不同于{R}地区，{O}地区的金额合计是 {v}。",
    "是{O}地区而不是{R}地区，金额合计为 {v}。",
    "除{R}地区外，{O}地区金额合计为 {v}。",
    "{R}地区和{O}地区中，{O}地区金额合计为 {v}。",
  ],
};

/** A word the label lacks: a qualifier, net, per day, a period. */
const LACKING: Record<"en" | "zh-CN", readonly string[]> = {
  en: [
    "{R}'s total amount per order is {v}.",
    "{R}'s total amount per day is {v}.",
    "{R}'s net amount is {v}.",
    "{R}'s total net amount is {v}.",
    "{R}'s total amount excluding refunds is {v}.",
    "{R}'s total amount for September is {v}.",
  ],
  "zh-CN": [
    "{R}地区每笔订单的金额合计为 {v}。",
    "{R}地区每天的金额合计为 {v}。",
    "{R}地区净金额为 {v}。",
    "{R}地区净金额合计为 {v}。",
    "{R}地区扣除退款后的金额合计为 {v}。",
    "{R}地区九月的金额合计为 {v}。",
  ],
};

const NEGATED: Record<"en" | "zh-CN", readonly string[]> = {
  en: [
    "{R}'s total amount is not {v}.",
    "{R}'s total amount is below {v}.",
    "{R}'s total amount was more than {v}.",
    "{R}'s total amount is less than {v}.",
  ],
  "zh-CN": [
    "{R}地区金额合计不是 {v}。",
    "{R}地区金额合计低于 {v}。",
    "{R}地区金额合计超过 {v}。",
    "{R}地区金额合计少于 {v}。",
  ],
};

const fill = (template: string, language: "en" | "zh-CN", region: Region, other?: Region) =>
  template
    .replaceAll("{R}", language === "en" ? region : ZH[region])
    .replaceAll("{O}", other ? (language === "en" ? other : ZH[other]) : "")
    .replaceAll("{v}", "[=1]");

export const nextOf = (region: Region, step = 1): Region =>
  REGIONS[(REGIONS.indexOf(region) + step) % REGIONS.length] ?? region;

function probesIn(language: "en" | "zh-CN"): NamingCase[] {
  const cases: NamingCase[] = [];
  const add = (kind: string, right: boolean, figures: NamingFigure[], sentence: string) =>
    cases.push({
      name: `${language} ${kind} ${cases.filter((each) => each.kind === kind).length + 1}`,
      language,
      kind,
      right,
      figures,
      sentence,
    });
  const hows: readonly How[] = ["sum", "mean", "max", "count"];
  // Right wordings, and each with another region's name, and with another measure's.
  for (const how of hows)
    RIGHT[language][how].forEach((template, at) => {
      const region = REGIONS[at % REGIONS.length] ?? "North";
      add("right", true, [{ region, how }], fill(template, language, region));
      add("another region", false, [{ region, how }], fill(template, language, nextOf(region)));
      const other = hows[(hows.indexOf(how) + 1) % hows.length] ?? "sum";
      const wording = RIGHT[language][other][at % RIGHT[language][other].length] ?? template;
      add("another measure", false, [{ region, how }], fill(wording, language, region));
    });
  for (const template of ANOTHER_NAMED[language])
    for (const region of REGIONS)
      add(
        "another region named in its clause",
        false,
        [{ region, how: "sum" }],
        fill(template, language, region, nextOf(region, 2)),
      );
  LACKING[language].forEach((template, at) => {
    const region = REGIONS[at % REGIONS.length] ?? "North";
    add(
      "a word the label lacks",
      false,
      [{ region, how: "sum" }],
      fill(template, language, region),
    );
  });
  NEGATED[language].forEach((template, at) => {
    const region = REGIONS[at % REGIONS.length] ?? "North";
    add(
      "negation or comparison",
      false,
      [{ region, how: "sum" }],
      fill(template, language, region),
    );
  });
  // A short code for each region, right and swapped.
  for (const region of REGIONS) {
    const code = region.slice(0, 1);
    const swapped = nextOf(region).slice(0, 1);
    const label = language === "en" ? `Total amount, region ${code}` : `${code} 区金额合计`;
    const say = (named: string) =>
      language === "en"
        ? `Region ${named}'s total amount is [=1].`
        : `${named} 区金额合计为 [=1]。`;
    add("short code", true, [{ region, how: "sum", label }], say(code));
    add("short code", false, [{ region, how: "sum", label }], say(swapped));
  }
  // A label with a digit, and a sentence whose only digits are the figure's own.
  for (const region of REGIONS) {
    const store = REGIONS.indexOf(region) + 6;
    const label = language === "en" ? `Total amount, store ${store}` : `${store} 号门店金额合计`;
    add(
      "the figure's own digits",
      true,
      [{ region, how: "sum", label }],
      language === "en"
        ? `Store ${store}'s total amount is [=1].`
        : `${store} 号门店金额合计为 [=1]。`,
    );
    add(
      "the figure's own digits",
      false,
      [{ region, how: "sum", label }],
      language === "en" ? "Store four's total amount is [=1]." : "四号门店金额合计为 [=1]。",
    );
  }
  if (language === "zh-CN") {
    // A region's name inside another's: 西南部 holds 南部.
    for (const [region, said] of [
      ["South", "西南部"],
      ["West", "中西部"],
      ["North", "东北部"],
      ["Central", "华中部"],
    ] as const)
      add(
        "Han inside another word",
        false,
        [{ region, how: "sum" }],
        `${said}地区金额合计为 [=1]。`,
      );
  }
  // Two figures: each in its own clause; each in the other's; and a name said first.
  for (const [a, b] of [
    ["North", "South"],
    ["Central", "West"],
  ] as const) {
    const pair = [
      { region: a, how: "sum" as const },
      { region: b, how: "sum" as const },
    ];
    const say = (first: Region, second: Region) =>
      language === "en"
        ? `${first}'s total amount is [=1], and ${second}'s total amount is [=2].`
        : `${ZH[first]}地区金额合计为 [=1]，${ZH[second]}地区金额合计为 [=2]。`;
    add("two figures", true, pair, say(a, b));
    add("two figures", false, pair, say(b, a));
    add(
      "a name said first",
      false,
      pair,
      language === "en"
        ? `${a} trails ${b}: ${b}'s total amount is [=1], ${a}'s is [=2].`
        : `${ZH[a]}地区落后于${ZH[b]}地区：${ZH[b]}地区金额合计为 [=1]，${ZH[a]}地区为 [=2]。`,
    );
  }
  return cases;
}

export const NAMING_PROBES: readonly NamingCase[] = [...probesIn("en"), ...probesIn("zh-CN")];
