/**
 * A number whose unit only its column's heading names, in Check against Documents (#3022): the
 * model gives that heading as the number's unit line, and the check reads the number in it. A
 * right sentence keeps the model's ✓ in a Note, and a wrong unit is never a ✓: a share is
 * compared as a number, and a kilogram under tonnes is one unit at another scale. The heading
 * cell of a number's own column holds beside another column's scale, and a row's cell of a units
 * column states its number's unit (#2997).
 */
import { expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkingModel, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";

const LEVIES = "| Item | Levy (‰) |\n|---|---|\n| Stamp duty | 5 |\n| Transfer | 3 |";
const LEVY_SHEET = "Levies\nItem\tLevy (‰)\nStamp duty\t5\nTransfer\t3\n";
const GROWTH = "| Metric | YoY% |\n|---|---|\n| Revenue | 12 |\n| Costs | 9 |";
const SPREADS = "| Bond | Spread (bps) |\n|---|---|\n| Series A | 145 |\n| Series B | 90 |";
const OUTPUT = "| Region | Output (t) |\n|---|---|\n| North | 540 |\n| South | 615 |";
const RATES = "| 项目 | 税率（‰） |\n|---|---|\n| 印花税 | 5 |\n| 过户费 | 3 |";
const TWO_COLUMNS = "| Item | Levy (‰) | Amount |\n|---|---|---|\n| Fees | 5 | 300 |";

interface Cited {
  /** The row the model cites, its number there, and the line it gives as that number's unit. */
  quote: string;
  number: string;
  unitQuote?: string;
}

/** What `claim` ends as, the model calling it supported from `cited`: alone, and in a Note. */
async function checked(claim: string, contents: string, cited: Cited) {
  const plan: Plan = { verdict: "supported", says: cited.quote, ...cited };
  const { core, client, mind } = await setUpWithDocuments(checkingModel({ [claim]: plan }), [
    { name: contents.includes("\t") ? "Table.txt" : "Table.md", contents: `${contents}\n` },
  ]);
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "deepseek",
    apiKey: "sk-test",
    modelId: "deepseek-flash",
  });
  if (saved.service) await core.allowDataFlow("checks", saved.service.id);
  const alone = (await core.checkClaim({ claim })).verdict;
  writeMind(client, [
    { type: "paragraph", attrs: { id: "block-1" }, content: [{ type: "text", text: claim }] },
  ]);
  await client.settled();
  await core.checkSentences({
    requestId: crypto.randomUUID(),
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "block-1", offset: 0 },
    to: { blockId: "block-1", offset: claim.length },
  });
  await client.settled();
  const [span] = claimSpans(readMind(client));
  return { alone, inNote: span?.check.state };
}

// protects=a right sentence whose unit is only in its number's column heading keeps the model's ✓ in a Note, where the heading is given as the number's unit line: a per mille, a percent, basis points and tonnes, in a Markdown table and a sheet's rows, in English and Chinese; fails_when=a column heading that names a share or a measure's unit is refused as a unit line, so the right sentence reads Not checked; no_claim=a table with no bars or tabs between its cells, a heading that names two units, or a model that gives no unit line
test.each([
  ["The levy on stamp duty is 5‰.", LEVIES, "| Stamp duty | 5 |", "5", "Levy (‰)"],
  ["The levy on stamp duty is 5‰.", LEVY_SHEET, "Stamp duty\t5", "5", "Levy (‰)"],
  ["The levy on stamp duty is 5‰.", LEVIES, "| Stamp duty | 5 |", "5", "| Item | Levy (‰) |"],
  ["Revenue grew 12% year on year.", GROWTH, "| Revenue | 12 |", "12", "YoY%"],
  ["Series A's spread is 145 bps.", SPREADS, "| Series A | 145 |", "145", "Spread (bps)"],
  ["North's output was 540 tonnes.", OUTPUT, "| North | 540 |", "540", "Output (t)"],
  ["印花税税率为5‰。", RATES, "| 印花税 | 5 |", "5", "税率（‰）"],
])(
  "%s keeps its ✓ in a Note from a cell under a heading that names its unit",
  async (claim, contents, quote, number, unitQuote) => {
    expect(await checked(claim, contents, { quote, number, unitQuote })).toEqual({
      alone: "supported",
      inNote: "supported",
    });
  },
);

// protects=a share in another unit than its column's heading names is never a ✓ in a Note though the model calls it supported: the number is read in the heading's unit and the two are compared as numbers; fails_when=the cell's number is taken in the sentence's unit, or the heading's unit is dropped; no_claim=the check of the sentence alone, which the model's own verdict decides on a provider that isn't offered calculate
test.each([
  ["The levy on stamp duty is 5%.", LEVIES, "| Stamp duty | 5 |", "5", "Levy (‰)"],
  ["Revenue grew 12‰ year on year.", GROWTH, "| Revenue | 12 |", "12", "YoY%"],
  [
    "Series A's spread is 145 percentage points.",
    SPREADS,
    "| Series A | 145 |",
    "145",
    "Spread (bps)",
  ],
  ["印花税税率为5%。", RATES, "| 印花税 | 5 |", "5", "税率（‰）"],
])("%s is Contradicted in a Note", async (claim, contents, quote, number, unitQuote) => {
  expect((await checked(claim, contents, { quote, number, unitQuote })).inNote).toBe(
    "contradicted",
  );
});

