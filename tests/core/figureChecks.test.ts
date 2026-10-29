import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { documentFigureContext } from "../../src/core/answers/calculations";
import { createClaimCheck } from "../../src/core/answers/checks/claimCheck";
import { figureReplyText, readFigureReply } from "../../src/core/answers/checks/figureChecks";
import { createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import type { CheckFigure } from "../../src/core/api";
import type { CitationSource } from "../../src/core/documents";
import { resolveCapabilities } from "../../src/core/providers/capabilities";
import type { PreparedChatModel } from "../../src/core/providers/chat";
import { MAX_CHART_VALUES } from "../../src/shared/charts";
import { readFigures } from "../../src/shared/figures";
import type { UnitText } from "../../src/shared/units";
import { type ModelCall, scriptedModel } from "../helpers/models";

const claim = "Revenue was £20 and the licence is valid.";
const reading = readFigures("£20", { language: "en" })[0];
if (!reading) throw new Error("Missing fixture reading");
const figures: CheckFigure[] = [
  {
    id: "f1",
    locator: { kind: "text", from: { blockId: "p", offset: 12 }, to: { blockId: "p", offset: 15 } },
    reading,
    calculated: null,
  },
];
const item = (id = "f1") => ({
  id,
  verdict: "supported",
  scope: "same",
  topic: "found",
  roles: "same",
  says: null,
  relation: "equals",
  source: { citation: 1, position: 1, reading: null, unitQuote: null },
  calculation: null,
});
const reply = (items: unknown[], remainder: unknown = null) =>
  `Verdict: supported\nFigures: ${JSON.stringify({ items, remainder })}`;

test("a complete same-run reply binds only the exact requested occurrence ids", () => {
  expect(readFigureReply(reply([item()]), figures, claim)).toMatchObject({
    items: [{ id: "f1", source: { citation: 1, position: 1 } }],
    remainder: null,
  });
});

test.each([
  { name: "missing", items: [] },
  { name: "unknown", items: [item("unknown")] },
  { name: "duplicate", items: [item(), item()] },
  { name: "malformed", items: [{ ...item(), relation: "maybe" }] },
])("$name item set is rejected", ({ items }) =>
  expect(readFigureReply(reply(items), figures, claim)).toBeNull(),
);

test("a chart's largest reply, for 500 values, is read whole", () => {
  const many = Array.from({ length: MAX_CHART_VALUES }, (_, index) => ({
    ...(figures[0] as CheckFigure),
    id: JSON.stringify(["chart", randomUUID(), randomUUID(), index]),
  }));
  const items = many.map(({ id }) => ({
    ...item(id),
    verdict: "unsupported",
    topic: "not found",
    source: null,
  }));
  const text = reply(items);
  expect(text.length).toBeGreaterThan(100_000);
  expect(readFigureReply(text, many, claim)?.items).toHaveLength(MAX_CHART_VALUES);
});

test("missing remainder remains missing rather than explicitly empty", () => {
  expect(
    readFigureReply(`Figures: ${JSON.stringify({ items: [item()] })}`, figures, claim)?.remainder,
  ).toBeUndefined();
});

test("only trailing citation transport annotations may follow the complete object", () => {
  expect(readFigureReply(`${reply([item()])}[^1][^2]`, figures, claim)?.items[0]?.id).toBe("f1");
  for (const suffix of ["garbage", " {}", "[^1] garbage", "[^0]", "[^10000]"])
    expect(readFigureReply(`${reply([item()])}${suffix}`, figures, claim)).toBeNull();
  expect(
    readFigureReply(
      `${reply([{ ...item(), source: { ...item().source, unitQuote: "Keep } and [^2] inside the string." } }])}[^1]`,
      figures,
      claim,
    )?.items[0]?.source?.unitQuote,
  ).toBe("Keep } and [^2] inside the string.");
});

test("a source names its number as the quote writes it, and markers written as digits are read", () => {
  const written = {
    ...item(),
    reading: "1",
    source: { citation: "1", number: "£20", unitQuote: null },
  };
  expect(readFigureReply(reply([written]), figures, claim)?.items[0]).toMatchObject({
    reading: 1,
    source: { citation: 1, number: "£20", position: null, reading: null },
  });
  for (const marker of ["3", { marker: 3 }]) {
    const calculated = { ...item(), source: null, calculation: marker };
    expect(readFigureReply(reply([calculated]), figures, claim)?.items[0]?.calculation).toBe(3);
  }
  for (const marker of ["0", "one", "1.5", -1])
    expect(
      readFigureReply(
        reply([{ ...item(), source: { ...item().source, citation: marker } }]),
        figures,
        claim,
      ),
    ).toBeNull();
});

test("a quote copied from a sheet row with its raw tabs is read", () => {
  const row = { ...item(), source: { passage: "P2", quote: "Fuel\t510\t450", number: "450" } };
  const written = reply([row]).replace(/\\t/g, "\t");
  expect(written).toContain("\t510");
  expect(readFigureReply(written, figures, claim)?.items[0]?.source?.record?.quote).toBe(
    "Fuel\t510\t450",
  );
});

test("the Figures line is the JSON one, not a line of prose that starts the same way", () => {
  const prose = `Verdict: supported\nFigures: the revenue figure is £20, as the accounts give it.\n${reply([item()]).replace("Verdict: supported\n", "")}`;
  expect(readFigureReply(prose, figures, claim)?.items[0]?.id).toBe("f1");
});

test.each([
  { final: "Verdict: unsupported", aside: [reply([item()])] },
  { final: "The quote states the revenue.", aside: [reply([item()]), "Verdict: unsupported"] },
  { final: "I'm sorry, I can't help with that.", aside: [reply([item()])] },
  {
    final: "The quote states the revenue.",
    aside: [reply([item()]).replace("Verdict: supported\n", "")],
  },
])("a stale or refused preamble cannot replace $final", ({ final, aside }) => {
  expect(figureReplyText(final, aside)).toBe(final);
});

test("only the last verdict-bearing preamble can supply its own Figures envelope", () => {
  const final = "The quote states the revenue.";
  const latest = reply([item()]);
  expect(figureReplyText(final, ["Verdict: unsupported", latest])).toBe(`${latest}\n${final}`);
  const superseding = reply([item("unknown")]);
  expect(figureReplyText(superseding, [latest])).toBe(superseding);
});

function target(
  id: string,
  shown = "£20",
  context = "Revenue in 2024",
  language: "en" | "zh-CN" = "en",
): CheckFigure {
  const reading = readFigures(shown, { language })[0];
  if (!reading) throw new Error("Missing target reading");
  return {
    id,
    locator: {
      kind: "text",
      from: { blockId: id, offset: 0 },
      to: { blockId: id, offset: shown.length },
    },
    reading,
    calculated: null,
    context,
    label: context,
  };
}

async function checkWith(options: {
  text: string;
  figures?: readonly CheckFigure[];
  claim?: string;
  body?: string;
  quotes?: readonly string[];
  units?: UnitText[];
  calculations?: readonly unknown[];
  judgement?: string;
  failure?: { status: number; message: string };
  besideCite?: string;
  /** Its reply when asked once more with a note that says `note`. */
  askedAgain?: { note: string; text: string };
  /** The model's search finds nothing, as when it searched with other words. */
  findsNothing?: boolean;
  /** It replies before it records its quotes, and records them only once asked to. */
  citesWhenAsked?: boolean;
}) {
  const body =
    options.body ?? "Revenue in 2024 was £20; revenue in 2025 was £21. The licence has expired.";
  const calls: ModelCall[] = [];
  const confirmations: string[] = [];
  let emitted = "";
  // Where the quotes are, as a model names it: a sheet's rows, or the page.
  const sheet = options.units?.find((unit) => unit.kind === "rows")?.label;
  const [first, ...rest] = sheet?.rows ?? [];
  const location =
    sheet?.sheet && first !== undefined
      ? `${sheet.sheet}, ${rest.length > 0 ? `rows ${first}–${rest.at(-1)}` : `row ${first}`}`
      : "p. 1";
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      if (!call.results.some((result) => result.tool === "search_documents"))
        return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
      const asked = /never recorded/.test(call.prompt);
      if (
        options.citesWhenAsked &&
        !asked &&
        !call.results.some((result) => result.tool === "cite")
      )
        return { text: options.text };
      if (!call.results.some((result) => result.tool === "cite"))
        return {
          text: options.besideCite,
          calls: [
            {
              tool: "cite",
              input: {
                citations: (options.quotes ?? [body]).map((quote, index) => ({
                  marker: index + 1,
                  passage: "P1",
                  location,
                  quote,
                })),
              },
            },
          ],
        };
      if (options.calculations && !call.results.some((result) => result.tool === "calculate"))
        return { calls: [{ tool: "calculate", input: { figures: options.calculations } }] };
      if (options.askedAgain && call.prompt.includes(options.askedAgain.note))
        return { text: options.askedAgain.text };
      return options.failure ? { error: options.failure } : { text: options.text };
    },
    {
      generate(call) {
        confirmations.push(call.prompt);
        return { text: options.judgement ?? "conflict" };
      },
    },
  );
  const prepared: PreparedChatModel = {
    model,
    provider: {
      id: "test",
      kind: "anthropic",
      catalogId: null,
      endpoint: null,
      baseUrl: null,
      service: null,
      hasApiKey: false,
    },
    modelId: "scripted-check",
    support: "tools",
    summarizesReasoning: false,
    capabilities: resolveCapabilities({
      catalog: { tools: true, calculates: true, temperature: true },
    }),
  };
  const source: CitationSource = {
    passageId: "passage-1",
    documentId: "document-1",
    documentName: "Accounts",
    documentKind: options.units?.some((unit) => unit.kind === "rows") ? "xlsx" : "pdf",
    contentHash: "hash-1",
    text: body,
    pageFrom: 1,
    pageTo: 1,
    documentDeleted: false,
    notCited: false,
  };
  const engine = createAiSdkAnswerEngine();
  const check = createClaimCheck({
    language: () => "en",
    engine: {
      async *generate(request) {
        for await (const event of engine.generate(request)) {
          if (event.type === "text-delta") emitted += event.text;
          if (event.type === "text-retracted") emitted = emitted.slice(0, -event.length);
          yield event;
        }
      },
    },
    evidence: {
      async search() {
        return {
          passages: options.findsNothing
            ? []
            : [{ ...source, seq: 1, position: 0, windowFrom: 0, windowTo: 0 }],
          excluded: [],
        };
      },
    },
    documents: {
      searchableCount: () => 1,
      searchableLanguages: () => [],
      searchableBySize: () => [{ id: source.documentId, name: source.documentName }],
      savedBySearch: () => false,
      citationSource: (id) => (id === source.passageId ? source : null),
      pageTexts: () => options.units ?? [{ page: 1, text: body, kind: "page", label: null }],
      documentDate: () => null,
    },
  });
  const result = await check({
    claim: options.claim ?? "Revenue in 2024 was £20 and revenue in 2025 was £20.",
    figures: options.figures,
    scope: { documentIds: null, excluded: new Map() },
    model: prepared,
    signal: new AbortController().signal,
  });
  return { result, calls, confirmations, emitted };
}

