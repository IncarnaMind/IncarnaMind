/**
 * Held-out evaluation set for #1979: sheets that hold an older and a current version of the same
 * rows, and decoys that don't. Written before any measured run of the change, and apart from the
 * load worksheet the change was developed on; its domains (an order, fees, a budget, an
 * allowance, expenses, rates, a quote) and its words appear in no instruction.
 *
 * - The file sets the older rows aside: struck through (an order; a quote with formulas) or
 *   hidden (fees, in Chinese). An Answer about the current state cites the current rows, and
 *   names every input that changed; equal totals and line totals in both versions are the decoys.
 * - Nothing in the file says which row is current (a budget; an allowance, in Chinese): the
 *   Answer says so and gives both, never one of them or their sum as the current figure.
 * - The set-aside rows come after the current ones (insurance, struck through; a supplier's
 *   prices, hidden, in Chinese), so the order of the rows doesn't give the current ones away. These
 *   two were added after the first run of main, before any run of the change: main had read the
 *   later rows as current in every case above, and was right only because they came last.
 * - Decoys: an expense log whose repeated items are separate entries to add up; a rate card whose
 *   dates say which rate is current; a budget whose status column says which version is.
 */
import { type SheetRow, sheetWithRows } from "./sheetRows";

export interface HeldOutCase {
  name: string;
  language: "en" | "zh-CN";
  file: string;
  workbook: () => Buffer;
  question: string;
  /** Rows an Answer must cite, by number. */
  cites: number[];
  /** Figures an Answer must give, as it may write them. */
  gives: string[][];
  /** Figures an Answer must never give: the versions added up. */
  never: string[];
  /** For a what-if: the figure's cell, the input changed and its new value, and the result. */
  whatIf?: { cell: string; input: string; value: number; result: number };
  /** What a person reads each Answer for, beyond what is checked here. */
  read: string;
}

const money = (value: number) => ({ value, format: "0.00" as const });
const whole = (value: number) => ({ value, format: "#,##0" as const });

const order = (struck: boolean): SheetRow[] => [
  { cells: ["Laptop stand", money(46.2), 10, money(462)], struck },
  { cells: ["Desk lamp", money(25), 4, money(100)], struck },
  { cells: ["Total", "", "", money(562)], struck },
];

