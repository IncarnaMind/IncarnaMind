/**
 * The calculator set (#3393): figures worked out from numbers a Document states, each with the
 * value and the unit it should give, a Question that asks for it, and a right and a wrong sentence
 * for a check. Every Document, name and figure is invented for this repository. Expected values
 * are worked out here in plain arithmetic over the numbers each Document writes, never by the
 * app's formula engine.
 *
 * Kinds, as the issue's bars name them: a sum or difference of two stated amounts; a share, a
 * margin or a growth rate; a quantity times a price per unit (`minorUnit` when the price is in
 * pence, cents, 港仙 or 美分); amounts under a scale line or word; two currencies that must not be
 * added as they stand; percent against percentage points; a figure over a table's row or column;
 * and a figure an Analysis works out over a sheet's rows with one number a Document states
 * (`analysis-number`): a price in a minor unit, a rate, a headcount or a budget under a scale line,
 * a percent, an amount with a scale word.
 */
import type { Language } from "../../src/core/language";

export type CalculatorKind =
  | "sum-difference"
  | "share-growth"
  | "quantity-price"
  | "scale"
  | "currencies"
  | "percent-points"
  | "table"
  | "analysis-number"
  /** A wrong sentence whose figure rests on a factor or an amount no Document gives (#3661). */
  | "unstated-input";

/** What the figure measures: money in a currency, a percent, percentage points, or a count of things. */
export type ExpectedUnit =
  | { kind: "currency"; code: string }
  | { kind: "percent" }
  | { kind: "points" }
  /** A quantity counted or measured: a bare number, or one of these words beside it. */
  | { kind: "count"; words: readonly string[] };

export interface CalculatorCase {
  id: string;
  language: Language;
  kind: CalculatorKind;
  /** Quantity times price: the price is in a currency's minor unit. */
  minorUnit?: boolean;
  /** An input is written under a scale line or with a scale word ("in thousands", "万元"). */
  scaled: boolean;
  document: { name: string; text: string };
  /** A CSV whose rows the figure is worked out over, beside the Document that states one of its numbers. */
  sheet?: { name: string; text: string };
  question: string;
  /** In base units: 3,503,500 for £3,503,500; 0.037 for 3.7 percentage points. A change by its size. */
  expected: { value: number; unit: ExpectedUnit };
  /** Values a known misreading gives. */
  traps: readonly { value: number; why: string }[];
  /** Words for what the inputs count, that a figure in money must not carry ("litres", "千瓦时"). */
  quantityWords?: readonly string[];
  right: string;
  wrong: { sentence: string; why: string };
  /** Each number the figure is worked out from, as the Document writes it. */
  inputs: readonly string[];
}

const GBP = { kind: "currency", code: "GBP" } as const;
const USD = { kind: "currency", code: "USD" } as const;
const EUR = { kind: "currency", code: "EUR" } as const;
const CNY = { kind: "currency", code: "CNY" } as const;
const HKD = { kind: "currency", code: "HKD" } as const;
const PERCENT = { kind: "percent" } as const;
const POINTS = { kind: "points" } as const;

const doc = (name: string, ...paragraphs: string[]) => ({
  name,
  text: `# ${name}\n\n${paragraphs.join("\n\n")}\n`,
});