test("equal shown values bind distinct checked source positions in one model run", async () => {
  const { result, calls, confirmations, emitted } = await checkWith({
    figures: [target("2024"), target("2025", "£20", "Revenue in 2025")],
    text: reply([item("2024"), { ...item("2025"), source: { ...item().source, position: 2 } }]),
  });
  expect(
    result.figures?.map((figure) => [
      figure.id,
      figure.result.verdict,
      figure.sourceInput?.number.value,
    ]),
    JSON.stringify({ result, emitted }),
  ).toEqual([
    ["2024", "supported", 20],
    ["2025", "contradicted", 21],
  ]);
  expect(result.verdict).toBe("contradicted");
  expect(calls).toHaveLength(3);
  expect(confirmations).toEqual([]);
  expect(calls[0]?.prompt).toContain("Revenue in 2024");
  expect(calls[0]?.prompt).toContain("Revenue in 2025");
});

test.each([
  { final: "The quote states the revenue.", verdict: "supported" },
  { final: "Verdict: unsupported", verdict: "not-checked" },
  { final: "I'm sorry, I can't help with that.", verdict: "not-checked" },
])(
  "cite-turn Figures recover only without a superseding final judgment: $final",
  async ({ final, verdict }) => {
    const { result } = await checkWith({
      figures: [target("f1")],
      besideCite: reply([item()]),
      text: final,
    });
    expect(result.figures?.[0]?.result.verdict).toBe(verdict);
    if (final.startsWith("I'm sorry"))
      expect(result.figures?.[0]?.result).toMatchObject({ reason: "refused" });
  },
);

