/**
 * A development set for what a sentence says about an Analysis's figure besides its number (#2544):
 * its name, a sign or symbol, a rate per item, a target, a subset, and a unit, currency or scale
 * said in the sentence, before it, in the heading or caption above, or in a typed table's column.
 * Written before any run on it, on five made-up Documents of their own (a CSV, a workbook, a PDF's
 * table, a Word table and a deck's table), in five shapes (a sentence the Answer writes, one with
 * another sentence or a line before it, one under a heading, one the User types around the figure
 * in the Note, and a typed table's cell under a caption), in English and Chinese. Each case is
 * classed by what the Note says once written, and runs in a data folder of its own, with only its
 * own Document. No case is a probe, a held-out or gate case of #2378's, or an example the
 * instructions give.
 */

export type WordsHow = "sum" | "mean" | "max";

export interface WordsDataset {
  file: string;
  kind: "csv" | "xlsx" | "pdf" | "docx" | "pptx";
  /** The name the Analysis's code reads it by: what one of its rows is. */
  input: string;
  key: string;
  columns: readonly string[];
  rows: readonly (readonly (string | number)[])[];
  /** Each number column's unit as the Analysis gives it; "" for a plain number. */
  units: Readonly<Record<string, string>>;
  title: { en: string; "zh-CN": string };
  /** The groups' names in Chinese, as a Chinese Analysis labels them. */
  zh: Readonly<Record<string, string>>;
  /** Each number column's words, in English and Chinese, as a label names it. */
  measure: Readonly<Record<string, { en: string; "zh-CN": string }>>;
}

const grid = (
  groups: readonly string[],
  periods: readonly string[],
  values: (group: number, period: number) => readonly number[],
) =>
  groups.flatMap((group, g) =>
    periods.map((period, p) => [group, period, ...values(g, p)] as const),
  );