const ENGLISH: readonly CalculatorCase[] = [
  {
    id: "en-sum-1",
    language: "en",
    kind: "sum-difference",
    scaled: false,
    document: doc(
      "Harrowgate Tile Works 2025 trading summary",
      "Harrowgate Tile Works makes ceramic tiles at its works in Thornby.",
      "In 2025 sales of floor tiles came to £2,416,000 and sales of wall tiles to £1,087,500. The works employed 64 people at the year end.",
      "The kiln rebuild planned for 2026 is budgeted at £390,000.",
    ),
    question: "What did Harrowgate Tile Works' tile sales come to in total in 2025?",
    expected: { value: 2_416_000 + 1_087_500, unit: GBP },
    traps: [],
    right: "Harrowgate's floor and wall tiles together sold £3,503,500 in 2025.",
    wrong: {
      sentence: "Harrowgate's floor and wall tiles together sold £3,403,500 in 2025.",
      why: "a slip in the sum",
    },
    inputs: ["£2,416,000", "£1,087,500"],
  },
  {
    id: "en-diff-1",
    language: "en",
    kind: "sum-difference",
    scaled: true,
    document: doc(
      "Pellmore Water annual report 2025 extract",
      "Pellmore Water supplies 212,000 homes in the Pell valley.",
      "Operating costs were $18.62 million in 2025, against $21.05 million in 2024, after the treatment works at Ashby moved to solar power.",
      "Capital spending rose to $9.4 million.",
    ),
    question: "By how much did Pellmore Water's operating costs change from 2024 to 2025?",
    expected: { value: 21_050_000 - 18_620_000, unit: USD },
    traps: [],
    right: "Pellmore Water's operating costs fell by $2.43 million from 2024 to 2025.",
    wrong: {
      sentence: "Pellmore Water's operating costs fell by $3.43 million from 2024 to 2025.",
      why: "a slip in the difference",
    },
    inputs: ["$18.62 million", "$21.05 million"],
  },
  {
    id: "en-diff-2",
    language: "en",
    kind: "sum-difference",
    scaled: false,
    document: doc(
      "Brackenridge Quarry output report",
      "Brackenridge Quarry cuts limestone for road building.",
      "Output was 184,300 tonnes in 2025 and 162,750 tonnes in 2024. The quarry worked 248 days in 2025.",
      "Its licence runs until 2034.",
    ),
    question: "How much more stone did Brackenridge Quarry produce in 2025 than in 2024?",
    expected: {
      value: 184_300 - 162_750,
      unit: { kind: "count", words: ["tonne", "ton", "t"] },
    },
    traps: [],
    right: "Brackenridge Quarry produced 21,550 tonnes more stone in 2025 than in 2024.",
    wrong: {
      sentence: "Brackenridge Quarry produced 12,550 tonnes more stone in 2025 than in 2024.",
      why: "a slip in the difference",
    },
    inputs: ["184,300", "162,750"],
  },
  {
    id: "en-growth-1",
    language: "en",
    kind: "share-growth",
    scaled: true,
    document: doc(
      "Brindle Mapping results for 2025",
      "Brindle Mapping sells survey software to local councils.",
      "Revenue was $84.6 million in 2025, compared with $72.3 million in 2024. Recurring licences made up most of the increase.",
      "The company had 410 council customers at the end of 2025.",
    ),
    question: "How fast did Brindle Mapping's revenue grow in 2025?",
    expected: { value: 84.6 / 72.3 - 1, unit: PERCENT },
    traps: [{ value: (84.6 - 72.3) / 84.6, why: "the rise over the later year" }],
    right: "Brindle Mapping's revenue grew 17.0% in 2025.",
    wrong: {
      sentence: "Brindle Mapping's revenue grew 14.5% in 2025.",
      why: "the rise over the later year",
    },
    inputs: ["$84.6 million", "$72.3 million"],
  },
  {
    id: "en-share-1",
    language: "en",
    kind: "share-growth",
    scaled: false,
    document: doc(
      "Kettering Lane Books 2025 sales note",
      "Kettering Lane Books publishes local history and walking guides.",
      "It sold 41,200 copies in 2025, of which 9,890 were e-books. The rest were paperbacks sold through bookshops and its own website.",
      "Twelve new titles came out during the year.",
    ),
    question: "What share of the copies Kettering Lane Books sold in 2025 were e-books?",
    expected: { value: 9_890 / 41_200, unit: PERCENT },
    traps: [{ value: 9_890 / (41_200 - 9_890), why: "e-books over paperbacks" }],
    right: "E-books were 24.0% of the copies Kettering Lane Books sold in 2025.",
    wrong: {
      sentence: "E-books were 31.6% of the copies Kettering Lane Books sold in 2025.",
      why: "e-books over paperbacks",
    },
    inputs: ["41,200", "9,890"],
  },
  {
    id: "en-margin-1",
    language: "en",
    kind: "share-growth",
    scaled: true,
    document: doc(
      "Tamsin Joinery 2025 accounts summary",
      "Tamsin Joinery fits kitchens and staircases in new homes.",
      "Revenue was £5.80 million in 2025 and operating profit was £638,000.",
      "The order book at the year end stood at 140 homes.",
    ),
    question: "What was Tamsin Joinery's operating margin in 2025?",
    expected: { value: 638_000 / 5_800_000, unit: PERCENT },
    traps: [],
    right: "Tamsin Joinery's operating margin was 11.0% in 2025.",
    wrong: {
      sentence: "Tamsin Joinery's operating margin was 13.5% in 2025.",
      why: "another margin",
    },
    inputs: ["£5.80 million", "£638,000"],
  },
  {
    id: "en-qp-minor-1",
    language: "en",
    kind: "quantity-price",
    minorUnit: true,
    scaled: false,
    document: doc(
      "Linmouth Bakery energy review 2025",
      "Linmouth Bakery bakes bread for 38 cafés from one site.",
      "The bakery used 86,400 kWh of electricity in 2025, at an average unit price of 27.5 pence per kWh. Gas for the ovens is reported separately.",
      "A solar array is planned for the roof in 2027.",
    ),
    question: "What did Linmouth Bakery's electricity cost in 2025?",
    expected: { value: 86_400 * 0.275, unit: GBP },
    traps: [{ value: 86_400 * 27.5, why: "pence taken as pounds" }],
    quantityWords: ["kWh", "kilowatt"],
    right: "Linmouth Bakery's electricity cost £23,760 in 2025.",
    wrong: {
      sentence: "Linmouth Bakery's electricity cost £2,376,000 in 2025.",
      why: "pence taken as pounds",
    },
    inputs: ["86,400", "27.5"],
  },
  {
    id: "en-qp-minor-2",
    language: "en",
    kind: "quantity-price",
    minorUnit: true,
    scaled: false,
    document: doc(
      "Eastwold Haulage fuel contract note",
      "Eastwold Haulage runs 46 lorries from its depot at Fennick.",
      "In 2025 it bought 512,000 litres of diesel at an average of 142 pence a litre.",
      "From January 2026 its new supply contract fixes the price at 129 pence a litre for three years.",
    ),
    question:
      "If Eastwold Haulage buys the same amount of diesel in 2026, how much will it save under the new contract?",
    expected: { value: 512_000 * (1.42 - 1.29), unit: GBP },
    traps: [{ value: 512_000 * (142 - 129), why: "pence taken as pounds" }],
    quantityWords: ["litre", "liter"],
    right: "Buying the same volume under the 2026 contract would save Eastwold Haulage £66,560.",
    wrong: {
      sentence:
        "Buying the same volume under the 2026 contract would save Eastwold Haulage £6,656,000.",
      why: "pence taken as pounds",
    },
    inputs: ["512,000", "142", "129"],
  },
  {
    id: "en-qp-minor-3",
    language: "en",
    kind: "quantity-price",
    minorUnit: true,
    scaled: false,
    document: doc(
      "Ridley Orchards 2025 harvest report",
      "Ridley Orchards grows apples and pears on 310 acres.",
      "It sold 1,850,000 kilograms of apples to packers in 2025, at an average of 52 cents a kilogram. Pears went to a cider maker under a separate contract.",
      "Frost cut the pear crop by about a fifth.",
    ),
    question: "How much did Ridley Orchards earn from the apples it sold to packers in 2025?",
    expected: { value: 1_850_000 * 0.52, unit: USD },
    traps: [{ value: 1_850_000 * 52, why: "cents taken as dollars" }],
    quantityWords: ["kilogram", "kg"],
    right: "Ridley Orchards earned $962,000 from apples sold to packers in 2025.",
    wrong: {
      sentence: "Ridley Orchards earned $96.2 million from apples sold to packers in 2025.",
      why: "cents taken as dollars",
    },
    inputs: ["1,850,000", "52"],
  },
  {
    id: "en-qp-major-1",
    language: "en",
    kind: "quantity-price",
    scaled: false,
    document: doc(
      "Fallowfield Seeds spring shipments",
      "Fallowfield Seeds supplies grass seed to sports grounds.",
      "Its spring shipments were 3,750 sacks, sold at $46.80 a sack. Autumn orders are taken from August.",
      "The firm has 19 staff.",
    ),
    question: "What were Fallowfield Seeds' spring shipments worth?",
    expected: { value: 3_750 * 46.8, unit: USD },
    traps: [],
    quantityWords: ["sack"],
    right: "Fallowfield Seeds' spring shipments were worth $175,500.",
    wrong: {
      sentence: "Fallowfield Seeds' spring shipments were worth $157,500.",
      why: "digits swapped",
    },
    inputs: ["3,750", "$46.80"],
  },
  {
    id: "en-scale-1",
    language: "en",
    kind: "scale",
    scaled: true,
    document: doc(
      "Varden Optics 2025 results",
      "Varden Optics grinds lenses for laboratory microscopes.",
      "Amounts in thousands of euros.",
      "| | 2025 | 2024 |\n|---|---:|---:|\n| Revenue | 48,250 | 44,100 |\n| Operating profit | 6,130 | 5,480 |",
    ),
    question: "By what amount did Varden Optics' revenue rise in 2025?",
    expected: { value: (48_250 - 44_100) * 1_000, unit: EUR },
    traps: [{ value: 48_250 - 44_100, why: "the thousands left out" }],
    right: "Varden Optics' revenue rose by €4.15 million in 2025.",
    wrong: {
      sentence: "Varden Optics' revenue rose by €4,150 in 2025.",
      why: "the thousands left out",
    },
    inputs: ["48,250", "44,100"],
  },
  {
    id: "en-scale-2",
    language: "en",
    kind: "scale",
    scaled: true,
    document: doc(
      "Holloway Rail Services key figures",
      "Holloway Rail Services maintains signalling on 1,140 miles of track.",
      "| (£m) | 2025 | 2024 |\n|---|---:|---:|\n| Revenue | 312.4 | 287.9 |\n| Net debt | 96.0 | 104.5 |",
      "A new depot opened at Carrow in May.",
    ),
    question: "By how much did Holloway Rail Services' net debt fall during 2025?",
    expected: { value: (104.5 - 96.0) * 1_000_000, unit: GBP },
    traps: [{ value: 104.5 - 96.0, why: "the millions left out" }],
    right: "Holloway Rail Services cut its net debt by £8.5 million in 2025.",
    wrong: {
      sentence: "Holloway Rail Services cut its net debt by £85 million in 2025.",
      why: "a decimal slip",
    },
    inputs: ["96.0", "104.5"],
  },
  {
    id: "en-scale-3",
    language: "en",
    kind: "scale",
    scaled: true,
    document: doc(
      "Ashcombe Group trading update",
      "Ashcombe Group builds hospital wards and schools.",
      "The order book stood at $1.42 billion at the end of 2025, up from $980 million a year earlier.",
      "Two school contracts were signed in December.",
    ),
    question: "By what amount did Ashcombe Group's order book grow in 2025?",
    expected: { value: 1_420_000_000 - 980_000_000, unit: USD },
    traps: [],
    right: "Ashcombe Group's order book grew by $440 million in 2025.",
    wrong: {
      sentence: "Ashcombe Group's order book grew by $44 million in 2025.",
      why: "a decimal slip",
    },
    inputs: ["$1.42 billion", "$980 million"],
  },
  {
    id: "en-scale-4",
    language: "en",
    kind: "scale",
    scaled: true,
    document: doc(
      "Penhallow Software people report 2025",
      "Penhallow Software writes booking systems for dental practices.",
      "Staff costs (in $000): 12,600 in 2025, against 11,250 in 2024.",
      "Average headcount in 2025 was 180.",
    ),
    question: "What did Penhallow Software spend on staff per employee in 2025, on average?",
    expected: { value: (12_600 * 1_000) / 180, unit: USD },
    traps: [{ value: 12_600 / 180, why: "the thousands left out" }],
    right: "Penhallow Software's staff costs came to $70,000 per employee on average in 2025.",
    wrong: {
      sentence: "Penhallow Software's staff costs came to $7,000 per employee on average in 2025.",
      why: "a slip of ten",
    },
    inputs: ["12,600", "180"],
  },
  {
    id: "en-cur-1",
    language: "en",
    kind: "currencies",
    scaled: true,
    document: doc(
      "Marlow Instruments 2025 sales summary",
      "Marlow Instruments makes weather stations for farms.",
      "Sales were £4.20 million in the United Kingdom and $3.10 million in the United States in 2025.",
      "The company translates dollar sales at the year's average rate of $1.25 to £1.",
    ),
    question: "What were Marlow Instruments' total sales in 2025, in pounds?",
    expected: { value: 4_200_000 + 3_100_000 / 1.25, unit: GBP },
    traps: [{ value: 4_200_000 + 3_100_000, why: "dollars added to pounds" }],
    right: "Marlow Instruments' total sales came to £6.68 million in 2025.",
    wrong: {
      sentence: "Marlow Instruments' total sales came to £7.30 million in 2025.",
      why: "dollars added to pounds",
    },
    inputs: ["£4.20 million", "$3.10 million", "$1.25"],
  },
  {
    id: "en-cur-2",
    language: "en",
    kind: "currencies",
    scaled: true,
    document: doc(
      "Ostwick Ferries 2025 earnings note",
      "Ostwick Ferries sails between Ostwick and Saint-Brévin.",
      "In 2025 it earned €2.6 million on French bookings and £1.9 million on British bookings.",
      "Sterling earnings are translated at €1.16 to £1.",
    ),
    question: "What did Ostwick Ferries earn in total in 2025, in euros?",
    expected: { value: 2_600_000 + 1_900_000 * 1.16, unit: EUR },
    traps: [{ value: 2_600_000 + 1_900_000, why: "pounds added to euros" }],
    right: "Ostwick Ferries earned about €4.80 million in all in 2025.",
    wrong: {
      sentence: "Ostwick Ferries earned €4.50 million in all in 2025.",
      why: "pounds added to euros",
    },
    inputs: ["€2.6 million", "£1.9 million", "€1.16"],
  },
  {
    id: "en-cur-3",
    language: "en",
    kind: "currencies",
    scaled: true,
    document: doc(
      "Coldharbour Tea grower payments 2025",
      "Coldharbour Tea buys leaf from smallholders in India and Kenya.",
      "It paid growers ₹48.0 million in India and $410,000 in Kenya in 2025.",
      "The report converts rupees at ₹84 to $1.",
    ),
    question: "What did Coldharbour Tea pay its growers in total in 2025, in dollars?",
    expected: { value: 48_000_000 / 84 + 410_000, unit: USD },
    traps: [{ value: 48_000_000 + 410_000, why: "rupees added to dollars" }],
    right: "Coldharbour Tea paid its growers about $981,000 in 2025.",
    wrong: {
      sentence: "Coldharbour Tea paid its growers $48.41 million in 2025.",
      why: "rupees added to dollars",
    },
    inputs: ["₹48.0 million", "$410,000", "₹84"],
  },
  {
    id: "en-pp-1",
    language: "en",
    kind: "percent-points",
    scaled: false,
    document: doc(
      "Fernhill Housing annual review",
      "Fernhill Housing lets 2,400 homes to key workers.",
      "Occupancy was 91.2% in 2025, against 87.5% in 2024.",
      "Rents rose by the rate the board set in March.",
    ),
    question: "How did Fernhill Housing's occupancy change between 2024 and 2025?",
    expected: { value: 0.912 - 0.875, unit: POINTS },
    traps: [{ value: 0.912 / 0.875 - 1, why: "the change as a percent" }],
    right: "Fernhill Housing's occupancy rose by 3.7 percentage points in 2025.",
    wrong: {
      sentence: "Fernhill Housing's occupancy rose by 3.7% in 2025.",
      why: "points written as a percent",
    },
    inputs: ["91.2%", "87.5%"],
  },
  {
    id: "en-pp-2",
    language: "en",
    kind: "percent-points",
    scaled: false,
    document: doc(
      "Tollgate Credit risk report 2025",
      "Tollgate Credit lends to small builders.",
      "The default rate on its loans was 2.9% in 2025, down from 4.1% in 2024.",
      "Lending grew to 1,860 loans.",
    ),
    question: "How did Tollgate Credit's default rate change in 2025?",
    expected: { value: 0.041 - 0.029, unit: POINTS },
    traps: [{ value: 1 - 0.029 / 0.041, why: "the change as a percent" }],
    right: "Tollgate Credit's default rate fell 1.2 percentage points in 2025.",
    wrong: {
      sentence: "Tollgate Credit's default rate fell 1.2% in 2025.",
      why: "points written as a percent",
    },
    inputs: ["2.9%", "4.1%"],
  },
  {
    id: "en-pp-3",
    language: "en",
    kind: "percent-points",
    scaled: false,
    document: doc(
      "Quillon Paints market review",
      "Quillon Paints sells trade paint to decorators.",
      "Its share of the trade paint market was 18% in 2024 and 22.5% in 2025.",
      "Two rivals merged in 2025.",
    ),
    question: "By how much, in relative terms, did Quillon Paints' market share grow in 2025?",
    expected: { value: 0.225 / 0.18 - 1, unit: PERCENT },
    traps: [{ value: 0.225 - 0.18, why: "the points taken for the relative change" }],
    right: "Quillon Paints' market share grew 25% in relative terms in 2025.",
    wrong: {
      sentence: "Quillon Paints' market share grew 4.5% in relative terms in 2025.",
      why: "the points taken for the relative change",
    },
    inputs: ["18%", "22.5%"],
  },
  {
    id: "en-table-1",
    language: "en",
    kind: "table",
    scaled: false,
    document: doc(
      "Marrow Valley Cycles sales by region 2025",
      "Bicycles sold by region and quarter, 2025.",
      "| Region | Q1 | Q2 | Q3 | Q4 |\n|---|---:|---:|---:|---:|\n| North | 1,240 | 1,515 | 1,880 | 1,105 |\n| South | 980 | 1,320 | 1,645 | 1,010 |\n| West | 760 | 1,045 | 1,290 | 835 |",
      "Marrow Valley Cycles sells through 22 dealers.",
    ),
    question: "How many bicycles did Marrow Valley Cycles sell in the West region in 2025?",
    expected: {
      value: 760 + 1_045 + 1_290 + 835,
      unit: { kind: "count", words: ["bicycle", "bike", "cycle", "unit"] },
    },
    traps: [],
    right: "Marrow Valley Cycles sold 3,930 bicycles in the West in 2025.",
    wrong: {
      sentence: "Marrow Valley Cycles sold 3,390 bicycles in the West in 2025.",
      why: "digits swapped",
    },
    inputs: ["760", "1,045", "1,290", "835"],
  },
  {
    id: "en-table-2",
    language: "en",
    kind: "table",
    scaled: true,
    document: doc(
      "Stannard Insurance cost report",
      "Costs by department (£000).",
      "| Department | 2024 | 2025 |\n|---|---:|---:|\n| Staff | 8,420 | 8,910 |\n| Premises | 1,260 | 1,240 |\n| IT | 2,075 | 2,640 |",
      "Stannard Insurance moved its claims system to a new supplier in 2025.",
    ),
    question: "How much did Stannard Insurance's IT costs rise from 2024 to 2025?",
    expected: { value: (2_640 - 2_075) * 1_000, unit: GBP },
    traps: [{ value: 2_640 - 2_075, why: "the thousands left out" }],
    right: "Stannard Insurance's IT costs rose by £565,000 from 2024 to 2025.",
    wrong: {
      sentence: "Stannard Insurance's IT costs rose by £56,500 from 2024 to 2025.",
      why: "a slip of ten",
    },
    inputs: ["2,075", "2,640"],
  },
  {
    id: "en-table-3",
    language: "en",
    kind: "table",
    scaled: false,
    document: doc(
      "Gorse Hill Museums visitor figures",
      "Visitors by site and month, spring 2025.",
      "| Site | April | May | June |\n|---|---:|---:|---:|\n| Gorse Hill House | 4,210 | 5,380 | 6,045 |\n| Mill Museum | 2,130 | 2,760 | 3,115 |\n| Tannery Yard | 1,480 | 1,905 | 2,250 |",
      "Entry is free for residents of the parish.",
    ),
    question: "How many visitors did the three Gorse Hill museums have together in June 2025?",
    expected: {
      value: 6_045 + 3_115 + 2_250,
      unit: { kind: "count", words: ["visitor", "visit"] },
    },
    traps: [],
    right: "The three Gorse Hill museums had 11,410 visitors together in June 2025.",
    wrong: {
      sentence: "The three Gorse Hill museums had 11,140 visitors together in June 2025.",
      why: "digits swapped",
    },
    inputs: ["6,045", "3,115", "2,250"],
  },
  {
    id: "en-unstated-1",
    language: "en",
    kind: "unstated-input",
    scaled: false,
    document: doc(
      "Ferrow Bay Harbour 2025 accounts note",
      "Ferrow Bay Harbour runs ferries and a freight quay.",
      "Fares came to £1,250,000 in 2025, and the 2026 plan assumes fares grow 3%. Freight income was £640,000; the plan sets no figure for freight.",
    ),
    question: "What does Ferrow Bay Harbour's plan expect fares to be in 2026?",
    expected: { value: 1_287_500, unit: GBP },
    traps: [],
    right: "Ferrow Bay Harbour's plan puts 2026 fares at £1,287,500.",
    wrong: {
      sentence: "Ferrow Bay Harbour's freight income will reach £659,200 in 2026.",
      why: "a growth rate the plan doesn't give for freight",
    },
    inputs: ["£1,250,000", "3%"],
  },
  {
    id: "en-unstated-2",
    language: "en",
    kind: "unstated-input",
    scaled: false,
    document: doc(
      "Oakhanger Studio running costs 2025",
      "Oakhanger Studio rents a pottery workshop in Wells.",
      "In 2025 rent was £48,000, staff costs £126,000 and utilities £9,600. The insurance renewal is due in March, and its premium has not been quoted yet.",
    ),
    question: "What did Oakhanger Studio's rent, staff and utilities cost in 2025?",
    expected: { value: 183_600, unit: GBP },
    traps: [],
    right: "Oakhanger Studio's rent, staff and utilities cost £183,600 in 2025.",
    wrong: {
      sentence: "With insurance, Oakhanger Studio's running costs came to £187,600 in 2025.",
      why: "an insurance premium no Document gives",
    },
    inputs: ["£48,000", "£126,000", "£9,600"],
  },
  {
    id: "en-unstated-3",
    language: "en",
    kind: "unstated-input",
    scaled: true,
    document: doc(
      "Corriemoor Knitwear export sales 2025",
      "Corriemoor Knitwear sells jumpers to shops abroad.",
      "Euro sales were €1.10 million in 2025, which the accounts convert at €1.10 to the pound. US sales were $2.40 million; the accounts give no dollar rate.",
    ),
    question: "What were Corriemoor Knitwear's euro sales in pounds in 2025?",
    expected: { value: 1_000_000, unit: GBP },
    traps: [],
    right: "Corriemoor Knitwear's euro sales came to £1.00 million in 2025 at the accounts' rate.",
    wrong: {
      sentence: "Corriemoor Knitwear's US sales came to £1.92 million in 2025.",
      why: "a dollar rate the accounts don't give",
    },
    inputs: ["€1.10 million", "€1.10 to the pound"],
  },
  {
    id: "en-unstated-4",
    language: "en",
    kind: "unstated-input",
    scaled: false,
    document: doc(
      "Tannerford Clinic activity report 2025",
      "Tannerford Clinic is a family practice with 12 doctors.",
      "The clinic saw 18,240 patients in 2025. It plans to hire three more doctors in 2026.",
    ),
    question: "How many patients did each Tannerford Clinic doctor see on average in 2025?",
    expected: { value: 1_520, unit: { kind: "count", words: ["patient", "patients"] } },
    traps: [],
    right: "Each Tannerford Clinic doctor saw 1,520 patients on average in 2025.",
    wrong: {
      sentence: "Tannerford Clinic will see 20,064 patients in 2026.",
      why: "a growth no Document gives",
    },
    inputs: ["18,240", "12 doctors"],
  },
];

