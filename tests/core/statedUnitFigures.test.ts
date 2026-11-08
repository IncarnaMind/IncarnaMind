/**
 * A figure written as bare digits, in the unit its Document states, is never Contradicted for that
 * unit alone (#2864): "668.3" against a Document in GBP million keeps the judge's Supported and
 * names the unit; where the unit can't be read it needs a look, "Units may differ". A figure that
 * really differs stays Contradicted, a percent is never scaled, and no code path gives a Supported
 * the judge didn't.
 */
import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { translate } from "../../src/shared/i18n";
import { checkingModel, type Plan, requestedFigures } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import type { ModelCall, ScriptedReply } from "../helpers/models";

interface SourceFile {
  name: string;
  contents: string;
}

/** Checks `claim` as a sentence of a Note, as the Note's Check does, and gives its check. */
async function check(
  claim: string,
  document: SourceFile,
  plan: Plan,
  language: "en" | "zh-CN" = "en",
): Promise<ClaimCheckAttributes> {
  const { core, mind, client } = await setUpWithDocuments(checkingModel({ [claim]: plan }), [
    document,
  ]);
  if (language !== "en") await core.updateSettings({ user: { language } });
  writeMind(client, [
    { type: "paragraph", attrs: { id: "line" }, content: [{ type: "text", text: claim }] },
  ]);
  await client.settled();
  await core.checkSentences({
    requestId: "check",
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "line", offset: 0 },
    to: { blockId: "line", offset: claim.length },
  });
  await client.settled();
  const span = claimSpans(readMind(client)).find((each) => each.sentence.text.trim() === claim);
  core.close();
  if (!span) throw new Error(`${claim} wasn't checked.`);
  return span.check;
}

const HALF_YEAR: SourceFile = {
  name: "Harbourline half-year update.txt",
  contents: [
    "Harbourline Foods plc half-year update",
    "GBP million unless stated otherwise",
    "Revenue for the six months was 668.3.",
    "Net debt at 30 June 2026 was 528.9.",
    "",
  ].join("\n"),
};

const THOUSANDS: SourceFile = {
  name: "Calder Mills interim.txt",
  contents: [
    "Calder Mills interim statement",
    "(US$ thousands)",
    "Revenue 84,215",
    "Operating costs 74,475.2",
    "",
  ].join("\n"),
};

const MILLIONS_ZH: SourceFile = {
  name: "华岭食品年报摘要.txt",
  contents: [
    "华岭食品2025年年度报告摘要",
    "单位：人民币百万元",
    "2025年全年营业收入为187.3。",
    "",
  ].join("\n"),
};

const TEN_THOUSANDS: SourceFile = {
  name: "北辰机械半年报.txt",
  contents: ["北辰机械2026年半年度报告", "单位：万元", "营业收入为3,416.2。", ""].join("\n"),
};

const TABLE: SourceFile = {
  name: "Segment table.md",
  contents: [
    "# Segment results",
    "",
    "| Segment | Revenue (£m) |",
    "| --- | --- |",
    "| Bakery | 41.0 |",
    "| Dairy | 63.5 |",
    "",
  ].join("\n"),
};

const NO_UNIT: SourceFile = {
  name: "Ridgeway Hotels.txt",
  contents: ["Ridgeway Hotels trading note", "Room revenue was 8,214,000.", ""].join("\n"),
};

const supported = (quote: string, unitQuote?: string): Plan => ({
  verdict: "supported",
  quote,
  says: quote,
  ...(unitQuote && { unitQuote }),
});
const contradicted = (quote: string, unitQuote?: string): Plan => ({
  ...supported(quote, unitQuote),
  verdict: "contradicted",
});

const unitLine = (language: "en" | "zh-CN", figure: string, unit: string) =>
  translate(language, "figures.card.statedUnit", { figure, unit });

describe("a bare figure in the unit its Document states is Supported, naming it", () => {
  // protects=the judge's Supported stands for bare digits its Document states in GBP million, US$ thousands, 人民币百万元, 万元 or a table heading's £m, and the figure carries the unit as the Document writes it; fails_when=668.3 against 668,300,000 is Contradicted again, or the unit isn't named; no_claim=a real model's verdict, which tests/live/statedUnits.live.test.ts measures.
  test.each([
    {
      claim: "Revenue for the six months: 668.3",
      document: HALF_YEAR,
      plan: supported(
        "Revenue for the six months was 668.3",
        "GBP million unless stated otherwise",
      ),
      unit: "GBP million",
      language: "en" as const,
    },
    {
      claim: "Revenue: 84,215",
      document: THOUSANDS,
      plan: supported("Revenue 84,215", "(US$ thousands)"),
      unit: "US$ thousands",
      language: "en" as const,
    },
    {
      claim: "营业收入：2025年全年为187.3。",
      document: MILLIONS_ZH,
      plan: supported("2025年全年营业收入为187.3", "单位：人民币百万元"),
      unit: "人民币百万元",
      language: "zh-CN" as const,
    },
    {
      claim: "营业收入为3,416.2。",
      document: TEN_THOUSANDS,
      plan: supported("营业收入为3,416.2", "单位：万元"),
      unit: "万元",
      language: "zh-CN" as const,
    },
    {
      claim: "Bakery revenue: 41.0",
      document: TABLE,
      plan: { ...supported("Bakery | 41.0", "Segment | Revenue (£m)"), number: "41.0" },
      unit: "£m",
      language: "en" as const,
    },
  ])("$claim in $unit", async ({ claim, document, plan, unit, language }) => {
    const result = await check(claim, document, plan, language);
    const [figure] = result.figures ?? [];
    expect(result.state).toBe("supported");
    expect(figure).toMatchObject({ statedUnit: unit, state: "supported" });
    expect(unitLine(language, figure?.reading.chars ?? "", figure?.statedUnit ?? "")).toBe(
      language === "en"
        ? `${figure?.reading.chars}: in ${unit}, as the Document states`
        : `${figure?.reading.chars}：以${unit}计，与文档一致`,
    );
  });
});