export const WORDS_DATASETS = {
  ferries: {
    file: "Ferry crossings.csv",
    kind: "csv",
    input: "crossings",
    key: "route",
    columns: ["route", "week", "passengers", "fares"],
    rows: grid(["Bayline", "Cliffside", "Dunmore", "Eastreach"], ["W1", "W2", "W3"], (g, p) => [
      410 + g * 55 + p * 23,
      3150 + g * 420 + p * 130,
    ]),
    units: { passengers: "", fares: "EUR" },
    title: { en: "Ferry crossings", "zh-CN": "渡轮航次" },
    zh: { Bayline: "海湾航线", Cliffside: "崖畔航线", Dunmore: "丹莫航线", Eastreach: "东岸航线" },
    measure: {
      passengers: { en: "passengers", "zh-CN": "乘客人数" },
      fares: { en: "fares", "zh-CN": "票款" },
    },
  },
  bakery: {
    file: "Bakery sales.xlsx",
    kind: "xlsx",
    input: "sales",
    key: "shop",
    columns: ["shop", "day", "loaves", "takings"],
    rows: grid(
      ["Alder Street", "Birch Lane", "Cedar Row", "Dove Yard"],
      ["Mon", "Tue", "Wed"],
      (g, p) => [180 + g * 24 + p * 9, 2040 + g * 310 + p * 85],
    ),
    units: { loaves: "", takings: "GBP" },
    title: { en: "Bakery sales", "zh-CN": "面包店销售" },
    zh: {
      "Alder Street": "桤木街店",
      "Birch Lane": "桦树巷店",
      "Cedar Row": "雪松路店",
      "Dove Yard": "鸽子院店",
    },
    measure: {
      loaves: { en: "loaves", "zh-CN": "面包数量" },
      takings: { en: "takings", "zh-CN": "营业收入" },
    },
  },
  meters: {
    file: "Water meters.pdf",
    kind: "pdf",
    input: "readings",
    key: "zone",
    columns: ["zone", "month", "usage"],
    rows: grid(
      ["Upper Marsh", "Lower Marsh", "Hilltop", "Riverbank"],
      ["Jan", "Feb", "Mar"],
      (g, p) => [5200 + g * 640 + p * 215],
    ),
    units: { usage: "" },
    title: { en: "Water meters", "zh-CN": "水表读数" },
    zh: {
      "Upper Marsh": "上沼片区",
      "Lower Marsh": "下沼片区",
      Hilltop: "山顶片区",
      Riverbank: "河岸片区",
    },
    measure: { usage: { en: "usage", "zh-CN": "用水量" } },
  },
  volunteers: {
    file: "Volunteer hours.docx",
    kind: "docx",
    input: "shifts",
    key: "team",
    columns: ["team", "month", "hours"],
    rows: grid(
      ["Garden", "Kitchen", "Reading Room", "Transport"],
      ["Jan", "Feb", "Mar"],
      (g, p) => [96 + g * 14 + p * 6],
    ),
    units: { hours: "" },
    title: { en: "Volunteer hours", "zh-CN": "志愿者时长" },
    zh: {
      Garden: "园艺小组",
      Kitchen: "厨房小组",
      "Reading Room": "阅览小组",
      Transport: "交通小组",
    },
    measure: { hours: { en: "hours", "zh-CN": "服务时长" } },
  },
  parcels: {
    file: "Parcel volumes.pptx",
    kind: "pptx",
    input: "deliveries",
    key: "hub",
    columns: ["hub", "week", "parcels", "weight"],
    rows: grid(["Northgate", "Southgate", "Westbury", "Eastfield"], ["W1", "W2", "W3"], (g, p) => [
      1320 + g * 175 + p * 60,
      2600 + g * 330 + p * 95,
    ]),
    units: { parcels: "", weight: "kg" },
    title: { en: "Parcel volumes", "zh-CN": "包裹数量" },
    zh: {
      Northgate: "北门枢纽",
      Southgate: "南门枢纽",
      Westbury: "西伯枢纽",
      Eastfield: "东田枢纽",
    },
    measure: {
      parcels: { en: "parcels", "zh-CN": "包裹数量" },
      weight: { en: "weight", "zh-CN": "重量" },
    },
  },
} as const satisfies Record<string, WordsDataset>;

export type WordsDatasetId = keyof typeof WORDS_DATASETS;

export interface WordsFigure {
  dataset: WordsDatasetId;
  group: string;
  column: string;
  how: WordsHow;
}

export type WordsShape =
  /** The Answer writes it into the Note, after `before` in the same paragraph when given. */
  | { kind: "answer"; before?: string }
  /** The Answer writes `line` as a paragraph of its own just above it. */
  | { kind: "line"; line: string }
  /** The Answer writes it under a heading of its own. */
  | { kind: "heading"; heading: string }
  /** The Answer writes the figure in a line of its own; the User types the sentence's words around it in the Note. */
  | { kind: "retyped" }
  /** A typed table's cell under `caption`, in the row `label`, holding the figure alone. */
  | { kind: "cell"; caption: string; headings: readonly [string, string]; label: string }
  /**
   * A list (#2584), the sentence its Markdown: in the Note the Answer writes, or, `added`, in an
   * Answer in the assistant that the User adds to a Note of their own.
   */
  | { kind: "list"; form: "bullet" | "numbered" | "nested" | "several"; added?: boolean };

export interface WordsCase {
  name: string;
  language: "en" | "zh-CN";
  kind: string;
  right: boolean;
  figure: WordsFigure;
  /** The figures [=2], [=3]… stand for, in a sentence that holds more than one. */
  also?: readonly WordsFigure[];
  shape: WordsShape;
  /** Its words, the figure's marker [=1] where the number goes; a cell holds [=1] alone. */
  sentence: string;
}