export const SUPERSEDED_HELD_OUT: readonly HeldOutCase[] = [
  {
    name: "order, older rows struck through",
    language: "en",
    file: "Supplier order.xlsx",
    workbook: () =>
      sheetWithRows("Order", [
        { cells: ["Item", "Unit price", "Quantity", "Line total"] },
        ...order(true),
        { cells: ["Laptop stand", money(38.5), 12, money(462)] },
        { cells: ["Desk lamp", money(25), 4, money(100)] },
        { cells: ["Total", "", "", money(562)] },
      ]),
    question:
      "What are the laptop stand's unit price and quantity on the order now, and what does the order come to? What changed from the earlier version?",
    cites: [5],
    gives: [["38.50"], ["562.00", "562"]],
    never: [],
    read: "The current figures are cited to rows 5–7, never to struck rows 2–4; the unit price (46.20 to 38.50) and the quantity (10 to 12) are both named as changed, though both totals are the same.",
  },
  {
    name: "fees, older rows hidden",
    language: "zh-CN",
    file: "收费标准.xlsx",
    workbook: () =>
      sheetWithRows("收费标准", [
        { cells: ["项目", "单价（元）", "数量", "小计（元）"] },
        { cells: ["审计费", whole(18000), 1, whole(18000)], hidden: true },
        { cells: ["税务咨询", whole(1500), 6, whole(9000)], hidden: true },
        { cells: ["合计", "", "", whole(27000)], hidden: true },
        { cells: ["审计费", whole(21000), 1, whole(21000)] },
        { cells: ["税务咨询", whole(1500), 8, whole(12000)] },
        { cells: ["合计", "", "", whole(33000)] },
      ]),
    question: "当前收费合计是多少？审计费现在的单价是多少？与之前的版本相比，哪些输入变了？",
    cites: [5, 7],
    gives: [
      ["33,000", "33000"],
      ["21,000", "21000"],
    ],
    never: [],
    read: "The current figures are cited to rows 5–7, never to hidden rows 2–4; the audit fee's unit price (18,000 to 21,000) and the tax advice quantity (6 to 8) are both named as changed.",
  },
  {
    name: "insurance, older rows struck through below the current ones",
    language: "en",
    file: "Insurance schedule.xlsx",
    workbook: () =>
      sheetWithRows("Policies", [
        { cells: ["Policy", "Annual premium", "Excess"] },
        { cells: ["Buildings", whole(2450), whole(500)] },
        { cells: ["Contents", whole(610), whole(100)] },
        { cells: ["Buildings", whole(2180), whole(250)], struck: true },
        { cells: ["Contents", whole(610), whole(100)], struck: true },
      ]),
    question:
      "What are the buildings policy's annual premium and excess now, and what changed from before?",
    cites: [2],
    gives: [["2,450", "2450"], ["500"]],
    never: [],
    read: "The current premium and excess are cited to row 2, never to struck row 4; the premium (2,180 to 2,450) and the excess (250 to 500) are both named as changed.",
  },
  {
    name: "supplier prices, older rows hidden below the current ones",
    language: "zh-CN",
    file: "供应商报价.xlsx",
    workbook: () =>
      sheetWithRows("报价", [
        { cells: ["物料", "单价（元）", "起订量"] },
        { cells: ["铝型材", money(26.8), whole(500)] },
        { cells: ["紧固件", money(0.35), whole(2000)] },
        { cells: ["铝型材", money(24.5), whole(300)], hidden: true },
        { cells: ["紧固件", money(0.35), whole(1000)], hidden: true },
      ]),
    question: "铝型材现在的单价和起订量是多少？与之前相比有什么变化？",
    cites: [2],
    gives: [["26.80"], ["500"]],
    never: [],
    read: "The current price and minimum order are cited to row 2, never to hidden row 4; the price (24.50 to 26.80) and the minimum order (300 to 500) are both named as changed.",
  },
  {
    name: "budget, nothing says which row is current",
    language: "en",
    file: "Department budget.xlsx",
    workbook: () =>
      sheetWithRows("Budget", [
        { cells: ["Line", "Monthly", "Months", "Annual"] },
        { cells: ["Software licences", whole(1200), 12, whole(14400)] },
        { cells: ["Office rent", whole(3500), 12, whole(42000)] },
        { cells: ["Travel", whole(800), 12, whole(9600)] },
        { cells: ["Software licences", whole(1450), 12, whole(17400)] },
      ]),
    question: "What is the current annual budget for software licences?",
    cites: [2, 5],
    gives: [
      ["14,400", "14400"],
      ["17,400", "17400"],
    ],
    never: ["31,800", "31800"],
    read: "The Answer says the budget doesn't make clear which software licences row is current and gives both; it never states one of them, or their sum, as the current figure.",
  },
  {
    name: "allowance, nothing says which row is current",
    language: "zh-CN",
    file: "补贴标准.xlsx",
    workbook: () =>
      sheetWithRows("补贴", [
        { cells: ["项目", "每天标准", "天数", "金额"] },
        { cells: ["差旅补贴", 300, 20, 6000] },
        { cells: ["通讯补贴", 100, 20, 2000] },
        { cells: ["差旅补贴", 350, 20, 7000] },
      ]),
    question: "差旅补贴现在的每天标准是多少？",
    cites: [2, 4],
    gives: [["300"], ["350"]],
    never: ["650"],
    read: "The Answer says the sheet doesn't make clear which travel allowance row is current and gives both 300 and 350; it never states one as the current standard.",
  },
  {
    name: "decoy: an expense log's repeated items are separate entries",
    language: "en",
    file: "Trip expenses.xlsx",
    workbook: () =>
      sheetWithRows("Expenses", [
        { cells: ["Item", "Amount"] },
        { cells: ["Taxi", money(18.4)] },
        { cells: ["Lunch", money(12)] },
        { cells: ["Taxi", money(22.1)] },
        { cells: ["Hotel", money(145)] },
        { cells: ["Taxi", money(9.75)] },
      ]),
    question: "How much did the taxis come to in total?",
    cites: [2, 4, 6],
    gives: [["50.25"]],
    never: [],
    read: "The Answer adds the three taxi entries up to 50.25 and doesn't say it can't tell which is current.",
  },
  {
    name: "decoy: dates say which rate is current",
    language: "en",
    file: "Rate card.xlsx",
    workbook: () =>
      sheetWithRows("Rates", [
        { cells: ["Role", "Effective from", "Hourly rate"] },
        { cells: ["Senior consultant", "2026-01-01", 180] },
        { cells: ["Analyst", "2026-01-01", 95] },
        { cells: ["Senior consultant", "2026-07-01", 195] },
      ]),
    question: "What is the senior consultant's current hourly rate?",
    cites: [4],
    gives: [["195"]],
    never: [],
    read: "The Answer gives 195, effective from 2026-07-01, as the current rate, and doesn't say it can't tell which is current.",
  },
  {
    name: "decoy: a status column says which version is current",
    language: "zh-CN",
    file: "推广预算.xlsx",
    workbook: () =>
      sheetWithRows("预算", [
        { cells: ["版本", "状态", "项目", "金额"] },
        { cells: ["V1", "已作废", "市场推广", whole(50000)] },
        { cells: ["V1", "已作废", "培训", whole(12000)] },
        { cells: ["V2", "现行", "市场推广", whole(65000)] },
        { cells: ["V2", "现行", "培训", whole(12000)] },
      ]),
    question: "市场推广现在的预算是多少？和上一版相比变了多少？",
    cites: [4],
    gives: [["65,000", "65000"]],
    never: [],
    read: "The Answer gives 65,000 from the V2 row as the current budget and the change of 15,000 from V1, and doesn't say it can't tell which is current.",
  },
  {
    name: "quote with formulas, older rows struck through: a what-if",
    language: "en",
    file: "Parts quote.xlsx",
    workbook: () =>
      sheetWithRows("Quote", [
        { cells: ["Item", "Unit cost", "Quantity", "Cost"] },
        {
          cells: ["Widgets", money(4), 20, { formula: "B2*C2", value: 80, format: "0.00" }],
          struck: true,
        },
        {
          cells: ["Brackets", money(2.5), 8, { formula: "B3*C3", value: 20, format: "0.00" }],
          struck: true,
        },
        {
          cells: ["Total", "", "", { formula: "SUM(D2:D3)", value: 100, format: "0.00" }],
          struck: true,
        },
        { cells: ["Widgets", money(3.6), 10, { formula: "B5*C5", value: 36, format: "0.00" }] },
        { cells: ["Brackets", money(2.5), 8, { formula: "B6*C6", value: 20, format: "0.00" }] },
        { cells: ["Total", "", "", { formula: "SUM(D5:D6)", value: 56, format: "0.00" }] },
      ]),
    question: "If the widget quantity were 15, what would the quote's total come to?",
    cites: [],
    gives: [["74.00", "74"]],
    never: [],
    whatIf: { cell: "Quote!D7", input: "Quote!C5", value: 15, result: 74 },
    read: "The what-if changes the current widget quantity (C5) and works out the current total (D7) as 74.00, never the struck rows' 80.00.",
  },
];