test("all calculation markers are checked before their parent is aggregated", async () => {
  const { result, confirmations, calls, emitted } = await checkWith({
    figures: [target("2024"), target("2025")],
    calculations: [1, 2].map((marker) => ({
      marker,
      label: "Revenue",
      formula: "source",
      stated: "£20",
      relation: "equals",
      inputs: [{ name: "source", label: "Revenue", citation: 1, position: marker }],
    })),
    text: reply(
      [1, 2].map((marker) => ({
        ...item(marker === 1 ? "2024" : "2025"),
        source: null,
        calculation: marker,
      })),
    ),
  });
  expect(
    result.figures?.map((figure) => [
      figure.result.verdict,
      "calculation" in figure.result && figure.result.calculation?.agrees,
    ]),
    JSON.stringify({ result, emitted, calls: calls.map((call) => call.results) }),
  ).toEqual([
    ["supported", true],
    ["contradicted", false],
  ]);
  expect(result.verdict).toBe("contradicted");
  expect(confirmations).toEqual([]);
});

test("qualitative remainder retains the existing contradiction confirmations", async () => {
  const { result, confirmations } = await checkWith({
    claim,
    figures: [target("f1")],
    quotes: ["Revenue in 2024 was £20", "The licence has expired."],
    text: reply([item()], {
      verdict: "contradicted",
      scope: "same",
      topic: "found",
      roles: "same",
      says: "The licence has expired.",
      text: "the licence is valid",
      citation: 2,
    }),
  });
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
  expect(result.remainder?.verdict).toBe("contradicted");
  expect(result.verdict).toBe("contradicted");
  expect(confirmations).toHaveLength(2);
  for (const prompt of confirmations) {
    expect(prompt).toContain("the licence is valid");
    expect(prompt).not.toContain(claim);
  }
});

test("a missing remainder cannot make the parent all supported", async () => {
  const { result } = await checkWith({
    figures: [target("f1")],
    text: `Figures: ${JSON.stringify({ items: [item()] })}`,
  });
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
  expect(result.remainder).toBeUndefined();
  expect(result.verdict).toBe("not-checked");
});

test("bad evidence affects its child only after a valid occurrence envelope", async () => {
  const { result } = await checkWith({
    figures: [target("a"), target("b")],
    text: reply([item("a"), { ...item("b"), source: { ...item().source, position: 9 } }]),
  });
  expect(result.figures?.map((figure) => figure.result.verdict)).toEqual([
    "supported",
    "not-checked",
  ]);
  expect(result.verdict).toBe("not-checked");
});

test("an unknown occurrence id cannot be rescued by an agreeing calculation", async () => {
  const { result } = await checkWith({
    figures: [target("f1")],
    calculations: [
      {
        marker: 1,
        label: "Revenue",
        formula: "source",
        stated: "£20",
        relation: "equals",
        inputs: [{ name: "source", label: "Revenue", citation: 1, position: 1 }],
      },
    ],
    text: reply([{ ...item("unknown"), source: null, calculation: 1 }]),
  });
  expect(result.figures?.[0]?.result).toMatchObject({
    verdict: "not-checked",
    reason: "malformed",
  });
});

test("equal numbers cannot override a different semantic subject", async () => {
  const { result } = await checkWith({
    figures: [target("f1")],
    text: reply([{ ...item(), topic: "not found" }]),
  });
  expect(result.figures?.[0]?.result.verdict).toBe("unsupported");
});

test("a found equal value cannot override the model's unsupported semantic finding", async () => {
  const { result } = await checkWith({
    figures: [target("f1")],
    text: reply([
      { ...item(), verdict: "unsupported", says: "The forecast is not an actual result." },
    ]),
  });
  expect(result.figures?.[0]?.result.verdict).toBe("unsupported");
});

test.each([
  { value: "2.5%", verdict: "supported" },
  { value: "3.001%", verdict: "contradicted" },
])("an own range keeps both endpoints against $value", async ({ value, verdict }) => {
  const { result } = await checkWith({
    figures: [target("f1", "2–3%")],
    body: `Margin ${value}`,
    text: reply([{ ...item(), reading: 2, source: { ...item().source, reading: 1 } }]),
  });
  expect(result.figures?.[0]?.result.verdict).toBe(verdict);
  expect(result.figures?.[0]?.reading.rangeTo).toBe(0.03);
  expect(result.figures?.[0]?.roundedFrom).toBeNull();
});

test("a satisfied covenant limit is not described as rounding", async () => {
  const { result } = await checkWith({
    figures: [target("f1", "3.25x")],
    body: "Leverage 2.8x",
    text: reply([{ ...item(), relation: "at most" }]),
  });
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
  expect(result.figures?.[0]?.roundedFrom).toBeNull();
});

test("a raw workbook value is compared at the Note's own shown precision", async () => {
  const body = "Revenue\t20.0%";
  const { result } = await checkWith({
    figures: [target("f1", "20.5%")],
    body,
    units: [
      {
        page: 1,
        text: body,
        kind: "rows",
        label: { sheet: "Accounts", from: 1, to: 1, rows: [1], column: 0, values: { B1: 0.2045 } },
      },
    ],
    text: reply([{ ...item(), source: { ...item().source, reading: 1 } }]),
  });
  const figure = result.figures?.[0];
  expect(figure?.sourceInput?.number.value).toBe(0.2045);
  expect(figure?.sourceInput?.cell?.stored).toBe(0.2045);
  expect(figure?.roundedFrom).toBe(0.2045);
  expect(figure?.result.verdict).toBe("supported");
});

