/**
 * A number whose unit only its column's heading names, in Check against Documents (#3022): the
 * model gives that heading as the number's unit line, and the check reads the number in it. A
 * right sentence keeps the model's ✓ in a Note, and a wrong unit is never a ✓: a share is
 * compared as a number, and a kilogram under tonnes is one unit at another scale.
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