// protects=kilograms under a column headed in tonnes are never a ✓, alone or in a Note, with or without the heading given as the unit line: a tonne is a million grams, so the two are one unit at two scales; fails_when=two units of mass are left to the model, which called 54,000 kg under "Output (t)" supported; no_claim=units of other measures the check doesn't convert (miles and km, gallons and litres), and short tons
test.each([
  [{ quote: "| North | 540 |", number: "540", unitQuote: "Output (t)" }],
  [{ quote: "| North | 540 |", number: "540" }],
])("kilograms under a column headed in tonnes are never a ✓: %o", async (cited) => {
  const { alone, inNote } = await checked("North's output was 540 kg.", OUTPUT, cited);
  expect(alone).not.toBe("supported");
  expect(inNote).not.toBe("supported");
});

// protects=a heading over another column is no unit line for a number: "Levy (‰)" doesn't make the Amount column's 300 a per mille; fails_when=a heading is taken for any number of its table's row; no_claim=which column the model should have read
test("a heading over another column states nothing for the number", async () => {
  const cited = { quote: "| Fees | 5 | 300 |", number: "300", unitQuote: "Levy (‰)" };
  expect((await checked("The fee levy is 300‰.", TWO_COLUMNS, cited)).inNote).not.toBe("supported");
});

const JOBLESS =
  "Unemployment by region\n| Region | Rate (%) | Persons (in thousands) |\n|---|---|---|\n| North | 6.1 | 412 |\n| South | 5.4 | 388 |";
const FINANCING =
  "表7 社会融资规模\n| 项目 | 年末存量（万亿元） | 同比增速（%） | 全年增量（亿元） |\n|---|---|---|---|\n| 人民币贷款 | 252.5 | 7.2 | 170500 |\n| 企业债券 | 32.3 | 3.8 | 19000 |";
const PRODUCTS =
  "表3 主要产品产量及其增长速度\n| 产品名称 | 单位 | 产量 | 比上年增长（%） |\n|---|---|---|---|\n| 原煤 | 万吨 | 540 | 3.2 |\n| 汽车 | 万辆 | 31 | 1.5 |";
const PRODUCT_HEADS = "| 产品名称 | 单位 | 产量 | 比上年增长（%） |";
const NORTH = "| North | 6.1 | 412 |";
const LOANS = "| 人民币贷款 | 252.5 | 7.2 | 170500 |";
const COAL = "| 原煤 | 万吨 | 540 | 3.2 |";

/** A Markdown table, one of its rows or a cell, as a sheet's tab-separated text has it. */
const asSheet = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\|[-|]+\|$/u.test(line))
    .map((line) => line.replace(/^\| | \|$/gu, "").replaceAll(" | ", "\t"))
    .join("\n");

/** What `claim` ends as in a Note from a Markdown table and from the same table as a sheet. */
async function inBothForms(claim: string, contents: string, cited: Cited) {
  const sheet = {
    quote: asSheet(cited.quote),
    number: cited.number,
    ...(cited.unitQuote !== undefined && { unitQuote: asSheet(cited.unitQuote) }),
  };
  return [
    (await checked(claim, contents, cited)).inNote,
    (await checked(claim, asSheet(contents), sheet)).inNote,
  ];
}

// protects=a right sentence keeps the model's ✓ in a Note where the heading cell of its number's own column is given as the unit line and another cell of that heading row states another column's scale: a rate beside a count in thousands, a growth rate between two columns of money, and a column headed in 万亿元 beside one in 亿元, in a Markdown table and a sheet; fails_when=another column's "in thousands" or （亿元） is taken for a nearer line that states the number's scale, or （万亿元） states no scale, so the right sentence can't be checked whatever line the model gives (#2997); no_claim=a heading row given whole, which is asked for the one cell as before
test.each([
  ["The unemployment rate in the North was 6.1%.", JOBLESS, NORTH, "6.1", "Rate (%)"],
  [
    "The North had 412 thousand unemployed persons.",
    JOBLESS,
    NORTH,
    "412",
    "Persons (in thousands)",
  ],
  ["人民币贷款同比增速为7.2%。", FINANCING, LOANS, "7.2", "同比增速（%）"],
  ["人民币贷款年末存量为252.5万亿元。", FINANCING, LOANS, "252.5", "年末存量（万亿元）"],
  ["人民币贷款全年增量为170500亿元。", FINANCING, LOANS, "170500", "全年增量（亿元）"],
])(
  "%s keeps its ✓ in a Note under its own column's heading beside another column's scale",
  async (claim, contents, quote, number, unitQuote) => {
    expect(await inBothForms(claim, contents, { quote, number, unitQuote })).toEqual([
      "supported",
      "supported",
    ]);
  },
);