test.each([
  { shown: "£1.01", source: "£1.005", verdict: "supported", rounded: 1.005 },
  {
    shown: "£1,000,000,000,000",
    source: "£1,000,000,000,001",
    verdict: "contradicted",
    rounded: null,
  },
  { shown: "2.5亿元", source: "250,000,000元", verdict: "supported", rounded: null },
])("$shown uses its own precision against $source", async ({ shown, source, verdict, rounded }) => {
  const { result } = await checkWith({
    figures: [target("f1", shown)],
    body: `Revenue ${source}`,
    text: reply([{ ...item(), source: { ...item().source, reading: 1 } }]),
  });
  expect(result.figures?.[0]?.result.verdict).toBe(verdict);
  expect(result.figures?.[0]?.roundedFrom).toBe(rounded);
});

test.each([
  { language: "en", shown: "7,509,964", cell: true },
  { language: "zh-CN", shown: "7,509,964", cell: true },
  { language: "en", shown: "7509964", cell: false },
  { language: "zh-CN", shown: "7509964", cell: false },
] as const)(
  "$shown in a $language Note agrees with its source grouped the other way, exactly",
  async ({ language, shown, cell }) => {
    const label = language === "en" ? "Revenue" : "收入";
    const body = cell ? `${label}\t7509964` : `${label} 7,509,964`;
    const { result } = await checkWith({
      figures: [target("f1", shown, label, language)],
      claim: language === "en" ? `Revenue was ${shown}.` : `收入为${shown}。`,
      body,
      ...(cell && {
        units: [
          {
            page: 1,
            text: body,
            kind: "rows" as const,
            label: {
              sheet: "Accounts",
              from: 1,
              to: 1,
              rows: [1],
              column: 0,
              values: { B1: 7509964 },
            },
          },
        ],
      }),
      text: reply([{ ...item(), source: { ...item().source, reading: 1 } }]),
    });
    const figure = result.figures?.[0];
    expect(figure?.sourceInput?.number.value).toBe(7509964);
    expect(figure?.result.verdict).toBe("supported");
    expect(figure?.difference).toBe(0);
    expect(figure?.roundedFrom).toBeNull();
  },
);

test("one failed quote cannot erase another figure's checked evidence", async () => {
  const { result } = await checkWith({
    figures: [target("a"), target("b")],
    quotes: ["Revenue in 2024 was £20", "Revenue was £999"],
    text: reply([item("a"), { ...item("b"), source: { ...item().source, citation: 2 } }]),
  });
  expect(result.figures?.map((figure) => figure.result.verdict)).toEqual([
    "supported",
    "not-checked",
  ]);
  expect(result.figures?.[1]?.sourceInput).toBeNull();
  expect(result.figures?.[1]?.source).toMatchObject({
    passageId: "passage-1",
    quote: "Revenue was £999",
    check: "not-found",
    checkReason: "quote-not-on-pages",
  });
});

test("saved formulas recheck exact UTF-16 spans without another calculate call", async () => {
  const body = "📊 Revenue was £20.";
  const first = await checkWith({
    figures: [target("f1")],
    body,
    calculations: [
      {
        marker: 1,
        label: "Revenue",
        formula: "source",
        stated: "£20",
        relation: "equals",
        inputs: [{ name: "source", label: "Revenue", citation: 1, position: 1 }],
      },
    ],
    text: reply([{ ...item(), source: null, calculation: 1 }]),
  });
  const judgment = first.result.figures?.[0]?.result;
  const figure = judgment && "calculation" in judgment ? judgment.calculation?.figure : null;
  if (!figure) throw new Error("No real calculated fixture receipt");
  expect(figure.inputs[0]?.number.at).toBe(15);
  const saved = { ...target("f1"), calculated: { id: "f1", figure, analysisId: null } };
  const again = await checkWith({
    figures: [saved],
    body,
    text: reply([{ ...item(), source: null }]),
  });
  expect(again.result.figures?.[0]?.result.verdict).toBe("supported");
  expect(
    again.calls.flatMap((call) => call.results).some((result) => result.tool === "calculate"),
  ).toBe(false);
  const elsewhere = await checkWith({
    figures: [saved],
    body,
    findsNothing: true,
    text: reply([{ ...item(), source: null }]),
  });
  expect(elsewhere.result.figures?.[0]?.result.verdict).toBe("supported");
  const changed = {
    ...saved,
    calculated: {
      ...saved.calculated,
      figure: {
        ...figure,
        inputs: figure.inputs.map((input) => ({
          ...input,
          number: { ...input.number, at: input.number.at + 1 },
        })),
      },
    },
  };
  const invalid = await checkWith({
    figures: [changed],
    body,
    text: reply([{ ...item(), source: null }]),
  });
  expect(invalid.result.figures?.[0]?.result).toMatchObject({
    verdict: "not-checked",
    reason: "no-evidence",
  });
  const shortcut = await checkWith({ figures: [changed], body, text: reply([item()]) });
  expect(shortcut.result.figures?.[0]?.sourceInput).toBeNull();
  expect(shortcut.result.figures?.[0]?.result).toMatchObject({
    verdict: "not-checked",
    reason: "no-evidence",
  });

  const analysis = {
    ...saved,
    calculated: {
      id: "f1",
      analysisId: "retained-run",
      figure: { ...figure, formula: "", inputs: [], analysis: { analysis: 1, result: "revenue" } },
    },
  };
  const retained = await checkWith({
    figures: [analysis],
    body,
    text: reply([{ ...item(), source: null }]),
  });
  expect(retained.result.figures?.[0]?.result).toMatchObject({
    verdict: "not-checked",
    reason: "no-evidence",
  });
  expect(retained.result.figures?.[0]?.sourceInput).toBeNull();
});

