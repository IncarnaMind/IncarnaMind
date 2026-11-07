/**
 * The scale cases #2365 still misses on `main`: a Chinese nearer line's bracket, a per-share
 * row under an exception, an exception clause's own scale, a caption for another table, a row
 * that isn't an amount, a heading that only looks like a scale, a bracket's dropped currency, a
 * sheet's name, a currency-only row head, and a price row. Each is read through the core as the
 * assistant uses it, with a scripted model; a figure is the scale its Document states, or the
 * calculation refuses, never the unscaled one.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { answerEnded, type ShownPassage, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { answerRequests, scriptedModel, scriptedModels } from "../helpers/models";
import { docxOf, xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";

type Call = { tool: string; input: unknown };
type UnitQuotes = readonly [string | undefined, string | undefined];

function passageWriting(passages: readonly ShownPassage[], quote: string): ShownPassage {
  const found = passages.find((each) => each.text.includes(quote));
  if (!found) {
    const shown = passages.map((each) => JSON.stringify(each.text.slice(0, 200))).join(" | ");
    throw new Error(`No Passage writes "${quote}". Shown: ${shown}`);
  }
  return found;
}

/**
 * A model that searches once, cites both rows from the Passage that writes them, works out the
 * second from the first, and writes the marker. `unitQuote` goes on both inputs.
 */
function calculatingModel(
  query: string,
  cites: readonly [string, string],
  numbers: readonly [string, string],
  unitQuote: string | undefined,
  unitQuotes: UnitQuotes | undefined,
): MockLanguageModelV4 {
  return scriptedModel((call) => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query } }] };
    }
    if (call.index === 1) {
      const passages = searches.flatMap((each) => shownPassages(each.text));
      const cited = cites.map((quote, index) => {
        const passage = passageWriting(passages, quote);
        return {
          marker: index + 1,
          passage: passage.id,
          location: passage.location ?? "p. 1",
          quote,
        };
      });
      const input = (name: string, label: string, index: number) => {
        const quoted = unitQuotes?.[index] ?? unitQuote;
        return {
          name,
          label,
          citation: index + 1,
          number: numbers[index],
          ...(quoted !== undefined && { unitQuote: quoted }),
        };
      };
      const call: Call = {
        tool: "calculate",
        input: {
          figures: [
            {
              marker: 1,
              label: "Difference",
              formula: "rev - cost",
              inputs: [input("rev", "Revenue", 0), input("cost", "Costs", 1)],
            },
          ],
        },
      };
      return { calls: [{ tool: "cite", input: { citations: cited } }, call] };
    }
    return { text: "[=1][^1]" };
  });
}

function told(model: MockLanguageModelV4, tool: string): string {
  const last = answerRequests(model).at(-1);
  if (!last) return "";
  const texts: string[] = [];
  for (const message of last.prompt) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === tool && part.output.type === "text")
        texts.push(part.output.value);
    }
  }
  return texts.join("\n");
}

async function askAndRead(core: Core) {
  const asked = await core.askInConversation({ text: "What is the difference?" });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  const content = await core.getConversation(asked.conversation.id);
  const answer = content.messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

interface Case {
  file: { name: string; contents: string | Uint8Array };
  /** The two rows' quotes, cited from 1, and their numbers as written. */
  cites: readonly [string, string];
  numbers: readonly [string, string];
  unitQuote?: string;
  unitQuotes?: UnitQuotes;
  query: string;
}

async function record(c: Case) {
  const model = calculatingModel(c.query, c.cites, c.numbers, c.unitQuote, c.unitQuotes);
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    answerPaths: { retrievesFirst: () => false },
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, c.file.name, c.file.contents)]);
  const answer = await askAndRead(core);
  core.close();
  return {
    value: answer.figures[0]?.value ?? null,
    scale: answer.figures[0]?.inputs[0]?.unitStatement?.scale ?? null,
    currency: answer.figures[0]?.inputs[0]?.unitStatement?.currency ?? null,
    statement: answer.figures[0]?.inputs[0]?.unitStatement?.citation.quote ?? null,
    asked: told(model, "calculate"),
  };
}