describe("a figure that differs only by a unit is never Contradicted", () => {
  // protects=the judge's Contradicted on bare digits that agree in the unit their Document states becomes Needs a look, "Units may differ", with the source's value in the sentence's terms; fails_when=668.3 in GBP million reads Contradicted, or Supported; no_claim=none beyond protects.
  test("the judge's Contradicted in the stated unit needs a look", async () => {
    const result = await check(
      "Revenue for the six months: 668.3",
      HALF_YEAR,
      contradicted("Revenue for the six months was 668.3", "GBP million unless stated otherwise"),
    );
    expect(result).toMatchObject({
      state: "unsupported",
      unsupported: {
        kind: "units",
        reason: "Units may differ: the source gives 668,300,000",
      },
    });
    expect(result.figures?.[0]?.statedUnit).toBeUndefined();
  });

  // protects=bare digits a thousand times from a number whose Document states no unit need a look, in English and Chinese, whatever the judge said; fails_when=8,214 against 8,214,000 is Contradicted or Supported; no_claim=none beyond protects.
  test.each(["supported", "contradicted"] as const)(
    "a unit the Document doesn't state, judged %s, may differ",
    async (verdict) => {
      const result = await check("Room revenue: 8,214", NO_UNIT, {
        verdict,
        quote: "Room revenue was 8,214,000",
        says: "Room revenue was 8,214,000",
      });
      expect(result).toMatchObject({
        state: "unsupported",
        unsupported: { kind: "units", reason: "Units may differ: the source gives 8,214,000" },
      });
      const zh = await check(
        "客房收入：8,214",
        { name: "客房.txt", contents: "客房经营简报\n客房收入为8,214,000。\n" },
        { verdict, quote: "客房收入为8,214,000", says: "客房收入为8,214,000" },
        "zh-CN",
      );
      expect(zh).toMatchObject({
        state: "unsupported",
        unsupported: { kind: "units", reason: "单位可能不同：来源为 8,214,000" },
      });
    },
  );
});

describe("Contradicted keeps its meaning", () => {
  // protects=a figure that really differs in the stated unit, bare or written with its own unit, stays Contradicted with the source value in the sentence's terms; fails_when=538.9 against 528.9 in GBP million is softened or Supported; no_claim=none beyond protects.
  test.each([
    { claim: "Net debt at 30 June 2026: 538.9", value: "528.9" },
    { claim: "Net debt at 30 June 2026 was £538.9m.", value: "£528.9m" },
  ])("$claim against 528.9 in GBP million", async ({ claim }) => {
    const result = await check(
      claim,
      HALF_YEAR,
      contradicted("Net debt at 30 June 2026 was 528.9", "GBP million unless stated otherwise"),
    );
    expect(result.state).toBe("contradicted");
    expect(result.figures?.[0]).toMatchObject({ state: "contradicted" });
    expect(result.figures?.[0]?.difference).toBe(10_000_000);
  });

  // protects=a figure whose own unit puts it a thousand times from its source keeps the Document's own scale reason, never Supported and never softened to a unit question; fails_when=£412.6m against 412.6 in GBP thousands reads Supported or "Units may differ"; no_claim=whether that reason is Unsupported or Contradicted, which #1798 settles.
  test("a figure written with its own unit a thousand times off isn't a unit question", async () => {
    const result = await check(
      "Ticket revenue was £412.6m.",
      {
        name: "Tollgate.txt",
        contents: "Tollgate Ferries results\nGBP thousands\nTicket revenue was 412.6.\n",
      },
      supported("Ticket revenue was 412.6", "GBP thousands"),
    );
    expect(result).toMatchObject({
      state: "unsupported",
      unsupported: { reason: "The Document gives 412.6, not £412.6m." },
    });
    expect(result.unsupported?.kind).toBeUndefined();
  });

  // protects=unit scaling never touches a percent: 4.5% against 4.1% and 0.041% against 41% stay Contradicted; fails_when=a share a thousand times off reads "Units may differ"; no_claim=none beyond protects.
  test.each([
    {
      claim: "2025年营业收入同比增长4.5%。",
      document: {
        name: "增长.txt",
        contents: "华岭食品年报摘要\n单位：人民币百万元\n2025年营业收入同比增长4.1%。\n",
      },
      quote: "2025年营业收入同比增长4.1%",
    },
    {
      claim: "The gross margin was 0.041%.",
      document: { name: "Margin.txt", contents: "Margins\nThe gross margin was 41%.\n" },
      quote: "The gross margin was 41%",
    },
  ])("$claim", async ({ claim, document, quote }) => {
    const result = await check(claim, document, contradicted(quote));
    expect(result.state).toBe("contradicted");
    expect(result.unsupported?.kind).toBeUndefined();
  });
});