test("a saved calculation's verdict and evidence both come from working it out again, whatever source the model names", async () => {
  const body = "📊 Revenue was £20. Another figure was £999.";
  const first = await checkWith({
    figures: [target("f1")],
    body,
    calculations: [
      {
        marker: 1,
        label: "Revenue",
        formula: "source",
        stated: "£20",
        relation: "equals",
        inputs: [{ name: "source", label: "Revenue", citation: 1, position: 1 }],
      },
    ],
    text: reply([{ ...item(), source: null, calculation: 1 }]),
  });
  const judgment = first.result.figures?.[0]?.result;
  const figure = judgment && "calculation" in judgment ? judgment.calculation?.figure : null;
  if (!figure) throw new Error("No real calculated fixture receipt");
  const saved = { ...target("f1"), calculated: { id: "f1", figure, analysisId: null } };
  const { result } = await checkWith({
    figures: [saved],
    body,
    quotes: [body, "Another figure was £999."],
    text: reply([
      { ...item(), source: { citation: 2, number: "£999", reading: null, unitQuote: null } },
    ]),
  });
  const row = result.figures?.[0];
  expect(row?.sourceInput).toBeNull();
  expect(row?.result.verdict).toBe("supported");
  expect(row?.result.verdict === "not-checked" ? null : row?.result.evidence?.quote).toBe(body);
});

test("asked to record a quote its Figures line names, the model's next step must call cite", async () => {
  const { result, calls } = await checkWith({
    figures: [target("f1", "£20", "Revenue in 2024")],
    citesWhenAsked: true,
    text: reply([
      { ...item(), source: { citation: 1, number: "£20", reading: null, unitQuote: null } },
    ]),
  });
  const asked = calls.find((call) => /never recorded/.test(call.prompt));
  expect(asked?.options.toolChoice).toEqual({ type: "tool", toolName: "cite" });
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
});

test.each([
  { named: "5704", verdict: "supported" },
  { named: "5,704", verdict: "supported" },
  { named: "57.04", verdict: "not-checked" },
])(
  "a source number named by its plain digits ($named) is read as the quote writes it",
  async ({ named, verdict }) => {
    // Its other numbers settle that the comma groups thousands, as a results release's do.
    const body = "Revenue was £4,983.4m. Net debt was £5,704m at 30 September 2026.";
    const { result } = await checkWith({
      figures: [target("f1", "£5.7bn", "Net debt")],
      claim: "Net debt was £5.7bn.",
      body,
      text: reply([
        { ...item(), source: { citation: 1, number: named, reading: null, unitQuote: null } },
      ]),
    });
    expect(result.figures?.[0]?.result.verdict).toBe(verdict);
    if (verdict === "supported") expect(result.figures?.[0]?.roundedFrom).toBe(5_704_000_000);
  },
);

test("narration with a marker beside cite isn't taken for the reply: the model goes on to write it", async () => {
  const { result, calls } = await checkWith({
    figures: [target("f1", "£20", "Revenue in 2024")],
    besideCite: "Calling cite now to record the quote for marker [^1].",
    text: reply([
      { ...item(), source: { citation: 1, number: "£20", reading: null, unitQuote: null } },
    ]),
  });
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
  expect(calls.length).toBeGreaterThan(2);
});

test("a verdict with no Figures line is asked for it once, and the reply that has it binds", async () => {
  const asked = await checkWith({
    figures: [target("f1")],
    text: "Verdict: supported",
    askedAgain: { note: "no Figures line", text: reply([item()]) },
  });
  expect(asked.result.figures?.[0]?.result.verdict).toBe("supported");
  expect(asked.calls.filter((call) => call.prompt.includes("no Figures line"))).toHaveLength(1);

  const unbound = await checkWith({ figures: [target("f1")], text: "Verdict: supported" });
  expect(unbound.result.figures?.[0]?.result).toMatchObject({
    verdict: "not-checked",
    reason: "malformed",
  });
});

test("a Figures line naming a calculation the check never made is asked again, and the reply with its source binds", async () => {
  const { result, calls } = await checkWith({
    figures: [target("f1")],
    text: reply([{ ...item(), source: null, calculation: 1 }]),
    askedAgain: { note: "wasn't worked out in this check", text: reply([item()]) },
  });
  expect(calls.filter((call) => call.prompt.includes("wasn't worked out"))).toHaveLength(1);
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
});

test("a Figures line that leaves out its remainder is asked for it once, and the reply that has it binds", async () => {
  const noRemainder = `Verdict: supported\nFigures: ${JSON.stringify({ items: [item()] })}`;
  const { result, calls } = await checkWith({
    figures: [target("f1")],
    text: noRemainder,
    askedAgain: { note: "gives no remainder", text: reply([item()]) },
  });
  expect(calls.filter((call) => call.prompt.includes("gives no remainder"))).toHaveLength(1);
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
});

const SEGMENTS = "All figures in £m\nSegment\tQ3 2026\tQ3 2025\nClothing\t300\t310";
const segments = (body = SEGMENTS): UnitText[] => [
  {
    page: 1,
    text: body,
    kind: "rows",
    label: { sheet: "Segments", from: 1, to: 3, rows: [1, 2, 3], column: 0 },
  },
];

/** A cell of the note's table under a heading that states the table's scale. */
function cell(id: string, shown: string, header: string): CheckFigure {
  const reading = readFigures(shown, { ...documentFigureContext([{ text: shown }]), header })[0];
  if (!reading) throw new Error("Missing cell reading");
  return { ...target(id, shown, "Clothing Q3 2026"), reading };
}

test.each([
  { shown: "300", reading: null, verdict: "supported" },
  { shown: "330", reading: null, verdict: "contradicted" },
  { shown: "330", reading: 2, verdict: "contradicted" },
])(
  "a bare cell under the note's “(£m)” heading needs no reading named when its source states the frame: $shown, reading $reading",
  async ({ shown, reading, verdict }) => {
    const unitQuote = "All figures in £m";
    const { result } = await checkWith({
      figures: [cell("f1", shown, "Q3 2026 (£m)")],
      body: SEGMENTS,
      units: segments(SEGMENTS),
      quotes: ["Clothing\t300\t310", unitQuote],
      text: reply([
        {
          ...item(),
          verdict,
          reading,
          source: { citation: 1, number: "300", reading: null, unitQuote },
        },
      ]),
    });
    expect(result.figures?.[0]?.result.verdict).toBe(verdict);
  },
);