/** What the Analysis calls a figure: its way of working it out, its column's words and its group. */
export function wordsLabel(language: WordsCase["language"], figure: WordsFigure): string {
  const set: WordsDataset = WORDS_DATASETS[figure.dataset];
  const measure = set.measure[figure.column]?.[language] ?? figure.column;
  if (language === "zh-CN") {
    const group = set.zh[figure.group] ?? figure.group;
    return figure.how === "sum"
      ? `${group}${measure}合计`
      : figure.how === "mean"
        ? `${group}平均${measure}`
        : `${group}最高${measure}`;
  }
  const how = { sum: "Total", mean: "Average", max: "Highest" }[figure.how];
  return `${how} ${measure}, ${figure.group}`;
}

type Row = [right: boolean, kind: string, figure: WordsFigure, shape: WordsShape, sentence: string];

export const wordsFigure = (
  dataset: WordsDatasetId,
  group: string,
  column: string,
  how: WordsHow = "sum",
): WordsFigure => ({ dataset, group, column, how });
const f = wordsFigure;
const answer: WordsShape = { kind: "answer" };
const retyped: WordsShape = { kind: "retyped" };
const before = (words: string): WordsShape => ({ kind: "answer", before: words });
const line = (words: string): WordsShape => ({ kind: "line", line: words });
const heading = (words: string): WordsShape => ({ kind: "heading", heading: words });
const cell = (caption: string, headings: readonly [string, string], label: string): WordsShape => ({
  kind: "cell",
  caption,
  headings,
  label,
});

const RIGHT = "right";
const PER_UNIT = "per unit";
const SIGN = "sign or symbol";
const SCALE = "scale said before";
const COLUMN = "typed-table column";
const TARGET = "target";
const CURRENCY = "currency the unit doesn't back";
const SUBSET = "subset";

