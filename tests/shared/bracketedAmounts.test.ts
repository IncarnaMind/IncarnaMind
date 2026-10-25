/**
 * Amounts in brackets (#978). Accountants write a negative as "(12,400)", so
 * a figure in a statement or a table's cell is minus; the same brackets in
 * running text are an aside, and a year, a note, a page or a list's "(a)" in
 * brackets is no amount at all. What the text can't settle (a lone "(250)", a
 * percent in brackets, a debit) is a question, never a guess. A count of
 * people in brackets is never a minus (#1023), and a currency sign inside the
 * brackets of a statement line is. Wrongly making a figure negative is the
 * worse mistake, so each case names every figure the text holds, as the
 * reader gives it.
 */
import { describe, expect, test } from "vitest";
import {
  type AmbiguityKind,
  type Figure,
  type FigureContext,
  figureContextOf,
  readFigures,
} from "../../src/shared/figures";

type Expected = [chars: string, value: number, questions?: AmbiguityKind[]];
type Case = [name: string, text: string, figures: Expected[], context?: FigureContext];

const EN: FigureContext = { language: "en" };
const ZH: FigureContext = { language: "zh-CN" };
const EN_ACCOUNTS: FigureContext = { ...EN, accounts: true };
const ZH_ACCOUNTS: FigureContext = { ...ZH, accounts: true };

const NEGATIVE_EN: Case[] = [
  ["an amount in brackets", "(12,400)", [["(12,400)", -12400]]],
  ["with the currency inside", "(£12,400)", [["(£12,400)", -12400]]],
  ["with the currency outside", "£(12,400)", [["£(12,400)", -12400]]],
  ["with a code outside", "USD(1,250)", [["USD(1,250)", -1250]]],
  ["with pence", "(£12,500.00)", [["(£12,500.00)", -12500]]],
  ["with spaces inside", "( 12,500.00 )", [["( 12,500.00 )", -12500]]],
  ["with the scale after", "(12.4)m", [["(12.4)m", -12400000]]],
  ["a debit after brackets", "(12,500.00) DR", [["(12,500.00) DR", -12500]]],
  ["a deduction in a statement", "Less: agent's fee (4,620.00)", [["(4,620.00)", -4620]]],
  [
    "a column after a figure",
    "Profit 12,400 (3,100)",
    [
      ["12,400", 12400],
      ["(3,100)", -3100],
    ],
  ],
  [
    "two cells of a row",
    "Interest paid\t(£340)\t(£280)",
    [
      ["(£340)", -340],
      ["(£280)", -280],
    ],
  ],
  ["a scale in a cell of a table row", "Net loss\t($1.2bn)", [["($1.2bn)", -1200000000]]],
  [
    "scales in cells between bars",
    "Net loss | ($1.2bn) | ($0.9bn)",
    [
      ["($1.2bn)", -1200000000],
      ["($0.9bn)", -900000000],
    ],
  ],
  [
    "a small amount with its currency, in a statement",
    "Less: search costs (£25)",
    [["(£25)", -25]],
  ],
  [
    "a whole number in a statement of accounts",
    "Less: legal fees (250)",
    [["(250)", -250]],
    EN_ACCOUNTS,
  ],
  ["a whole number in a cell of accounts", "Rent\t(250)", [["(250)", -250]], EN_ACCOUNTS],
  ["a whole number under a unit header", "£'000\nRent\t(250)", [["(250)", -250, ["scale"]]]],
  [
    "a scale on a statement line of accounts",
    "Impairment (£1.2m)",
    [["(£1.2m)", -1200000]],
    EN_ACCOUNTS,
  ],
  [
    "a scale on a statement line, spelled out",
    "Impairment ($1.2 million)",
    [["($1.2 million)", -1200000]],
    EN_ACCOUNTS,
  ],
  [
    "a currency code with a scale",
    "Impairment (USD 1.2bn)",
    [["(USD 1.2bn)", -1200000000]],
    EN_ACCOUNTS,
  ],
  [
    "the currency outside, the scale inside",
    "Impairment £(1.2m)",
    [["£(1.2m)", -1200000]],
    EN_ACCOUNTS,
  ],
  [
    "a scale on a statement line under a unit header",
    "£'000\nImpairment (£1.2m)",
    [["(£1.2m)", -1200000]],
  ],
  ["a scale in a statement table's row", "Impairment\t(£1.2m)", [["(£1.2m)", -1200000]]],
  [
    "a figure of a statement line that isn't a count of people",
    "Staff costs (1,250)",
    [["(1,250)", -1250]],
  ],
  ["a count label with an amount's currency", "Staff (£1,250)", [["(£1,250)", -1250]]],
  ["a count label with the currency outside", "Staff £(1,250)", [["£(1,250)", -1250]]],
  ["employees with a dollar outside", "Employees $(1,250)", [["$(1,250)", -1250]]],
  ["a headcount's size with the currency outside", "Headcount £(250)", [["£(250)", -250]]],
  ["cash paid to people", "Cash paid to suppliers and employees (12,500)", [["(12,500)", -12500]]],
  ["payments to people", "Payments to employees (12,500)", [["(12,500)", -12500]]],
  ["amounts owed to people", "Amounts owed to staff (12,500)", [["(12,500)", -12500]]],
  ["loans from people", "Loans from employees (1,250)", [["(1,250)", -1250]]],
  ["the cost of people", "Cost of staff (1,250)", [["(1,250)", -1250]]],
  ["money per person", "Revenue per employee (125)", [["(125)", -125]], EN_ACCOUNTS],
  [
    "money per person under a unit header",
    "£'000\nRevenue per employee (125)",
    [["(125)", -125, ["scale"]]],
  ],
  [
    "money paid to people, in a table's cell",
    "Payments to staff\t(250)",
    [["(250)", -250]],
    EN_ACCOUNTS,
  ],
  [
    "a cost of staff under a unit header",
    "£'000\nStaff costs (1,250)",
    [["(1,250)", -1250, ["scale"]]],
  ],
  [
    "a count label that doesn't end the line's words",
    "Employees' benefits\t(1,250)",
    [["(1,250)", -1250]],
  ],
];