const CHINESE: readonly CalculatorCase[] = [
  {
    id: "zh-sum-1",
    language: "zh-CN",
    kind: "sum-difference",
    scaled: true,
    document: doc(
      "青桐家具2025年经营简报",
      "青桐家具主要生产实木餐桌椅，在华东地区有12家门店。",
      "2025年，公司线上销售额为1,286万元，门店销售额为2,047万元。",
      "2026年计划新开门店3家。",
    ),
    question: "青桐家具2025年线上和门店销售额合计是多少？",
    expected: { value: (1_286 + 2_047) * 10_000, unit: CNY },
    traps: [],
    right: "青桐家具2025年线上和门店销售额合计3,333万元。",
    wrong: { sentence: "青桐家具2025年线上和门店销售额合计3,233万元。", why: "a slip in the sum" },
    inputs: ["1,286万元", "2,047万元"],
  },
  {
    id: "zh-diff-1",
    language: "zh-CN",
    kind: "sum-difference",
    scaled: true,
    document: doc(
      "澄川水务2025年年度报告摘要",
      "澄川水务为澄川市及周边县区供水。",
      "2025年营业成本为4.82亿元，2024年为5.37亿元，主要由于药剂采购价格下降。",
      "2025年新铺设供水管网86公里。",
    ),
    question: "澄川水务2025年营业成本比2024年变化的金额是多少？",
    expected: { value: (5.37 - 4.82) * 100_000_000, unit: CNY },
    traps: [],
    right: "澄川水务2025年营业成本比上年减少5,500万元。",
    wrong: { sentence: "澄川水务2025年营业成本比上年减少5.5亿元。", why: "a slip of ten" },
    inputs: ["4.82亿元", "5.37亿元"],
  },
  {
    id: "zh-diff-2",
    language: "zh-CN",
    kind: "sum-difference",
    scaled: true,
    document: doc(
      "石岭矿业生产情况通报",
      "石岭矿业开采建筑用石灰石。",
      "公司2025年产量为68.4万吨，2024年为61.9万吨。",
      "采矿许可证有效期至2033年。",
    ),
    question: "石岭矿业2025年产量比上年增加了多少？",
    expected: { value: (68.4 - 61.9) * 10_000, unit: { kind: "count", words: ["吨"] } },
    traps: [],
    right: "石岭矿业2025年产量比上年增加6.5万吨。",
    wrong: { sentence: "石岭矿业2025年产量比上年增加65万吨。", why: "a slip of ten" },
    inputs: ["68.4万吨", "61.9万吨"],
  },
  {
    id: "zh-growth-1",
    language: "zh-CN",
    kind: "share-growth",
    scaled: true,
    document: doc(
      "云栖软件2025年度业绩快报",
      "云栖软件为中小医院提供排班软件。",
      "2025年营业收入为3.46亿元，2024年为2.88亿元。",
      "截至2025年末，公司共有客户1,320家。",
    ),
    question: "云栖软件2025年营业收入同比增长了多少？",
    expected: { value: 3.46 / 2.88 - 1, unit: PERCENT },
    traps: [{ value: (3.46 - 2.88) / 3.46, why: "the rise over the later year" }],
    right: "云栖软件2025年营业收入同比增长20.1%。",
    wrong: {
      sentence: "云栖软件2025年营业收入同比增长16.8%。",
      why: "the rise over the later year",
    },
    inputs: ["3.46亿元", "2.88亿元"],
  },
  {
    id: "zh-share-1",
    language: "zh-CN",
    kind: "share-growth",
    scaled: false,
    document: doc(
      "南浦书局2025年销售情况",
      "南浦书局主要出版地方史和旅行指南。",
      "2025年共售出图书52,600册，其中电子书13,150册，其余为纸质书。",
      "全年出版新书15种。",
    ),
    question: "南浦书局2025年售出的图书中，电子书占比多少？",
    expected: { value: 13_150 / 52_600, unit: PERCENT },
    traps: [{ value: 13_150 / (52_600 - 13_150), why: "e-books over print" }],
    right: "南浦书局2025年售出的图书中电子书占25.0%。",
    wrong: { sentence: "南浦书局2025年售出的图书中电子书占33.3%。", why: "e-books over print" },
    inputs: ["52,600", "13,150"],
  },
  {
    id: "zh-margin-1",
    language: "zh-CN",
    kind: "share-growth",
    scaled: true,
    document: doc(
      "鹿鸣制衣2025年财务摘要",
      "鹿鸣制衣为连锁品牌代工校服。",
      "2025年营业收入为8,640万元，净利润为691.2万元。",
      "公司年末员工人数为420人。",
    ),
    question: "鹿鸣制衣2025年净利润率是多少？",
    expected: { value: 691.2 / 8_640, unit: PERCENT },
    traps: [],
    right: "鹿鸣制衣2025年净利润率为8.0%。",
    wrong: { sentence: "鹿鸣制衣2025年净利润率为12.5%。", why: "revenue over profit" },
    inputs: ["8,640万元", "691.2万元"],
  },
  {
    id: "zh-qp-minor-1",
    language: "zh-CN",
    kind: "quantity-price",
    minorUnit: true,
    scaled: true,
    document: doc(
      "海晴控股2025年度业绩公告摘要",
      "董事会建议派发2025年度末期股息每股18港仙。",
      "于2025年12月31日，公司已发行股份为4.2亿股。",
      "集团全年收益为32.6亿港元。",
    ),
    question: "按已发行股份计算，海晴控股2025年度末期股息总额是多少？",
    expected: { value: 420_000_000 * 0.18, unit: HKD },
    traps: [{ value: 420_000_000 * 18, why: "港仙 taken as 港元" }],
    quantityWords: ["股"],
    right: "按已发行股份计算，海晴控股2025年度末期股息总额约为7,560万港元。",
    wrong: {
      sentence: "按已发行股份计算，海晴控股2025年度末期股息总额约为75.6亿港元。",
      why: "港仙 taken as 港元",
    },
    inputs: ["18港仙", "4.2亿股"],
  },
  {
    id: "zh-qp-minor-2",
    language: "zh-CN",
    kind: "quantity-price",
    minorUnit: true,
    scaled: true,
    document: doc(
      "丰禾电子海外工厂能耗报告",
      "丰禾电子在美国俄亥俄州设有一家组装工厂。",
      "该工厂2025年用电1,250万千瓦时，平均电价为每千瓦时9.6美分。",
      "工厂计划2027年加装储能设备。",
    ),
    question: "丰禾电子美国工厂2025年的电费是多少？",
    expected: { value: 12_500_000 * 0.096, unit: USD },
    traps: [{ value: 12_500_000 * 9.6, why: "美分 taken as 美元" }],
    quantityWords: ["千瓦时", "度"],
    right: "丰禾电子美国工厂2025年电费约为120万美元。",
    wrong: { sentence: "丰禾电子美国工厂2025年电费约为1.2亿美元。", why: "美分 taken as 美元" },
    inputs: ["1,250万千瓦时", "9.6美分"],
  },
  {
    id: "zh-qp-major-1",
    language: "zh-CN",
    kind: "quantity-price",
    scaled: false,
    document: doc(
      "瑞丰化工2025年产品销售情况",
      "瑞丰化工主要生产烧碱和液氯。",
      "2025年公司销售烧碱1,860吨，平均售价为每吨2,350元。",
      "液氯销售情况另行披露。",
    ),
    question: "瑞丰化工2025年烧碱销售收入是多少？",
    expected: { value: 1_860 * 2_350, unit: CNY },
    traps: [],
    quantityWords: ["吨"],
    right: "瑞丰化工2025年烧碱销售收入为437.1万元。",
    wrong: { sentence: "瑞丰化工2025年烧碱销售收入为43.71万元。", why: "a slip of ten" },
    inputs: ["1,860吨", "2,350元"],
  },
  {
    id: "zh-qp-major-2",
    language: "zh-CN",
    kind: "quantity-price",
    scaled: true,
    document: doc(
      "晨光物流用电合同说明",
      "晨光物流在城东运营一座冷链仓库。",
      "2025年仓库用电96万千瓦时，电价为每千瓦时0.82元。",
      "自2026年1月起，新签订的供电合同电价为每千瓦时0.71元，期限三年。",
    ),
    question: "如果2026年用电量与2025年相同，晨光物流按新合同能节省多少电费？",
    expected: { value: 960_000 * (0.82 - 0.71), unit: CNY },
    traps: [],
    quantityWords: ["千瓦时", "度"],
    right: "用电量不变时，晨光物流按新合同2026年可节省电费10.56万元。",
    wrong: {
      sentence: "用电量不变时，晨光物流按新合同2026年可节省电费10.56万千瓦时。",
      why: "the quantity's unit on the saving",
    },
    inputs: ["96万千瓦时", "0.82元", "0.71元"],
  },
  {
    id: "zh-scale-1",
    language: "zh-CN",
    kind: "scale",
    scaled: true,
    document: doc(
      "汇川精密2025年年度报告摘要",
      "公司主营精密轴承。",
      "合并利润表（单位：万元）",
      "| 项目 | 2025年 | 2024年 |\n|---|---:|---:|\n| 营业收入 | 36,480 | 31,920 |\n| 营业利润 | 4,210 | 3,880 |",
    ),
    question: "汇川精密2025年营业收入比上年增加了多少？",
    expected: { value: (36_480 - 31_920) * 10_000, unit: CNY },
    traps: [{ value: 36_480 - 31_920, why: "万 left out" }],
    right: "汇川精密2025年营业收入比上年增加4,560万元。",
    wrong: { sentence: "汇川精密2025年营业收入比上年增加4.56亿元。", why: "a slip of ten" },
    inputs: ["36,480", "31,920"],
  },
  {
    id: "zh-scale-2",
    language: "zh-CN",
    kind: "scale",
    scaled: true,
    document: doc(
      "远江港务主要财务数据",
      "远江港务经营内河集装箱码头。",
      "主要财务数据（金额单位：亿元）",
      "| 项目 | 2025年末 | 2024年末 |\n|---|---:|---:|\n| 总资产 | 128.6 | 117.3 |\n| 总负债 | 61.4 | 58.2 |",
    ),
    question: "远江港务2025年末总资产比上年末增加了多少？",
    expected: { value: (128.6 - 117.3) * 100_000_000, unit: CNY },
    traps: [{ value: 128.6 - 117.3, why: "亿 left out" }],
    right: "远江港务2025年末总资产比上年末增加11.3亿元。",
    wrong: { sentence: "远江港务2025年末总资产比上年末增加1.13亿元。", why: "a slip of ten" },
    inputs: ["128.6", "117.3"],
  },
  {
    id: "zh-scale-3",
    language: "zh-CN",
    kind: "scale",
    scaled: true,
    document: doc(
      "栖霞生物研发投入情况",
      "栖霞生物研发兽用疫苗。",
      "研发投入（单位：人民币千元）：2025年为18,650，2024年为15,920。",
      "截至2025年末，公司员工人数为245人。",
    ),
    question: "按年末员工人数计算，栖霞生物2025年人均研发投入是多少？",
    expected: { value: (18_650 * 1_000) / 245, unit: CNY },
    traps: [{ value: 18_650 / 245, why: "千 left out" }],
    right: "按年末员工人数计算，栖霞生物2025年人均研发投入约7.61万元。",
    wrong: {
      sentence: "按年末员工人数计算，栖霞生物2025年人均研发投入约76.1万元。",
      why: "a slip of ten",
    },
    inputs: ["18,650", "245"],
  },
  {
    id: "zh-scale-4",
    language: "zh-CN",
    kind: "scale",
    scaled: true,
    document: doc(
      "北辰重工经营情况说明",
      "北辰重工生产港口起重机。",
      "截至2025年末，公司在手订单金额为2.35亿元，上年末为19,800万元。",
      "2025年共交付起重机14台。",
    ),
    question: "北辰重工2025年末在手订单比上年末增加了多少？",
    expected: { value: 235_000_000 - 198_000_000, unit: CNY },
    traps: [],
    right: "北辰重工2025年末在手订单比上年末增加3,700万元。",
    wrong: { sentence: "北辰重工2025年末在手订单比上年末增加3.7亿元。", why: "a slip of ten" },
    inputs: ["2.35亿元", "19,800万元"],
  },
  {
    id: "zh-cur-1",
    language: "zh-CN",
    kind: "currencies",
    scaled: true,
    document: doc(
      "远帆贸易2025年销售概况",
      "远帆贸易出口小家电并在国内开设网店。",
      "2025年国内销售额为6,200万元人民币，海外销售额为850万美元。",
      "年报按全年平均汇率1美元=7.10元人民币折算外币金额。",
    ),
    question: "按人民币计算，远帆贸易2025年总销售额是多少？",
    expected: { value: 62_000_000 + 8_500_000 * 7.1, unit: CNY },
    traps: [{ value: 62_000_000 + 8_500_000, why: "美元 added to 元" }],
    right: "按人民币计算，远帆贸易2025年总销售额为12,235万元。",
    wrong: {
      sentence: "按人民币计算，远帆贸易2025年总销售额为7,050万元。",
      why: "美元 added to 元",
    },
    inputs: ["6,200万元", "850万美元", "7.10"],
  },
  {
    id: "zh-cur-2",
    language: "zh-CN",
    kind: "currencies",
    scaled: true,
    document: doc(
      "鸿图机械2025年收入构成",
      "鸿图机械生产食品包装机。",
      "2025年国内收入为1.5亿元，欧洲收入为2,400万欧元。",
      "欧元收入按1欧元=7.80元人民币折算。",
    ),
    question: "鸿图机械2025年国内和欧洲收入按人民币合计是多少？",
    expected: { value: 150_000_000 + 24_000_000 * 7.8, unit: CNY },
    traps: [{ value: 150_000_000 + 24_000_000, why: "欧元 added to 元" }],
    right: "鸿图机械2025年国内和欧洲收入按人民币合计约3.37亿元。",
    wrong: {
      sentence: "鸿图机械2025年国内和欧洲收入按人民币合计约1.74亿元。",
      why: "欧元 added to 元",
    },
    inputs: ["1.5亿元", "2,400万欧元", "7.80"],
  },
  {
    id: "zh-cur-3",
    language: "zh-CN",
    kind: "currencies",
    scaled: true,
    document: doc(
      "泛亚航材2025年利润情况",
      "泛亚航材经营航空器材维修。",
      "2025年新加坡子公司净利润为420万新加坡元，境内公司净利润为3,150万元。",
      "折算汇率：1新加坡元=5.40元人民币。",
    ),
    question: "以人民币计，泛亚航材2025年境内外净利润合计多少？",
    expected: { value: 31_500_000 + 4_200_000 * 5.4, unit: CNY },
    traps: [{ value: 31_500_000 + 4_200_000, why: "新加坡元 added to 元" }],
    right: "以人民币计，泛亚航材2025年境内外净利润合计5,418万元。",
    wrong: {
      sentence: "以人民币计，泛亚航材2025年境内外净利润合计3,570万元。",
      why: "新加坡元 added to 元",
    },
    inputs: ["420万新加坡元", "3,150万元", "5.40"],
  },
  {
    id: "zh-pp-1",
    language: "zh-CN",
    kind: "percent-points",
    scaled: false,
    document: doc(
      "安居公寓年度运营报告",
      "安居公寓在城南运营1,860套长租公寓。",
      "2025年平均出租率为92.4%，2024年为88.1%。",
      "租金按董事会三月确定的幅度调整。",
    ),
    question: "安居公寓2025年平均出租率比上年变化了多少？",
    expected: { value: 0.924 - 0.881, unit: POINTS },
    traps: [{ value: 0.924 / 0.881 - 1, why: "the change as a percent" }],
    right: "安居公寓2025年平均出租率比上年上升4.3个百分点。",
    wrong: {
      sentence: "安居公寓2025年平均出租率比上年上升4.3%。",
      why: "points written as a percent",
    },
    inputs: ["92.4%", "88.1%"],
  },
  {
    id: "zh-pp-2",
    language: "zh-CN",
    kind: "percent-points",
    scaled: false,
    document: doc(
      "明德食品经营分析",
      "明德食品生产速冻面点。",
      "受原料价格上涨影响，毛利率由2024年的35.6%下降至2025年的31.8%。",
      "公司全年新增经销商42家。",
    ),
    question: "明德食品2025年毛利率比上年变化了多少？",
    expected: { value: 0.356 - 0.318, unit: POINTS },
    traps: [{ value: 1 - 0.318 / 0.356, why: "the change as a percent" }],
    right: "明德食品2025年毛利率比上年下降3.8个百分点。",
    wrong: { sentence: "明德食品2025年毛利率比上年下降3.8%。", why: "points written as a percent" },
    inputs: ["35.6%", "31.8%"],
  },
  {
    id: "zh-pp-3",
    language: "zh-CN",
    kind: "percent-points",
    scaled: false,
    document: doc(
      "星河涂料市场情况",
      "星河涂料主要销售工程涂料。",
      "公司在工程涂料市场的占有率由2024年的12%提升至2025年的15%。",
      "两家竞争对手于2025年合并。",
    ),
    question: "星河涂料2025年市场占有率相对上年提升了百分之几？",
    expected: { value: 0.15 / 0.12 - 1, unit: PERCENT },
    traps: [{ value: 0.15 - 0.12, why: "the points taken for the relative change" }],
    right: "星河涂料2025年市场占有率相对上年提升了25%。",
    wrong: {
      sentence: "星河涂料2025年市场占有率相对上年提升了3%。",
      why: "the points taken for the relative change",
    },
    inputs: ["12%", "15%"],
  },
  {
    id: "zh-table-1",
    language: "zh-CN",
    kind: "table",
    scaled: false,
    document: doc(
      "骏驰电器2025年分区域销量",
      "各区域季度销量（台）",
      "| 区域 | 一季度 | 二季度 | 三季度 | 四季度 |\n|---|---:|---:|---:|---:|\n| 华东 | 3,420 | 3,880 | 4,150 | 4,610 |\n| 华南 | 2,760 | 3,040 | 3,315 | 3,590 |\n| 华北 | 1,980 | 2,215 | 2,470 | 2,705 |",
      "骏驰电器主要销售家用空气净化器。",
    ),
    question: "骏驰电器华南区域2025年全年销量是多少台？",
    expected: {
      value: 2_760 + 3_040 + 3_315 + 3_590,
      unit: { kind: "count", words: ["台"] },
    },
    traps: [],
    right: "骏驰电器华南区域2025年全年销量为12,705台。",
    wrong: { sentence: "骏驰电器华南区域2025年全年销量为12,507台。", why: "digits swapped" },
    inputs: ["2,760", "3,040", "3,315", "3,590"],
  },
  {
    id: "zh-table-2",
    language: "zh-CN",
    kind: "table",
    scaled: true,
    document: doc(
      "长丰证券部门费用表",
      "各类费用（单位：万元）",
      "| 费用 | 2024年 | 2025年 |\n|---|---:|---:|\n| 人工 | 6,840 | 7,215 |\n| 租金 | 1,120 | 1,105 |\n| 信息技术 | 1,465 | 1,980 |",
      "2025年公司更换了交易系统供应商。",
    ),
    question: "长丰证券2025年信息技术费用比2024年增加了多少？",
    expected: { value: (1_980 - 1_465) * 10_000, unit: CNY },
    traps: [{ value: 1_980 - 1_465, why: "万 left out" }],
    right: "长丰证券2025年信息技术费用比上年增加515万元。",
    wrong: { sentence: "长丰证券2025年信息技术费用比上年增加5,150万元。", why: "a slip of ten" },
    inputs: ["1,465", "1,980"],
  },
  {
    id: "zh-table-3",
    language: "zh-CN",
    kind: "table",
    scaled: false,
    document: doc(
      "味稻餐饮门店客流统计",
      "各门店月客流（人次），2025年",
      "| 门店 | 4月 | 5月 | 6月 |\n|---|---:|---:|---:|\n| 人民路店 | 8,240 | 9,105 | 9,860 |\n| 滨江店 | 6,315 | 7,020 | 7,745 |\n| 大学城店 | 5,190 | 4,860 | 3,975 |",
      "大学城店6月起进入暑期淡季。",
    ),
    question: "味稻餐饮三家门店2025年6月客流合计多少人次？",
    expected: { value: 9_860 + 7_745 + 3_975, unit: { kind: "count", words: ["人次", "人"] } },
    traps: [],
    right: "味稻餐饮三家门店2025年6月客流合计21,580人次。",
    wrong: { sentence: "味稻餐饮三家门店2025年6月客流合计21,850人次。", why: "digits swapped" },
    inputs: ["9,860", "7,745", "3,975"],
  },
  {
    id: "zh-unstated-1",
    language: "zh-CN",
    kind: "unstated-input",
    scaled: true,
    document: doc(
      "澄湖茶饮2025年经营简报",
      "澄湖茶饮在本市经营12家门店，并开展线上外卖业务。",
      "2025年线上销售额为310万元，公司计划2026年线上销售额增长20%。门店销售额为860万元，计划中没有给出门店销售额的目标。",
    ),
    question: "按计划，澄湖茶饮2026年线上销售额是多少？",
    expected: { value: 3_720_000, unit: CNY },
    traps: [],
    right: "按计划，澄湖茶饮2026年线上销售额为372万元。",
    wrong: {
      sentence: "澄湖茶饮2026年门店销售额将达到946万元。",
      why: "计划没有给出的门店增速",
    },
    inputs: ["310万元", "20%"],
  },
  {
    id: "zh-unstated-2",
    language: "zh-CN",
    kind: "unstated-input",
    scaled: true,
    document: doc(
      "青石陶艺工作室2025年运营支出",
      "青石陶艺工作室在城西租用一处陶艺工坊。",
      "2025年房租48万元，人工126万元，水电9.6万元。保险将于3月续保，保费尚未确定。",
    ),
    question: "青石陶艺工作室2025年房租、人工和水电合计多少？",
    expected: { value: 1_836_000, unit: CNY },
    traps: [],
    right: "青石陶艺工作室2025年房租、人工和水电合计183.6万元。",
    wrong: {
      sentence: "加上保险，青石陶艺工作室2025年运营支出合计187.6万元。",
      why: "文档没有给出的保费",
    },
    inputs: ["48万元", "126万元", "9.6万元"],
  },
  {
    id: "zh-unstated-3",
    language: "zh-CN",
    kind: "unstated-input",
    scaled: true,
    document: doc(
      "云岭针织2025年出口销售",
      "云岭针织向海外门店出口毛衫。",
      "2025年欧元区销售额为110万欧元，报表按每欧元7.8元折算。美国销售额为240万美元，报表没有给出美元汇率。",
    ),
    question: "按报表汇率，云岭针织2025年欧元区销售额折合人民币多少？",
    expected: { value: 8_580_000, unit: CNY },
    traps: [],
    right: "按报表汇率，云岭针织2025年欧元区销售额折合人民币858万元。",
    wrong: {
      sentence: "云岭针织2025年美国销售额折合人民币1,716万元。",
      why: "报表没有给出的美元汇率",
    },
    inputs: ["110万欧元", "7.8元"],
  },
  {
    id: "zh-unstated-4",
    language: "zh-CN",
    kind: "unstated-input",
    scaled: false,
    document: doc(
      "柳溪社区诊所2025年诊疗情况",
      "柳溪社区诊所共有12名医生。",
      "2025年接诊18,240人次。诊所计划2026年再招聘3名医生。",
    ),
    question: "柳溪社区诊所2025年平均每位医生接诊多少人次？",
    expected: { value: 1_520, unit: { kind: "count", words: ["人次"] } },
    traps: [],
    right: "柳溪社区诊所2025年平均每位医生接诊1,520人次。",
    wrong: {
      sentence: "柳溪社区诊所2026年接诊量将达到20,064人次。",
      why: "文档没有给出的增幅",
    },
    inputs: ["18,240", "12名"],
  },
];