const EN: readonly Row[] = [
  [
    false,
    PER_UNIT,
    f("ferries", "Bayline", "passengers"),
    answer,
    "A Bayline crossing's total passengers came to [=1].",
  ],
  [
    false,
    PER_UNIT,
    f("bakery", "Birch Lane", "loaves"),
    retyped,
    "Birch Lane's total loaves were [=1]/sale.",
  ],
  [
    false,
    PER_UNIT,
    f("parcels", "Northgate", "parcels"),
    answer,
    "A Northgate delivery had a total of [=1] parcels.",
  ],
  [
    false,
    PER_UNIT,
    f("volunteers", "Kitchen", "hours"),
    heading("Volunteer hours by team"),
    "A Kitchen shift's total hours were [=1].",
  ],
  [false, SIGN, f("meters", "Hilltop", "usage"), answer, "Hilltop's total usage was -[=1]."],
  [
    false,
    SIGN,
    f("ferries", "Cliffside", "passengers"),
    answer,
    "Cliffside's total passengers: +[=1].",
  ],
  [false, SIGN, f("volunteers", "Garden", "hours"), retyped, "Garden's total hours ≥ [=1]."],
  [
    false,
    SIGN,
    f("parcels", "Southgate", "weight"),
    answer,
    "Southgate's total weight was ≤ [=1].",
  ],
  [false, SIGN, f("bakery", "Cedar Row", "loaves"), answer, "Cedar Row's total loaves were [=1]%."],
  [
    false,
    SCALE,
    f("meters", "Lower Marsh", "usage"),
    before("All usage figures here are in thousands of litres."),
    "Lower Marsh's total usage was [=1].",
  ],
  [
    false,
    SCALE,
    f("volunteers", "Transport", "hours"),
    heading("Hours (in thousands)"),
    "Transport's total hours came to [=1].",
  ],
  [
    false,
    SCALE,
    f("parcels", "Westbury", "parcels"),
    line("Figures below are in '000s."),
    "Westbury's total parcels came to [=1].",
  ],
  [
    false,
    SCALE,
    f("ferries", "Dunmore", "passengers"),
    before("Passenger numbers here are in thousands."),
    "Dunmore's total passengers came to [=1].",
  ],
  [
    false,
    COLUMN,
    f("bakery", "Dove Yard", "loaves"),
    cell("Loaves by shop", ["Shop", "Total loaves %"], "Dove Yard"),
    "[=1]",
  ],
  [
    false,
    COLUMN,
    f("meters", "Riverbank", "usage"),
    cell("Usage by zone", ["Zone", "Total usage ($)"], "Riverbank"),
    "[=1]",
  ],
  [
    false,
    COLUMN,
    f("ferries", "Eastreach", "passengers"),
    cell("Passengers by route", ["Route", "Total passengers (€)"], "Eastreach"),
    "[=1]",
  ],
  [
    false,
    TARGET,
    f("ferries", "Bayline", "passengers"),
    answer,
    "Bayline's total passengers have to reach [=1].",
  ],
  [
    false,
    TARGET,
    f("bakery", "Alder Street", "takings"),
    answer,
    "Alder Street's total takings were to have reached [=1].",
  ],
  [
    false,
    TARGET,
    f("volunteers", "Reading Room", "hours"),
    retyped,
    "Reading Room's total hours had to reach [=1].",
  ],
  [
    false,
    CURRENCY,
    f("volunteers", "Garden", "hours"),
    answer,
    "Garden's total hours came to £[=1].",
  ],
  [
    false,
    CURRENCY,
    f("bakery", "Birch Lane", "takings"),
    answer,
    "Birch Lane's total takings were $[=1].",
  ],
  [
    false,
    CURRENCY,
    f("parcels", "Eastfield", "parcels"),
    heading("Parcels (USD)"),
    "Eastfield's total parcels came to [=1].",
  ],
  [
    false,
    SUBSET,
    f("parcels", "Northgate", "parcels"),
    answer,
    "Northgate's closed deliveries had total parcels of [=1].",
  ],
  [
    false,
    SUBSET,
    f("bakery", "Cedar Row", "takings"),
    answer,
    "Saturday sales at Cedar Row had total takings of [=1].",
  ],
  [
    false,
    SUBSET,
    f("meters", "Upper Marsh", "usage"),
    answer,
    "Upper Marsh's household readings had a total usage of [=1].",
  ],
  [
    true,
    RIGHT,
    f("ferries", "Bayline", "passengers"),
    answer,
    "Bayline's total passengers came to [=1].",
  ],
  [
    true,
    RIGHT,
    f("ferries", "Cliffside", "fares"),
    heading("Fares (EUR)"),
    "Cliffside's total fares were [=1].",
  ],
  [
    true,
    RIGHT,
    f("ferries", "Dunmore", "passengers", "mean"),
    answer,
    "Dunmore's average passengers came to [=1].",
  ],
  [
    true,
    RIGHT,
    f("ferries", "Eastreach", "passengers", "max"),
    retyped,
    "Eastreach's highest passengers were [=1].",
  ],
  [
    true,
    RIGHT,
    f("bakery", "Alder Street", "loaves"),
    before("The shops baked through the spring."),
    "Alder Street's total loaves came to [=1].",
  ],
  [
    true,
    RIGHT,
    f("bakery", "Birch Lane", "takings"),
    heading("Takings (GBP thousands)"),
    "Birch Lane had total takings of [=1].",
  ],
  [
    true,
    RIGHT,
    f("bakery", "Cedar Row", "takings", "mean"),
    line("Takings are in GBP."),
    "Cedar Row's average takings were [=1].",
  ],
  [
    true,
    RIGHT,
    f("bakery", "Dove Yard", "loaves", "max"),
    cell("Loaves by shop", ["Shop", "Highest loaves"], "Dove Yard"),
    "[=1]",
  ],
  [
    true,
    RIGHT,
    f("meters", "Upper Marsh", "usage"),
    answer,
    "Upper Marsh recorded a total usage of [=1].",
  ],
  [
    true,
    RIGHT,
    f("meters", "Lower Marsh", "usage", "mean"),
    heading("Water use by zone"),
    "The average usage in Lower Marsh was [=1].",
  ],
  [
    true,
    RIGHT,
    f("meters", "Hilltop", "usage", "max"),
    retyped,
    "Hilltop's highest usage was [=1].",
  ],
  [
    true,
    RIGHT,
    f("meters", "Riverbank", "usage"),
    cell("Usage by zone", ["Zone", "Total usage"], "Riverbank"),
    "[=1]",
  ],
  [
    true,
    RIGHT,
    f("volunteers", "Garden", "hours"),
    answer,
    "The total hours for Garden came to [=1].",
  ],
  [
    true,
    RIGHT,
    f("volunteers", "Kitchen", "hours", "mean"),
    answer,
    "Kitchen's average hours were [=1].",
  ],
  [
    true,
    RIGHT,
    f("volunteers", "Reading Room", "hours"),
    retyped,
    "Reading Room's total hours: [=1].",
  ],
  [
    true,
    RIGHT,
    f("volunteers", "Transport", "hours", "max"),
    line("The teams logged their shifts by month."),
    "Transport's highest hours were [=1].",
  ],
  [
    true,
    RIGHT,
    f("parcels", "Northgate", "parcels"),
    answer,
    "Northgate's total parcels came to [=1].",
  ],
  [
    true,
    RIGHT,
    f("parcels", "Southgate", "weight"),
    heading("Weight (kg)"),
    "Southgate's total weight was [=1].",
  ],
  [
    true,
    RIGHT,
    f("parcels", "Westbury", "parcels", "mean"),
    retyped,
    "The average parcels at Westbury came to [=1].",
  ],
  [
    true,
    RIGHT,
    f("parcels", "Eastfield", "weight", "max"),
    answer,
    "Eastfield's highest weight stood at [=1].",
  ],
  [
    true,
    RIGHT,
    f("ferries", "Bayline", "fares"),
    before("Fares are shown in euros."),
    "Bayline's total fares came to [=1].",
  ],
  [
    true,
    RIGHT,
    f("bakery", "Alder Street", "takings"),
    cell("Takings by shop (GBP)", ["Shop", "Total takings"], "Alder Street"),
    "[=1]",
  ],
  [
    true,
    RIGHT,
    f("volunteers", "Garden", "hours"),
    heading("Volunteer hours"),
    "Garden's total hours came to [=1].",
  ],
  [true, RIGHT, f("meters", "Hilltop", "usage"), answer, "At Hilltop, the total usage was [=1]."],
  [
    true,
    RIGHT,
    f("parcels", "Westbury", "weight"),
    answer,
    "Westbury's deliveries had a total weight of [=1].",
  ],
  [
    true,
    RIGHT,
    f("ferries", "Eastreach", "passengers"),
    before("Last year's fares came to €8,000."),
    "Eastreach's total passengers came to [=1].",
  ],
];

