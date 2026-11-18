/**
 * Data files and the sentences a User writes from their rows, each beside a wrong twin: a figure
 * that has to be worked out from the whole file, never read off its first lines. Four invented
 * files (orders, loans, clinic visits, and Chinese sales), thousands of rows each, and eight pairs
 * on each, two of every `way`, over sum, mean, median, count, maximum, share, change and ratio.
 *
 * Every row comes from a seeded generator, and both figures of a pair are worked out here, from
 * those rows: nothing is typed in. A sentence is written as a person writes a figure, rounded
 * ("£1.30 million", "8.3%", "38 minutes"), and a twin is the same sentence with another figure,
 * which has to differ by more than the rounding and by at least 2%; the first 100 rows must not
 * give the sentence's figure either. A pair that breaks one of these throws when this file loads,
 * so a bad seed is found before any run.
 *
 * The set is fixed: a pair is not edited once a baseline rests on it, and a new shape is a new pair.
 */
export type RowsWay = "off-by-a-little" | "wrong-period" | "wrong-group" | "wrong-filter";

export interface RowsPair {
  id: string;
  /** What the figure is, in plain words, for whoever reads a report; never sent to a model. */
  question: string;
  right: string;
  wrong: string;
  /**
   * How the twin is wrong: its figure is 2% to 6% off, or is another period's, another group's,
   * or the figure with the wrong rows in.
   */
  way: RowsWay;
}

export interface RowsDataset {
  id: string;
  language: "en" | "zh-CN";
  fileName: string;
  csv: string;
  rows: number;
  pairs: readonly RowsPair[];
}

interface Draw {
  next(): number;
  normal(): number;
  lognormal(median: number, sigma: number): number;
  pick<Item>(items: readonly Item[], weight: (item: Item) => number): Item;
}

/** mulberry32: the same seed always gives the same rows. */
function drawer(seed: number): Draw {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return {
    next,
    normal,
    lognormal: (median, sigma) => median * Math.exp(sigma * normal()),
    pick(items, weight) {
      let left = next() * items.reduce((sum, item) => sum + weight(item), 0);
      for (const item of items) {
        left -= weight(item);
        if (left < 0) return item;
      }
      throw new Error("Nothing was left to pick.");
    },
  };
}

/** A position in 0 to 1 that leans late, so a period's rows differ from the one a year before. */
const spread = (draw: Draw) => (draw.next() < 0.75 ? draw.next() : Math.sqrt(draw.next()));

const pad = (number: number) => String(number).padStart(2, "0");
const dayOf = (offset: number) =>
  new Date(Date.UTC(2025, 0, 1 + offset)).toISOString().slice(0, 10);

interface Kind {
  name: string;
  weight: number;
  price: number;
}

interface Trade {
  date: string;
  region: string;
  channel: string;
  status: string;
  quantity: number;
  amount: number;
}

interface TradeKinds {
  seed: number;
  size: number;
  unitPrice: number;
  regions: readonly Kind[];
  channels: readonly (Kind & { notCompleted: number })[];
  completed: string;
  cancelled: string;
  refunded: string;
}

const TRADE_DAYS = 546;

function trades(kinds: TradeKinds): Trade[] {
  const draw = drawer(kinds.seed);
  return Array.from({ length: kinds.size }, () => {
    const day = Math.floor(TRADE_DAYS * spread(draw));
    const region = draw.pick(kinds.regions, (each) => each.weight);
    const channel = draw.pick(kinds.channels, (each) => each.weight);
    const quantity = Math.min(12, 1 + Math.floor(draw.lognormal(3, 0.7)));
    const unit =
      draw.lognormal(kinds.unitPrice, 0.45) *
      region.price *
      channel.price *
      (1 + (0.007 * day) / 30);
    const status =
      draw.next() < channel.notCompleted
        ? draw.next() < 0.6
          ? kinds.cancelled
          : kinds.refunded
        : kinds.completed;
    return {
      date: dayOf(day),
      region: region.name,
      channel: channel.name,
      status,
      quantity,
      amount: Math.round(quantity * unit * 100) / 100,
    };
  });
}

