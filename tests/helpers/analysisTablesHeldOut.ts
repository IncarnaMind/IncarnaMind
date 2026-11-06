/**
 * Held-out set for #2378: an Analysis's tables and figures written into a Note, then checked.
 * Written before any measured run of the change, on a workbook and Questions apart from the walk's
 * orders and from every instruction: clinic visits, by clinic and by department, in English and
 * Chinese. Its references are worked out here from the same rows, never from the app.
 *
 * - Group totals, averages, counts and highest values: each column is one rule over the rows of a
 *   label, which IncarnaMind should reproduce.
 * - A trend's slope and whole-sheet figures: a model's own figure, whose rows the code may name.
 * - A share of a total: worked out by the code, which no single rule reproduces, so it must never
 *   show as recalculated.
 */
import { xlsxOf } from "./office";

export const CLINIC_FILE = "Clinic visits 2026.xlsx";

const CLINICS = ["Northside", "Riverside", "Hilltop"] as const;
const DEPARTMENTS = ["Cardiology", "Dermatology", "Pediatrics", "Orthopedics"] as const;

export interface Visit {
  id: number;
  date: string;
  clinic: (typeof CLINICS)[number];
  department: (typeof DEPARTMENTS)[number];
  minutes: number;
  fee: number;
}

/** 48 visits over 48 days in March and April 2026; fees in halves, so sums are exact in binary. */
export const VISITS: readonly Visit[] = Array.from({ length: 48 }, (_, at) => {
  const day = new Date(Date.UTC(2026, 2, 2 + at));
  return {
    id: 5001 + at,
    date: day.toISOString().slice(0, 10),
    clinic: CLINICS[(at * 7) % 3] ?? "Northside",
    department: DEPARTMENTS[(at * 5 + Math.floor(at / 4)) % 4] ?? "Cardiology",
    minutes: 15 + ((at * 13) % 31),
    fee: 40 + ((at * 37) % 23) * 4.5,
  };
});

export const clinicWorkbook = (): Buffer =>
  xlsxOf([
    {
      name: "Visits",
      rows: [
        ["visit_id", "visit_date", "clinic", "department", "minutes", "fee"],
        ...VISITS.map((visit) => [
          visit.id,
          visit.date,
          visit.clinic,
          visit.department,
          visit.minutes,
          visit.fee,
        ]),
      ],
    },
  ]);

type Key = "clinic" | "department";
const by = (key: Key) => {
  const groups = new Map<string, Visit[]>();
  for (const visit of VISITS) groups.set(visit[key], [...(groups.get(visit[key]) ?? []), visit]);
  return groups;
};
const sum = (values: readonly number[]) => values.reduce((total, each) => total + each, 0);

/** Every number a held-out Answer may rightly give, by what it is: the reference. */
export function clinicReference(): Map<string, number> {
  const known = new Map<string, number>();
  for (const key of ["clinic", "department"] as const)
    for (const [label, visits] of by(key)) {
      known.set(`${key}:${label}:fee:sum`, sum(visits.map((each) => each.fee)));
      known.set(
        `${key}:${label}:minutes:mean`,
        sum(visits.map((each) => each.minutes)) / visits.length,
      );
      known.set(`${key}:${label}:fee:max`, Math.max(...visits.map((each) => each.fee)));
      known.set(`${key}:${label}:count`, visits.length);
    }
  known.set("all:count", VISITS.length);
  known.set("all:fee:sum", sum(VISITS.map((each) => each.fee)));
  known.set("all:minutes:mean", sum(VISITS.map((each) => each.minutes)) / VISITS.length);
  for (const [clinic, visits] of by("clinic")) {
    const cardiology = sum(
      visits.filter((each) => each.department === "Cardiology").map((each) => each.fee),
    );
    known.set(`share:${clinic}`, cardiology / sum(visits.map((each) => each.fee)));
  }
  // Least squares of minutes on the day number, as numpy's polyfit gives it.
  const xs = VISITS.map((_, at) => at);
  const ys = VISITS.map((each) => each.minutes);
  const mx = sum(xs) / xs.length;
  const my = sum(ys) / ys.length;
  const slope =
    sum(xs.map((x, at) => (x - mx) * ((ys[at] ?? 0) - my))) / sum(xs.map((x) => (x - mx) ** 2));
  known.set("trend:minutes:slope", slope);
  return known;
}

export interface TableHeldOut {
  name: string;
  language: "en" | "zh-CN";
  question: string;
  /** What a person reads its Note for, beyond what is counted. */
  read: string;
}

export const TABLES_HELD_OUT: readonly TableHeldOut[] = [
  {
    name: "fees and minutes by clinic",
    language: "en",
    question: `Using ${CLINIC_FILE}, give each clinic's total fees and its average visit length in minutes in one table, and write the table into a new note called Clinic summary.`,
    read: "One table, recalculated columns (sum of fee, mean of minutes), no cell Not found.",
  },
  {
    name: "visit length trend",
    language: "en",
    question: `From ${CLINIC_FILE}, fit a linear trend of visit minutes against the visit date and give its slope per day. Put the result in a new note called Visit trend.`,
    read: "The slope's sentence is never Unsupported; its figure names the rows it was fitted on.",
  },
  {
    name: "visits by department, charted",
    language: "en",
    question: `Count the visits in ${CLINIC_FILE} by department and make a bar chart of the counts. Write the table and the chart into a new note called Department visits.`,
    read: "One table and one chart; the chart's values cite the visits sheet.",
  },
  {
    name: "Cardiology share by clinic",
    language: "en",
    question: `Using ${CLINIC_FILE}, what share of each clinic's fees came from Cardiology? Put the table in a new note called Cardiology share.`,
    read: "A share is the code's own: never shown recalculated, never Not found.",
  },
  {
    name: "科室费用合计与最高费用",
    language: "zh-CN",
    question: `用 ${CLINIC_FILE} 按科室汇总费用，并给出每个科室的最高一笔费用，把表格写进名为「科室费用」的新笔记。`,
    read: "一张表，两列都已重新计算；没有一格“未找到”。",
  },
  {
    name: "全部就诊概况",
    language: "zh-CN",
    question: `根据 ${CLINIC_FILE} 计算全部就诊的总费用和平均就诊时长（分钟），写进名为「就诊概况」的新笔记。`,
    read: "两个数字；求和与平均值可由 IncarnaMind 重新计算；句子不是“无依据”。",
  },
];