const NEGATIVE_ZH: Case[] = [
  ["a full-width bracket", "（12,400）", [["（12,400）", -12400]]],
  ["with pence", "（12,400.50）", [["（12,400.50）", -12400.5]]],
  ["with a yuan sign inside", "（¥12,400）", [["（¥12,400）", -12400]]],
  ["a deduction in a statement", "减：中介费 （46,200.00）", [["（46,200.00）", -46200]]],
  [
    "a whole number in a statement of accounts",
    "减：中介费 （250）",
    [["（250）", -250]],
    ZH_ACCOUNTS,
  ],
  [
    "a scale in a cell of a table row",
    "净亏损\t（1.2亿元）",
    [["（1.2亿元）", -120000000]],
    ZH_ACCOUNTS,
  ],
  [
    "a table under a unit header",
    "单位：万元\n管理费用\t（250）\t（300）",
    [
      ["（250）", -250, ["scale"]],
      ["（300）", -300, ["scale"]],
    ],
  ],
  [
    "a yuan sign and a scale on a statement line of accounts",
    "减值损失（¥1.2亿）",
    [["（¥1.2亿）", -120000000]],
    ZH_ACCOUNTS,
  ],
  [
    "a currency word before the scale",
    "减值损失（人民币1.2亿元）",
    [["（人民币1.2亿元）", -120000000]],
    ZH_ACCOUNTS,
  ],
  [
    "a yuan sign and a scale on a statement line under a unit header",
    "单位：万元\n减值损失（¥1.2亿）",
    [["（¥1.2亿）", -120000000]],
  ],
  ["a count label with the yuan sign outside", "员工 ¥（1,250）", [["¥（1,250）", -1250]]],
  ["cash paid to people", "支付给员工（12,500）", [["（12,500）", -12500]]],
  ["money per person", "每名员工（125）", [["（125）", -125]], ZH_ACCOUNTS],
  ["amounts owed to people", "应付员工（1,250）", [["（1,250）", -1250]]],
  ["a cost of staff, not a count", "员工成本（1,250）", [["（1,250）", -1250]]],
];

