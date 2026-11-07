/**
 * A wider development set for the claim judge's naming of an Analysis's figure (#2378), written
 * before any run on it: three Documents of their own (two CSVs and a workbook) with other columns
 * and units than Orders.csv, four shapes of Answer (prose, a list, a typed table, a heading that
 * states a scale), and every kind of wording a review found the judge or the filter let through.
 * Each case runs in a data folder of its own, with only its own Document. No case is a probe, a
 * held-out or gate case, or an example the instructions give.
 */

export type WideHow = "sum" | "mean" | "max";

export interface WideDataset {
  file: string;
  kind: "csv" | "xlsx";
  /** The name the Analysis's code reads it by. */
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

const months = ["Jan", "Feb", "Mar"];
const weeks = ["W1", "W2", "W3"];
const days = ["Mon", "Tue", "Wed"];

export const DATASETS = {
  clinics: {
    file: "Clinic visits.csv",
    kind: "csv",
    input: "clinics",
    key: "clinic",
    columns: ["clinic", "month", "visits", "wait_minutes"],
    rows: ["Harbour", "Hillside", "Riverside", "Station"].flatMap((clinic, at) =>
      months.map((month, m) => [clinic, month, 140 + at * 37 + m * 11, 12 + at * 3 + m * 1.5]),
    ),
    units: { visits: "", wait_minutes: "minutes" },
    title: { en: "Clinic visits", "zh-CN": "诊所就诊" },
    zh: { Harbour: "海港诊所", Hillside: "山坡诊所", Riverside: "河畔诊所", Station: "车站诊所" },
    measure: {
      visits: { en: "visits", "zh-CN": "就诊次数" },
      wait_minutes: { en: "wait", "zh-CN": "等候时间" },
    },
  },
  freight: {
    file: "Freight costs.xlsx",
    kind: "xlsx",
    input: "freight",
    key: "depot",
    columns: ["depot", "week", "cost", "weight"],
    rows: ["Bristol", "Exeter", "Bath", "Truro"].flatMap((depot, at) =>
      weeks.map((week, w) => [depot, week, 2150 + at * 415 + w * 96, 860 + at * 120 + w * 45]),
    ),
    units: { cost: "GBP", weight: "kg" },
    title: { en: "Freight costs", "zh-CN": "货运成本" },
    zh: { Bristol: "布里斯托尔", Exeter: "埃克塞特", Bath: "巴斯", Truro: "特鲁罗" },
    measure: { cost: { en: "cost", "zh-CN": "运费" }, weight: { en: "weight", "zh-CN": "重量" } },
  },
  energy: {
    file: "Energy use.csv",
    kind: "csv",
    input: "energy",
    key: "site",
    columns: ["site", "day", "energy", "bill"],
    rows: ["North Mill", "South Mill", "East Yard", "West Yard"].flatMap((site, at) =>
      days.map((day, d) => [site, day, 3200 + at * 510 + d * 130, 410 + at * 66 + d * 17]),
    ),
    units: { energy: "kWh", bill: "USD" },
    title: { en: "Energy use", "zh-CN": "能源使用" },
    zh: { "North Mill": "北厂", "South Mill": "南厂", "East Yard": "东场", "West Yard": "西场" },
    measure: { energy: { en: "energy", "zh-CN": "用电量" }, bill: { en: "bill", "zh-CN": "电费" } },
  },
} as const satisfies Record<string, WideDataset>;

export type WideDatasetId = keyof typeof DATASETS;

export interface WideFigure {
  dataset: WideDatasetId;
  group: string;
  column: string;
  how: WideHow;
}

export type WideShape =
  | { kind: "prose"; before?: string }
  | { kind: "list" }
  | { kind: "heading"; heading: string }
  | { kind: "table"; headings: [string, string]; label: string };

export interface WideCase {
  name: string;
  language: "en" | "zh-CN";
  kind: string;
  right: boolean;
  figure: WideFigure;
  shape: WideShape;
  /** Its words, the figure's marker [=1] where the number goes; a table's cell holds [=1] alone. */
  sentence: string;
}

/** What the Analysis calls a figure: its way of working it out, its column's words and its group. */
export function wideLabel(language: WideCase["language"], figure: WideFigure): string {
  const set: WideDataset = DATASETS[figure.dataset];
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

type Row = [right: boolean, kind: string, figure: WideFigure, shape: WideShape, sentence: string];

const f = (dataset: WideDatasetId, group: string, column: string, how: WideHow): WideFigure => ({
  dataset,
  group,
  column,
  how,
});
const prose: WideShape = { kind: "prose" };
const list: WideShape = { kind: "list" };

const EN: readonly Row[] = [
  [
    true,
    "right",
    f("clinics", "Harbour", "visits", "sum"),
    prose,
    "Harbour's total visits came to [=1].",
  ],
  [
    true,
    "right",
    f("freight", "Bristol", "cost", "sum"),
    list,
    "Bristol had a total cost of [=1].",
  ],
  [
    true,
    "right",
    f("freight", "Exeter", "cost", "sum"),
    { kind: "heading", heading: "Freight costs (GBP)" },
    "Exeter's total cost was [=1].",
  ],
  [
    true,
    "right",
    f("energy", "North Mill", "energy", "sum"),
    { kind: "table", headings: ["Site", "Total energy"], label: "North Mill" },
    "[=1]",
  ],
  [
    true,
    "right",
    f("clinics", "Hillside", "wait_minutes", "mean"),
    prose,
    "The average wait at Hillside was [=1].",
  ],
  [
    true,
    "right",
    f("energy", "South Mill", "bill", "mean"),
    list,
    "South Mill's average bill was [=1].",
  ],
  [
    true,
    "right",
    f("clinics", "Station", "wait_minutes", "max"),
    prose,
    "Station's highest wait was [=1].",
  ],
  [
    true,
    "right",
    f("freight", "Bath", "weight", "max"),
    { kind: "table", headings: ["Depot", "Highest weight"], label: "Bath" },
    "[=1]",
  ],
  [
    true,
    "right",
    f("energy", "West Yard", "energy", "sum"),
    { kind: "heading", heading: "Energy use (kWh)" },
    "West Yard's total energy came to [=1].",
  ],
  [true, "right", f("freight", "Truro", "cost", "sum"), prose, "The total cost for Truro is [=1]."],
  [
    false,
    "per unit",
    f("freight", "Bristol", "cost", "sum"),
    prose,
    "A Bristol shipment's total cost is [=1].",
  ],
  [
    false,
    "per unit",
    f("clinics", "Harbour", "visits", "sum"),
    list,
    "Harbour's total visits are [=1]/month.",
  ],
  [
    false,
    "target",
    f("freight", "Exeter", "cost", "sum"),
    prose,
    "Exeter's total cost has to reach [=1].",
  ],
  [
    false,
    "target",
    f("clinics", "Hillside", "wait_minutes", "mean"),
    list,
    "Hillside's average wait is to fall to [=1].",
  ],
  [
    false,
    "sign or symbol",
    f("freight", "Bath", "cost", "sum"),
    prose,
    "Bath's total cost is -[=1].",
  ],
  [
    false,
    "sign or symbol",
    f("clinics", "Riverside", "visits", "sum"),
    prose,
    "Riverside's total visits are ≥ [=1].",
  ],
  [
    false,
    "sign or symbol",
    f("energy", "East Yard", "energy", "sum"),
    list,
    "East Yard's total energy is [=1]%.",
  ],
  [
    false,
    "sign or symbol",
    f("freight", "Truro", "cost", "sum"),
    prose,
    "Truro's total cost ≠ [=1].",
  ],
  [
    false,
    "scale said before",
    f("freight", "Bath", "cost", "sum"),
    { kind: "prose", before: "All costs below are in thousands." },
    "Bath's total cost is [=1].",
  ],
  [
    false,
    "scale said before",
    f("energy", "South Mill", "energy", "sum"),
    { kind: "heading", heading: "Energy use (MWh)" },
    "South Mill's total energy came to [=1].",
  ],
  [
    false,
    "currency",
    f("freight", "Exeter", "cost", "sum"),
    prose,
    "Exeter's total cost was €[=1].",
  ],
  [
    false,
    "currency",
    f("energy", "North Mill", "bill", "mean"),
    list,
    "North Mill's average bill was £[=1].",
  ],
  [
    false,
    "subset",
    f("freight", "Bristol", "cost", "sum"),
    prose,
    "Bristol's refrigerated shipments had a total cost of [=1].",
  ],
  [
    false,
    "subset",
    f("clinics", "Harbour", "visits", "sum"),
    prose,
    "Harbour's weekend visits totalled [=1].",
  ],
  [
    false,
    "typed-table unit",
    f("freight", "Truro", "cost", "sum"),
    { kind: "table", headings: ["Depot", "Total cost (€)"], label: "Truro" },
    "[=1]",
  ],
  [
    false,
    "typed-table unit",
    f("energy", "West Yard", "energy", "sum"),
    { kind: "table", headings: ["Site", "Total energy (%)"], label: "West Yard" },
    "[=1]",
  ],
  [
    false,
    "another group",
    f("freight", "Bath", "cost", "sum"),
    prose,
    "Truro's total cost came to [=1].",
  ],
  [
    false,
    "another group",
    f("clinics", "Station", "visits", "sum"),
    list,
    "Riverside's total visits came to [=1].",
  ],
  [
    false,
    "another aggregate",
    f("freight", "Exeter", "cost", "sum"),
    prose,
    "The average cost for Exeter is [=1].",
  ],
  [
    false,
    "negation",
    f("clinics", "Station", "wait_minutes", "max"),
    prose,
    "Station's highest wait was not [=1].",
  ],
  [
    false,
    "comparison",
    f("energy", "West Yard", "energy", "sum"),
    prose,
    "West Yard's total energy was above [=1].",
  ],
  [
    false,
    "qualifier",
    f("clinics", "Hillside", "visits", "sum"),
    prose,
    "Hillside's total visits this winter came to [=1].",
  ],
];

const ZH_ROWS: readonly Row[] = [
  [true, "right", f("clinics", "Harbour", "visits", "sum"), prose, "海港诊所就诊次数合计为 [=1]。"],
  [true, "right", f("freight", "Bristol", "cost", "sum"), list, "布里斯托尔运费合计为 [=1]。"],
  [
    true,
    "right",
    f("freight", "Exeter", "cost", "sum"),
    { kind: "heading", heading: "货运成本（英镑）" },
    "埃克塞特的运费合计是 [=1]。",
  ],
  [
    true,
    "right",
    f("energy", "North Mill", "energy", "sum"),
    { kind: "table", headings: ["厂区", "用电量合计"], label: "北厂" },
    "[=1]",
  ],
  [
    true,
    "right",
    f("clinics", "Hillside", "wait_minutes", "mean"),
    prose,
    "山坡诊所平均等候时间为 [=1]。",
  ],
  [true, "right", f("energy", "South Mill", "bill", "mean"), list, "南厂平均电费为 [=1]。"],
  [true, "right", f("freight", "Bath", "weight", "max"), prose, "巴斯最高重量为 [=1]。"],
  [
    true,
    "right",
    f("energy", "West Yard", "energy", "sum"),
    { kind: "heading", heading: "能源使用（千瓦时）" },
    "西场用电量合计为 [=1]。",
  ],
  [
    false,
    "per unit",
    f("freight", "Bristol", "cost", "sum"),
    prose,
    "布里斯托尔每批货的运费合计为 [=1]。",
  ],
  [
    false,
    "target",
    f("freight", "Exeter", "cost", "sum"),
    prose,
    "埃克塞特的运费合计须达到 [=1]。",
  ],
  [
    false,
    "sign or symbol",
    f("clinics", "Riverside", "visits", "sum"),
    prose,
    "河畔诊所就诊次数合计为 -[=1]。",
  ],
  [
    false,
    "sign or symbol",
    f("energy", "East Yard", "energy", "sum"),
    list,
    "东场用电量合计为 [=1]%。",
  ],
  [false, "sign or symbol", f("freight", "Truro", "cost", "sum"), prose, "特鲁罗运费合计 ≤ [=1]。"],
  [
    false,
    "scale said before",
    f("freight", "Bath", "cost", "sum"),
    { kind: "prose", before: "以下金额单位为千英镑。" },
    "巴斯运费合计为 [=1]。",
  ],
  [
    false,
    "scale said before",
    f("energy", "South Mill", "energy", "sum"),
    { kind: "heading", heading: "能源使用（兆瓦时）" },
    "南厂用电量合计为 [=1]。",
  ],
  [
    false,
    "currency",
    f("freight", "Exeter", "cost", "sum"),
    prose,
    "埃克塞特运费合计为 [=1]美元。",
  ],
  [
    false,
    "subset",
    f("clinics", "Harbour", "visits", "sum"),
    prose,
    "海港诊所周末就诊次数合计为 [=1]。",
  ],
  [
    false,
    "typed-table unit",
    f("freight", "Truro", "cost", "sum"),
    { kind: "table", headings: ["仓库", "运费合计（欧元）"], label: "特鲁罗" },
    "[=1]",
  ],
  [false, "another group", f("freight", "Bath", "cost", "sum"), prose, "特鲁罗运费合计为 [=1]。"],
  [
    false,
    "another aggregate",
    f("clinics", "Hillside", "wait_minutes", "mean"),
    list,
    "山坡诊所最高等候时间为 [=1]。",
  ],
  [
    false,
    "negation",
    f("energy", "West Yard", "energy", "sum"),
    prose,
    "西场用电量合计不是 [=1]。",
  ],
  [
    false,
    "comparison",
    f("clinics", "Station", "visits", "sum"),
    prose,
    "车站诊所就诊次数合计超过 [=1]。",
  ],
  [
    false,
    "qualifier",
    f("energy", "North Mill", "bill", "mean"),
    prose,
    "北厂今年冬季平均电费为 [=1]。",
  ],
];

const cases = (language: WideCase["language"], rows: readonly Row[]): WideCase[] =>
  rows.map(([right, kind, figure, shape, sentence], at) => ({
    name: `${language} wide ${right ? "right" : "wrong"} ${at + 1}`,
    language,
    kind,
    right,
    figure,
    shape,
    sentence,
  }));

export const NAMING_WIDE: readonly WideCase[] = [...cases("en", EN), ...cases("zh-CN", ZH_ROWS)];