/**
 * A second held-out set, written after the first run of the change, when an expense log's
 * separate entries were refused a total, and committed before the reworded instruction was run on
 * any held-out sheet. It leans on the decoys that run found weak: repeated items to add up, and a
 * long table whose years tell its rows apart; beside them, rows nothing tells apart, and set-aside
 * rows in other places, a what-if among them.
 */
export const SUPERSEDED_HELD_OUT_SECOND: readonly HeldOutCase[] = [
  {
    name: "decoy: petty cash entries to add up",
    language: "en",
    file: "Petty cash.xlsx",
    workbook: () =>
      sheetWithRows("Petty cash", [
        { cells: ["Paid for", "Amount"] },
        { cells: ["Postage", money(6.85)] },
        { cells: ["Milk", money(2.4)] },
        { cells: ["Postage", money(12.3)] },
        { cells: ["Postage", money(3.15)] },
        { cells: ["Batteries", money(7.99)] },
      ]),
    question: "What did postage cost altogether?",
    cites: [2, 4, 5],
    gives: [["22.30", "22.3"]],
    never: [],
    read: "The Answer adds the three postage entries up to 22.30 and doesn't say it can't tell which is current.",
  },
  {
    name: "decoy: purchase lines to add up",
    language: "zh-CN",
    file: "采购明细.xlsx",
    workbook: () =>
      sheetWithRows("明细", [
        { cells: ["品名", "数量", "金额（元）"] },
        { cells: ["打印纸", 5, money(115)] },
        { cells: ["墨盒", 2, money(260)] },
        { cells: ["打印纸", 3, money(69)] },
      ]),
    question: "打印纸一共花了多少钱？",
    cites: [2, 4],
    gives: [["184.00", "184"]],
    never: [],
    read: "The Answer adds the two printer paper lines up to 184 and doesn't say it can't tell which is current.",
  },
  {
    name: "decoy: years tell a long table's rows apart",
    language: "en",
    file: "Regional revenue.xlsx",
    workbook: () =>
      sheetWithRows("Revenue", [
        { cells: ["Region", "Year", "Revenue"] },
        { cells: ["North", 2024, whole(1200)] },
        { cells: ["South", 2024, whole(900)] },
        { cells: ["North", 2025, whole(1350)] },
        { cells: ["South", 2025, whole(980)] },
      ]),
    question: "What was the total revenue across both regions in 2025?",
    cites: [4, 5],
    gives: [["2,330", "2330"]],
    never: [],
    read: "The Answer adds the two 2025 rows up to 2,330 and doesn't say it can't tell which is current.",
  },
  {
    name: "shipping, nothing says which row is current",
    language: "en",
    file: "Shipping rates.xlsx",
    workbook: () =>
      sheetWithRows("Rates", [
        { cells: ["Service", "Price"] },
        { cells: ["Standard delivery", money(4.95)] },
        { cells: ["Express delivery", money(9.95)] },
        { cells: ["Standard delivery", money(5.45)] },
      ]),
    question: "What does standard delivery cost at the moment?",
    cites: [2, 4],
    gives: [["4.95"], ["5.45"]],
    never: ["10.40"],
    read: "The Answer says the sheet doesn't make clear which standard delivery row is current and gives both; it never states one as the current price.",
  },
  {
    name: "meal allowance, nothing says which row is current",
    language: "zh-CN",
    file: "餐补.xlsx",
    workbook: () =>
      sheetWithRows("餐补", [
        { cells: ["项目", "每天（元）"] },
        { cells: ["午餐补贴", 25] },
        { cells: ["晚餐补贴", 20] },
        { cells: ["午餐补贴", 30] },
      ]),
    question: "午餐补贴目前是每天多少？",
    cites: [2, 4],
    gives: [["25"], ["30"]],
    never: ["55"],
    read: "The Answer says the sheet doesn't make clear which lunch allowance row is current and gives both; it never states one as the current figure.",
  },
  {
    name: "headcount plan, older rows struck through",
    language: "zh-CN",
    file: "人员计划.xlsx",
    workbook: () =>
      sheetWithRows("人员", [
        { cells: ["部门", "人数", "人均月薪（元）"] },
        { cells: ["研发", 12, whole(18000)], struck: true },
        { cells: ["销售", 8, whole(12000)], struck: true },
        { cells: ["研发", 15, whole(18000)] },
        { cells: ["销售", 8, whole(13000)] },
      ]),
    question: "研发部现在计划多少人？和原来的计划比，哪些数字变了？",
    cites: [4],
    gives: [["15"]],
    never: [],
    read: "The current headcount is cited to row 4, never to struck row 2; R&D headcount (12 to 15) and sales monthly pay (12,000 to 13,000) are named as changed.",
  },
  {
    name: "membership fees, older rows hidden below the current ones",
    language: "en",
    file: "Membership fees.xlsx",
    workbook: () =>
      sheetWithRows("Fees", [
        { cells: ["Tier", "Monthly fee", "Joining fee"] },
        { cells: ["Standard", money(39), money(25)] },
        { cells: ["Premium", money(64), money(0)] },
        { cells: ["Standard", money(35), money(25)], hidden: true },
        { cells: ["Premium", money(59), money(50)], hidden: true },
      ]),
    question:
      "What are the Premium tier's monthly and joining fees now, and how do they differ from before?",
    cites: [3],
    gives: [["64.00", "64"]],
    never: [],
    read: "The current fees are cited to row 3, never to hidden row 5; the monthly fee (59 to 64) and the joining fee (50 to 0) are both named as changed.",
  },
  {
    name: "project budget with formulas, older rows hidden: a what-if",
    language: "zh-CN",
    file: "项目预算.xlsx",
    workbook: () =>
      sheetWithRows("预算", [
        { cells: ["费用", "单价", "数量", "金额"] },
        {
          cells: ["外包设计", whole(8000), 3, { formula: "B2*C2", value: 24000, format: "#,##0" }],
          hidden: true,
        },
        {
          cells: ["服务器", whole(1500), 4, { formula: "B3*C3", value: 6000, format: "#,##0" }],
          hidden: true,
        },
        {
          cells: ["合计", "", "", { formula: "SUM(D2:D3)", value: 30000, format: "#,##0" }],
          hidden: true,
        },
        {
          cells: ["外包设计", whole(9000), 2, { formula: "B5*C5", value: 18000, format: "#,##0" }],
        },
        { cells: ["服务器", whole(1500), 6, { formula: "B6*C6", value: 9000, format: "#,##0" }] },
        { cells: ["合计", "", "", { formula: "SUM(D5:D6)", value: 27000, format: "#,##0" }] },
      ]),
    question: "如果服务器的数量改成 8 台，预算合计会是多少？",
    cites: [],
    gives: [["30,000", "30000", "3万"]],
    never: [],
    whatIf: { cell: "预算!D7", input: "预算!C6", value: 8, result: 30000 },
    read: "The what-if changes the shown server quantity (C6) and works out the shown total (D7) as 30,000, never the hidden rows' 36,000.",
  },
];