interface Loan {
  branch: string;
  product: string;
  quarter: string;
  principal: number;
  rate: number;
  defaulted: boolean;
}

const LOAN_QUARTERS = 10;
const quarterOf = (index: number) => `${2024 + Math.floor(index / 4)}Q${(index % 4) + 1}`;

function loans(): Loan[] {
  const draw = drawer(32820602);
  const branches: readonly Kind[] = [
    { name: "Austin", weight: 0.26, price: 1 },
    { name: "Denver", weight: 0.22, price: 1.15 },
    { name: "Columbus", weight: 0.18, price: 0.85 },
    { name: "Tampa", weight: 0.2, price: 0.95 },
    { name: "Portland", weight: 0.14, price: 1.1 },
  ];
  const products = [
    {
      name: "Mortgage",
      weight: 0.2,
      median: 330000,
      sigma: 0.45,
      rate: 5.8,
      spread: 0.5,
      bad: 0.01,
    },
    { name: "Auto", weight: 0.3, median: 27000, sigma: 0.4, rate: 7.4, spread: 0.9, bad: 0.032 },
    {
      name: "Personal",
      weight: 0.35,
      median: 11500,
      sigma: 0.5,
      rate: 11.5,
      spread: 1.8,
      bad: 0.065,
    },
    { name: "SME", weight: 0.15, median: 160000, sigma: 0.7, rate: 8.8, spread: 1.3, bad: 0.048 },
  ];
  return Array.from({ length: 5000 }, () => {
    const quarter = Math.floor(LOAN_QUARTERS * spread(draw));
    const branch = draw.pick(branches, (each) => each.weight);
    const product = draw.pick(products, (each) => each.weight);
    return {
      branch: branch.name,
      product: product.name,
      quarter: quarterOf(quarter),
      principal: Math.round(draw.lognormal(product.median, product.sigma) * branch.price),
      rate: Math.round((product.rate + product.spread * draw.normal()) * 100) / 100,
      defaulted: draw.next() < product.bad * (1.4 - 0.08 * quarter),
    };
  });
}

interface Visit {
  clinic: string;
  month: string;
  age: number;
  wait: number;
  outcome: string;
}

const VISIT_MONTHS = 18;
const monthOf = (index: number) => `${2025 + Math.floor(index / 12)}-${pad((index % 12) + 1)}`;

function visits(): Visit[] {
  const draw = drawer(32820623);
  const clinics = [
    { name: "Riverside", weight: 0.32, wait: 1, age: 42, trend: 0.003 },
    { name: "Northgate", weight: 0.28, wait: 1.25, age: 54, trend: 0.022 },
    { name: "Eastfield", weight: 0.22, wait: 0.85, age: 34, trend: 0.003 },
    { name: "Harbourview", weight: 0.18, wait: 1.1, age: 46, trend: 0.003 },
  ];
  const season = [1.3, 1.25, 1.1, 1, 1, 0.85, 0.85, 0.85, 1, 1, 1.05, 1.3];
  const months = Array.from({ length: VISIT_MONTHS }, (_, index) => index);
  return Array.from({ length: 4000 }, () => {
    const month = draw.pick(months, (each) => (1 + 0.03 * each) * (season[each % 12] ?? 1));
    const clinic = draw.pick(clinics, (each) => each.weight);
    const winter = [0, 1, 11].includes(month % 12);
    const summer = [5, 6, 7].includes(month % 12);
    const admitted = 0.14 + (winter ? 0.05 : summer ? -0.04 : 0);
    const chance = draw.next();
    const outcome =
      chance < admitted ? "Admitted" : chance < admitted + 0.08 ? "Referred" : "Discharged";
    const older = outcome === "Admitted" ? 12 : outcome === "Referred" ? 4 : 0;
    const age =
      draw.next() < 0.12
        ? Math.floor(draw.next() * 18)
        : Math.min(95, Math.max(18, Math.round(clinic.age + older + 17 * draw.normal())));
    const slower = outcome === "Admitted" ? 0.7 : outcome === "Referred" ? 1.2 : 1;
    return {
      clinic: clinic.name,
      month: monthOf(month),
      age,
      wait: Math.max(
        1,
        Math.round(draw.lognormal(28, 0.6) * clinic.wait * slower * (1 + clinic.trend * month)),
      ),
      outcome,
    };
  });
}