const POSITIVE_EN: Case[] = [
  ["the fund", "the fund (£2.1bn) invested", [["£2.1bn", 2100000000]]],
  ["a market value", "a market value (US$3 trillion)", [["US$3 trillion", 3000000000000]]],
  [
    "a count of properties",
    "12 properties (£4.5m)",
    [
      ["12", 12],
      ["£4.5m", 4500000],
    ],
  ],
  ["a small fee in a phrase", "a fee (£25)", []],
  ["a lone restated amount", "(US$170 million)", [["US$170 million", 170000000]]],
  [
    "a scale in running text",
    "The loss was £5m (£1.2bn including tax).",
    [
      ["£5m", 5000000],
      ["£1.2bn", 1200000000],
    ],
  ],
  [
    "an amount restated in another currency",
    "revenue of RMB 1.2 billion (US$170 million)",
    [
      ["RMB 1.2 billion", 1200000000],
      ["US$170 million", 170000000],
    ],
  ],
  [
    "sterling restated in dollars",
    "£5m ($6.3m)",
    [
      ["£5m", 5000000],
      ["$6.3m", 6300000],
    ],
  ],
  [
    "a restated amount in a cell of its own",
    "Revenue\t¥1.2bn\t($170m)",
    [
      ["¥1.2bn", 1200000000, ["currency"]],
      ["$170m", 170000000],
    ],
  ],
  ["a doctor, not a debit", "balance 1,200.50 Dr. Smith", [["1,200.50", 1200.5]]],
  [
    "a whole number in running text of accounts",
    "Legal fees (250) were paid in June.",
    [["(250)", 250, ["sign"]]],
    EN_ACCOUNTS,
  ],
  [
    "a whole number after a sentence",
    "He paid on paper (250) of the order.",
    [["(250)", 250, ["sign"]]],
    EN_ACCOUNTS,
  ],
  [
    "a whole number in a statement, outside accounts",
    "Less: legal fees (250)",
    [["(250)", 250, ["sign"]]],
  ],
  [
    "a scale in a statement's sentence",
    "Impairment (£1.2m) was charged in June.",
    [["£1.2m", 1200000]],
  ],
  [
    "a scale in running text of accounts",
    "the impairment (£1.2m) charged",
    [["£1.2m", 1200000]],
    EN_ACCOUNTS,
  ],
  [
    "an amount restated on a statement line",
    "Revenue of RMB 1.2 billion (US$170 million)",
    [
      ["RMB 1.2 billion", 1200000000],
      ["US$170 million", 170000000],
    ],
  ],
  [
    "a scale with no currency sign on a statement line",
    "Impairment (1.2m)",
    [["1.2m", 1200000]],
    EN_ACCOUNTS,
  ],
  ["a fund's size on a label line", "Fund (£2.1bn)", [["£2.1bn", 2100000000]]],
  ["assets under management", "AUM (US$2.1bn)", [["US$2.1bn", 2100000000]]],
  ["a company's size", "Acme Ltd (US$1.2bn)", [["US$1.2bn", 1200000000]]],
  ["a scale on a label line outside accounts", "Impairment (£1.2m)", [["£1.2m", 1200000]]],
  [
    "a label line of a deck",
    "Total assets (£4.5m)\nNet loss (£1.2m)",
    [
      ["£4.5m", 4500000],
      ["£1.2m", 1200000],
    ],
  ],
];

const COUNTS_EN: Case[] = [
  ["headcount", "Headcount (250)", [["(250)", 250]], EN_ACCOUNTS],
  ["headcount, outside accounts", "Headcount (250)", [["(250)", 250]]],
  ["employees", "Employees (1,250)", [["(1,250)", 1250]]],
  ["staff", "Staff (1,250)", [["(1,250)", 1250]]],
  ["FTEs", "FTE (12.5)", [["(12.5)", 12.5]]],
  ["people", "People (1,250)", [["(1,250)", 1250]], EN_ACCOUNTS],
  ["a label in capitals", "HEADCOUNT (250)", [["(250)", 250]], EN_ACCOUNTS],
  ["a label of several words", "Average number of employees (1,250)", [["(1,250)", 1250]]],
  ["a total", "Total number of staff (250)", [["(250)", 250]], EN_ACCOUNTS],
  [
    "a number of full-time staff",
    "Number of full-time employees (250)",
    [["(250)", 250]],
    EN_ACCOUNTS,
  ],
  ["an average headcount", "Average headcount (1,250)", [["(1,250)", 1250]]],
  ["a count after a year", "In 2025 headcount (250) rose.", [["(250)", 250]], EN_ACCOUNTS],
  ["a count with its unit", "Employees (1,250 staff)", [["1,250 staff", 1250]]],
  ["a count under a unit header", "£'000\nHeadcount (250)", [["(250)", 250]]],
  ["a count under a scale header", "(in millions)\nEmployees (1,250)", [["(1,250)", 1250]]],
  [
    "a count in the cells of a table's row",
    "Headcount\t(250)\t(240)",
    [
      ["(250)", 250],
      ["(240)", 240],
    ],
    EN_ACCOUNTS,
  ],
  [
    "a count between bars",
    "| Employees | (1,250) | (1,100) |",
    [
      ["(1,250)", 1250],
      ["(1,100)", 1100],
    ],
  ],
  ["a count with a scale in a table's cell", "Staff\t(1.2m)", [["(1.2m)", 1200000]]],
  ["a count in running text", "Our headcount (250) grew.", [["(250)", 250]], EN_ACCOUNTS],
  [
    "a count after another count",
    "We had 250 staff (1,250).",
    [
      ["250 staff", 250],
      ["(1,250)", 1250],
    ],
  ],
];