/**
 * A CSV of `count` rows, each a label and an amount, the same on every run: the amounts come in
 * pairs either side of `mean`, so they add up to `count` times it. Too many rows to quote one by one.
 */
function sheetOf(
  name: string,
  header: string,
  label: (at: number) => string,
  { count, mean, seed }: { count: number; mean: number; seed: number },
) {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const amounts = new Array<number>(count).fill(mean);
  for (let at = 0; at < count / 2; at++) {
    const away = Math.round(next() * 0.6 * mean);
    amounts[at] = mean + away;
    amounts[count - 1 - at] = mean - away;
  }
  const rows = amounts.map((amount, at) => `${label(at)},${amount}`);
  return { name, text: `${[header, ...rows].join("\n")}\n` };
}

const ANALYSIS: readonly CalculatorCase[] = [
  {
    id: "an-en-minor",
    language: "en",
    kind: "analysis-number",
    minorUnit: true,
    scaled: false,
    document: doc(
      "Corrow Freight fuel terms 2025",
      "Corrow Freight runs four depots on the east coast.",
      "Under the 2025 supply contract, diesel is bought at 138 pence a litre at every depot.",
    ),
    sheet: sheetOf(
      "Corrow Freight diesel deliveries 2025",
      "Delivery,Litres",
      (at) => `D-${1001 + at}`,
      { count: 300, mean: 540, seed: 11 },
    ),
    question: "What did Corrow Freight's 2025 diesel deliveries cost, in pounds?",
    expected: { value: 162_000 * 1.38, unit: GBP },
    traps: [{ value: 162_000 * 138, why: "pence taken as pounds" }],
    quantityWords: ["litre", "liter"],
    right: "Corrow Freight's 2025 diesel deliveries cost £223,560.",
    wrong: {
      sentence: "Corrow Freight's 2025 diesel deliveries cost £22,356,000.",
      why: "pence taken as pounds",
    },
    inputs: ["138"],
  },
  {
    id: "an-en-headcount",
    language: "en",
    kind: "analysis-number",
    scaled: true,
    document: doc(
      "Quenby Analytics people report 2025",
      "Key people figures ($000)",
      "| Measure | 2025 |\n|---|---:|\n| Training spend | 214 |\n| Average headcount | 152 |",
      "Quenby Analytics opened a second office in 2025.",
    ),
    sheet: sheetOf(
      "Quenby Analytics staff cost lines 2025",
      "Payroll line,Staff cost ($)",
      (at) => `P-${2001 + at}`,
      { count: 250, mean: 15200, seed: 23 },
    ),
    question:
      "What was Quenby Analytics' staff cost per employee in 2025, from the staff cost sheet and the average headcount?",
    expected: { value: 3_800_000 / 152, unit: USD },
    traps: [{ value: 3_800_000 / 152_000, why: "the headcount taken in thousands" }],
    right: "Quenby Analytics' staff cost per employee was $25,000 in 2025.",
    wrong: {
      sentence: "Quenby Analytics' staff cost per employee was $25 in 2025.",
      why: "the headcount taken in thousands",
    },
    inputs: ["152"],
  },
  {
    id: "an-en-rate",
    language: "en",
    kind: "analysis-number",
    scaled: false,
    document: doc(
      "Pembury Toys treasury note H1 2025",
      "Treasury converted all US receipts for the half year at $1.35 to £1.",
      "Receipts in euros are reported in a separate note.",
    ),
    sheet: sheetOf(
      "Pembury Toys US sales H1 2025",
      "Invoice,Sales ($)",
      (at) => `INV-${3001 + at}`,
      { count: 360, mean: 6750, seed: 37 },
    ),
    question: "What were Pembury Toys' US sales for the half year in pounds, at the treasury rate?",
    expected: { value: 2_430_000 / 1.35, unit: GBP },
    traps: [{ value: 2_430_000 * 1.35, why: "multiplied by the rate" }],
    right: "Pembury Toys' US sales for the half year were £1,800,000.",
    wrong: {
      sentence: "Pembury Toys' US sales for the half year were £3,280,500.",
      why: "multiplied by the rate",
    },
    inputs: ["1.35"],
  },
  {
    id: "an-en-budget",
    language: "en",
    kind: "analysis-number",
    scaled: true,
    document: doc(
      "Whitlow Council libraries budget 2025",
      "Approved budgets (£000)",
      "| Service | 2025 |\n|---|---:|\n| Libraries | 2,950 |\n| Archives | 410 |",
      "The libraries budget includes the mobile library service.",
    ),
    sheet: sheetOf(
      "Whitlow Council libraries spending 2025",
      "Payment,Spend (£)",
      (at) => `PAY-${4001 + at}`,
      { count: 280, mean: 9950, seed: 41 },
    ),
    question: "By how much was Whitlow Council's 2025 libraries spending under its budget?",
    expected: { value: 2_950_000 - 2_786_000, unit: GBP },
    // The budget's thousands left out gives about the spending total, which a right working shows too.
    traps: [{ value: 2_950_000_000 - 2_786_000, why: "the budget read in millions" }],
    right: "Whitlow Council's 2025 libraries spending was £164,000 under budget.",
    wrong: {
      sentence: "Whitlow Council's 2025 libraries spending was £1,640,000 under budget.",
      why: "a slip of ten",
    },
    inputs: ["2,950"],
  },
  {
    id: "an-en-percent",
    language: "en",
    kind: "analysis-number",
    scaled: false,
    document: doc(
      "Aldergrove Kitchens board minutes November 2025",
      "The board approved a price rise of 3.5% on every product from January 2026.",
      "The board also noted the new warehouse lease.",
    ),
    sheet: sheetOf(
      "Aldergrove Kitchens revenue by product 2025",
      "Order,Revenue 2025 ($)",
      (at) => `ORD-${5001 + at}`,
      { count: 320, mean: 5125, seed: 53 },
    ),
    question:
      "If Aldergrove Kitchens sells the same volumes in 2026, what will its revenue be after the price rise?",
    expected: { value: 1_640_000 * 1.035, unit: USD },
    traps: [
      { value: 1_640_000 * 0.035, why: "the rise alone" },
      { value: 1_640_000 * 4.5, why: "the percent taken as a whole number" },
    ],
    right: "After the price rise, Aldergrove Kitchens' revenue would be $1,697,400 in 2026.",
    wrong: {
      sentence: "After the price rise, Aldergrove Kitchens' revenue would be $1,679,400 in 2026.",
      why: "digits swapped",
    },
    inputs: ["3.5%"],
  },
  {
    id: "an-en-scaleword",
    language: "en",
    kind: "analysis-number",
    scaled: true,
    document: doc(
      "Lintwell Engineering remuneration note 2025",
      "The remuneration committee set the 2025 bonus pool at £1.2 million.",
      "Bonuses are paid in March.",
    ),
    sheet: sheetOf(
      "Lintwell Engineering payroll by department 2025",
      "Payroll line,Payroll (£)",
      (at) => `L-${6001 + at}`,
      { count: 300, mean: 32000, seed: 67 },
    ),
    question: "What share of Lintwell Engineering's 2025 payroll is the bonus pool?",
    expected: { value: 1_200_000 / 9_600_000, unit: PERCENT },
    traps: [{ value: 1.2 / 9_600, why: "the million left out" }],
    right: "Lintwell Engineering's bonus pool is 12.5% of its 2025 payroll.",
    wrong: {
      sentence: "Lintwell Engineering's bonus pool is 14.3% of its 2025 payroll.",
      why: "divided by payroll less the pool",
    },
    inputs: ["1.2"],
  },
  {
    id: "an-zh-minor",
    language: "zh-CN",
    kind: "analysis-number",
    minorUnit: true,
    scaled: false,
    document: doc(
      "嘉禾电机美国工厂电价说明",
      "嘉禾电机在美国设有三家工厂。",
      "2025年美国工厂的电价为每千瓦时8.5美分。",
    ),
    sheet: sheetOf(
      "嘉禾电机美国工厂用电量2025",
      "抄表单号,用电量（千瓦时）",
      (at) => `M${7001 + at}`,
      { count: 260, mean: 5000, seed: 71 },
    ),
    question: "嘉禾电机三家美国工厂2025年电费合计多少美元？",
    expected: { value: 1_300_000 * 0.085, unit: USD },
    traps: [{ value: 1_300_000 * 8.5, why: "美分 taken as 美元" }],
    quantityWords: ["千瓦时", "度"],
    right: "嘉禾电机三家美国工厂2025年电费合计110,500美元。",
    wrong: {
      sentence: "嘉禾电机三家美国工厂2025年电费合计11,050,000美元。",
      why: "美分 taken as 美元",
    },
    inputs: ["8.5"],
  },
  {
    id: "an-zh-rate",
    language: "zh-CN",
    kind: "analysis-number",
    scaled: false,
    document: doc(
      "启明玩具外币折算说明",
      "财务部按1美元兑7.20元人民币折算本期美元收入。",
      "欧元收入另行说明。",
    ),
    sheet: sheetOf("启明玩具美国销售额2025", "订单号,销售额（美元）", (at) => `SO${8001 + at}`, {
      count: 240,
      mean: 15000,
      seed: 83,
    }),
    question: "启明玩具表中的美元销售额按财务部的汇率折合人民币多少元？",
    expected: { value: 3_600_000 * 7.2, unit: CNY },
    traps: [{ value: 3_600_000 / 7.2, why: "divided by the rate" }],
    right: "启明玩具表中的美元销售额折合人民币25,920,000元。",
    wrong: {
      sentence: "启明玩具表中的美元销售额折合人民币500,000元。",
      why: "divided by the rate",
    },
    inputs: ["7.20"],
  },
  {
    id: "an-zh-headcount",
    language: "zh-CN",
    kind: "analysis-number",
    scaled: true,
    document: doc(
      "锦程医药研发情况摘要",
      "研发情况（单位：人民币千元）",
      "| 项目 | 2025年 |\n|---|---:|\n| 研发设备投入 | 3,260 |\n| 研发人员数量 | 140 |",
      "公司2025年新增两条中试生产线。",
    ),
    sheet: sheetOf("锦程医药研发费用2025", "凭证号,研发费用（元）", (at) => `RD${9001 + at}`, {
      count: 280,
      mean: 35000,
      seed: 97,
    }),
    question: "锦程医药2025年人均研发费用是多少元？按研发费用表与研发人员数量计算。",
    expected: { value: 9_800_000 / 140, unit: CNY },
    traps: [{ value: 9_800_000 / 140_000, why: "the headcount taken in thousands" }],
    right: "锦程医药2025年人均研发费用为70,000元。",
    wrong: {
      sentence: "锦程医药2025年人均研发费用为70元。",
      why: "the headcount taken in thousands",
    },
    inputs: ["140"],
  },
  {
    id: "an-zh-budget",
    language: "zh-CN",
    kind: "analysis-number",
    scaled: true,
    document: doc(
      "白鹭社区服务中心2025年预算",
      "2025年预算（单位：万元）",
      "| 项目 | 预算 |\n|---|---:|\n| 日常运营 | 310 |\n| 设备更新 | 45 |",
      "预算经理事会审议通过。",
    ),
    sheet: sheetOf(
      "白鹭社区服务中心日常运营支出2025",
      "凭证号,支出（元）",
      (at) => `ZC${1101 + at}`,
      { count: 250, mean: 11380, seed: 101 },
    ),
    question: "白鹭社区服务中心2025年日常运营实际支出比预算少多少元？",
    expected: { value: 3_100_000 - 2_845_000, unit: CNY },
    // 万 left out gives about the spending total, which a right working shows too.
    traps: [],
    right: "白鹭社区服务中心2025年日常运营实际支出比预算少255,000元。",
    wrong: {
      sentence: "白鹭社区服务中心2025年日常运营实际支出比预算少2,550,000元。",
      why: "a slip of ten",
    },
    inputs: ["310"],
  },
  {
    id: "an-zh-percent",
    language: "zh-CN",
    kind: "analysis-number",
    scaled: false,
    document: doc(
      "禾风茶饮董事会决议摘要",
      "董事会批准自2026年1月起全部产品提价6%。",
      "董事会同时审议了新门店选址。",
    ),
    sheet: sheetOf("禾风茶饮门店营收2025", "销售单号,营收（元）", (at) => `XS${1201 + at}`, {
      count: 400,
      mean: 20000,
      seed: 113,
    }),
    question: "若销量不变，禾风茶饮2026年提价后营收是多少元？",
    expected: { value: 8_000_000 * 1.06, unit: CNY },
    traps: [
      { value: 8_000_000 * 0.06, why: "the rise alone" },
      { value: 8_000_000 * 7, why: "the percent taken as a whole number" },
    ],
    right: "若销量不变，禾风茶饮2026年营收为8,480,000元。",
    wrong: {
      sentence: "若销量不变，禾风茶饮2026年营收为8,840,000元。",
      why: "digits swapped",
    },
    inputs: ["6%"],
  },
  {
    id: "an-zh-minor-hk",
    language: "zh-CN",
    kind: "analysis-number",
    minorUnit: true,
    scaled: false,
    document: doc(
      "瀚海航运末期股息公告摘要",
      "董事会建议派发2025年度末期股息每股12港仙。",
      "股息将于2026年6月派付。",
    ),
    sheet: sheetOf("瀚海航运股东持股2025", "股东编号,持股数（股）", (at) => `H${1301 + at}`, {
      count: 300,
      mean: 1200000,
      seed: 127,
    }),
    question: "按表中持股数计算，瀚海航运末期股息总额为多少港元？",
    expected: { value: 360_000_000 * 0.12, unit: HKD },
    traps: [{ value: 360_000_000 * 12, why: "港仙 taken as 港元" }],
    quantityWords: ["股"],
    right: "瀚海航运末期股息总额为43,200,000港元。",
    wrong: { sentence: "瀚海航运末期股息总额为4,320,000,000港元。", why: "港仙 taken as 港元" },
    inputs: ["12"],
  },
];

export const CALCULATOR_CASES: readonly CalculatorCase[] = [...ENGLISH, ...CHINESE, ...ANALYSIS];