// protects=a wrong scale or unit under such a heading is never a ✓ in a Note though the model calls it supported: the number is read in its own column's unit, so percentage points for a percent, 亿元 for 万亿元, a million for a thousand and money for a rate are not what the Document gives; fails_when=reading the heading cell beside another column's scale lets any unit through; no_claim=which mark each ends as
test.each([
  [
    "The unemployment rate in the North was 6.1 percentage points.",
    JOBLESS,
    NORTH,
    "6.1",
    "Rate (%)",
  ],
  ["The North had 6.1 thousand unemployed persons.", JOBLESS, NORTH, "6.1", "Rate (%)"],
  [
    "The North had 412 million unemployed persons.",
    JOBLESS,
    NORTH,
    "412",
    "Persons (in thousands)",
  ],
  ["人民币贷款年末存量为252.5亿元。", FINANCING, LOANS, "252.5", "年末存量（万亿元）"],
  ["人民币贷款年末存量为7.2万亿元。", FINANCING, LOANS, "7.2", "同比增速（%）"],
  ["人民币贷款全年增量为170500万亿元。", FINANCING, LOANS, "170500", "全年增量（亿元）"],
])(
  "%s is never a ✓ in a Note under its own column's heading",
  async (claim, contents, quote, number, unitQuote) => {
    for (const state of await inBothForms(claim, contents, { quote, number, unitQuote }))
      expect(state).not.toBe("supported");
  },
);

// protects=a right sentence keeps the model's ✓ in a Note where its number's unit is its row's cell of the table's units column (万吨 under 单位) and its own column's heading states none, whatever the model gives as the unit line: the heading row, the column's heading, the cell itself or nothing; fails_when=the heading row's （%） of another column is read as the number's unit, or the check asks for a unit line no line of the table can be (#2997); no_claim=a units column whose cells name organisations, which states no unit
test.each([[PRODUCT_HEADS], ["产量"], ["万吨"], [undefined]])(
  "a number takes its row's cell of the units column, the unit line given as %s",
  async (unitQuote) => {
    const cited = { quote: COAL, number: "540", ...(unitQuote !== undefined && { unitQuote }) };
    expect(await inBothForms("原煤产量为540万吨。", PRODUCTS, cited)).toEqual([
      "supported",
      "supported",
    ]);
  },
);

// protects=beside a units column, a wrong scale, another column's percent and the units cell on a number whose own column is headed in percent are never a ✓ in a Note though the model calls each supported, and the growth rate under its own （%） heading keeps its ✓; fails_when="原煤产量比上年增长540%。" keeps a ✓ from the heading row's （%）, as it did, or the units cell is read for the 3.2 of the （%） column; no_claim=which mark a wrong one ends as
test("beside a units column each number keeps to its own unit", async () => {
  const cited = (number: string, unitQuote?: string) => ({
    quote: COAL,
    number,
    ...(unitQuote !== undefined && { unitQuote }),
  });
  for (const [claim, source] of [
    ["原煤产量为540吨。", cited("540", PRODUCT_HEADS)],
    ["原煤产量为540吨。", cited("540")],
    ["原煤产量比上年增长540%。", cited("540", PRODUCT_HEADS)],
    ["原煤产量比上年增长540%。", cited("540", "比上年增长（%）")],
    ["原煤产量为3.2万吨。", cited("3.2", PRODUCT_HEADS)],
    ["原煤产量比上年增长3.2个百分点。", cited("3.2", "比上年增长（%）")],
  ] as const)
    for (const state of await inBothForms(claim, PRODUCTS, source))
      expect(state, claim).not.toBe("supported");
  for (const unitQuote of ["比上年增长（%）", PRODUCT_HEADS])
    expect(
      await inBothForms("原煤产量比上年增长3.2%。", PRODUCTS, cited("3.2", unitQuote)),
    ).toEqual(["supported", "supported"]);
});

// protects=a "¥" in a units cell that the Document doesn't say is yuan or yen states no currency, so a sentence that writes yuan is never a ✓ in a Note though the model calls it supported; fails_when=the open "¥" is recorded as the first currency it could be (#2997); no_claim=what the sentence ends as
test("an open ¥ in a units cell states no currency", async () => {
  const row = "| Fees | ¥ | 540 |";
  const contents = `| Item | Unit | Amount |\n|---|---|---|\n${row}`;
  const cited = { quote: row, number: "540" };
  for (const state of await inBothForms("Fees were CN¥540.", contents, cited))
    expect(state).not.toBe("supported");
});