test.each([
  { unitQuote: "All figures in £m", verdict: "supported" },
  { unitQuote: "All figures in £000", verdict: "not-checked" },
])(
  "a bare cell under the note's “(£m)” heading is compared in its source's frame when the note offers it: $unitQuote",
  async ({ unitQuote, verdict }) => {
    const body = SEGMENTS.replace("All figures in £m", unitQuote);
    const figure = cell("f1", "300", "Q3 2026 (£m)");
    expect(figure.reading.ambiguous.map((each) => each.kind)).toEqual(["scale"]);
    const { result } = await checkWith({
      figures: [figure],
      body,
      units: segments(body),
      quotes: ["Clothing\t300\t310", unitQuote],
      text: reply([
        {
          ...item(),
          reading: 1,
          source: { citation: 1, number: "300", reading: null, unitQuote },
        },
      ]),
    });
    expect(result.figures?.[0]?.result.verdict).toBe(verdict);
  },
);

test("a figure given a currency its Document never states is Unsupported, and says which part (#1798)", async () => {
  const body = "The annual salary is 54,000, paid monthly in arrears.";
  const { result } = await checkWith({
    figures: [target("f1", "£54,000", "The annual salary")],
    claim: "The annual salary is £54,000, paid monthly in arrears.",
    body,
    // One number alone doesn't settle whether its comma groups thousands: the model says so.
    text: reply([{ ...item(), source: { citation: 1, number: "54,000", reading: 1 } }]),
  });
  expect(result.figures?.[0]?.result).toMatchObject({
    verdict: "unsupported",
    unsupported: {
      covered: expect.stringContaining("54,000"),
      uncovered: expect.stringContaining("£"),
    },
  });
  expect(result).toMatchObject({ verdict: "unsupported", unsupported: { found: true } });
});

test.each([
  {
    name: "a source in millions",
    body: "Net debt (in millions)\n528.9",
    shown: "£518.9m",
    reply: reply([
      {
        ...item(),
        source: { citation: 1, number: "528.9", reading: null, unitQuote: "in millions" },
      },
    ]),
  },
  {
    name: "a calculation over bare digits",
    body: "Net debt 528,900,000",
    shown: "£518,900,000",
    calculations: [
      {
        marker: 2,
        label: "Net debt",
        formula: "source",
        stated: "£518,900,000",
        relation: "equals",
        inputs: [{ name: "source", label: "Net debt", citation: 1, position: 1 }],
      },
    ],
    reply: reply([{ ...item(), source: null, calculation: 2 }]),
  },
])(
  "$name gives a figure in a currency it never states no contradiction, only Unsupported",
  async ({ body, shown, calculations, reply: text }) => {
    const { result } = await checkWith({
      figures: [target("f1", shown, "Net debt")],
      claim: `Net debt was ${shown}.`,
      body,
      ...(calculations && { calculations }),
      text,
    });
    expect(result.figures?.[0]?.result).toMatchObject({
      verdict: "unsupported",
      unsupported: { uncovered: expect.stringContaining("£") },
    });
  },
);

test("a source may give its quote in place of a marker, as calculate takes one", async () => {
  const quoted = {
    ...item(),
    source: { passage: "P1", location: "p. 1", quote: "Revenue in 2024 was £20", number: "£20" },
  };
  const { result } = await checkWith({ figures: [target("f1")], text: reply([quoted]) });
  expect(result.figures?.[0]).toMatchObject({
    result: { verdict: "supported" },
    source: { quote: "Revenue in 2024 was £20", check: "found" },
  });
});

test("a number that writes its own scale is read whatever unit line comes with it", async () => {
  const body = "2026年第三季度营业收入为人民币4,979.6百万元。";
  const { result } = await checkWith({
    figures: [target("f1", "49.80亿元", "营业收入")],
    claim: "营业收入为49.80亿元。",
    body,
    text: reply([
      { ...item(), source: { citation: 1, number: "4,979.6", unitQuote: "单位：人民币百万元" } },
    ]),
  });
  expect(result.figures?.[0]).toMatchObject({
    result: { verdict: "supported" },
    roundedFrom: 4_979_600_000,
  });
});

test.each([
  { claim: "300", verdict: "supported" },
  { claim: "Revenue in 2024 was £20 and revenue in 2025 was £20.", verdict: "not-checked" },
])("a bare calculated cell binds only to its actual claim: $claim", async ({ claim, verdict }) => {
  const { result, calls } = await checkWith({
    claim,
    figures: [cell("f1", "300", "Q3 2026 (£m)")],
    body: SEGMENTS,
    units: segments(),
    quotes: ["Clothing\t300\t310", "All figures in £m"],
    calculations: [
      {
        marker: 1,
        label: "Clothing Q3 2026",
        formula: "c",
        stated: "300",
        relation: "equals",
        inputs: [{ name: "c", citation: 1, number: "300", unitQuote: "All figures in £m" }],
      },
    ],
    text: reply([{ ...item(), reading: 1, source: null, calculation: 1 }]),
  });
  expect(result.figures?.[0]?.result.verdict).toBe(verdict);
  if (verdict === "not-checked") {
    expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
    expect(
      calls
        .flatMap((call) => call.results)
        .some(
          (result) =>
            result.tool === "calculate" && result.text.includes("not a readable quantity"),
        ),
    ).toBe(true);
  }
});

test("a source left without its sheet's unit line is asked for with calculate's words, and the fixed reply binds", async () => {
  const bare = {
    ...item(),
    source: { citation: 1, number: "300", reading: null, unitQuote: null },
  };
  const fixed = { ...bare, source: { ...bare.source, unitQuote: "All figures in £m" } };
  const { result, calls } = await checkWith({
    figures: [target("f1", "£300m", "Clothing Q3 2026")],
    body: SEGMENTS,
    units: segments(),
    quotes: ["Clothing\t300\t310"],
    text: reply([bare]),
    askedAgain: { note: "can't be read", text: reply([fixed]) },
  });
  const asked = calls.find((call) => call.prompt.includes("can't be read"));
  expect(asked?.prompt).toContain("give that line as unitQuote");
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
});