const total = <Row>(rows: readonly Row[], value: (row: Row) => number) =>
  rows.reduce((sum, row) => sum + value(row), 0);
const average = <Row>(rows: readonly Row[], value: (row: Row) => number) =>
  total(rows, value) / rows.length;
const highest = <Row>(rows: readonly Row[], value: (row: Row) => number) =>
  Math.max(...rows.map(value));

function median<Row>(rows: readonly Row[], value: (row: Row) => number): number {
  const sorted = rows.map(value).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const at = (index: number) => sorted[index] ?? Number.NaN;
  return sorted.length % 2 === 1 ? at(middle) : (at(middle - 1) + at(middle)) / 2;
}

const percent = (part: number, whole: number) => (100 * part) / whole;
const change = (from: number, to: number) => (100 * (to - from)) / from;
const keep = <Row>(rows: readonly Row[], ...tests: ((row: Row) => boolean)[]) =>
  rows.filter((row) => tests.every((test) => test(row)));

/** How a figure is written: its value divided by `divisor`, to `decimals`, which fixes the rounding. */
interface Figure {
  show(value: number): string;
  step: number;
}

const figure = (divisor: number, decimals: number): Figure => ({
  show: (value) =>
    (value / divisor).toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }),
  step: divisor / 10 ** decimals,
});

interface Spec<Row> {
  id: string;
  question: string;
  way: RowsWay;
  figure: Figure;
  right: (rows: readonly Row[]) => number;
  /** The twin's figure, from other rows; for off-by-a-little, how far off the right one: 0.04 is 4% more. */
  wrong: ((rows: readonly Row[]) => number) | number;
  say: (shown: string) => string;
}

function pairOf<Row>(rows: readonly Row[], spec: Spec<Row>): RowsPair {
  const fail = (why: string): never => {
    throw new Error(`${spec.id}: ${why}`);
  };
  if ((spec.way === "off-by-a-little") !== (typeof spec.wrong === "number"))
    fail("only an off-by-a-little twin is a share off the right figure");
  const right = spec.right(rows);
  const wrong = typeof spec.wrong === "number" ? right * (1 + spec.wrong) : spec.wrong(rows);
  if (!Number.isFinite(right) || !Number.isFinite(wrong)) fail(`not numbers: ${right}, ${wrong}`);
  const gap = Math.abs(wrong - right);
  const off = gap / Math.abs(right);
  if (gap <= spec.figure.step) fail(`the twin is within the rounding: ${right}, ${wrong}`);
  if (off < 0.02 || (spec.way === "off-by-a-little" && off > 0.06))
    fail(`the twin is ${(off * 100).toFixed(1)}% off`);
  const head = spec.right(rows.slice(0, 100));
  if (Number.isFinite(head) && Math.abs(head - right) <= spec.figure.step)
    fail(`the first 100 rows give it: ${head}`);
  return {
    id: spec.id,
    question: spec.question,
    way: spec.way,
    right: spec.say(spec.figure.show(right)),
    wrong: spec.say(spec.figure.show(wrong)),
  };
}

function dataset<Row>(input: {
  id: string;
  language: RowsDataset["language"];
  fileName: string;
  header: readonly string[];
  rows: readonly Row[];
  cells: (row: Row, index: number) => readonly (string | number | boolean)[];
  specs: readonly Spec<Row>[];
}): RowsDataset {
  const lines = input.rows.map((row, index) => input.cells(row, index).join(","));
  return {
    id: input.id,
    language: input.language,
    fileName: input.fileName,
    csv: `${[input.header.join(","), ...lines].join("\n")}\n`,
    rows: input.rows.length,
    pairs: input.specs.map((spec) => pairOf(input.rows, spec)),
  };
}

const serial = (prefix: string, index: number) => `${prefix}-${String(index + 1).padStart(6, "0")}`;