describe("a separator reading a thousand times away is never Supported", () => {
  /**
   * The judge cites the quote, then reads the figure's digits as `reading` (2: "." grouping
   * thousands), bound to the Document's 8,214 under its unit line.
   */
  const readsAs =
    (reading: number) =>
    (call: ModelCall): ScriptedReply => {
      const quote = "Room revenue was 8,214";
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(call.results.at(-1)?.text ?? "").find((each) =>
          each.text.includes(quote),
        );
        return {
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } },
          ],
        };
      }
      const items = requestedFigures(call).map(({ id }) => ({
        id,
        verdict: "supported",
        scope: "same",
        topic: "found",
        roles: "same",
        says: null,
        reading,
        relation: "equals",
        source: {
          citation: 1,
          number: "8,214",
          reading: 1,
          unitQuote: "GBP thousands unless stated otherwise",
        },
        calculation: null,
      }));
      return {
        text: `Verdict: supported\n${quote} [^1]\nFigures: ${JSON.stringify({ items, remainder: null })}`,
      };
    };

  // protects="8.214 thousand pounds" against 8,214 in GBP thousands (8,214,000) needs a look when the judge reads its "." as grouping thousands to make it agree, and the reading English writes stays the one shown; fails_when=that reading makes it Supported; no_claim=a Note whose separators its other numbers settle, which offers no such reading.
  test("8.214 thousand read as 8,214 thousand needs a look", async () => {
    const claim = "Room revenue was 8.214 thousand pounds.";
    const result = await check(
      claim,
      {
        name: "Ridgeway Hotels.txt",
        contents:
          "Ridgeway Hotels\nGBP thousands unless stated otherwise\nRoom revenue was 8,214.\n",
      },
      { reply: readsAs(2) },
    );
    expect(result).toMatchObject({
      state: "unsupported",
      unsupported: { kind: "units", reason: "Units may differ: the source gives 8,214 thousand" },
    });
    expect(result.figures?.[0]?.reading.value).toBe(8214);
  });
});

describe("no code path gives a Supported the judge didn't", () => {
  const CASES: { claim: string; document: SourceFile; quote: string; unitQuote?: string }[] = [
    {
      claim: "Revenue for the six months: 668.3",
      document: HALF_YEAR,
      quote: "Revenue for the six months was 668.3",
      unitQuote: "GBP million unless stated otherwise",
    },
    {
      claim: "Revenue for the six months: 668.3",
      document: HALF_YEAR,
      quote: "Revenue for the six months was 668.3",
    },
    {
      claim: "Revenue for the six months was £668.3m.",
      document: HALF_YEAR,
      quote: "Revenue for the six months was 668.3",
      unitQuote: "GBP million unless stated otherwise",
    },
    {
      claim: "Revenue: 84,215",
      document: THOUSANDS,
      quote: "Revenue 84,215",
      unitQuote: "(US$ thousands)",
    },
    { claim: "Room revenue: 8,214,000", document: NO_UNIT, quote: "Room revenue was 8,214,000" },
    { claim: "Room revenue: 8,214", document: NO_UNIT, quote: "Room revenue was 8,214,000" },
    {
      claim: "营业收入：2025年全年为187.3。",
      document: MILLIONS_ZH,
      quote: "2025年全年营业收入为187.3",
      unitQuote: "单位：人民币百万元",
    },
  ];

  // protects=whatever the figures, units and unit lines, a judge's Contradicted or Unsupported never comes back Supported, for the sentence or any figure in it; fails_when=code turns a judge's verdict into Supported on its own; no_claim=none beyond protects.
  test.each(
    CASES.flatMap((each) =>
      (["contradicted", "unsupported"] as const).map((verdict) => ({ ...each, verdict })),
    ),
  )(
    "$claim judged $verdict ($unitQuote)",
    async ({ claim, document, quote, unitQuote, verdict }) => {
      const result = await check(claim, document, {
        verdict,
        quote,
        says: quote,
        ...(unitQuote && { unitQuote }),
      });
      expect(result.state).not.toBe("supported");
      expect(result.figures?.map((figure) => figure.state)).not.toContain("supported");
    },
  );
});