const ZH: readonly Row[] = [
  [
    false,
    PER_UNIT,
    f("ferries", "Bayline", "passengers"),
    answer,
    "海湾航线每个航次的乘客人数合计为 [=1]。",
  ],
  [
    false,
    PER_UNIT,
    f("bakery", "Birch Lane", "loaves"),
    retyped,
    "桦树巷店面包数量合计为 [=1]/单。",
  ],
  [
    false,
    PER_UNIT,
    f("parcels", "Northgate", "parcels"),
    answer,
    "北门枢纽一次配送的包裹数量合计为 [=1]。",
  ],
  [false, SIGN, f("meters", "Hilltop", "usage"), answer, "山顶片区用水量合计为 -[=1]。"],
  [false, SIGN, f("ferries", "Cliffside", "passengers"), answer, "崖畔航线乘客人数合计 ≥ [=1]。"],
  [false, SIGN, f("volunteers", "Garden", "hours"), retyped, "园艺小组服务时长合计为 [=1]%。"],
  [false, SIGN, f("parcels", "Southgate", "parcels"), answer, "南门枢纽包裹数量合计为 +[=1]。"],
  [false, SIGN, f("bakery", "Cedar Row", "loaves"), answer, "雪松路店面包数量合计 ≠ [=1]。"],
  [
    false,
    SCALE,
    f("meters", "Lower Marsh", "usage"),
    before("以下用水量以万为单位。"),
    "下沼片区用水量合计为 [=1]。",
  ],
  [
    false,
    SCALE,
    f("volunteers", "Transport", "hours"),
    heading("服务时长（单位：千小时）"),
    "交通小组服务时长合计为 [=1]。",
  ],
  [
    false,
    SCALE,
    f("parcels", "Westbury", "parcels"),
    line("以下包裹数单位为万件。"),
    "西伯枢纽包裹数量合计为 [=1]。",
  ],
  [
    false,
    SCALE,
    f("ferries", "Dunmore", "passengers"),
    before("以下人数单位为千人。"),
    "丹莫航线乘客人数合计为 [=1]。",
  ],
  [
    false,
    COLUMN,
    f("bakery", "Dove Yard", "loaves"),
    cell("各门店面包数量", ["门店", "面包数量合计（%）"], "鸽子院店"),
    "[=1]",
  ],
  [
    false,
    COLUMN,
    f("meters", "Riverbank", "usage"),
    cell("各片区用水量", ["片区", "用水量合计（万元）"], "河岸片区"),
    "[=1]",
  ],
  [
    false,
    COLUMN,
    f("ferries", "Eastreach", "passengers"),
    cell("各航线乘客人数", ["航线", "乘客人数合计（€）"], "东岸航线"),
    "[=1]",
  ],
  [
    false,
    TARGET,
    f("ferries", "Bayline", "passengers"),
    answer,
    "海湾航线乘客人数合计须达到 [=1]。",
  ],
  [
    false,
    TARGET,
    f("bakery", "Alder Street", "takings"),
    answer,
    "桤木街店营业收入合计目标为 [=1]。",
  ],
  [
    false,
    TARGET,
    f("volunteers", "Reading Room", "hours"),
    retyped,
    "阅览小组服务时长合计应达到 [=1]。",
  ],
  [false, CURRENCY, f("volunteers", "Garden", "hours"), answer, "园艺小组服务时长合计为 ¥[=1]。"],
  [
    false,
    CURRENCY,
    f("parcels", "Eastfield", "parcels"),
    answer,
    "东田枢纽包裹数量合计为 [=1]美元。",
  ],
  [false, CURRENCY, f("bakery", "Birch Lane", "takings"), answer, "桦树巷店营业收入合计为 €[=1]。"],
  [
    false,
    SUBSET,
    f("parcels", "Northgate", "parcels"),
    answer,
    "北门枢纽已签收包裹数量合计为 [=1]。",
  ],
  [
    false,
    SUBSET,
    f("ferries", "Cliffside", "passengers"),
    answer,
    "崖畔航线周末航次乘客人数合计为 [=1]。",
  ],
  [false, SUBSET, f("meters", "Upper Marsh", "usage"), answer, "上沼片区居民用水量合计为 [=1]。"],
  [true, RIGHT, f("ferries", "Bayline", "passengers"), answer, "海湾航线乘客人数合计为 [=1]。"],
  [
    true,
    RIGHT,
    f("ferries", "Cliffside", "fares"),
    heading("票款（欧元）"),
    "崖畔航线票款合计为 [=1]。",
  ],
  [
    true,
    RIGHT,
    f("ferries", "Dunmore", "passengers", "mean"),
    answer,
    "丹莫航线平均乘客人数为 [=1]。",
  ],
  [
    true,
    RIGHT,
    f("ferries", "Eastreach", "passengers", "max"),
    retyped,
    "东岸航线最高乘客人数是 [=1]。",
  ],
  [
    true,
    RIGHT,
    f("bakery", "Alder Street", "loaves"),
    before("各门店的数据按日记录。"),
    "桤木街店面包数量合计为 [=1]。",
  ],
  [true, RIGHT, f("bakery", "Birch Lane", "takings"), answer, "桦树巷店的营业收入合计为 [=1]。"],
  [
    true,
    RIGHT,
    f("bakery", "Cedar Row", "takings", "mean"),
    line("营业收入以英镑计。"),
    "雪松路店平均营业收入为 [=1]。",
  ],
  [
    true,
    RIGHT,
    f("bakery", "Dove Yard", "loaves", "max"),
    cell("各门店面包数量", ["门店", "最高面包数量"], "鸽子院店"),
    "[=1]",
  ],
  [true, RIGHT, f("meters", "Upper Marsh", "usage"), answer, "上沼片区用水量合计达到 [=1]。"],
  [
    true,
    RIGHT,
    f("meters", "Lower Marsh", "usage", "mean"),
    heading("各片区用水"),
    "下沼片区平均用水量为 [=1]。",
  ],
  [true, RIGHT, f("meters", "Hilltop", "usage", "max"), retyped, "山顶片区最高用水量为 [=1]。"],
  [
    true,
    RIGHT,
    f("meters", "Riverbank", "usage"),
    cell("各片区用水量", ["片区", "用水量合计"], "河岸片区"),
    "[=1]",
  ],
  [true, RIGHT, f("volunteers", "Garden", "hours"), answer, "园艺小组的服务时长合计为 [=1]。"],
  [
    true,
    RIGHT,
    f("volunteers", "Kitchen", "hours", "mean"),
    answer,
    "厨房小组平均服务时长为 [=1]。",
  ],
  [true, RIGHT, f("volunteers", "Reading Room", "hours"), retyped, "阅览小组服务时长合计：[=1]。"],
  [
    true,
    RIGHT,
    f("volunteers", "Transport", "hours", "max"),
    line("各小组按月记录服务时长。"),
    "交通小组最高服务时长为 [=1]。",
  ],
  [true, RIGHT, f("parcels", "Northgate", "parcels"), answer, "北门枢纽包裹数量合计为 [=1]。"],
  [
    true,
    RIGHT,
    f("parcels", "Southgate", "weight"),
    heading("重量（千克）"),
    "南门枢纽重量合计为 [=1]。",
  ],
  [
    true,
    RIGHT,
    f("parcels", "Westbury", "parcels", "mean"),
    retyped,
    "西伯枢纽平均包裹数量为 [=1]。",
  ],
  [true, RIGHT, f("parcels", "Eastfield", "weight", "max"), answer, "东田枢纽最高重量为 [=1]。"],
  [
    true,
    RIGHT,
    f("ferries", "Bayline", "fares"),
    before("票款均以欧元计。"),
    "海湾航线票款合计为 [=1]。",
  ],
  [
    true,
    RIGHT,
    f("bakery", "Alder Street", "takings"),
    cell("各门店营业收入（英镑）", ["门店", "营业收入合计"], "桤木街店"),
    "[=1]",
  ],
  [
    true,
    RIGHT,
    f("volunteers", "Garden", "hours"),
    heading("志愿服务时长"),
    "园艺小组服务时长合计为 [=1]。",
  ],
  [true, RIGHT, f("meters", "Hilltop", "usage"), answer, "在山顶片区，用水量合计为 [=1]。"],
  [true, RIGHT, f("parcels", "Westbury", "weight"), answer, "西伯枢纽的重量合计是 [=1]。"],
  [
    true,
    RIGHT,
    f("ferries", "Eastreach", "passengers"),
    before("东岸航线去年票款为 €8,000。"),
    "东岸航线乘客人数合计为 [=1]。",
  ],
];

const cases = (language: WordsCase["language"], rows: readonly Row[]): WordsCase[] =>
  rows.map(([right, kind, figure, shape, sentence], at) => ({
    name: `${language} words ${right ? "right" : "wrong"} ${at + 1}`,
    language,
    kind,
    right,
    figure,
    shape,
    sentence,
  }));

export const FIGURE_WORDS: readonly WordsCase[] = [...cases("en", EN), ...cases("zh-CN", ZH)];
