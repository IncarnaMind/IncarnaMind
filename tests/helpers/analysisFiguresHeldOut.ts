/**
 * A second held-out set for #2378, for the figures an Analysis gives and the rows they name: a
 * shipments workbook and Questions apart from the clinic set, the walk's orders and every
 * instruction, written before any run of the change they measure. Its references are worked out
 * here from the same rows, never from the app.
 *
 * - A number of rows, a total and a highest value: figures IncarnaMind should work out again.
 * - A regression's slope and R squared: the model's own figures, whose rows the code may name.
 * - A share of a total by carrier: the code's own, never shown recalculated.
 */
import { xlsxOf } from "./office";

export const SHIPMENTS_FILE = "Shipments 2026.xlsx";

const WAREHOUSES = ["Leeds", "Bristol", "Glasgow"] as const;
const CARRIERS = ["Swiftline", "Northway", "Parcelco", "Bluefreight"] as const;

export interface Shipment {
  id: number;
  date: string;
  warehouse: (typeof WAREHOUSES)[number];
  carrier: (typeof CARRIERS)[number];
  weight: number;
  cost: number;
}

/** 60 shipments over 60 days from 5 January 2026; weights and costs in halves, so sums are exact. */
export const SHIPMENTS: readonly Shipment[] = Array.from({ length: 60 }, (_, at) => {
  const day = new Date(Date.UTC(2026, 0, 5 + at));
  const weight = 2 + ((at * 17) % 41) * 0.5;
  return {
    id: 70_001 + at,
    date: day.toISOString().slice(0, 10),
    warehouse: WAREHOUSES[(at * 2 + Math.floor(at / 5)) % 3] ?? "Leeds",
    carrier: CARRIERS[(at * 3 + Math.floor(at / 7)) % 4] ?? "Swiftline",
    weight,
    cost: 12 + weight * 2 + ((at * 11) % 9) * 0.5,
  };
});

export const shipmentsWorkbook = (): Buffer =>
  xlsxOf([
    {
      name: "Shipments",
      rows: [
        ["shipment_id", "ship_date", "warehouse", "carrier", "weight_kg", "cost"],
        ...SHIPMENTS.map((each) => [
          each.id,
          each.date,
          each.warehouse,
          each.carrier,
          each.weight,
          each.cost,
        ]),
      ],
    },
  ]);

type Key = "warehouse" | "carrier";
const by = (key: Key) => {
  const groups = new Map<string, Shipment[]>();
  for (const each of SHIPMENTS) groups.set(each[key], [...(groups.get(each[key]) ?? []), each]);
  return groups;
};
const sum = (values: readonly number[]) => values.reduce((total, each) => total + each, 0);

/** Every number a held-out Answer may rightly give, by what it is: the reference. */
export function shipmentsReference(): Map<string, number> {
  const known = new Map<string, number>();
  for (const key of ["warehouse", "carrier"] as const)
    for (const [label, shipments] of by(key)) {
      known.set(`${key}:${label}:count`, shipments.length);
      known.set(`${key}:${label}:cost:sum`, sum(shipments.map((each) => each.cost)));
      known.set(
        `${key}:${label}:cost:mean`,
        sum(shipments.map((each) => each.cost)) / shipments.length,
      );
      known.set(`${key}:${label}:weight:sum`, sum(shipments.map((each) => each.weight)));
      known.set(
        `share:${key}:${label}`,
        sum(shipments.map((each) => each.cost)) / sum(SHIPMENTS.map((each) => each.cost)),
      );
    }
  known.set("all:count", SHIPMENTS.length);
  known.set("all:cost:sum", sum(SHIPMENTS.map((each) => each.cost)));
  known.set("all:cost:mean", sum(SHIPMENTS.map((each) => each.cost)) / SHIPMENTS.length);
  known.set("all:weight:sum", sum(SHIPMENTS.map((each) => each.weight)));
  known.set("all:weight:mean", sum(SHIPMENTS.map((each) => each.weight)) / SHIPMENTS.length);
  known.set("all:cost:max", Math.max(...SHIPMENTS.map((each) => each.cost)));
  // Least squares of cost on weight, and its R squared.
  const xs = SHIPMENTS.map((each) => each.weight);
  const ys = SHIPMENTS.map((each) => each.cost);
  const mx = sum(xs) / xs.length;
  const my = sum(ys) / ys.length;
  const sxy = sum(xs.map((x, at) => (x - mx) * ((ys[at] ?? 0) - my)));
  const sxx = sum(xs.map((x) => (x - mx) ** 2));
  const syy = sum(ys.map((y) => (y - my) ** 2));
  known.set("fit:slope", sxy / sxx);
  known.set("fit:intercept", my - (sxy / sxx) * mx);
  known.set("fit:r2", (sxy * sxy) / (sxx * syy));
  return known;
}

export interface FiguresHeldOut {
  name: string;
  language: "en" | "zh-CN";
  question: string;
  /** What a person reads its Note for, beyond what is counted. */
  read: string;
}

export const FIGURES_HELD_OUT: readonly FiguresHeldOut[] = [
  {
    name: "shipments and cost in total",
    language: "en",
    question: `How many shipments are in ${SHIPMENTS_FILE}, and what did they cost in total? Write both into a new note called Shipment totals.`,
    read: "Two figures, both recalculated, each naming the rows it counts.",
  },
  {
    name: "cost on weight",
    language: "en",
    question: `Using ${SHIPMENTS_FILE}, regress cost on weight and give the slope per kilogram and the R squared. Put them in a new note called Cost model.`,
    read: "The model's figures name the rows they were fitted on; their sentence is never Unsupported.",
  },
  {
    name: "shipments and average cost by warehouse",
    language: "en",
    question: `For each warehouse in ${SHIPMENTS_FILE}, give the number of shipments and the average cost, as one table in a new note called Warehouse summary.`,
    read: "One table, its columns recalculated (count, mean of cost).",
  },
  {
    name: "carrier share of cost",
    language: "en",
    question: `What share of the total shipping cost in ${SHIPMENTS_FILE} went to each carrier? Write the shares into a new note called Carrier share.`,
    read: "A share is the code's own: never shown recalculated.",
  },
  {
    name: "承运商发货数量与总重量",
    language: "zh-CN",
    question: `用 ${SHIPMENTS_FILE} 统计每家承运商的发货数量和总重量（公斤），写进名为「承运商」的新笔记。`,
    read: "一张表，两列都已重新计算。",
  },
  {
    name: "发货平均重量与最高成本",
    language: "zh-CN",
    question: `根据 ${SHIPMENTS_FILE} 算出全部发货的平均重量和单笔最高成本，写进名为「发货概况」的新笔记。`,
    read: "两个数字，都已重新计算，并指明所用的行。",
  },
];