const within = (from: string, to: string) => (row: Trade) => row.date >= from && row.date < to;
const inYear = (year: string) => within(`${year}-01-01`, `${year}-12-32`);
const firstQuarter = (year: string) => within(`${year}-01-01`, `${year}-04-01`);
const secondQuarter = (year: string) => within(`${year}-04-01`, `${year}-07-01`);
const inRegion = (name: string) => (row: Trade) => row.region === name;
const inChannel = (name: string) => (row: Trade) => row.channel === name;
const amountOf = (row: Trade) => row.amount;

const ORDERS = trades({
  seed: 32820601,
  size: 6000,
  unitPrice: 78,
  regions: [
    { name: "North", weight: 0.27, price: 1 },
    { name: "South", weight: 0.23, price: 0.92 },
    { name: "East", weight: 0.3, price: 1.12 },
    { name: "West", weight: 0.2, price: 1.05 },
  ],
  channels: [
    { name: "Online", weight: 0.55, price: 1, notCompleted: 0.075 },
    { name: "Store", weight: 0.25, price: 1.1, notCompleted: 0.04 },
    { name: "Partner", weight: 0.2, price: 0.85, notCompleted: 0.15 },
  ],
  completed: "Completed",
  cancelled: "Cancelled",
  refunded: "Refunded",
});

const SALES = trades({
  seed: 32820604,
  size: 5000,
  unitPrice: 320,
  regions: [
    { name: "华东", weight: 0.32, price: 1.15 },
    { name: "华南", weight: 0.28, price: 1 },
    { name: "华北", weight: 0.24, price: 0.9 },
    { name: "西南", weight: 0.16, price: 0.8 },
  ],
  channels: [
    { name: "线上", weight: 0.5, price: 1, notCompleted: 0.075 },
    { name: "门店", weight: 0.3, price: 1.1, notCompleted: 0.04 },
    { name: "经销商", weight: 0.2, price: 1.5, notCompleted: 0.15 },
  ],
  completed: "已完成",
  cancelled: "已取消",
  refunded: "已退款",
});

const LOANS = loans();
const VISITS = visits();

const orderDone = (row: Trade) => row.status === "Completed";
const saleDone = (row: Trade) => row.status === "已完成";
const loanIn = (quarter: string) => (row: Loan) => row.quarter === quarter;
const loanYear = (year: string) => (row: Loan) => row.quarter.startsWith(year);
const loanProduct = (name: string) => (row: Loan) => row.product === name;
const loanBranch = (name: string) => (row: Loan) => row.branch === name;
const principalOf = (row: Loan) => row.principal;
const visitAt = (name: string) => (row: Visit) => row.clinic === name;
const visitIn = (month: string) => (row: Visit) => row.month === month;
const visitYear = (year: string) => (row: Visit) => row.month.startsWith(year);
const visitHalf = (year: string) => (row: Visit) =>
  row.month >= `${year}-01` && row.month <= `${year}-06`;
const visitOutcome = (name: string) => (row: Visit) => row.outcome === name;
const waitOf = (row: Visit) => row.wait;
const ageOf = (row: Visit) => row.age;