const pdf = (name: string, lines: readonly string[]) => ({
  name: `${name}.pdf`,
  contents: buildPdf([{ lines }]),
});
const pdfZh = (name: string, lines: readonly string[]) => ({
  name: `${name}.pdf`,
  contents: buildPdf([{ chineseLines: lines }]),
});
const rows: readonly [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
const rowsZh: readonly [string, string] = ["收入 1,200", "成本 300"];
/** Enough text that a page's scale line is a Passage of its own. */
const filler = (chinese: boolean) =>
  Array.from({ length: 40 }, (_, index) =>
    chinese
      ? `董事会第${index + 1}次审阅了集团的经营情况、现金状况以及来年的展望。`
      : `The directors reviewed item ${index + 1} of the group's trading, cash and outlook in detail.`,
  );

describe("The scale cases #2365 still misses (#2365)", { timeout: 120_000 }, () => {
  // protects=#2365; fails_when=a Chinese bracket naming a currency and a scale ("（人民币，百万）") is invisible to the nearer check, so a wider 千元 line scales figures at a hundredth of the stated 百万.
  test.each([
    { language: "Simplified", nearer: "董事酬金（人民币，百万）" },
    { language: "Traditional", nearer: "董事酬金（人民幣，百萬）" },
  ])("a nearer Chinese bracket states its currency and scale: $language", async ({ nearer }) => {
    const file = pdfZh("董事酬金账目", ["所有金额单位：千元", nearer, ...rowsZh]);
    const wider = await record({
      file,
      cites: rowsZh,
      numbers: ["1,200", "300"],
      unitQuote: "所有金额单位：千元",
      query: "董事酬金 收入 成本",
    });
    const bracket = await record({
      file,
      cites: rowsZh,
      numbers: ["1,200", "300"],
      unitQuote: nearer,
      query: "董事酬金 收入 成本",
    });

    expect([null, 900_000_000]).toContain(wider.value);
    expect(bracket.value).toBe(900_000_000);
    expect(bracket.scale).toBe(1_000_000);
  });

  // protects=#2365; fails_when=a per-share row a line excepts is scaled by the line, or loses the currency its own head states, so the result has no unit statement.
  test("a per-share row the line excepts keeps its own currency", async () => {
    const recorded = await record({
      file: pdf("EPS results", [
        "(in millions, except per share data)",
        "Basic EPS ($) 2.47",
        "Diluted EPS ($) 2.41",
      ]),
      cites: ["Basic EPS ($) 2.47", "Diluted EPS ($) 2.41"],
      numbers: ["2.47", "2.41"],
      query: "EPS results",
    });

    expect(recorded.value).toBeCloseTo(0.06, 9);
    expect(recorded.currency).toBe("USD");
    expect(recorded.statement).not.toBeNull();
  });

  // protects=#2365; fails_when=a scale inside a bracket's exception clause ("except share counts in thousands") is read as the line's scale and the currency is dropped.
  test.each([
    "(in $, except share counts in thousands)",
    "(in $, other than headcount in thousands)",
  ])("a scale in an exception clause states only what the clause excepts: %s", async (line) => {
    const recorded = await record({
      file: pdf("Exceptions", [line, ...rows]),
      cites: rows,
      numbers: ["1,234.5", "334.5"],
      unitQuote: line,
      query: "exceptions revenue costs",
    });

    expect([null, 900]).toContain(recorded.value);
  });

  // protects=#2365; fails_when=a caption in the figure's own Unit that names another table ("Table 1 … (in thousands)") states a later table's scale.
  test.each([
    {
      language: "PDF",
      file: pdf("Two tables", [
        "Table 1 Group revenue (in thousands)",
        "Sales 500.5",
        "Fees 100.5",
        "Table 2 Company results",
        ...rows,
      ]),
      line: "Table 1 Group revenue (in thousands)",
    },
    {
      language: "text",
      file: {
        name: "Two tables.txt",
        contents:
          "Table 1 Group revenue (in thousands)\nSales 500.5\nFees 100.5\n\nTable 2 Company results\nRevenue 1,234.5\nCosts 334.5\n",
      },
      line: "Table 1 Group revenue (in thousands)",
    },
    {
      language: "this table",
      file: pdf("Table blocks", [
        "All amounts in this table are in £'000",
        "Sales 500.5",
        "Fees 100.5",
        "Other information",
        ...rows,
      ]),
      line: "All amounts in this table are in £'000",
    },
  ])(
    "a caption for another table never states the figure's scale: $language",
    async ({ file, line }) => {
      const recorded = await record({
        file,
        cites: rows,
        numbers: ["1,234.5", "334.5"],
        unitQuote: line,
        query: "company results revenue costs",
      });

      expect(recorded.value).toBeNull();
    },
  );

  // protects=#2365; fails_when=a caption's money scale is applied to a row that isn't an amount: a return, a cover, a days ratio, gearing, or a price in pence.
  test.each([
    {
      row: "Return on equity 12.5",
      other: "Return on assets 4.5",
      line: "(in £'000)",
      ok: [null, 8],
    },
    {
      row: "Interest cover 4.5",
      other: "Dividend cover 2.5",
      line: "(in $ millions)",
      ok: [null, 2],
    },
    { row: "Inventory days 60.5", other: "Debtor days 45.5", line: "(in £'000)", ok: [null, 15] },
    {
      row: "Gearing 35.5",
      other: "Net debt to EBITDA 1.5",
      line: "(in thousands)",
      ok: [null, 34],
    },
    {
      row: "Closing share price (p) 245.5",
      other: "Opening share price (p) 45.5",
      line: "Five-year summary (in £m)",
      ok: [null, 200],
    },
  ])("a scale for amounts doesn't apply to $row", async ({ row, other, line, ok }) => {
    const recorded = await record({
      file: pdf("Ratios", [line, row, other]),
      cites: [row, other],
      numbers: [row.split(" ").at(-1) as string, other.split(" ").at(-1) as string],
      unitQuote: line,
      query: "ratios summary",
    });

    expect(ok).toContain(recorded.value);
  });

  // protects=#2365; fails_when=a heading that only looks like a scale ("Thousand Oaks", "Millions of customers served", "千元店业绩") is read and scales a figure under it.
  test.each([
    {
      language: "Thousand Oaks",
      file: pdf("Oaks", ["Thousand Oaks", ...rows]),
      line: "Thousand Oaks",
    },
    {
      language: "Thousand Island",
      file: pdf("Island", ["Thousand Island", ...rows]),
      line: "Thousand Island",
    },
    {
      language: "Billion dollar brands",
      file: pdf("Brands", ["Billion dollar brands", ...rows]),
      line: "Billion dollar brands",
    },
    {
      language: "千元店业绩",
      file: pdfZh("千元店", ["千元店业绩", ...rowsZh]),
      line: "千元店业绩",
      chinese: true,
    },
    {
      language: "Millions of customers served",
      file: {
        name: "Customers.docx",
        contents: docxOf([
          { text: "Overview", heading: 1 },
          { text: "Millions of customers served", heading: 2 },
          ...rows.map((text) => ({ text })),
        ]),
      },
      line: "Millions of customers served",
    },
  ])(
    "a heading that only looks like a scale states none: $language",
    async ({ file, line, chinese }) => {
      const cited = chinese ? rowsZh : rows;
      const recorded = await record({
        file,
        cites: cited,
        numbers: chinese ? ["1,200", "300"] : ["1,234.5", "334.5"],
        unitQuote: line,
        query: `${line.split(" ")[0]} revenue costs`,
      });

      expect(recorded.value).toBeNull();
    },
  );

  // protects=#2365; fails_when=a bracket's currency is dropped once its tail's scale is read ("(in dollars, in thousands)", "(in HK$, figures in millions)").
  test.each([
    { line: "(in dollars, in thousands)", value: 900_000, currency: "USD" },
    { line: "(in HK$, figures in millions)", value: 900_000_000, currency: "HKD" },
  ])(
    "a bracket's currency is kept with its tail's scale: %s",
    async ({ line, value, currency }) => {
      const recorded = await record({
        file: pdf("Currency tails", [line, ...rows]),
        cites: rows,
        numbers: ["1,234.5", "334.5"],
        unitQuote: line,
        query: "currency tails revenue costs",
      });

      expect(recorded.value).toBe(value);
      expect(recorded.currency).toBe(currency);
    },
  );

  // protects=#2365; fails_when=a sheet's name states a scale ("P&L £'000") and its figures are calculated unscaled with no statement.
  test("a scale in a sheet's name refuses a figure that can't quote it", async () => {
    const recorded = await record({
      file: {
        name: "Sheet scale.xlsx",
        contents: xlsxOf([
          {
            name: "P&L £'000",
            rows: [
              ["Revenue", 1234.5],
              ["Costs", 334.5],
            ],
          },
        ]),
      },
      cites: ["Revenue\t1234.5", "Costs\t334.5"],
      numbers: ["1234.5", "334.5"],
      query: "revenue costs",
    });

    expect(recorded.value).toBeNull();
    expect(recorded.asked).toContain("P&L £'000");
  });

  // protects=#2365; fails_when=quoting a row head that states only a currency ("(US$)" under "(in thousands)") records the amount unscaled.
  test("a currency-only row head quoted under a scale refuses or combines the scale", async () => {
    const dollarRows: readonly [string, string] = ["Revenue (US$) 1,234.5", "Costs (US$) 334.5"];
    const recorded = await record({
      file: pdf("Dollar head", ["(in thousands)", ...dollarRows]),
      cites: dollarRows,
      numbers: ["1,234.5", "334.5"],
      unitQuote: "(US$)",
      query: "dollar head revenue costs",
    });

    expect(recorded.value).toBe(900_000);
    expect(recorded.statement).toBe("(in thousands)");
  });

  // protects=#2365; fails_when=a row head that states only a currency borrows a scale from another table, or one below it, instead of refusing or reading the row's own currency.
  test.each([
    {
      language: "another table's scale",
      file: pdf("Two tables", [
        "Table 1 Headcount (in thousands)",
        "Employees 1,200",
        "Table 2 Revenue",
        "Revenue (US$) 1,234.5",
        "Costs (US$) 334.5",
      ]),
    },
    {
      language: "a scale below the rows",
      file: pdf("Later table", [
        "Table 2 Revenue",
        "Revenue (US$) 1,234.5",
        "Costs (US$) 334.5",
        "Table 1 Headcount (in thousands)",
        "Employees 1,200",
      ]),
    },
  ])("a currency-only row head doesn't borrow $language", async ({ file }) => {
    const dollarRows: readonly [string, string] = ["Revenue (US$) 1,234.5", "Costs (US$) 334.5"];
    const recorded = await record({
      file,
      cites: dollarRows,
      numbers: ["1,234.5", "334.5"],
      unitQuote: "(US$)",
      query: "two tables revenue costs",
    });

    expect([null, 900]).toContain(recorded.value);
  });

  // protects=#2365; fails_when=a fragment of another table's caption ("(in thousands)" from "Table 1 …") is quoted and states a later table's scale, because only the fragment is judged.
  test("a fragment of another table's caption doesn't state a scale", async () => {
    const recorded = await record({
      file: pdf("Fragment table", [
        "Table 1 Headcount (in thousands)",
        "Employees 1,200",
        "Table 2 Revenue",
        ...rows,
      ]),
      cites: rows,
      numbers: ["1,234.5", "334.5"],
      unitQuote: "(in thousands)",
      query: "fragment table revenue costs",
    });

    expect([null, 900]).toContain(recorded.value);
  });

  // protects=#2365; fails_when=a bracket that only looks like a scale ("（千元店业绩）", "（万元户调查）") states one and scales the rows under it.
  test.each(["经营概况（千元店业绩）", "经营概况（万元户调查）"])(
    "a bracketed shop or household name states no scale: %s",
    async (line) => {
      const recorded = await record({
        file: pdfZh("经营概况", [line, ...rowsZh]),
        cites: rowsZh,
        numbers: ["1,200", "300"],
        unitQuote: line,
        query: "经营概况 收入 成本",
      });

      expect(recorded.value).toBeNull();
    },
  );

  // protects=#2365; fails_when=a longer Chinese bracket that names its currency ("（以港币千元列示）", "（以港幣仟元列示）") is read as yuan.
  test.each(["董事酬金（以港币千元列示）", "董事酬金（以港幣仟元列示）"])(
    "a longer Chinese bracket keeps its named currency: %s",
    async (line) => {
      const recorded = await record({
        file: pdfZh("董事酬金账目", [line, ...rowsZh]),
        cites: rowsZh,
        numbers: ["1,200", "300"],
        unitQuote: line,
        query: "董事酬金 收入 成本",
      });

      expect(recorded.value).toBe(900_000);
      expect(recorded.currency).toBe("HKD");
    },
  );

  // protects=#2365; fails_when=a quote of the number alone drops the currency its own line writes, so a unitQuote in another currency ("(in £m)" over "$1,234.5", "金额单位：万英镑" over "收入（元）") scales it instead of refusing.
  test.each([
    {
      language: "English",
      file: pdf("Currency", ["(in £m)", "Revenue $1,234.5", "Costs $334.5"]),
      cites: ["1,234.5", "334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      unitQuote: "(in £m)",
      query: "currency rows revenue costs",
    },
    {
      language: "Chinese",
      file: pdfZh("币种", ["金额单位：万英镑", "收入（元） 1,200", "成本（元） 300"]),
      cites: ["1,200", "300"] as [string, string],
      numbers: ["1,200", "300"] as [string, string],
      unitQuote: "金额单位：万英镑",
      query: "币种 收入 成本",
    },
  ])("a bare-number quote keeps the currency its line states: $language", async (each) => {
    const recorded = await record({
      file: each.file,
      cites: each.cites,
      numbers: each.numbers,
      unitQuote: each.unitQuote,
      query: each.query,
    });

    expect([null, 900]).toContain(recorded.value);
  });

  // protects=#2365; fails_when=the exception-clause guard is removed and a bracket that states only an exception ("(except share counts in thousands)") scales the rows.
  test("an exception-only bracket states no scale", async () => {
    const line = "(except share counts in thousands)";
    const recorded = await record({
      file: pdf("Exception only", [line, ...rows]),
      cites: rows,
      numbers: ["1,234.5", "334.5"],
      unitQuote: line,
      query: "exception only revenue costs",
    });

    expect(recorded.value).toBeNull();
    expect(recorded.asked).toContain("states no unit or scale");
  });

  // protects=#2365; fails_when=the row's own currency is dropped when the exception line itself is the unitQuote.
  test("a per-share row keeps its own currency when the exception line is quoted", async () => {
    const head = "(in millions, except per share data)";
    const recorded = await record({
      file: pdf("EPS results", [head, "Basic EPS ($) 2.47", "Diluted EPS ($) 2.41"]),
      cites: ["Basic EPS ($) 2.47", "Diluted EPS ($) 2.41"],
      numbers: ["2.47", "2.41"],
      unitQuote: head,
      query: "EPS results",
    });

    expect(recorded.value).toBeCloseTo(0.06, 9);
    expect(recorded.currency).toBe("USD");
  });

  // protects=#2365; fails_when=a per-share row the quoted line excepts takes the line's currency ("(in US$ millions, except per share data)") over the one its own head or figure writes ("Basic EPS (HK$)"), so HK$1.00 is recorded as $1.00; or a row that writes none loses the line's.
  test.each([
    {
      language: "English, the whole row",
      lines: ["Basic EPS (HK$) 2.47", "Diluted EPS (HK$) 1.47"],
      cites: ["Basic EPS (HK$) 2.47", "Diluted EPS (HK$) 1.47"] as [string, string],
      currency: "HKD",
    },
    {
      language: "English, the number alone",
      lines: ["Basic EPS (HK$) 2.47", "Diluted EPS (HK$) 1.47"],
      cites: ["2.47", "1.47"] as [string, string],
      currency: "HKD",
    },
    {
      language: "English, the number alone on a line that writes its sign",
      lines: ["Basic EPS HK$2.47", "Diluted EPS HK$1.47"],
      cites: ["2.47", "1.47"] as [string, string],
      currency: "HKD",
    },
    {
      language: "English, a row that writes no currency",
      lines: ["Basic EPS 2.47", "Diluted EPS 1.47"],
      cites: ["Basic EPS 2.47", "Diluted EPS 1.47"] as [string, string],
      currency: "USD",
    },
    {
      language: "Chinese, the whole row",
      lines: ["基本每股收益（港元） 2.47", "稀释每股收益（港元） 1.47"],
      cites: ["基本每股收益（港元） 2.47", "稀释每股收益（港元） 1.47"] as [string, string],
      currency: "HKD",
    },
    {
      language: "Chinese, the number alone",
      lines: ["基本每股收益（港元） 2.47", "稀释每股收益（港元） 1.47"],
      cites: ["2.47", "1.47"] as [string, string],
      currency: "HKD",
    },
    {
      language: "Chinese, a row that writes no currency",
      lines: ["基本每股收益 2.47", "稀释每股收益 1.47"],
      cites: ["基本每股收益 2.47", "稀释每股收益 1.47"] as [string, string],
      currency: "USD",
    },
  ])(
    "an excepted per-share row keeps its own currency over the line's: $language",
    async (each) => {
      const chinese = each.language.startsWith("Chinese");
      const head = chinese
        ? "（除每股数据外，单位：百万美元）"
        : "(in US$ millions, except per share data)";
      const recorded = await record({
        file: chinese
          ? pdfZh("每股收益", [head, ...each.lines])
          : pdf("EPS currency", [head, ...each.lines]),
        cites: each.cites,
        numbers: ["2.47", "1.47"],
        unitQuote: head,
        query: chinese ? "每股收益" : "EPS currency",
      });

      expect(recorded.value).toBeCloseTo(1, 9);
      expect(recorded.currency).toBe(each.currency);
    },
  );

  // protects=#2365; fails_when=the conflicting-scales refusal is removed and a currency-only row takes one of two scales ("Volumes in millions; amounts in thousands").
  test("a currency-only row with two scale statements refuses", async () => {
    const dollarRows: readonly [string, string] = ["Revenue (US$) 1,234.5", "Costs (US$) 334.5"];
    const recorded = await record({
      file: pdf("Two scales", ["Volumes in millions; amounts in thousands", ...dollarRows]),
      cites: dollarRows,
      numbers: ["1,234.5", "334.5"],
      unitQuote: "(US$)",
      query: "two scales revenue costs",
    });

    expect(recorded.value).toBeNull();
  });

  // protects=#2365; fails_when=a currency-only row takes a scale across a bare table caption ("表2"), from a measure ("million tonnes"), or from a retained Word header, instead of refusing or using only its own scale.
  test.each([
    {
      language: "a bare table caption",
      file: pdfZh("分部", [
        "表1 分部业绩（单位：千元）",
        "分部收入 1,200",
        "表2",
        "收入（元） 1,200",
        "成本（元） 300",
      ]),
      cites: ["收入（元） 1,200", "成本（元） 300"] as [string, string],
      numbers: ["1,200", "300"] as [string, string],
      unitQuotes: ["收入（元）", "成本（元）"] as [string, string],
      query: "分部 收入 成本",
      ok: [null, 900],
    },
    {
      language: "a measure",
      file: pdf("Measures", ["Unit: million tonnes", "Revenue (US$) 1,234.5", "Costs (USD) 334.5"]),
      cites: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      unitQuotes: ["(US$)", "(USD)"] as [string, string],
      query: "measures revenue costs",
      ok: [null, 900],
    },
    {
      language: "a retained Word header",
      file: {
        name: "Header scale.docx",
        contents: docxOf([{ text: "Revenue (US$) 1,234.5" }, { text: "Costs (USD) 334.5" }], {
          header: "All amounts in thousands",
        }),
      },
      cites: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      unitQuotes: ["(US$)", "(USD)"] as [string, string],
      query: "header scale revenue costs",
      ok: [null, 900_000],
    },
  ])("a currency-only row doesn't take $language", async (each) => {
    const recorded = await record({
      file: each.file,
      cites: each.cites,
      numbers: each.numbers,
      unitQuotes: each.unitQuotes,
      query: each.query,
    });

    expect(each.ok).toContain(recorded.value);
  });

  // protects=#2365; fails_when=a quoted line that states a measure ("Unit: million tonnes", "单位：万吨") scales or names the unit of an amount its row head or own line writes in a currency, so $1,234.5 becomes $1,234.5 million or 1,234.5 million tonnes.
  test.each([
    {
      language: "English, the whole row",
      lines: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"],
      cites: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"] as [string, string],
    },
    {
      language: "English, the number alone",
      lines: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"],
      cites: ["1,234.5", "334.5"] as [string, string],
    },
    {
      language: "English, the number alone on a line that writes its sign",
      lines: ["Revenue $1,234.5", "Costs $334.5"],
      cites: ["1,234.5", "334.5"] as [string, string],
    },
    {
      language: "Chinese, the whole row",
      lines: ["收入（元） 1,200", "成本（元） 300"],
      cites: ["收入（元） 1,200", "成本（元） 300"] as [string, string],
    },
    {
      language: "Chinese, the number alone",
      lines: ["收入（元） 1,200", "成本（元） 300"],
      cites: ["1,200", "300"] as [string, string],
    },
  ])("a quoted measure's line never scales an amount: $language", async (each) => {
    const chinese = each.language.startsWith("Chinese");
    const measure = chinese ? "单位：万吨" : "Unit: million tonnes";
    const recorded = await record({
      file: chinese
        ? pdfZh("计量", [measure, ...each.lines])
        : pdf("Measures", [measure, ...each.lines]),
      cites: each.cites,
      numbers: chinese ? ["1,200", "300"] : ["1,234.5", "334.5"],
      unitQuote: measure,
      query: chinese ? "计量 收入 成本" : "measures revenue costs",
    });

    expect(recorded.value).toBeNull();
    expect(recorded.asked).toContain("states a unit of measure");
  });

  // protects=#2365; fails_when=the measure guard refuses a measure's own rows, which the line's scale states.
  test.each([
    {
      language: "English",
      file: pdf("Measures", ["Unit: million tonnes", "Output 1,234.5", "Shipments 334.5"]),
      cites: ["Output 1,234.5", "Shipments 334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      unitQuote: "Unit: million tonnes",
      query: "measures output shipments",
      value: 900_000_000,
    },
    {
      language: "Chinese",
      file: pdfZh("计量", ["单位：万吨", "产量 1,200", "销量 300"]),
      cites: ["产量 1,200", "销量 300"] as [string, string],
      numbers: ["1,200", "300"] as [string, string],
      unitQuote: "单位：万吨",
      query: "计量 产量 销量",
      value: 9_000_000,
    },
  ])("a measure's line still scales its own rows: $language", async (each) => {
    const recorded = await record(each);

    expect(recorded.value).toBe(each.value);
    expect(recorded.currency).toBeNull();
    expect(recorded.statement).toBe(each.unitQuote);
  });

  // protects=#2365; fails_when=a currency-only row head reads its rows plain though an earlier page states a scale for the whole Document ("All amounts in thousands"), so $900 thousand is recorded as $900.
  test.each([
    {
      language: "English",
      pages: [
        ["Group notes", "All amounts in thousands", ...filler(false)],
        filler(false),
        ["Group accounts", "Revenue (US$) 1,234.5", "Costs (USD) 334.5"],
      ],
      cites: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      unitQuotes: ["(US$)", "(USD)"] as [string, string],
      scale: "All amounts in thousands",
      query: "group accounts revenue costs",
    },
    {
      language: "Chinese",
      pages: [
        ["集团附注", "所有金额单位：千元", ...filler(true)],
        filler(true),
        ["集团账目", "收入（元） 1,200", "成本（元） 300"],
      ],
      cites: ["收入（元） 1,200", "成本（元） 300"] as [string, string],
      numbers: ["1,200", "300"] as [string, string],
      unitQuotes: ["收入（元）", "成本（元）"] as [string, string],
      scale: "所有金额单位：千元",
      query: "集团账目 收入 成本",
    },
  ])(
    "a currency-only row head doesn't read plain under an earlier page's scale: $language",
    async (each) => {
      const chinese = each.language === "Chinese";
      const recorded = await record({
        file: {
          name: chinese ? "跨页.pdf" : "Cross page.pdf",
          contents: buildPdf(
            each.pages.map((lines) => (chinese ? { chineseLines: lines } : { lines })),
          ),
        },
        cites: each.cites,
        numbers: each.numbers,
        unitQuotes: each.unitQuotes,
        query: each.query,
      });

      expect(recorded.value).toBeNull();
      expect(recorded.asked).toContain(each.scale);
    },
  );

  // protects=#2365; fails_when=prose that names a shop's results or a household survey ("以千元店业绩为基准", "以万元户调查为基础") is read as a unit declaration.
  test.each(["经营概况（以千元店业绩为基准）", "经营概况（以万元户调查为基础）"])(
    "prose with a shop or household clause states no scale: %s",
    async (line) => {
      const recorded = await record({
        file: pdfZh("经营概况", [line, ...rowsZh]),
        cites: rowsZh,
        numbers: ["1,200", "300"],
        unitQuote: line,
        query: "经营概况 收入 成本",
      });

      expect(recorded.value).toBeNull();
    },
  );

  // protects=#2365; fails_when=a price row takes the page's money scale, so "(in thousands)" turns 12.5 − 3.5 into $9.0 thousand.
  test("a price row under a page's scale is refused or read plain", async () => {
    const priceRows: readonly [string, string] = [
      "Average price (US$) 12.5",
      "Unit cost (US$) 3.5",
    ];
    const recorded = await record({
      file: pdf("Average prices", ["(in thousands)", ...priceRows]),
      cites: priceRows,
      numbers: ["12.5", "3.5"],
      unitQuote: "(in thousands)",
      query: "average prices",
    });

    expect([null, 9]).toContain(recorded.value);
  });
});