test.each([
  { language: "en", heading: "Region\t2026 sales (£)", row: "West\t9537361", shown: "£9,537,361" },
  {
    language: "zh-CN",
    heading: "地区\t2026 年销售额（英镑）",
    row: "西区\t9537361",
    shown: "9,537,361 英镑",
  },
])(
  "a yearly row's bare cell under its column's currency is asked for that line, then Supported: $language",
  async ({ heading, row, shown }) => {
    const body = `${heading}\n${row}`;
    const units: UnitText[] = [
      {
        page: 1,
        text: body,
        kind: "rows",
        label: { sheet: "2026", from: 1, to: 2, rows: [1, 2], column: 0 },
      },
    ];
    const bare = {
      ...item(),
      source: { citation: 1, number: "9537361", reading: null, unitQuote: null },
    };
    const fixed = { ...bare, source: { ...bare.source, unitQuote: heading } };
    const { result, calls } = await checkWith({
      figures: [target("f1", shown, "West 2026")],
      body,
      units,
      quotes: [row, heading],
      text: reply([bare]),
      askedAgain: { note: "can't be read", text: reply([fixed]) },
    });
    const asked = calls.find((call) => call.prompt.includes("can't be read"));
    expect(asked?.prompt).toContain("give that line as unitQuote");
    expect(result.figures?.[0]?.result.verdict).toBe("supported");
  },
);

const rowsOf = (body: string): UnitText[] => [
  {
    page: 1,
    text: body,
    kind: "rows",
    label: { sheet: "Budget", from: 1, to: 3, rows: [1, 2, 3], column: 0 },
  },
];

// A scale its source doesn't state ("million" over a row's "thousand tonnes") is the scale
// guard's Unsupported, with its own words, as any scale the Documents never state is.
test.each([
  {
    body: "项目\t2024年\t2025年\t单位\n收入\t100\t120\t万元",
    quote: "收入\t100\t120\t万元",
    figure: () => cell("f1", "100", "2024年\n收入 | 100 | 120\n单位：万元"),
    number: "100",
    unitQuote: null as string | null,
    said: "supported",
    verdict: "supported",
  },
  {
    body: "项目\t2024年\t2025年\t单位\n收入\t100\t120\t万元",
    quote: "收入\t100\t120\t万元",
    figure: () => cell("f1", "100", "2024年\n收入 | 100 | 120\n单位：万元"),
    number: "100",
    unitQuote: "单位" as string | null,
    said: "supported",
    verdict: "supported",
  },
  {
    body: "项目\t2024年\t2025年\t单位\n收入\t100\t120\t万元",
    quote: "收入\t100\t120\t万元",
    figure: () => cell("f1", "120", "2025年\n收入 | 100 | 120\n单位：万元"),
    number: "120",
    unitQuote: "单位" as string | null,
    said: "supported",
    verdict: "supported",
  },
  {
    body: "项目\t2024年\t2025年\t单位\n成本\t70\t78\t万元",
    quote: "成本\t70\t78\t万元",
    figure: () => target("f1", "70万元", "成本 2024年", "zh-CN"),
    number: "70",
    unitQuote: null as string | null,
    said: "supported",
    verdict: "supported",
  },
  {
    body: "Item\t2024\t2025\tUnit\nCost\t70\t78\tthousand tonnes",
    quote: "Cost\t70\t78\tthousand tonnes",
    figure: () => target("f1", "70 thousand tonnes", "Cost 2024"),
    number: "70",
    unitQuote: null as string | null,
    said: "supported",
    verdict: "supported",
  },
  {
    body: "Item\t2024\t2025\tUnit\nCost\t70\t78\tthousand tonnes",
    quote: "Cost\t70\t78\tthousand tonnes",
    figure: () => target("f1", "78 million tonnes", "Cost 2025"),
    number: "78",
    unitQuote: null as string | null,
    said: "contradicted",
    verdict: "unsupported",
  },
])(
  "a quoted row's unit cell states the unit of each number in its row, with no unit line asked for: $number → $verdict",
  async ({ body, quote, figure, number, unitQuote, said, verdict }) => {
    const { result, calls } = await checkWith({
      figures: [figure()],
      body,
      units: rowsOf(body),
      quotes: unitQuote ? [quote, unitQuote] : [quote],
      text: reply([
        { ...item(), verdict: said, source: { citation: 1, number, reading: null, unitQuote } },
      ]),
    });
    expect(calls.some((call) => call.prompt.includes("can't be read"))).toBe(false);
    expect(result.figures?.[0]?.result.verdict).toBe(verdict);
  },
);

test("a bare cell under the note's own “(£m)” that the Documents don't state is Unsupported, with no reading named", async () => {
  const figure = cell("f1", "999", "Q3 2026 (£m)");
  expect(figure.reading.ambiguous.map((each) => each.kind)).toEqual(["scale"]);
  const { result } = await checkWith({
    figures: [figure],
    body: SEGMENTS,
    units: segments(),
    quotes: ["Clothing\t300\t310"],
    text: reply([{ ...item(), verdict: "unsupported", topic: "not found", source: null }]),
  });
  expect(result.figures?.[0]?.result.verdict).toBe("unsupported");
});

test.each([
  { again: "42", verdict: "contradicted" },
  { again: "78", verdict: "not-checked" },
])(
  "a figure called contradicted with a source number equal to it is asked for its own row's number, and never Supported: $again",
  async ({ again, verdict }) => {
    const body = "Item\t2024\t2025\nCost\t70\t78\nProfit\t30\t42";
    const given = (citation: number, number: string) => ({
      ...item(),
      verdict: "contradicted",
      source: { citation, number, reading: null, unitQuote: null },
    });
    const { result, calls } = await checkWith({
      figures: [target("f1", "78", "Profit 2025")],
      body,
      units: rowsOf(body),
      quotes: ["Cost\t70\t78", "Profit\t30\t42"],
      text: reply([given(1, "78")]),
      askedAgain: {
        note: "you call it contradicted",
        text: reply([given(again === "42" ? 2 : 1, again)]),
      },
    });
    expect(calls.some((call) => call.prompt.includes("you call it contradicted"))).toBe(true);
    expect(result.figures?.[0]?.result.verdict).toBe(verdict);
  },
);

test.each([
  { text: "I'm sorry, I can't help with that.", reason: "refused" },
  { text: "", reason: "empty" },
  { text: "Figures: {", reason: "malformed" },
  { text: "", reason: "rate-limit", failure: { status: 429, message: "Rate limit reached." } },
])(
  "a $reason final reply cannot be rescued by an earlier agreeing calculation",
  async ({ text, reason, failure }) => {
    const { result } = await checkWith({
      figures: [target("f1")],
      text,
      failure,
      calculations: [
        {
          marker: 1,
          label: "Revenue",
          formula: "source",
          stated: "£20",
          relation: "equals",
          inputs: [{ name: "source", citation: 1, position: 1 }],
        },
      ],
    });
    expect(result.figures?.[0]?.result).toMatchObject({ verdict: "not-checked", reason });
  },
);