export const ROWS_DATASETS: readonly RowsDataset[] = [
  dataset({
    id: "orders",
    language: "en",
    fileName: "orders.csv",
    header: ["order_id", "order_date", "region", "channel", "status", "quantity", "amount_gbp"],
    rows: ORDERS,
    cells: (row, index) => [
      serial("ORD", index),
      row.date,
      row.region,
      row.channel,
      row.status,
      row.quantity,
      row.amount.toFixed(2),
    ],
    specs: [
      {
        id: "orders-01",
        question: "Value of the Completed orders placed in 2025, against all orders of 2025",
        way: "wrong-filter",
        figure: figure(1e6, 2),
        right: (rows) => total(keep(rows, orderDone, inYear("2025")), amountOf),
        wrong: (rows) => total(keep(rows, inYear("2025")), amountOf),
        say: (shown) => `Completed orders placed in 2025 were worth £${shown} million.`,
      },
      {
        id: "orders-02",
        question: "Mean value of a Completed order from the North, against the East's",
        way: "wrong-group",
        figure: figure(1, 0),
        right: (rows) => average(keep(rows, orderDone, inRegion("North")), amountOf),
        wrong: (rows) => average(keep(rows, orderDone, inRegion("East")), amountOf),
        say: (shown) => `The average completed order from the North region was worth £${shown}.`,
      },
      {
        id: "orders-03",
        question: "Median value of an Online order in 2026",
        way: "off-by-a-little",
        figure: figure(1, 0),
        right: (rows) => median(keep(rows, inChannel("Online"), inYear("2026")), amountOf),
        wrong: 0.04,
        say: (shown) => `The median Online order in 2026 was worth £${shown}.`,
      },
      {
        id: "orders-04",
        question: "Orders of the Store channel in the first quarter of 2026, against 2025's",
        way: "wrong-period",
        figure: figure(1, 0),
        right: (rows) => keep(rows, inChannel("Store"), firstQuarter("2026")).length,
        wrong: (rows) => keep(rows, inChannel("Store"), firstQuarter("2025")).length,
        say: (shown) => `The Store channel took ${shown} orders in the first quarter of 2026.`,
      },
      {
        id: "orders-05",
        question: "Largest single order from the West, against the North's",
        way: "wrong-group",
        figure: figure(1, 0),
        right: (rows) => highest(keep(rows, inRegion("West")), amountOf),
        wrong: (rows) => highest(keep(rows, inRegion("North")), amountOf),
        say: (shown) => `The largest single order from the West region was worth £${shown}.`,
      },
      {
        id: "orders-06",
        question:
          "Partner's share of the value of Completed orders in 2026, against its share of all orders",
        way: "wrong-filter",
        figure: figure(1, 1),
        right: (rows) =>
          percent(
            total(keep(rows, orderDone, inYear("2026"), inChannel("Partner")), amountOf),
            total(keep(rows, orderDone, inYear("2026")), amountOf),
          ),
        wrong: (rows) =>
          percent(
            total(keep(rows, inYear("2026"), inChannel("Partner")), amountOf),
            total(keep(rows, inYear("2026")), amountOf),
          ),
        say: (shown) =>
          `Partner orders made up ${shown}% of the value of completed orders in 2026.`,
      },
      {
        id: "orders-07",
        question: "Change in Completed order value from Q1 2025 to Q1 2026, against Q2 to Q2",
        way: "wrong-period",
        figure: figure(1, 1),
        right: (rows) =>
          change(
            total(keep(rows, orderDone, firstQuarter("2025")), amountOf),
            total(keep(rows, orderDone, firstQuarter("2026")), amountOf),
          ),
        wrong: (rows) =>
          change(
            total(keep(rows, orderDone, secondQuarter("2025")), amountOf),
            total(keep(rows, orderDone, secondQuarter("2026")), amountOf),
          ),
        say: (shown) =>
          `Completed order value rose ${shown}% from the first quarter of 2025 to the first quarter of 2026.`,
      },
      {
        id: "orders-08",
        question: "Online orders to Store orders in 2026",
        way: "off-by-a-little",
        figure: figure(1, 2),
        right: (rows) =>
          keep(rows, inChannel("Online"), inYear("2026")).length /
          keep(rows, inChannel("Store"), inYear("2026")).length,
        wrong: -0.05,
        say: (shown) => `Online orders outnumbered Store orders ${shown} to 1 in 2026.`,
      },
    ],
  }),
  dataset({
    id: "loans",
    language: "en",
    fileName: "loans.csv",
    header: [
      "loan_id",
      "branch",
      "product",
      "origination_quarter",
      "principal_usd",
      "rate_pct",
      "defaulted",
    ],
    rows: LOANS,
    cells: (row, index) => [
      serial("LN", index),
      row.branch,
      row.product,
      row.quarter,
      row.principal,
      row.rate.toFixed(2),
      row.defaulted ? "yes" : "no",
    ],
    specs: [
      {
        id: "loans-01",
        question: "Principal of the Mortgages originated in 2025 Q4, against 2025 Q3's",
        way: "wrong-period",
        figure: figure(1e6, 1),
        right: (rows) => total(keep(rows, loanProduct("Mortgage"), loanIn("2025Q4")), principalOf),
        wrong: (rows) => total(keep(rows, loanProduct("Mortgage"), loanIn("2025Q3")), principalOf),
        say: (shown) => `Mortgages originated in 2025 Q4 totalled $${shown} million in principal.`,
      },
      {
        id: "loans-02",
        question: "Mean principal of a loan at the Denver branch, against Columbus's",
        way: "wrong-group",
        figure: figure(1, 0),
        right: (rows) => average(keep(rows, loanBranch("Denver")), principalOf),
        wrong: (rows) => average(keep(rows, loanBranch("Columbus")), principalOf),
        say: (shown) =>
          `The average loan written at the Denver branch had a principal of $${shown}.`,
      },
      {
        id: "loans-03",
        question: "Median principal of an Auto loan",
        way: "off-by-a-little",
        figure: figure(1, 0),
        right: (rows) => median(keep(rows, loanProduct("Auto")), principalOf),
        wrong: -0.035,
        say: (shown) => `The median Auto loan had a principal of $${shown}.`,
      },
      {
        id: "loans-04",
        question: "Loans originated in 2025 that have not defaulted, against all of them",
        way: "wrong-filter",
        figure: figure(1, 0),
        right: (rows) => keep(rows, loanYear("2025"), (row) => !row.defaulted).length,
        wrong: (rows) => keep(rows, loanYear("2025")).length,
        say: (shown) => `${shown} loans originated in 2025 have not defaulted.`,
      },
      {
        id: "loans-05",
        question: "Largest SME loan at the Austin branch, against Portland's",
        way: "wrong-group",
        figure: figure(1, 0),
        right: (rows) => highest(keep(rows, loanProduct("SME"), loanBranch("Austin")), principalOf),
        wrong: (rows) =>
          highest(keep(rows, loanProduct("SME"), loanBranch("Portland")), principalOf),
        say: (shown) =>
          `The largest SME loan written at the Austin branch had a principal of $${shown}.`,
      },
      {
        id: "loans-06",
        question:
          "Share of the Personal loans originated in 2025 that have defaulted, against the share of all loans",
        way: "wrong-filter",
        figure: figure(1, 1),
        right: (rows) => {
          const personal = keep(rows, loanProduct("Personal"), loanYear("2025"));
          return percent(keep(personal, (row) => row.defaulted).length, personal.length);
        },
        wrong: (rows) => {
          const all = keep(rows, loanYear("2025"));
          return percent(keep(all, (row) => row.defaulted).length, all.length);
        },
        say: (shown) => `${shown}% of the Personal loans originated in 2025 have defaulted.`,
      },
      {
        id: "loans-07",
        question:
          "Change in Auto loan principal originated from 2025 Q1 to 2026 Q1, against Q2 to Q2",
        way: "wrong-period",
        figure: figure(1, 1),
        right: (rows) =>
          change(
            total(keep(rows, loanProduct("Auto"), loanIn("2025Q1")), principalOf),
            total(keep(rows, loanProduct("Auto"), loanIn("2026Q1")), principalOf),
          ),
        wrong: (rows) =>
          change(
            total(keep(rows, loanProduct("Auto"), loanIn("2025Q2")), principalOf),
            total(keep(rows, loanProduct("Auto"), loanIn("2026Q2")), principalOf),
          ),
        say: (shown) => `Auto loan principal originated rose ${shown}% from 2025 Q1 to 2026 Q1.`,
      },
      {
        id: "loans-08",
        question: "Mean Mortgage principal to mean SME principal",
        way: "off-by-a-little",
        figure: figure(1, 2),
        right: (rows) =>
          average(keep(rows, loanProduct("Mortgage")), principalOf) /
          average(keep(rows, loanProduct("SME")), principalOf),
        wrong: 0.045,
        say: (shown) => `The average mortgage was ${shown} times the size of the average SME loan.`,
      },
    ],
  }),
  dataset({
    id: "visits",
    language: "en",
    fileName: "visits.csv",
    header: ["visit_id", "clinic", "month", "age", "wait_minutes", "outcome"],
    rows: VISITS,
    cells: (row, index) => [
      serial("V", index),
      row.clinic,
      row.month,
      row.age,
      row.wait,
      row.outcome,
    ],
    specs: [
      {
        id: "visits-01",
        question: "Mean wait of the Admitted patients, against the mean of all patients",
        way: "wrong-filter",
        figure: figure(1, 0),
        right: (rows) => average(keep(rows, visitOutcome("Admitted")), waitOf),
        wrong: (rows) => average(rows, waitOf),
        say: (shown) => `Admitted patients waited ${shown} minutes on average.`,
      },
      {
        id: "visits-02",
        question: "Visits to Northgate in January 2026, against January 2025's",
        way: "wrong-period",
        figure: figure(1, 0),
        right: (rows) => keep(rows, visitAt("Northgate"), visitIn("2026-01")).length,
        wrong: (rows) => keep(rows, visitAt("Northgate"), visitIn("2025-01")).length,
        say: (shown) => `Northgate had ${shown} visits in January 2026.`,
      },
      {
        id: "visits-03",
        question: "Median age of the patients at Eastfield, against Harbourview's",
        way: "wrong-group",
        figure: figure(1, 0),
        right: (rows) => median(keep(rows, visitAt("Eastfield")), ageOf),
        wrong: (rows) => median(keep(rows, visitAt("Harbourview")), ageOf),
        say: (shown) => `The median age of patients at Eastfield was ${shown} years.`,
      },
      {
        id: "visits-04",
        question: "Longest wait at Riverside",
        way: "off-by-a-little",
        figure: figure(1, 0),
        right: (rows) => highest(keep(rows, visitAt("Riverside")), waitOf),
        wrong: 0.035,
        say: (shown) => `The longest wait at Riverside was ${shown} minutes.`,
      },
      {
        id: "visits-05",
        question: "Hours the adult patients at Riverside waited in 2025, against all its patients",
        way: "wrong-filter",
        figure: figure(1, 0),
        right: (rows) =>
          total(
            keep(rows, visitAt("Riverside"), visitYear("2025"), (row) => row.age >= 18),
            waitOf,
          ) / 60,
        wrong: (rows) => total(keep(rows, visitAt("Riverside"), visitYear("2025")), waitOf) / 60,
        say: (shown) => `Adult patients at Riverside waited ${shown} hours in total in 2025.`,
      },
      {
        id: "visits-06",
        question: "Share of visits in January 2026 that ended in an admission, against July 2025's",
        way: "wrong-period",
        figure: figure(1, 1),
        right: (rows) => {
          const month = keep(rows, visitIn("2026-01"));
          return percent(keep(month, visitOutcome("Admitted")).length, month.length);
        },
        wrong: (rows) => {
          const month = keep(rows, visitIn("2025-07"));
          return percent(keep(month, visitOutcome("Admitted")).length, month.length);
        },
        say: (shown) => `In January 2026, ${shown}% of visits ended in an admission.`,
      },
      {
        id: "visits-07",
        question:
          "Change in the mean wait at Northgate from H1 2025 to H1 2026, against Eastfield's",
        way: "wrong-group",
        figure: figure(1, 1),
        right: (rows) =>
          change(
            average(keep(rows, visitAt("Northgate"), visitHalf("2025")), waitOf),
            average(keep(rows, visitAt("Northgate"), visitHalf("2026")), waitOf),
          ),
        wrong: (rows) =>
          change(
            average(keep(rows, visitAt("Eastfield"), visitHalf("2025")), waitOf),
            average(keep(rows, visitAt("Eastfield"), visitHalf("2026")), waitOf),
          ),
        say: (shown) =>
          `The average wait at Northgate rose ${shown}% from the first half of 2025 to the first half of 2026.`,
      },
      {
        id: "visits-08",
        question: "Mean age of the Admitted patients to the mean age of the Discharged",
        way: "off-by-a-little",
        figure: figure(1, 2),
        right: (rows) =>
          average(keep(rows, visitOutcome("Admitted")), ageOf) /
          average(keep(rows, visitOutcome("Discharged")), ageOf),
        wrong: -0.04,
        say: (shown) =>
          `The average admitted patient was ${shown} times as old as the average discharged patient.`,
      },
    ],
  }),
  dataset({
    id: "sales",
    language: "zh-CN",
    fileName: "销售.csv",
    header: ["订单号", "日期", "地区", "渠道", "状态", "数量", "金额（元）"],
    rows: SALES,
    cells: (row, index) => [
      serial("XS", index),
      row.date,
      row.region,
      row.channel,
      row.status,
      row.quantity,
      row.amount.toFixed(2),
    ],
    specs: [
      {
        id: "sales-01",
        question: "Value of the Completed orders of the East in Q1 2026, against Q1 2025's",
        way: "wrong-period",
        figure: figure(1e4, 1),
        right: (rows) =>
          total(keep(rows, saleDone, inRegion("华东"), firstQuarter("2026")), amountOf),
        wrong: (rows) =>
          total(keep(rows, saleDone, inRegion("华东"), firstQuarter("2025")), amountOf),
        say: (shown) => `2026 年第一季度，华东地区已完成订单的销售额为 ${shown} 万元。`,
      },
      {
        id: "sales-02",
        question: "Mean value of an order through distributors, against stores'",
        way: "wrong-group",
        figure: figure(1, 0),
        right: (rows) => average(keep(rows, inChannel("经销商")), amountOf),
        wrong: (rows) => average(keep(rows, inChannel("门店")), amountOf),
        say: (shown) => `经销商渠道的平均订单金额为 ${shown} 元。`,
      },
      {
        id: "sales-03",
        question: "Median value of an order in the South",
        way: "off-by-a-little",
        figure: figure(1, 0),
        right: (rows) => median(keep(rows, inRegion("华南")), amountOf),
        wrong: 0.03,
        say: (shown) => `华南地区订单金额的中位数为 ${shown} 元。`,
      },
      {
        id: "sales-04",
        question: "Orders Completed in 2025, against all orders of 2025",
        way: "wrong-filter",
        figure: figure(1, 0),
        right: (rows) => keep(rows, saleDone, inYear("2025")).length,
        wrong: (rows) => keep(rows, inYear("2025")).length,
        say: (shown) => `2025 年共有 ${shown} 笔订单已完成。`,
      },
      {
        id: "sales-05",
        question: "Largest single order from the Southwest, against the North's",
        way: "wrong-group",
        figure: figure(1, 0),
        right: (rows) => highest(keep(rows, inRegion("西南")), amountOf),
        wrong: (rows) => highest(keep(rows, inRegion("华北")), amountOf),
        say: (shown) => `西南地区的单笔订单金额最高为 ${shown} 元。`,
      },
      {
        id: "sales-06",
        question:
          "Distributors' share of the value of Completed orders in 2026, against their share of all orders",
        way: "wrong-filter",
        figure: figure(1, 1),
        right: (rows) =>
          percent(
            total(keep(rows, saleDone, inYear("2026"), inChannel("经销商")), amountOf),
            total(keep(rows, saleDone, inYear("2026")), amountOf),
          ),
        wrong: (rows) =>
          percent(
            total(keep(rows, inYear("2026"), inChannel("经销商")), amountOf),
            total(keep(rows, inYear("2026")), amountOf),
          ),
        say: (shown) => `经销商订单占 2026 年已完成订单销售额的 ${shown}%。`,
      },
      {
        id: "sales-07",
        question: "Change in Completed order value from Q1 2025 to Q1 2026, against Q2 to Q2",
        way: "wrong-period",
        figure: figure(1, 1),
        right: (rows) =>
          change(
            total(keep(rows, saleDone, firstQuarter("2025")), amountOf),
            total(keep(rows, saleDone, firstQuarter("2026")), amountOf),
          ),
        wrong: (rows) =>
          change(
            total(keep(rows, saleDone, secondQuarter("2025")), amountOf),
            total(keep(rows, saleDone, secondQuarter("2026")), amountOf),
          ),
        say: (shown) => `2026 年第一季度已完成订单的销售额同比增长 ${shown}%。`,
      },
      {
        id: "sales-08",
        question: "Online orders to store orders",
        way: "off-by-a-little",
        figure: figure(1, 2),
        right: (rows) =>
          keep(rows, inChannel("线上")).length / keep(rows, inChannel("门店")).length,
        wrong: -0.045,
        say: (shown) => `线上渠道的订单数是门店渠道的 ${shown} 倍。`,
      },
    ],
  }),
];