const POSITIVE_ZH: Case[] = [
  ["a yuan amount in a phrase", "（¥1.2亿）", [["¥1.2亿", 120000000]]],
  ["R&D spending in accounts", "研发投入（1.2亿元）", [["1.2亿元", 120000000]], ZH_ACCOUNTS],
  [
    "an amount restated in another currency",
    "营业收入12亿元（1.7亿美元）",
    [
      ["12亿元", 1200000000],
      ["1.7亿美元", 170000000],
    ],
  ],
  [
    "an approximate restatement",
    "营业收入12亿元（约1.7亿美元）",
    [
      ["12亿元", 1200000000],
      ["1.7亿美元", 170000000],
    ],
  ],
  [
    "a number in a sentence of accounts",
    "公司的研发投入（250）已披露。",
    [["（250）", 250, ["sign"]]],
    ZH_ACCOUNTS,
  ],
  ["a yuan sign in a statement's sentence", "减值损失（¥1.2亿）已确认。", [["¥1.2亿", 120000000]]],
  ["a fund's size on a label line", "基金规模（¥2.1亿）", [["¥2.1亿", 210000000]]],
  ["a yuan sign on a label line outside accounts", "减值损失（¥1.2亿）", [["¥1.2亿", 120000000]]],
  ["a currency word on a label line", "减值损失（人民币1.2亿元）", [["人民币1.2亿元", 120000000]]],
];

const COUNTS_ZH: Case[] = [
  ["人数", "Staff 人数（250）", [["（250）", 250]], ZH_ACCOUNTS],
  ["人数, outside accounts", "员工人数（250）", [["（250）", 250]]],
  ["员工", "员工（1,250）", [["（1,250）", 1250]]],
  ["人员", "技术人员（1,250）", [["（1,250）", 1250]], ZH_ACCOUNTS],
  ["职工", "职工（1,250）", [["（1,250）", 1250]]],
  ["a count with its unit", "员工（1,250人）", [["1,250人", 1250]]],
  ["a count at the end of the year", "期末员工人数（250）", [["（250）", 250]], ZH_ACCOUNTS],
  ["a count under a unit header", "单位：万元\n员工人数（250）", [["（250）", 250]]],
  [
    "a count in the cells of a row",
    "员工人数\t（250）\t（240）",
    [
      ["（250）", 250],
      ["（240）", 240],
    ],
    ZH_ACCOUNTS,
  ],
];

const PERCENTS: Case[] = [
  ["growth", "growth of (12.5%)", [["(12.5%)", 0.125, ["sign"]]], EN_ACCOUNTS],
  ["a deposit", "The deposit (10%)", [["(10%)", 0.1, ["sign"]]], EN_ACCOUNTS],
  ["a margin in a statement", "Gross margin (3.2%)", [["(3.2%)", 0.032, ["sign"]]], EN_ACCOUNTS],
  ["a margin in a table's cell", "Margin\t(3.2%)", [["(3.2%)", 0.032, ["sign"]]], EN_ACCOUNTS],
  ["a share in Chinese", "增长率（12.5%）", [["（12.5%）", 0.125, ["sign"]]], ZH_ACCOUNTS],
  ["a staff share", "Staff (12.5%)", [["(12.5%)", 0.125, ["sign"]]], EN_ACCOUNTS],
  ["a staff share in Chinese", "员工（12.5%）", [["（12.5%）", 0.125, ["sign"]]], ZH_ACCOUNTS],
];