test.each(["same", "neither", "malformed"])(
  "a qualitative contradiction confirmation of %s never becomes supported",
  async (judgement) => {
    const { result } = await checkWith({
      claim,
      figures: [target("f1")],
      judgement,
      quotes: ["Revenue in 2024 was £20", "The licence has expired."],
      text: reply([item()], {
        verdict: "contradicted",
        scope: "same",
        topic: "found",
        roles: "same",
        says: null,
        text: "the licence is valid",
        citation: 2,
      }),
    });
    expect(result.figures?.[0]?.result.verdict).toBe("supported");
    expect(result.remainder?.verdict).toBe(
      judgement === "malformed" ? "not-checked" : "unsupported",
    );
  },
);

test("a numeric whole-claim remainder is never reused as qualitative evidence", async () => {
  const { result } = await checkWith({
    claim,
    figures: [target("f1")],
    text: reply([item()], {
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      says: null,
      text: claim,
      citation: 1,
    }),
  });
  expect(result.remainder).toBeUndefined();
  expect(result.verdict).toBe("not-checked");
});

function noteChoice(shown: string, header: string | null = null): CheckFigure {
  const reading = readFigures(shown, { language: "en", header, midLine: true })[0];
  if (!reading) throw new Error("Missing ambiguous Note fixture");
  return {
    ...target("f1"),
    reading,
    locator: {
      kind: "text",
      from: { blockId: "f1", offset: 0 },
      to: { blockId: "f1", offset: shown.length },
    },
  };
}

test.each([
  { shown: "4980", header: "£m", value: 4_980_000_000, source: "£4980000000" },
  { shown: "(250)", header: null, value: 250, source: "250" },
])(
  "an explicit offered own reading settles $shown under $header",
  async ({ shown, header, value, source }) => {
    const requested = noteChoice(shown, header);
    const ambiguity = requested.reading.ambiguous[0];
    expect(requested.reading.ambiguous).toHaveLength(1);
    const reading = (ambiguity?.readings.findIndex((reading) => reading.value === value) ?? -1) + 1;
    expect(reading).toBeGreaterThan(0);
    const { result, calls } = await checkWith({
      figures: [requested],
      body: `Revenue ${source}`,
      text: reply([{ ...item(), reading }]),
    });
    expect(result.figures?.[0]?.result.verdict).toBe("supported");
    expect(result.figures?.[0]?.reading).toMatchObject({
      value,
      chars: shown,
      start: requested.reading.start,
      end: requested.reading.end,
      ambiguous: [],
    });
    expect(calls[0]?.prompt).toContain('"readings"');
  },
);

test.each([undefined, 99])(
  "missing or out-of-range own reading %j stays unread",
  async (reading) => {
    const { result } = await checkWith({
      figures: [noteChoice("4980", "£m")],
      body: "Revenue £4980000000",
      text: reply([{ ...item(), reading }]),
    });
    expect(result.figures?.[0]?.result).toMatchObject({ verdict: "not-checked", reason: "unread" });
    expect(result.figures?.[0]?.reading.ambiguous.length).toBeGreaterThan(0);
  },
);

test("multiple own ambiguity axes are never combined by guessing", async () => {
  const requested = noteChoice("(4980)", "£m");
  expect(requested.reading.ambiguous.length).toBeGreaterThan(1);
  const { result } = await checkWith({
    figures: [requested],
    body: "Revenue £4980000000",
    text: reply([{ ...item(), reading: 1 }]),
  });
  expect(result.figures?.[0]?.result).toMatchObject({ verdict: "not-checked", reason: "unread" });
});

test.each([undefined, []])(
  "no requested figures keeps the legacy reply contract (%j)",
  async (figures) => {
    // A sentence its Document states whole, so the check needs no calculation (#1978).
    const { result } = await checkWith({
      figures,
      claim: "Revenue in 2024 was £20.",
      quotes: ["Revenue in 2024 was £20"],
      text: "Verdict: supported\nScope: same\nTopic: found\nRoles: same\nSays: Revenue in 2024 was £20.\nCalculation: none",
    });
    expect(result.verdict).toBe("supported");
    expect(result).not.toHaveProperty("figures");
    expect(result).not.toHaveProperty("remainder");
  },
);

test.each([
  {
    name: "a currency and scale",
    shown: "£528.9m",
    body: "Net debt 528.9",
    verdict: "unsupported",
  },
  { name: "a scale", shown: "528.9m", body: "Net debt 528.9", verdict: "unsupported" },
  {
    name: "a written-out amount",
    shown: "528.9m",
    body: "Net debt 528,900,000",
    verdict: "supported",
  },
  {
    name: "a currency on the same amount",
    shown: "£528,900,000",
    body: "Net debt 528,900,000",
    verdict: "unsupported",
  },
  {
    name: "a stated currency and scale",
    shown: "£528.9m",
    body: "Net debt £528.9m",
    verdict: "supported",
  },
  {
    name: "a different stated amount",
    shown: "£528.9m",
    body: "Net debt £518.9m",
    verdict: "contradicted",
  },
])(
  "bare source digits never back or contradict $name the note adds (#2073)",
  async ({ shown, body, verdict }) => {
    const { result } = await checkWith({
      figures: [target("f1", shown, "Net debt")],
      body,
      text: reply([item()]),
    });
    expect(result.figures?.[0]?.result.verdict).toBe(verdict);
  },
);

test("a quoted heading states the scale and currency the bare digits lack", async () => {
  const body = "Net debt (£m)\n528.9";
  const { result } = await checkWith({
    figures: [target("f1", "£528.9m", "Net debt")],
    body,
    quotes: ["528.9"],
    text: reply([{ ...item(), source: { ...item().source, unitQuote: "Net debt (£m)" } }]),
  });
  expect(result.figures?.[0]?.sourceInput?.unitStatement).not.toBeNull();
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
});