const NOT_AMOUNTS: Case[] = [
  ["a year", "(2023)", []],
  ["a note", "(note 4)", []],
  ["a page", "(p. 12)", []],
  ["a section", "(see section 12)", []],
  ["list markers", "(a) the buyer; (iii) the seller", []],
  ["footnote numbers", "(1) and (2)", []],
  ["a paragraph", "paragraph (12)", [], EN_ACCOUNTS],
  ["a paragraph with an amount's size", "Paragraph (250)", [], EN_ACCOUNTS],
  ["a section of an Act", "section 1159(10)", [], EN_ACCOUNTS],
  ["a section with a letter", "section 12(3)(a)", [], EN_ACCOUNTS],
  ["a note in a statement", "Note (250)", [], EN_ACCOUNTS],
  ["a count with its unit", "(5 users)", [["5 users", 5]]],
  ["a room", "the meeting (room 250)", [["250", 250]]],
  ["Chinese list markers", "（一）买方；（二）卖方", []],
  ["a Chinese year", "（2023年）", []],
  ["a Chinese note", "（见附注4）", []],
  ["a Chinese page", "（第12页）", []],
  ["a Chinese article", "第（250）条", [], ZH_ACCOUNTS],
  ["a Chinese count", "（5家）", [["5家", 5]]],
];

const DEBITS: Case[] = [
  ["a debit", "12,500.00 DR", [["12,500.00 DR", 12500, ["sign"]]]],
  ["a credit", "12,500.00 CR", [["12,500.00 CR", 12500, ["sign"]]]],
  ["a debit stuck to its amount", "£12,500.00Dr", [["£12,500.00Dr", 12500, ["sign"]]]],
];

const GROUPS: { name: string; context: FigureContext; cases: Case[] }[] = [
  { name: "English: negative", context: EN, cases: NEGATIVE_EN },
  { name: "Chinese: negative", context: ZH, cases: NEGATIVE_ZH },
  { name: "English: prose and asides stay positive", context: EN, cases: POSITIVE_EN },
  { name: "Chinese: prose and asides stay positive", context: ZH, cases: POSITIVE_ZH },
  { name: "English: a count of people is never a minus", context: EN, cases: COUNTS_EN },
  { name: "Chinese: a count of people is never a minus", context: ZH, cases: COUNTS_ZH },
  { name: "a percent in brackets is never decided negative", context: EN, cases: PERCENTS },
  { name: "references and list markers are no amounts", context: EN, cases: NOT_AMOUNTS },
  { name: "a debit or credit is a question", context: EN, cases: DEBITS },
];

const shape = (figure: Figure): Expected =>
  figure.ambiguous.length > 0
    ? [figure.chars, figure.value, figure.ambiguous.map((each) => each.kind)]
    : [figure.chars, figure.value];

describe("amounts in brackets", () => {
  for (const group of GROUPS) {
    describe(group.name, () => {
      test.each(group.cases)("%s: %s", (_name, text, figures, context) => {
        const read = readFigures(text, context ?? group.context);
        expect(read.map(shape)).toEqual(figures);
        for (const each of read) expect(text.slice(each.start, each.end)).toBe(each.chars);
      });
    });
  }
});

describe("a Document that is accounts", () => {
  test.each([
    ["writes an amount in brackets", "Fees (1,500.00)", true],
    ["writes pence in brackets", "Fees (12.50)", true],
    ["states its scale in the English way", "Revenue (in millions)", true],
    ["states its unit in the Chinese way", "单位：万元", true],
    ["states its currency in the heading", "£'000", true],
    ["says nothing of money in brackets", "As agreed (see below) on 4 June (2026).", false],
    ["only a percentage heading", "Growth (%)", false],
    ["a lone whole number", "As agreed (250)", false],
  ])("%s: %s", (_name, text, accounts) => {
    expect(figureContextOf(text, "en").accounts).toBe(accounts);
  });

  test("its context reads a whole number in a statement line of it as negative, and one in its prose as it is", () => {
    const document = figureContextOf("Fees (1,500.00)\nLegal (250)", "en");
    expect(readFigures("Less: legal fees (250)", document).map((each) => each.value)).toEqual([
      -250,
    ]);
    expect(
      readFigures("The legal fees (250) were paid.", document).map((each) => each.value),
    ).toEqual([250]);
    expect(readFigures("Less: legal fees (250)", EN).map((each) => each.value)).toEqual([250]);
  });

  test("its counts of people are counts, and its impairment is a minus", () => {
    const document = [
      "£'000",
      "Administrative expenses (12,500)",
      "Headcount (250)",
      "Employees (1,250)",
      "Staff 人数（250）",
      "Impairment (£1.2m)",
    ].join("\n");
    const read = readFigures(document, figureContextOf(document, "en"));
    expect(read.map((each) => each.value)).toEqual([-12500, 250, 1250, 250, -1200000]);
  });
});
