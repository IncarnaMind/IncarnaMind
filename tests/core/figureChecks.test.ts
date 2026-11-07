import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { documentFigureContext } from "../../src/core/answers/calculations";
import { createClaimCheck } from "../../src/core/answers/checks/claimCheck";
import { readFigureReply } from "../../src/core/answers/checks/figureChecks";
import { figureHandle, replyAcrossTurns } from "../../src/core/answers/checks/prompt";
import { createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import type {
  CalculatedFigure,
  ChatProviderKind,
  CheckFigure,
  ClaimCheckResult,
} from "../../src/core/api";
import type { CitationSource } from "../../src/core/documents";
import { extractXlsx } from "../../src/core/documents/formats/xlsx";
import { resolveCapabilities } from "../../src/core/providers/capabilities";
import type { PreparedChatModel } from "../../src/core/providers/chat";
import { workbookTools } from "../../src/core/workbooks/tool";
import { MAX_CHART_VALUES } from "../../src/shared/charts";
import { readFigures } from "../../src/shared/figures";
import { translate } from "../../src/shared/i18n";
import type { UnitText } from "../../src/shared/units";
import { unsupportedWorkbook, WorkbookBuilder } from "../helpers/financeWorkbooks";
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
/** A reply as a model writes it: each figure named by the handle its request gives it. */
const asSent = (text: string, sent: readonly CheckFigure[]) =>
  sent.reduce(
    (written, figure, index) =>
      written.replaceAll(JSON.stringify(figure.id), JSON.stringify(figureHandle(index))),
    text,
  );
const reply = (items: unknown[], remainder: unknown = null) =>
  `Verdict: supported\nAbsence: no\nFigures: ${JSON.stringify({ items, remainder })}`;

test("a complete same-run reply binds only the exact requested occurrence ids", () => {
  expect(readFigureReply(asSent(reply([item()]), figures), figures, claim)).toMatchObject({
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
  expect(readFigureReply(asSent(reply(items), figures), figures, claim)).toBeNull(),
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
  expect(readFigureReply(asSent(text, many), many, claim)?.items).toHaveLength(MAX_CHART_VALUES);
});

test("missing remainder remains missing rather than explicitly empty", () => {
  expect(
    readFigureReply(
      asSent(`Figures: ${JSON.stringify({ items: [item()] })}`, figures),
      figures,
      claim,
    )?.remainder,
  ).toBeUndefined();
});

test("only trailing citation transport annotations may follow the complete object", () => {
  expect(
    readFigureReply(asSent(`${reply([item()])}[^1][^2]`, figures), figures, claim)?.items[0]?.id,
  ).toBe("f1");
  for (const suffix of ["garbage", " {}", "[^1] garbage", "[^0]", "[^10000]"])
    expect(
      readFigureReply(asSent(`${reply([item()])}${suffix}`, figures), figures, claim),
    ).toBeNull();
  expect(
    readFigureReply(
      asSent(
        `${reply([{ ...item(), source: { ...item().source, unitQuote: "Keep } and [^2] inside the string." } }])}[^1]`,
        figures,
      ),
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
  expect(
    readFigureReply(asSent(reply([written]), figures), figures, claim)?.items[0],
  ).toMatchObject({
    reading: 1,
    source: { citation: 1, number: "£20", position: null, reading: null },
  });
  for (const marker of ["3", { marker: 3 }]) {
    const calculated = { ...item(), source: null, calculation: marker };
    expect(
      readFigureReply(asSent(reply([calculated]), figures), figures, claim)?.items[0]?.calculation,
    ).toBe(3);
  }
  for (const marker of ["0", "one", "1.5", -1])
    expect(
      readFigureReply(
        asSent(reply([{ ...item(), source: { ...item().source, citation: marker } }]), figures),
        figures,
        claim,
      ),
    ).toBeNull();
});

test("a quote copied from a sheet row with its raw tabs is read", () => {
  const row = { ...item(), source: { passage: "P2", quote: "Fuel\t510\t450", number: "450" } };
  const written = reply([row]).replace(/\\t/g, "\t");
  expect(written).toContain("\t510");
  expect(
    readFigureReply(asSent(written, figures), figures, claim)?.items[0]?.source?.record?.quote,
  ).toBe("Fuel\t510\t450");
});

test("the Figures line is the JSON one, not a line of prose that starts the same way", () => {
  const prose = `Verdict: supported\nFigures: the revenue figure is £20, as the accounts give it.\n${reply([item()]).replace("Verdict: supported\nAbsence: no\n", "")}`;
  expect(readFigureReply(asSent(prose, figures), figures, claim)?.items[0]?.id).toBe("f1");
});

test.each([
  { final: "Verdict: unsupported", aside: [reply([item()])] },
  { final: "I'm sorry, I can't help with that.", aside: [reply([item()])] },
  {
    final: "The quote states the revenue.",
    aside: [reply([item()]).replace("Verdict: supported\nAbsence: no\n", "")],
  },
])("a stale or refused preamble cannot replace $final", ({ final, aside }) => {
  expect(replyAcrossTurns(final, aside)).toBe(final);
});

test("only the last verdict-bearing preamble can supply its own Figures envelope", () => {
  const final = "The quote states the revenue.";
  const latest = reply([item()]);
  expect(replyAcrossTurns(final, ["Verdict: unsupported", latest])).toBe(`${latest}\n\n${final}`);
  expect(replyAcrossTurns(final, [latest, "Verdict: unsupported"])).toBe(
    `Verdict: unsupported\n\n${final}`,
  );
  const superseding = reply([item("unknown")]);
  expect(replyAcrossTurns(superseding, [latest])).toBe(superseding);
});

test("a last turn of only its Figures line is read after the verdict set aside beside cite (#2184)", () => {
  const figuresLine = reply([item()]).split("\n").at(-1) ?? "";
  expect(figuresLine).toMatch(/^Figures: /);
  const verdict =
    "Verdict: supported\nAbsence: no\nThe accounts give revenue of £20.\nCite records:";
  expect(replyAcrossTurns(figuresLine, [verdict])).toBe(`${verdict}\n\n${figuresLine}`);
  expect(replyAcrossTurns(figuresLine, [])).toBe(figuresLine);
  expect(replyAcrossTurns(figuresLine, [verdict, "I'm sorry, I can't help with that."])).toBe(
    figuresLine,
  );
  expect(replyAcrossTurns(figuresLine, ["I'm sorry, I can't help with that.", verdict])).toBe(
    `${verdict}\n\n${figuresLine}`,
  );
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
  /** Its Document has no pages, as a whole TXT or Markdown file cited before Units. */
  pagesless?: boolean;
  calculations?: readonly unknown[];
  /** It calls calculate this many times, one figure each, before its cite: a turn's Tool calls race. */
  calculatesBeforeCite?: number;
  judgement?: string;
  failure?: { status: number; message: string };
  besideCite?: string;
  /** Its reply when asked once more with a note that says `note`. */
  askedAgain?: { note: string; text: string };
  /** The model's search finds nothing, as when it searched with other words. */
  findsNothing?: boolean;
  /** It replies before it records its quotes, and records them only once asked to. */
  citesWhenAsked?: boolean;
  forcedToolChoice?: boolean;
  providerKind?: ChatProviderKind;
  /** It never calls cite: its sources and its calculation's inputs give their quotes inline. */
  neverCites?: boolean;
  /** The sentence cites its Document, so a calculation's citation 1 names a citation it has. */
  citeSentence?: boolean;
  /** Asked once more for its record, it gives this quote, under the markers asked for if any. */
  recordWhenAsked?: string;
  scope?: { documentIds: string[] | null; excluded: Map<string, "own-file"> };
}) {
  const body =
    options.body ?? "Revenue in 2024 was £20; revenue in 2025 was £21. The licence has expired.";
  const calls: ModelCall[] = [];
  const confirmations: string[] = [];
  const sent = (text: string) => asSent(text, options.figures ?? []);
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
        return { text: sent(options.text) };
      if (options.calculatesBeforeCite) {
        const made = call.results.filter((result) => result.tool === "calculate").length;
        if (made < options.calculatesBeforeCite)
          return {
            calls: [
              {
                tool: "calculate",
                input: { figures: (options.calculations ?? []).slice(made, made + 1) },
              },
            ],
          };
      }
      if (!options.neverCites && !call.results.some((result) => result.tool === "cite"))
        return {
          text: options.besideCite && sent(options.besideCite),
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
        return { text: sent(options.askedAgain.text) };
      return options.failure ? { error: options.failure } : { text: sent(options.text) };
    },
    {
      generate(call) {
        const quote = options.recordWhenAsked;
        if (quote !== undefined && call.system.startsWith("You checked a sentence")) {
          const record = { passage: "P1", location: "p. 1", quote };
          const markers = /Missing Citation markers: (\[[^\]]*\])/.exec(call.prompt)?.[1];
          return {
            text: JSON.stringify(
              markers
                ? {
                    citations: (JSON.parse(markers) as number[]).map((marker) => ({
                      marker,
                      ...record,
                    })),
                  }
                : record,
            ),
          };
        }
        confirmations.push(call.prompt);
        return { text: options.judgement ?? "conflict" };
      },
    },
  );
  const prepared: PreparedChatModel = {
    model,
    provider: {
      id: "test",
      kind: options.providerKind ?? "anthropic",
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
      catalog: {
        tools: true,
        calculates: true,
        checkCalculates: true,
        temperature: true,
        forcedToolChoice: options.forcedToolChoice,
      },
    }),
  };
  const source: CitationSource = {
    passageId: "passage-1",
    documentId: "document-1",
    documentName: "Accounts",
    documentKind: options.units?.some((unit) => unit.kind === "rows") ? "xlsx" : "pdf",
    contentHash: "hash-1",
    text: body,
    pageFrom: options.pagesless ? null : 1,
    pageTo: options.pagesless ? null : 1,
    documentDeleted: false,
    notCited: false,
    yourNoteAt: null,
  };
  const engine = createAiSdkAnswerEngine();
  const check = createClaimCheck({
    language: () => "en",
    walledDocument: () => null,
    walledFolderName: () => null,
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
      searchableBySize: () => [
        { id: source.documentId, name: source.documentName, size: body.length },
      ],
      passagesBetween: () => [{ ...source, seq: 1, position: 0, windowFrom: 0, windowTo: 0 }],
      savedBySearch: () => false,
      unitCounts: () => new Map([[source.documentId, 1]]),
      citationSource: (id) => (id === source.passageId ? source : null),
      pageTexts: () => options.units ?? [{ page: 1, text: body, kind: "page", label: null }],
      documentDate: () => null,
    },
  });
  const result = await check({
    claim: options.claim ?? "Revenue in 2024 was £20 and revenue in 2025 was £20.",
    figures: options.figures,
    scope: options.scope ?? { documentIds: null, excluded: new Map() },
    ...(options.citeSentence && {
      cited: [
        {
          documentName: source.documentName,
          quote: source.text,
          passageId: source.passageId,
        },
      ],
    }),
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
  // One verdict everywhere: a reply that can't be read backs none of its figures either (#2378).
  expect(result.figures?.[0]?.result).toMatchObject({
    verdict: "not-checked",
    reason: "malformed",
  });
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
  // A saved calculation has no Document number to cite, so the undecided ask never fires for it.
  expect(again.calls.map((call) => call.prompt).join("\n")).not.toContain(
    "you give neither the Document's number",
  );
  // The saved figure goes by its handle, without its Citations' ids and versions (#2525).
  const asked = again.calls.map((call) => call.prompt).join("\n");
  expect(asked).toContain('"id":"F1"');
  expect(asked).toContain('"saved":{');
  for (const id of ["document-1", "passage-1", "hash-1"]) expect(asked).not.toContain(id);
  const elsewhere = await checkWith({
    figures: [saved],
    body,
    findsNothing: true,
    text: reply([{ ...item(), source: null }]),
  });
  expect(elsewhere.result.figures?.[0]?.result.verdict).toBe("supported");
  // The sentence rests on its figure's own quote, found or not by the search (#2184).
  expect(elsewhere.result.verdict).toBe("supported");
  const uncited = await checkWith({
    figures: [saved],
    body,
    neverCites: true,
    text: reply([{ ...item(), source: null }]),
  });
  expect(uncited.result.verdict).toBe("supported");
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

  const outside = await checkWith({
    figures: [saved],
    body,
    text: reply([{ ...item(), source: null }]),
    scope: { documentIds: [], excluded: new Map() },
  });
  expect(outside.result.figures?.[0]?.result.verdict).toBe("supported");
  expect(outside.calls.map((call) => call.prompt).join("\n")).not.toContain("<passage id=");

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
  // An Analysis's figure with no record of its run: the Analysis it came from is gone (#2378).
  expect(retained.result.figures?.[0]?.result).toMatchObject({
    verdict: "not-checked",
    reason: "analysis-gone",
  });
  expect(retained.result.figures?.[0]?.sourceInput).toBeNull();

  // A saved calculation and an Analysis's figure have no Document number by contract, so the
  // undecided ask never fires for either.
  for (const each of [saved, analysis]) {
    const undecided = await checkWith({
      figures: [each],
      body,
      text: reply([
        { ...item(), verdict: "unsupported", topic: "not found", source: null, says: null },
      ]),
    });
    expect(undecided.calls.map((call) => call.prompt).join("\n")).not.toContain(
      "you give neither the Document's number",
    );
  }
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

test.each([
  { kind: "openrouter", forced: false, automatic: true },
  { kind: "openrouter", forced: undefined, automatic: false },
  ...(["deepseek", "qwen", "kimi", "glm", "anthropic", "openai", "ollama"] as const).map(
    (kind) => ({ kind, forced: false, automatic: false }),
  ),
] satisfies { kind: ChatProviderKind; forced: boolean | undefined; automatic: boolean }[])(
  "a correction keeps its existing choice outside OpenRouter ($kind, $forced)",
  async ({ kind, forced, automatic }) => {
    const { result, calls } = await checkWith({
      forcedToolChoice: forced,
      providerKind: kind,
      figures: [target("f1", "£20", "Revenue in 2024")],
      citesWhenAsked: true,
      text: reply([
        { ...item(), source: { citation: 1, number: "£20", reading: null, unitQuote: null } },
      ]),
    });
    const asked = calls.find((call) => /never recorded/.test(call.prompt));
    expect(asked?.options.toolChoice).toEqual(
      automatic ? { type: "auto" } : { type: "tool", toolName: "cite" },
    );
    expect(result.figures?.[0]?.result.verdict).toBe("supported");
  },
);

test("a model that cannot force Tools still cannot settle a figure without recorded evidence", async () => {
  const { result } = await checkWith({
    forcedToolChoice: false,
    providerKind: "openrouter",
    figures: [target("f1", "£20", "Revenue in 2024")],
    citesWhenAsked: true,
    quotes: [],
    text: reply([
      { ...item(), source: { citation: 1, number: "£20", reading: null, unitQuote: null } },
    ]),
  });
  expect(result.verdict).toBe("not-checked");
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

test("a figure left undecided with neither its source nor a reason is asked once, and the reply with its source binds", async () => {
  const { result, calls } = await checkWith({
    figures: [target("f1")],
    text: reply([
      { ...item(), verdict: "unsupported", topic: "not found", source: null, says: null },
    ]),
    askedAgain: {
      note: "you give neither the Document's number nor what differs",
      text: reply([item()]),
    },
  });
  expect(
    calls.filter((call) => call.prompt.includes("you give neither the Document's number")),
  ).toHaveLength(1);
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
});

test("a supported figure with no source is asked for its source, and a reply without a new quote is not accepted", async () => {
  const { result, calls } = await checkWith({
    figures: [target("f1")],
    text: reply([{ ...item(), source: null }]),
    askedAgain: { note: "a supported figure needs its source", text: reply([item()]) },
  });
  expect(
    calls.filter((call) => call.prompt.includes("a supported figure needs its source")),
  ).toHaveLength(1);
  expect(result.figures?.[0]?.result.verdict).toBe("not-checked");
});

test("a source position that names another number than the one given is read as the number the quote writes once", async () => {
  const body = "Revenue\t100\t120";
  const units: UnitText[] = [
    {
      page: 1,
      text: body,
      kind: "rows",
      label: { sheet: "Budget", from: 1, to: 1, rows: [1], column: 0 },
    },
  ];
  const { result } = await checkWith({
    figures: [target("f1", "120", "Revenue 2025")],
    claim: "Revenue was 120.",
    body,
    units,
    quotes: [body],
    text: reply([
      {
        ...item(),
        source: { citation: 1, number: "120", position: 1, reading: null, unitQuote: null },
      },
    ]),
  });
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
});

test("a calculate that ran before the cite beside it recorded its quote is worked out again, and the reply's source binds", async () => {
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
    calculatesBeforeCite: 1,
    text: reply([item()]),
  });
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
});

test("two calculates that raced their cite are both worked out again, and the reply's source binds", async () => {
  const calculation = (marker: number) => ({
    marker,
    label: "Revenue",
    formula: "source",
    stated: "£20",
    relation: "equals",
    inputs: [{ name: "source", label: "Revenue", citation: 1, position: 1 }],
  });
  const { result } = await checkWith({
    figures: [target("f1")],
    calculations: [calculation(1), calculation(2)],
    calculatesBeforeCite: 2,
    citeSentence: true,
    text: reply([{ ...item(), source: null, calculation: 1 }]),
  });
  expect(result.figures?.[0]?.result.verdict).toBe("supported");
});

test("a calculate the model abandoned for a readable source does not hide the figure", async () => {
  const { result } = await checkWith({
    figures: [target("f1")],
    calculations: [
      {
        marker: 1,
        label: "Revenue",
        formula: "source",
        stated: "£20",
        relation: "equals",
        inputs: [
          {
            name: "source",
            label: "Revenue",
            citation: 1,
            position: 1,
            unitQuote: "no such line",
          },
        ],
      },
    ],
    text: reply([item()]),
  });
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
  // The source's £300,000 is a thousandth of the note's £300m (#2365).
  { unitQuote: "All figures in £000", verdict: "contradicted" },
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

const INLINE = { passage: "P1", location: "p. 1", quote: "Revenue in 2024 was £20" };

test.each([
  {
    name: "an inline source",
    text: reply([{ ...item(), source: { ...INLINE, number: "£20" } }]),
  },
  {
    name: "a calculation's inline input",
    calculations: [
      {
        marker: 1,
        label: "Revenue",
        formula: "source",
        stated: "£20",
        relation: "equals",
        inputs: [{ name: "source", label: "Revenue", ...INLINE, number: "£20" }],
      },
    ],
    text: reply([{ ...item(), source: null, calculation: 1 }]),
  },
])(
  "a Supported sentence its figure holds by $name, with no quote recorded, stays Supported (#2184)",
  async ({ text, calculations }) => {
    const { result } = await checkWith({
      figures: [target("f1")],
      neverCites: true,
      ...(calculations && { calculations }),
      text,
    });
    expect(result.figures?.[0]?.result.verdict).toBe("supported");
    expect(result.verdict).toBe("supported");
  },
);

test.each([
  { verdict: "contradicted", route: "recorded with cite", source: { citation: 1, number: "£21" } },
  { verdict: "unsupported", route: "recorded with cite", source: { citation: 1, number: "£21" } },
  { verdict: "contradicted", route: "given inline", source: { ...INLINE, number: "£21" } },
  { verdict: "unsupported", route: "given inline", source: { ...INLINE, number: "£21" } },
])(
  "a figure called $verdict whose quote, $route, is on a page with no text to read stays not checked (#2184)",
  async ({ verdict, source }) => {
    const { result } = await checkWith({
      figures: [target("f1")],
      units: [{ page: 1, text: "", kind: "page", label: null }],
      text: reply([{ ...item(), verdict, source: { reading: null, unitQuote: null, ...source } }]),
    });
    expect(result.figures?.[0]?.result.verdict).toBe("not-checked");
  },
);

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
    expect(result.figures?.[0]?.result.verdict).toBe(
      judgement === "malformed" ? "not-checked" : "supported",
    );
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
      text: "Verdict: supported\nAbsence: no\nScope: same\nTopic: found\nRoles: same\nSays: Revenue in 2024 was £20.\nCalculation: none",
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

// protects=a quote cited with no pages is placed in its Document, not in itself, so a table's cell quoted alone is named by its own row there, and another row's label names another number (#2255); fails_when=a pages-less quote is read as its whole text, so the other row's label goes unseen; no_claim=none beyond protects.
test.each([
  { words: "Revenue growth", verdict: "supported" },
  { words: "Operating margin", verdict: "not-checked" },
])("a quote cited with no pages is placed in its Document: $words", async ({ words, verdict }) => {
  const claim = `${words} was 12% in 2025.`;
  const { result } = await checkWith({
    figures: [target("f1", "12%", claim)],
    claim,
    body: "| Measure | 2025 |\n| --- | --- |\n| Revenue growth | 12% |\n| Operating margin | 9% |",
    quotes: ["12%"],
    pagesless: true,
    text: reply([
      {
        ...item(),
        source: { citation: 1, number: "12%", unitQuote: null },
        measure: { sentence: words, quote: words, match: "same" },
      },
    ]),
  });
  expect(result.figures?.[0]?.source?.pageFrom).toBeNull();
  expect(result.figures?.[0]?.result.verdict).toBe(verdict);
});

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

/** A plan whose 2027 sales are worked out from its growth assumption (#2347). */
async function planUnits(growth: number): Promise<UnitText[]> {
  const book = new WorkbookBuilder();
  book
    .sheet("Plan")
    .text("A1", "Line")
    .text("B1", "2026")
    .text("C1", "2027")
    .text("A2", "Sales")
    .number("B2", 400)
    .formula("C2", "B2*(1+B4)", 400 * (1 + growth))
    .text("A4", "Growth")
    .number("B4", growth, "percent");
  return (await extractXlsx(new Uint8Array(book.xlsx()))).units;
}

/** A workbook's Tools over `units`, read as one Passage, and the figures they record. */
function workbookPassage(units: UnitText[], language: "en" | "zh-CN") {
  const source: CitationSource = {
    passageId: "passage-1",
    documentId: "document-1",
    documentName: "Accounts",
    documentKind: "xlsx",
    contentHash: "hash-1",
    text: units.map((unit) => unit.text).join("\n"),
    pageFrom: 1,
    pageTo: 1,
    documentDeleted: false,
    notCited: false,
    yourNoteAt: null,
  };
  const recorded: CalculatedFigure[] = [];
  const [trace, whatIf] = workbookTools({
    passage: (id) => (id === "P1" ? { source, units } : null),
    passageOf: () => source.passageId,
    figure: (figure) => recorded.push(figure),
    language,
  });
  if (!trace || !whatIf) throw new Error("No workbook Tools.");
  const context = { toolCallId: "call", signal: new AbortController().signal };
  return { trace, whatIf, context, recorded };
}

/** The plan's 2027 sales as `trace_formulas` records it, and with growth at 10% as `what_if` does. */
async function planFigures(units: UnitText[], language: "en" | "zh-CN") {
  const { trace, whatIf, context, recorded } = workbookPassage(units, language);
  await trace.call({ passage: "P1", cell: "Plan!C2", label: "Sales 2027" }, context);
  await whatIf.call(
    { passage: "P1", cell: "Plan!C2", label: "Sales 2027", input: "Plan!B4", value: "10%" },
    context,
  );
  const [traced, changed] = recorded;
  if (!traced || !changed) throw new Error("The workbook's figures weren't recorded.");
  return { traced, changed };
}

describe.each([
  { language: "en" as const, claim: "Sales in 2027 were 420, or 440 at 10% growth." },
  { language: "zh-CN" as const, claim: "2027 年销售额为 420，增长率为 10% 时为 440。" },
])("$language: a workbook's figure is checked against its cell (#2347)", ({ language, claim }) => {
  const saved = (id: string, figure: CalculatedFigure, shown = figure.shown): CheckFigure => ({
    ...target(id, shown, figure.label, language),
    calculated: { id, figure, analysisId: null },
  });
  const check = async (figures: CheckFigure[], units: UnitText[]) =>
    checkWith({
      figures,
      claim,
      units,
      body: units.map((unit) => unit.text).join("\n"),
      text: reply(figures.map((figure) => ({ ...item(figure.id), source: null }))),
    });

  test("a figure the workbook gives is Supported by its cell, and a what-if by working it out again", async () => {
    const units = await planUnits(0.05);
    const { traced, changed } = await planFigures(units, language);
    expect([traced.shown, changed.shown]).toEqual(["420", "440"]);
    const { result } = await check([saved("f1", traced), saved("f2", changed)], units);
    const [cell, whatIf] = result.figures ?? [];
    expect(cell?.result.verdict).toBe("supported");
    expect(cell?.sourceInput).toMatchObject({
      number: { chars: "420", value: 420 },
      cell: { sheet: "Plan", ref: "C2" },
      citation: {
        check: "found",
        quote: "Sales\t400\t420",
        location: { kind: "rows", sheet: "Plan", from: 2, to: 2 },
      },
    });
    expect(whatIf?.result.verdict).toBe("supported");
    expect(whatIf?.sourceInput).toBeNull();
    const worked = whatIf?.result.verdict === "supported" ? whatIf.result.calculation : null;
    expect(worked?.figure.value).toBeCloseTo(440, 9);
    expect(worked?.figure.workbook?.change).toEqual({
      input: "Plan_B4",
      value: 0.1,
      shown: "10.0%",
    });
  });

  test("a figure its cell doesn't give is Contradicted, with the cell's number beside it", async () => {
    const units = await planUnits(0.05);
    const { traced } = await planFigures(units, language);
    const { result } = await check([saved("f1", traced, "425")], units);
    expect(result.figures?.[0]?.result.verdict).toBe("contradicted");
    expect(result.figures?.[0]?.sourceInput?.number.chars).toBe("420");
  });

  test("once the workbook's cells no longer give a figure, it isn't checked, and says why", async () => {
    const { traced, changed } = await planFigures(await planUnits(0.05), language);
    const { result } = await check(
      [saved("f1", traced), saved("f2", changed)],
      await planUnits(0.06),
    );
    expect(result.figures?.map((figure) => figure.result)).toEqual([
      expect.objectContaining({ verdict: "not-checked", reason: "workbook-changed" }),
      expect.objectContaining({ verdict: "not-checked", reason: "workbook-changed" }),
    ]);
    expect(translate(language, "claim.reason.workbook-changed")).toContain(
      language === "en" ? "workbook’s cells" : "工作簿现在的单元格",
    );
  });
});

const correctionOf = (result: ClaimCheckResult) =>
  result.verdict === "not-checked" ? undefined : result.correction;

test.each([
  { name: "alone", calculated: false, offered: true },
  { name: "beside a supported calculated figure", calculated: true, offered: false },
])("a figure's correction is offered $name", async ({ calculated, offered }) => {
  const sentence = calculated ? "Revenue was £20 and profit was £10." : "Revenue was £20.";
  const revenue = {
    ...item("revenue"),
    verdict: "contradicted",
    source: { citation: 1, number: "£21" },
  };
  const items = calculated
    ? [revenue, { ...item("profit"), source: null, calculation: 1 }]
    : [revenue];
  const { result } = await checkWith({
    claim: sentence,
    figures: [
      target("revenue", "£20", sentence),
      ...(calculated ? [target("profit", "£10", sentence)] : []),
    ],
    body: "Revenue was £21. Costs were £11.",
    ...(calculated && {
      calculations: [
        {
          marker: 1,
          label: "Profit",
          formula: "revenue - costs",
          stated: "£10",
          relation: "equals",
          inputs: [
            { name: "revenue", label: "Revenue", citation: 1, position: 1 },
            { name: "costs", label: "Costs", citation: 1, position: 2 },
          ],
        },
      ],
    }),
    text: `Verdict: contradicted\nChange 1: £20\nTo 1: £21 [^1]\nFigures: ${JSON.stringify({ items, remainder: null })}`,
  });

  expect(result.verdict).toBe("contradicted");
  expect(result.figures?.map((figure) => figure.result.verdict)).toEqual(
    calculated ? ["contradicted", "supported"] : ["contradicted"],
  );
  expect(correctionOf(result)?.choices[0]?.wording).toBe(offered ? "£21" : undefined);
});

test.each([
  { name: "its own sentence", table: false, offered: true },
  { name: "table headings", table: true, offered: false },
])("a figure's correction is offered with $name as its context", async ({ table, offered }) => {
  const sentence = "Revenue was £20.";
  const { result } = await checkWith({
    claim: sentence,
    figures: [target("f1", "£20", table ? `Revenue | 2025\n${sentence}` : sentence)],
    body: "Revenue was £21.",
    text: `Verdict: contradicted\nChange 1: £20\nTo 1: £21 [^1]\nFigures: ${JSON.stringify({
      items: [{ ...item(), verdict: "contradicted", source: { citation: 1, number: "£21" } }],
      remainder: null,
    })}`,
  });

  expect(result.verdict).toBe("contradicted");
  expect(correctionOf(result)?.choices[0]?.wording).toBe(offered ? "£21" : undefined);
});

const RENT = "The base rent is $15,000 per month.";
const LEASE = "The Tenant shall pay a base rent of $14,250 per month, in advance.";
const rentLines = (to: string) =>
  [
    "Verdict: contradicted",
    "Absence: no",
    "Scope: none, same",
    "Topic: found",
    "Roles: none, same",
    "Change 1: $15,000",
    `To 1: ${to}`,
    "The lease sets the base rent at $14,250 per month, not $15,000.",
    "Evidence: [1]",
  ].join("\n");

test.each([
  { name: "the lease's", quote: LEASE, wording: "$14,250" },
  { name: "another line's", quote: "The Tenant shall pay rent monthly.", wording: undefined },
])(
  "a figure's correction is offered from $name quote when the record is given only once asked (#1481)",
  async ({ quote, wording }) => {
    const { result } = await checkWith({
      claim: RENT,
      figures: [target("f1", "$15,000", RENT)],
      body: `${LEASE} The Tenant shall pay rent monthly.`,
      neverCites: true,
      recordWhenAsked: quote,
      text: `${rentLines('"a base rent of $14,250 per month"')}\nFigures: ${JSON.stringify({
        items: [
          {
            ...item(),
            verdict: "contradicted",
            source: { citation: 1, number: "$14,250", reading: 1, unitQuote: null },
          },
        ],
        remainder: null,
      })}`,
    });

    expect(result.verdict).toBe("contradicted");
    expect(correctionOf(result)?.choices[0]?.wording).toBe(wording);
  },
);

const TERM = "Rent is paid 12 times a year.";

test.each([
  { name: "only names the lease's number", claim: RENT, formula: "rent", wording: "$14,250" },
  {
    name: "works a number out",
    claim: "The base rent is $150,000 a year.",
    formula: "rent * months",
    wording: undefined,
  },
])("a figure's correction is offered when its calculation $name (#1481)", async (each) => {
  const stated = each.claim === RENT ? "$15,000" : "$150,000";
  const { result } = await checkWith({
    claim: each.claim,
    figures: [target("f1", stated, each.claim)],
    body: `${LEASE} ${TERM}`,
    quotes: [LEASE, TERM],
    calculations: [
      {
        marker: 1,
        label: "Base rent",
        formula: each.formula,
        stated,
        relation: "equals",
        as: "currency",
        inputs: [
          {
            name: "rent",
            label: "Base rent per month",
            citation: 1,
            number: "$14,250",
            reading: 1,
          },
          ...(each.formula === "rent"
            ? []
            : [{ name: "months", label: "Payments a year", citation: 2, number: "12" }]),
        ],
      },
    ],
    text: `${rentLines("$14,250 per month").replace("$15,000", stated)}\nFigures: ${JSON.stringify({
      items: [{ ...item(), verdict: "contradicted", source: null, calculation: 1 }],
      remainder: null,
    })}`,
  });

  expect(result.verdict).toBe("contradicted");
  expect(result.figures?.[0]?.result.verdict).toBe("contradicted");
  expect(correctionOf(result)?.choices[0]?.wording).toBe(each.wording);
});

test.each([
  { to: "人民币九万八千元（¥98,000）", wording: "人民币九万八千元（¥98,000）" },
  { to: "人民币九万六千元", wording: undefined },
])(
  "a Chinese figure's correction is $to when the Document writes its number twice (#1481)",
  async ({ to, wording }) => {
    const sentence = "月租金为人民币九万五千元。";
    const { result } = await checkWith({
      claim: sentence,
      figures: [target("f1", "人民币九万五千元", sentence, "zh-CN")],
      body: "月租金调整为人民币九万八千元（¥98,000）。",
      text: `Verdict: contradicted\nChange 1: 人民币九万五千元\nTo 1: ${to}\nEvidence: [1]\nFigures: ${JSON.stringify(
        {
          items: [
            {
              ...item(),
              verdict: "contradicted",
              source: { citation: 1, number: "98,000", reading: null, unitQuote: null },
            },
          ],
          remainder: null,
        },
      )}`,
    });

    expect(result.verdict).toBe("contradicted");
    expect(result.figures?.[0]?.result.verdict).toBe("contradicted");
    expect(correctionOf(result)?.choices[0]?.wording).toBe(wording);
  },
);

test.each([
  {
    claim: "Revenue was $1.5m in the year.",
    figure: "$1.5m",
    body: "Revenue was $1.2m ($1,200,000) in the year.",
    number: "$1.2m",
    from: "1.5",
    to: "1,200,000",
    language: "en" as const,
    wording: "$1.2m",
  },
  {
    claim: "Revenue was $1.5m in the year.",
    figure: "$1.5m",
    body: "Revenue was $1.2m in the year.",
    number: "$1.2m",
    from: "1.5",
    to: "1.2",
    language: "en" as const,
    wording: "1.2",
  },
  {
    claim: "营收为1.5亿元。",
    figure: "1.5亿元",
    body: "营收为1.2亿元（120,000,000元）。",
    number: "1.2亿元",
    from: "1.5",
    to: "120,000,000元",
    language: "zh-CN" as const,
    wording: "1.2亿元",
  },
  {
    claim: "营收为1.5亿元。",
    figure: "1.5亿元",
    body: "营收为1.2亿元。",
    number: "1.2亿元",
    from: "1.5",
    to: "1.2",
    language: "zh-CN" as const,
    wording: "1.2",
  },
])(
  "a figure's digits changed to $to give $wording: the Document's number, read whole (#1481)",
  async (each) => {
    const { result } = await checkWith({
      claim: each.claim,
      figures: [target("f1", each.figure, each.claim, each.language)],
      body: each.body,
      text: `Verdict: contradicted\nChange 1: ${each.from}\nTo 1: ${each.to} [^1]\nEvidence: [1]\nFigures: ${JSON.stringify(
        {
          items: [
            {
              ...item(),
              verdict: "contradicted",
              source: { citation: 1, number: each.number, reading: null, unitQuote: null },
            },
          ],
          remainder: null,
        },
      )}`,
    });

    expect(result.verdict).toBe("contradicted");
    expect(result.figures?.[0]?.result.verdict).toBe("contradicted");
    expect(correctionOf(result)?.choices[0]?.wording).toBe(each.wording);
  },
);

// protects=#2341; fails_when=a Document that gives an amount in words and then again in figures in
// brackets, "人民币九万八千元（¥98,000）", has its bracket read as a negative, so a correct sentence that
// gives the figures is Contradicted; or a bracket whose figures disagree with the words before it
// backs a sentence that gives those figures.
const bracketed = [
  {
    name: "Chinese words, then ¥ figures, against a Chinese sentence",
    claim: "月租金为¥98,000。",
    figure: "¥98,000",
    language: "zh-CN",
    body: "月租金调整为人民币九万八千元（¥98,000）。",
    number: "98,000",
    value: 98000,
  },
  {
    name: "Chinese words, then ¥ figures, against an English sentence",
    claim: "The monthly rent is RMB 98,000.",
    figure: "RMB 98,000",
    language: "en",
    body: "月租金调整为人民币九万八千元（¥98,000）。",
    number: "98,000",
    value: 98000,
  },
  {
    name: "Chinese capitals, then figures with cents",
    claim: "合同总价为100,000元。",
    figure: "100,000元",
    language: "zh-CN",
    body: "合同总价为人民币壹拾万元整（¥100,000.00）。",
    number: "100,000.00",
    value: 100000,
  },
  {
    name: "a scale word, then the full figures",
    claim: "The purchase price is $1,200,000.",
    figure: "$1,200,000",
    language: "en",
    body: "The purchase price is USD 1.2 million ($1,200,000), payable on completion.",
    number: "$1,200,000",
    value: 1200000,
  },
  {
    name: "a Chinese scale, then the full figures",
    claim: "保证金为75,000元。",
    figure: "75,000元",
    language: "zh-CN",
    body: "乙方应支付保证金人民币7.5万元（¥75,000）。",
    number: "75,000",
    value: 75000,
  },
  {
    name: "English words, then figures",
    claim: "The quarterly rent is $75,000.",
    figure: "$75,000",
    language: "en",
    body: "The Tenant shall pay Seventy-Five Thousand Dollars ($75,000.00) each quarter.",
    number: "$75,000.00",
    value: 75000,
  },
] as const;

test.each(bracketed)(
  "$name: the bracket gives the same amount, and the sentence is Supported (#2341)",
  async (each) => {
    const { result } = await checkWith({
      claim: each.claim,
      figures: [target("f1", each.figure, each.claim, each.language)],
      body: each.body,
      text: reply([
        {
          ...item(),
          source: { citation: 1, number: each.number, reading: null, unitQuote: null },
        },
      ]),
    });

    expect(result.figures?.[0]?.sourceInput?.number.value).toBe(each.value);
    expect(result.figures?.[0]?.result.verdict).toBe("supported");
    expect(result.verdict).toBe("supported");
  },
);

test.each([
  {
    claim: "月租金为¥98,000。",
    figure: "¥98,000",
    language: "zh-CN",
    body: "月租金调整为人民币九万五千元（¥98,000）。",
    number: "98,000",
  },
  {
    claim: "The quarterly rent is $57,000.",
    figure: "$57,000",
    language: "en",
    body: "The Tenant shall pay Seventy-Five Thousand Dollars ($57,000.00) each quarter.",
    number: "$57,000.00",
  },
] as const)(
  "figures in brackets that disagree with the words before them never back $claim (#2341)",
  async (each) => {
    const { result } = await checkWith({
      claim: each.claim,
      figures: [target("f1", each.figure, each.claim, each.language)],
      body: each.body,
      text: reply([
        {
          ...item(),
          source: { citation: 1, number: each.number, reading: null, unitQuote: null },
        },
      ]),
    });

    expect(result.figures?.[0]?.result.verdict).not.toBe("supported");
    expect(result.verdict).not.toBe("supported");
  },
);

// protects=#2341; fails_when=a sign the words give the amount ("minus", "亏损") or a cell break
// before the bracket is passed over, so the bracket loses its minus and backs a sentence that drops
// the sign; or a Document that says brackets are negative has its bracket read as a plain amount.
test.each([
  {
    name: "a sign in words before the amount",
    claim: "The balance is -$64,000.",
    figure: "-$64,000",
    language: "en",
    body: "The balance is minus sixty-four thousand dollars ($64,000.00).",
    number: "$64,000.00",
    supported: true,
  },
  {
    name: "the same sentence without its sign",
    claim: "The balance is $64,000.",
    figure: "$64,000",
    language: "en",
    body: "The balance is minus sixty-four thousand dollars ($64,000.00).",
    number: "$64,000.00",
    supported: false,
  },
  {
    name: "the same amount with no sign",
    claim: "The balance is $64,000.",
    figure: "$64,000",
    language: "en",
    body: "The balance is sixty-four thousand dollars ($64,000.00).",
    number: "$64,000.00",
    supported: true,
  },
  {
    name: "a loss given in Chinese words",
    claim: "本期为¥64,000。",
    figure: "¥64,000",
    language: "zh-CN",
    body: "本期亏损人民币六万四千元（¥64,000）。",
    number: "64,000",
    supported: false,
  },
  {
    name: "words cut by a tab",
    claim: "The total is $3,700.",
    figure: "$3,700",
    language: "en",
    body: "Total three thousand\tseven hundred ($3,700.00)",
    number: "$3,700.00",
    supported: false,
  },
  {
    name: "the same words with no tab",
    claim: "The total is $3,700.",
    figure: "$3,700",
    language: "en",
    body: "Total three thousand seven hundred dollars ($3,700.00)",
    number: "$3,700.00",
    supported: true,
  },
  {
    name: "整 after Chinese numerals",
    claim: "尾款为¥64,000。",
    figure: "¥64,000",
    language: "zh-CN",
    body: "尾款为人民币六万四千元整（¥64,000.00）。",
    number: "64,000.00",
    supported: true,
  },
  {
    name: "a Document that says brackets are negative",
    claim: "Net cash was £2,700,000.",
    figure: "£2,700,000",
    language: "en",
    body: "Amounts in brackets are negative.\nNet cash was £2.7m (£2,700,000).",
    number: "£2,700,000",
    supported: false,
  },
  {
    name: "a note on another line that brackets are negative",
    claim: "Net cash was £2,700,000.",
    figure: "£2,700,000",
    language: "en",
    body: "Amounts in brackets are negative.\nNet cash was £2.7m (£2,700,000).",
    quotes: ["Net cash was £2.7m (£2,700,000)."],
    number: "£2,700,000",
    supported: false,
  },
  {
    name: "a sign two words before English words",
    claim: "The balance is $62,000.",
    figure: "$62,000",
    language: "en",
    body: "The account had a negative balance of sixty-two thousand dollars ($62,000.00).",
    number: "$62,000.00",
    supported: false,
  },
  {
    name: "the signed sentence against a sign two words before",
    claim: "The balance is -$62,000.",
    figure: "-$62,000",
    language: "en",
    body: "The account had a negative balance of sixty-two thousand dollars ($62,000.00).",
    number: "$62,000.00",
    supported: true,
  },
  {
    name: "the same balance with no sign",
    claim: "The balance is $62,000.",
    figure: "$62,000",
    language: "en",
    body: "The account had a balance of sixty-two thousand dollars ($62,000.00).",
    number: "$62,000.00",
    supported: true,
  },
  {
    name: "Chinese words whose sign is a question",
    claim: "金额为¥62,000。",
    figure: "¥62,000",
    language: "zh-CN",
    body: "金额为△人民币六万二千元（¥62,000）。",
    number: "62,000",
    supported: false,
  },
  {
    name: "the same Chinese words with no sign",
    claim: "金额为¥62,000。",
    figure: "¥62,000",
    language: "zh-CN",
    body: "金额为人民币六万二千元（¥62,000）。",
    number: "62,000",
    supported: true,
  },
  {
    name: "a negative word before an earlier number",
    claim: "The balance is $95,000.",
    figure: "$95,000",
    language: "en",
    body: "The negative balance fell from 98,000 to ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: false,
  },
  {
    name: "the signed sentence against a negative word before an earlier number",
    claim: "The balance is -$95,000.",
    figure: "-$95,000",
    language: "en",
    body: "The negative balance fell from 98,000 to ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: true,
  },
  {
    name: "the same balance with no negative word",
    claim: "The balance is $95,000.",
    figure: "$95,000",
    language: "en",
    body: "The balance fell from 98,000 to ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: true,
  },
  {
    name: "负数 before an earlier Chinese number",
    claim: "余额为¥95,000。",
    figure: "¥95,000",
    language: "zh-CN",
    body: "负数余额从8,000元增至人民币九万五千元（¥95,000）。",
    number: "95,000",
    supported: false,
  },
  {
    name: "the same Chinese balance with no 负数",
    claim: "余额为¥95,000。",
    figure: "¥95,000",
    language: "zh-CN",
    body: "余额从8,000元增至人民币九万五千元（¥95,000）。",
    number: "95,000",
    supported: true,
  },
  {
    name: "a negative word far back in a long clause",
    claim: "The movement was $75,000.",
    figure: "$75,000",
    language: "en",
    body: "The negative movement recorded over the full year for the combined portfolio of the Group's subsidiaries in all of its regions after all adjustments was seventy-five thousand dollars ($75,000.00).",
    number: "$75,000.00",
    supported: false,
  },
  {
    name: "负债, which is no sign",
    claim: "负债总额为¥62,000。",
    figure: "¥62,000",
    language: "zh-CN",
    body: "截至年末，公司负债总额为人民币六万二千元（¥62,000）。",
    number: "62,000",
    supported: true,
  },
  {
    name: "a negative word before a comma",
    claim: "The balance is $75,000.",
    figure: "$75,000",
    language: "en",
    body: "The account had a negative balance, after all adjustments, of seventy-five thousand dollars ($75,000.00).",
    number: "$75,000.00",
    supported: false,
  },
  {
    name: "the signed sentence against a negative word before a comma",
    claim: "The balance is -$75,000.",
    figure: "-$75,000",
    language: "en",
    body: "The account had a negative balance, after all adjustments, of seventy-five thousand dollars ($75,000.00).",
    number: "$75,000.00",
    supported: true,
  },
  {
    name: "the same balance before a comma with no negative word",
    claim: "The balance is $75,000.",
    figure: "$75,000",
    language: "en",
    body: "The account had a balance, after all adjustments, of seventy-five thousand dollars ($75,000.00).",
    number: "$75,000.00",
    supported: true,
  },
  {
    name: "负 before a Chinese comma",
    claim: "余额为¥95,000。",
    figure: "¥95,000",
    language: "zh-CN",
    body: "账户为负余额，经调整后为人民币九万五千元（¥95,000）。",
    number: "95,000",
    supported: false,
  },
  {
    name: "the same Chinese balance before a comma with no 负",
    claim: "余额为¥95,000。",
    figure: "¥95,000",
    language: "zh-CN",
    body: "账户为正余额，经调整后为人民币九万五千元（¥95,000）。",
    number: "95,000",
    supported: true,
  },
  {
    name: "a negative word before an abbreviation's stop",
    claim: "The balance is $95,000.",
    figure: "$95,000",
    language: "en",
    body: "The negative balance owed by Party A Inc. was ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: false,
  },
  {
    name: "the signed sentence against a negative word before an abbreviation's stop",
    claim: "The balance is -$95,000.",
    figure: "-$95,000",
    language: "en",
    body: "The negative balance owed by Party A Inc. was ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: true,
  },
  {
    name: "a negative word in the sentence before",
    claim: "Party A Inc. paid a fee of $95,000.",
    figure: "$95,000",
    language: "en",
    body: "Party A had a negative result. Party A Inc. paid a fee of ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a negative word before a place's abbreviation",
    claim: "The balance is $95,000.",
    figure: "$95,000",
    language: "en",
    body: "The negative balance at the St. Louis branch was ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence against a negative word before a place's abbreviation",
    claim: "The balance is -$95,000.",
    figure: "-$95,000",
    language: "en",
    body: "The negative balance at the St. Louis branch was ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: true,
  },
  {
    name: "a negative word before a title",
    claim: "The balance is $95,000.",
    figure: "$95,000",
    language: "en",
    body: "The negative balance due to Prof. E was ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a negative word before an account's number",
    claim: "The balance is $95,000.",
    figure: "$95,000",
    language: "en",
    body: "The negative balance in Account No. A12 was ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a negative word before a company's abbreviations",
    claim: "The balance is $95,000.",
    figure: "$95,000",
    language: "en",
    body: "The negative balance of Party B Co. Ltd. was ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a sentence that ends after a company's abbreviation keeps the minus",
    claim: "The fee is $95,000.",
    figure: "$95,000",
    language: "en",
    body: "The balance was negative for Party A Inc. The fee was ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: false,
  },
  {
    name: "a negative word before a lowercase abbreviation",
    claim: "The balance is $95,000.",
    figure: "$95,000",
    language: "en",
    body: "The negative balance in acct. A12 was ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence against a negative word before a lowercase abbreviation",
    claim: "The balance is -$95,000.",
    figure: "-$95,000",
    language: "en",
    body: "The negative balance in acct. A12 was ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: true,
  },
  {
    name: "a negative word on the line before",
    claim: "The balance is $95,000.",
    figure: "$95,000",
    language: "en",
    body: "The negative balance\nwas ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence against a negative word on the line before",
    claim: "The balance is -$95,000.",
    figure: "-$95,000",
    language: "en",
    body: "The negative balance\nwas ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: true,
  },
  {
    name: "a negative word in the sentence before that the amount still has",
    claim: "The balance is $95,000.",
    figure: "$95,000",
    language: "en",
    body: "The balance was negative. It was ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence against a negative word in the sentence before",
    claim: "The balance is -$95,000.",
    figure: "-$95,000",
    language: "en",
    body: "The balance was negative. It was ninety-five thousand dollars ($95,000.00).",
    number: "$95,000.00",
    supported: true,
  },
  {
    name: "a negative word after the amount",
    claim: "The net position is $62,000.",
    figure: "$62,000",
    language: "en",
    body: "The fund's net position, sixty-two thousand dollars ($62,000.00), turned negative in March.",
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence against a negative word after the amount",
    claim: "The net position is -$62,000.",
    figure: "-$62,000",
    language: "en",
    body: "The fund's net position, sixty-two thousand dollars ($62,000.00), turned negative in March.",
    number: "$62,000.00",
    supported: true,
  },
  {
    name: "由盈转亏 before the amount",
    claim: "净利润为¥62,000。",
    figure: "¥62,000",
    language: "zh-CN",
    body: "公司由盈转亏，净利润为人民币六万二千元（¥62,000）。",
    number: "62,000",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a quote that starts after its sign word",
    claim: "The reserve was $62,000.",
    figure: "$62,000",
    language: "en",
    body: "The reserve turned negative in May. At year end it stood at sixty-two thousand dollars ($62,000.00).",
    quotes: ["At year end it stood at sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence against a quote that starts after its sign word",
    claim: "The reserve was -$62,000.",
    figure: "-$62,000",
    language: "en",
    body: "The reserve turned negative in May. At year end it stood at sixty-two thousand dollars ($62,000.00).",
    quotes: ["At year end it stood at sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: true,
  },
  {
    name: "the same quote with no sign word before it",
    claim: "The reserve was $62,000.",
    figure: "$62,000",
    language: "en",
    body: "The reserve stayed positive in May. At year end it stood at sixty-two thousand dollars ($62,000.00).",
    quotes: ["At year end it stood at sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: true,
  },
  {
    name: "a quote that ends before its sign word",
    claim: "Cash was $62,000.",
    figure: "$62,000",
    language: "en",
    body: "Cash came to sixty-two thousand dollars ($62,000.00). That balance is negative.",
    quotes: ["Cash came to sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a Chinese quote that starts after 透支",
    claim: "月末余额为¥62,000。",
    figure: "¥62,000",
    language: "zh-CN",
    body: "该账户本月出现透支。月末余额为人民币六万二千元（¥62,000）。",
    quotes: ["月末余额为人民币六万二千元（¥62,000）。"],
    number: "62,000",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a quote that starts after its line's Less label",
    claim: "The retention held back was $62,000.",
    figure: "$62,000",
    language: "en",
    body: "Less: retention held back sixty-two thousand dollars ($62,000.00)",
    quotes: ["retention held back sixty-two thousand dollars ($62,000.00)"],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a quote far into its page under a heading after a blank line, with no sign word",
    claim: "The rent is $62,000.",
    figure: "$62,000",
    language: "en",
    body: `${"The Tenant shall keep the premises in good repair. ".repeat(12)}\n\n4. Rent\nThe rent is sixty-two thousand dollars ($62,000.00).`,
    quotes: ["The rent is sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: true,
  },
  {
    name: "a Chinese quote far into its page under a heading after a blank line, with no sign word",
    claim: "租金为¥62,000。",
    figure: "¥62,000",
    language: "zh-CN",
    body: `${"承租人应妥善保管租赁物。".repeat(35)}\n\n第四条 租金\n租金为人民币六万二千元（¥62,000）。`,
    quotes: ["租金为人民币六万二千元（¥62,000）。"],
    number: "62,000",
    supported: true,
  },
  {
    name: "a quote far into its page under a numbered heading with no blank line above keeps main's minus",
    claim: "The rent is $62,000.",
    figure: "$62,000",
    language: "en",
    body: `${"The Tenant shall keep the premises in good repair. ".repeat(12)}\n4. Rent\nThe rent is sixty-two thousand dollars ($62,000.00).`,
    quotes: ["The rent is sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a quote far into its page under a short line with no number keeps main's minus",
    claim: "The rent is $62,000.",
    figure: "$62,000",
    language: "en",
    body: `${"The Tenant shall keep the premises in good repair. ".repeat(12)}\nRent\nThe rent is sixty-two thousand dollars ($62,000.00).`,
    quotes: ["The rent is sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a far sign word in the sentence a short line carries on keeps main's minus",
    claim: "The reserve was $68,000.",
    figure: "$68,000",
    language: "en",
    body: `The reserve remained negative throughout ${"the year while the board kept the matter under review ".repeat(8)}\nand was reported as\nsixty-eight thousand dollars ($68,000.00).`,
    quotes: ["sixty-eight thousand dollars ($68,000.00)."],
    number: "$68,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence against a far sign word in the sentence a short line carries on",
    claim: "The reserve was -$68,000.",
    figure: "-$68,000",
    language: "en",
    body: `The reserve remained negative throughout ${"the year while the board kept the matter under review ".repeat(8)}\nand was reported as\nsixty-eight thousand dollars ($68,000.00).`,
    quotes: ["sixty-eight thousand dollars ($68,000.00)."],
    number: "$68,000.00",
    supported: true,
  },
  {
    name: "a far 负数 in the sentence a short line carries on keeps main's minus",
    claim: "准备金为¥68,000。",
    figure: "¥68,000",
    language: "zh-CN",
    body: `该准备金全年为负数，${"董事会在每次会议上都对该事项进行审阅，".repeat(22)}\n并列示为\n人民币六万八千元（¥68,000）。`,
    quotes: ["人民币六万八千元（¥68,000）。"],
    number: "68,000",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence against a far 负数 in the sentence a short line carries on",
    claim: "准备金为-¥68,000。",
    figure: "-¥68,000",
    language: "zh-CN",
    body: `该准备金全年为负数，${"董事会在每次会议上都对该事项进行审阅，".repeat(22)}\n并列示为\n人民币六万八千元（¥68,000）。`,
    quotes: ["人民币六万八千元（¥68,000）。"],
    number: "68,000",
    supported: true,
  },
  {
    name: "a far sign word and a numbered line that carries on a sentence keep main's minus",
    claim: "The reserve was $68,000.",
    figure: "$68,000",
    language: "en",
    body: `The reserve remained negative throughout ${"the year while the board kept the matter under review ".repeat(8)}as set out in clause\n3. Under that clause it was reported as\nsixty-eight thousand dollars ($68,000.00).`,
    quotes: ["sixty-eight thousand dollars ($68,000.00)."],
    number: "$68,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a far sign word, a semicolon and a numbered line that carries on the sentence keep main's minus",
    claim: "The reserve was $68,000.",
    figure: "$68,000",
    language: "en",
    body: `The reserve remained negative throughout ${"the year while the board kept the matter under review ".repeat(8)}and was recorded as follows;\n(1) it was reported as\nsixty-eight thousand dollars ($68,000.00).`,
    quotes: ["sixty-eight thousand dollars ($68,000.00)."],
    number: "$68,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence against a far sign word, a semicolon and a numbered line that carries on the sentence",
    claim: "The reserve was -$68,000.",
    figure: "-$68,000",
    language: "en",
    body: `The reserve remained negative throughout ${"the year while the board kept the matter under review ".repeat(8)}and was recorded as follows;\n(1) it was reported as\nsixty-eight thousand dollars ($68,000.00).`,
    quotes: ["sixty-eight thousand dollars ($68,000.00)."],
    number: "$68,000.00",
    supported: true,
  },
  {
    name: "a far 负数, a ； and a （一） line that carries on the sentence keep main's minus",
    claim: "准备金为¥68,000。",
    figure: "¥68,000",
    language: "zh-CN",
    body: `该准备金全年为负数，${"董事会在每次会议上都对该事项进行审阅，".repeat(22)}并按以下条目记录；\n（一）其列示金额为\n人民币六万八千元（¥68,000）。`,
    quotes: ["人民币六万八千元（¥68,000）。"],
    number: "68,000",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence against a far 负数, a ； and a （一） line that carries on the sentence",
    claim: "准备金为-¥68,000。",
    figure: "-¥68,000",
    language: "zh-CN",
    body: `该准备金全年为负数，${"董事会在每次会议上都对该事项进行审阅，".repeat(22)}并按以下条目记录；\n（一）其列示金额为\n人民币六万八千元（¥68,000）。`,
    quotes: ["人民币六万八千元（¥68,000）。"],
    number: "68,000",
    supported: true,
  },
  {
    name: "a far sign word and a numbered line after “account no.” keep main's minus",
    claim: "The reserve was $68,000.",
    figure: "$68,000",
    language: "en",
    body: `The reserve remained negative throughout ${"the year while the board kept the matter under review ".repeat(8)}as recorded in account no.\n3. It was reported as\nsixty-eight thousand dollars ($68,000.00).`,
    quotes: ["sixty-eight thousand dollars ($68,000.00)."],
    number: "$68,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence against a far sign word and a numbered line after “account no.”",
    claim: "The reserve was -$68,000.",
    figure: "-$68,000",
    language: "en",
    body: `The reserve remained negative throughout ${"the year while the board kept the matter under review ".repeat(8)}as recorded in account no.\n3. It was reported as\nsixty-eight thousand dollars ($68,000.00).`,
    quotes: ["sixty-eight thousand dollars ($68,000.00)."],
    number: "$68,000.00",
    supported: true,
  },
  {
    name: "a far sign word and a numbered line after “cl.” keep main's minus",
    claim: "The reserve was $68,000.",
    figure: "$68,000",
    language: "en",
    body: `The reserve remained negative throughout ${"the year while the board kept the matter under review ".repeat(8)}as set out in cl.\n3. It was reported as\nsixty-eight thousand dollars ($68,000.00).`,
    quotes: ["sixty-eight thousand dollars ($68,000.00)."],
    number: "$68,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence against a far sign word and a numbered line after “cl.”",
    claim: "The reserve was -$68,000.",
    figure: "-$68,000",
    language: "en",
    body: `The reserve remained negative throughout ${"the year while the board kept the matter under review ".repeat(8)}as set out in cl.\n3. It was reported as\nsixty-eight thousand dollars ($68,000.00).`,
    quotes: ["sixty-eight thousand dollars ($68,000.00)."],
    number: "$68,000.00",
    supported: true,
  },
  {
    name: "a quote far into its page with no heading above it keeps main's minus",
    claim: "The rent is $62,000.",
    figure: "$62,000",
    language: "en",
    body: `${"The Tenant shall keep the premises in good repair. ".repeat(12)}The rent is sixty-two thousand dollars ($62,000.00).`,
    quotes: ["The rent is sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a (−) on the line before the quote",
    claim: "The net result was $62,000.",
    figure: "$62,000",
    language: "en",
    body: "Net result (−)\nsixty-two thousand dollars ($62,000.00)",
    quotes: ["sixty-two thousand dollars ($62,000.00)"],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a full-width （−） on the line before a Chinese quote",
    claim: "净利润为¥62,000。",
    figure: "¥62,000",
    language: "zh-CN",
    body: "净利润（−）\n人民币六万二千元（¥62,000）",
    quotes: ["人民币六万二千元（¥62,000）"],
    number: "62,000",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a sign word more than 400 characters before the quote, in an earlier paragraph",
    claim: "The reserve was $62,000.",
    figure: "$62,000",
    language: "en",
    body: `The reserve turned negative in May. ${"The Tenant shall keep the premises in good repair. ".repeat(9)}\n\nAt year end it stood at sixty-two thousand dollars ($62,000.00).`,
    quotes: ["At year end it stood at sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: true,
  },
  {
    name: "a sign word more than 400 characters before the quote, with no break between, keeps main's minus",
    claim: "The reserve was $62,000.",
    figure: "$62,000",
    language: "en",
    body: `The reserve turned negative in May. ${"The Tenant shall keep the premises in good repair. ".repeat(9)}At year end it stood at sixty-two thousand dollars ($62,000.00).`,
    quotes: ["At year end it stood at sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a sign word more than 400 characters after the quote",
    claim: "Cash was $62,000.",
    figure: "$62,000",
    language: "en",
    body: `Cash came to sixty-two thousand dollars ($62,000.00). ${"The Tenant shall keep the premises in good repair. ".repeat(9)}That balance is negative.`,
    quotes: ["Cash came to sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: true,
  },
  {
    name: "a Less label on the line before the quote keeps the minus",
    claim: "The rent is $62,000.",
    figure: "$62,000",
    language: "en",
    body: "Less: deposit paid\nThe rent is sixty-two thousand dollars ($62,000.00).",
    quotes: ["The rent is sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a Less label before a quote whose amount is on its second line keeps the minus",
    claim: "The rent is $62,000.",
    figure: "$62,000",
    language: "en",
    body: "Less: deposit paid\nThe rent is sixty-two thousand dollars ($62,000.00).",
    quotes: ["deposit paid\nThe rent is sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a minus sign on the page right before a quote",
    claim: "Net cash was $62,000.",
    figure: "$62,000",
    language: "en",
    body: "Net cash: −sixty-two thousand dollars ($62,000.00).",
    quotes: ["sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "below zero in the sentence before a quote",
    claim: "The fund's cash was $62,000.",
    figure: "$62,000",
    language: "en",
    body: "The fund's cash dropped below zero in the spring. By year end it was sixty-two thousand dollars ($62,000.00).",
    quotes: ["By year end it was sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a (−) on the line after the quote",
    claim: "Net cash was $62,000.",
    figure: "$62,000",
    language: "en",
    body: "Net cash came to sixty-two thousand dollars ($62,000.00)\nSign: (−)",
    quotes: ["Net cash came to sixty-two thousand dollars ($62,000.00)"],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a negative word starting 400 characters before the quote",
    claim: "The fund's cash was $62,000.",
    figure: "$62,000",
    language: "en",
    body: `The fund turned negative ${"x".repeat(389)}\n\nBy year end it was sixty-two thousand dollars ($62,000.00).`,
    quotes: ["By year end it was sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a negative word starting 401 characters before the quote",
    claim: "The fund's cash was $62,000.",
    figure: "$62,000",
    language: "en",
    body: `The fund turned negative ${"x".repeat(390)}\n\nBy year end it was sixty-two thousand dollars ($62,000.00).`,
    quotes: ["By year end it was sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: true,
  },
  {
    name: "a negative word ending 400 characters after the quote",
    claim: "Cash was $62,000.",
    figure: "$62,000",
    language: "en",
    body: `Cash came to sixty-two thousand dollars ($62,000.00). ${"x".repeat(390)} negative`,
    quotes: ["Cash came to sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a negative word ending 401 characters after the quote",
    claim: "Cash was $62,000.",
    figure: "$62,000",
    language: "en",
    body: `Cash came to sixty-two thousand dollars ($62,000.00). ${"x".repeat(391)} negative`,
    quotes: ["Cash came to sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: true,
  },
  {
    name: "a second year's figure under a two-year header",
    claim: "Revenue in 2024 was $1,200,000.",
    figure: "$1,200,000",
    language: "en",
    body: "Income statement\n 2025 2024\nRevenue $1.2m ($1,200,000)",
    quotes: ["Revenue $1.2m ($1,200,000)"],
    number: "$1,200,000",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the same line with no header of periods",
    claim: "Revenue was $1,200,000.",
    figure: "$1,200,000",
    language: "en",
    body: "Income statement\nRevenue $1.2m ($1,200,000)",
    quotes: ["Revenue $1.2m ($1,200,000)"],
    number: "$1,200,000",
    supported: true,
  },
  {
    name: "a prior period's figure under 本期 上期",
    claim: "上期营业收入为25,000。",
    figure: "25,000",
    language: "zh-CN",
    body: "利润表\n项目 本期 上期\n营业收入 2.5万 （25,000）",
    quotes: ["营业收入 2.5万 （25,000）"],
    number: "25,000",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a net loss's size keeps the minus",
    claim: "The net loss was $62,000.",
    figure: "$62,000",
    language: "en",
    body: "The net loss for the period came to sixty-two thousand dollars ($62,000.00).",
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a 减 label alone on a line above the quote",
    claim: "已付定金为¥62,000。",
    figure: "¥62,000",
    language: "zh-CN",
    body: "现金流量\n减\n已付定金人民币六万二千元（¥62,000）",
    quotes: ["已付定金人民币六万二千元（¥62,000）"],
    number: "62,000",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a second year's figure under full-width years above the quote",
    claim: "Cash at bank in 2024 was $1,200,000.",
    figure: "$1,200,000",
    language: "en",
    body: "Cash flow statement\n２０２５ ２０２４\nCash at bank $1.2m ($1,200,000)",
    quotes: ["Cash at bank $1.2m ($1,200,000)"],
    number: "$1,200,000",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "the signed sentence under full-width years above the quote",
    claim: "Cash at bank in 2024 was -$1,200,000.",
    figure: "-$1,200,000",
    language: "en",
    body: "Cash flow statement\n２０２５ ２０２４\nCash at bank $1.2m ($1,200,000)",
    quotes: ["Cash at bank $1.2m ($1,200,000)"],
    number: "$1,200,000",
    supported: true,
  },
  {
    name: "a far sign word, a cut-off line and a long line above the quote keep main's minus",
    claim: "The reserve was $62,000.",
    figure: "$62,000",
    language: "en",
    body: `The reserve is negative. ${"The Tenant shall keep the premises in good repair. ".repeat(4)}Notes on the reserve follow\n${"The Tenant shall keep the premises in good repair. ".repeat(7)}and the parties agree that\nAt year end it stood at sixty-two thousand dollars ($62,000.00).`,
    quotes: ["At year end it stood at sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a far sign word and a short sentence on its own line above the quote keep main's minus",
    claim: "The reserve was $62,000.",
    figure: "$62,000",
    language: "en",
    body: `The reserve is negative. ${"The Tenant shall keep the premises in good repair. ".repeat(9)}\nPayment is due monthly.\nAt year end it stood at sixty-two thousand dollars ($62,000.00).`,
    quotes: ["At year end it stood at sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "a far sign word and a line too long for a heading above the quote keep main's minus",
    claim: "The reserve was $62,000.",
    figure: "$62,000",
    language: "en",
    body: `The reserve is negative. ${"The Tenant shall keep the premises in good repair. ".repeat(9)}\nSchedule of the payments due under the lease in the second year\nAt year end it stood at sixty-two thousand dollars ($62,000.00).`,
    quotes: ["At year end it stood at sixty-two thousand dollars ($62,000.00)."],
    number: "$62,000.00",
    supported: false,
    verdict: "contradicted",
  },
  {
    name: "English words with an article",
    claim: "The deposit is $160,000.",
    figure: "$160,000",
    language: "en",
    body: "The Tenant shall pay a hundred and sixty thousand dollars ($160,000.00) on signing.",
    number: "$160,000.00",
    supported: true,
  },
] as const)("$name: Supported is $supported (#2341)", async (each) => {
  const { result } = await checkWith({
    claim: each.claim,
    figures: [target("f1", each.figure, each.claim, each.language)],
    body: each.body,
    quotes: "quotes" in each ? each.quotes : undefined,
    text: reply([
      {
        ...item(),
        source: { citation: 1, number: each.number, reading: null, unitQuote: null },
      },
    ]),
  });

  if (each.supported) {
    expect(result.figures?.[0]?.result.verdict).toBe("supported");
    expect(result.verdict).toBe("supported");
  } else {
    expect(result.figures?.[0]?.result.verdict).not.toBe("supported");
    expect(result.verdict).not.toBe("supported");
  }
  if ("verdict" in each) expect(result.verdict).toBe(each.verdict);
});

type Verdicts = { amount: "supported" | "contradicted"; minus: "supported" | "contradicted" };

interface SignProbe {
  id: string;
  shape: string;
  lang: "en" | "zh-CN";
  body: string;
  quote?: string;
  amount: string;
  number: string;
  truth: "pos" | "neg";
  main: Verdicts;
  expected: Verdicts;
}

// Written before it was run (#2341): restatements beside sign words near and far, false sign
// claims, headers of periods and "Less:" lines, each checked with its amount and with its minus.
// Both claims are pinned to the verdict the Check gives, and main's verdicts are kept beside them.
const signProbes = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/figures/bracket-sign-probes.json"), "utf8"),
) as SignProbe[];
const signs = ["amount", "minus"] as const;
const backs = (probe: SignProbe, sign: (typeof signs)[number]) =>
  (probe.truth === "neg") === (sign === "minus");

test.each(signProbes)(
  "$id ($shape): no claim main checks right is checked wrong here (#2341)",
  (probe) => {
    for (const sign of signs) {
      const right = (verdict: string) => (verdict === "supported") === backs(probe, sign);
      if (right(probe.main[sign])) expect(right(probe.expected[sign])).toBe(true);
    }
  },
);

test.each(signProbes.flatMap((probe) => signs.map((sign) => ({ ...probe, sign }))))(
  "$id ($shape), $sign: the Check gives its pinned verdict (#2341)",
  async (probe) => {
    const shown = `${probe.sign === "minus" ? "-" : ""}${probe.amount}`;
    const claim = probe.lang === "zh-CN" ? `金额为${shown}。` : `The amount is ${shown}.`;
    const { result } = await checkWith({
      claim,
      figures: [target("f1", shown, claim, probe.lang)],
      body: probe.body,
      quotes: probe.quote ? [probe.quote] : undefined,
      text: reply([
        {
          ...item(),
          source: { citation: 1, number: probe.number, reading: null, unitQuote: null },
        },
      ]),
    });
    expect(result.verdict).toBe(probe.expected[probe.sign]);
  },
);

// The figure the Check reads its number from is backed only when every formula behind it was
// worked out here and gave the value Excel saved (#2347).
describe.each(["en", "zh-CN"] as const)(
  "%s: a workbook's figure built on a cell IncarnaMind can't work out",
  (language) => {
    test.each([
      { name: "a stale saved value", cell: "Cases!D10", reason: "workbook-differs" },
      { name: "a link to another file", cell: "Cases!D6", reason: "workbook-external" },
      { name: "a value that changes each time", cell: "Cases!D2", reason: "workbook-volatile" },
      { name: "formulas that refer to each other", cell: "Cases!D8", reason: "workbook-circular" },
      { name: "a hidden sheet not read", cell: "Cases!D11", reason: "workbook-not-read" },
      {
        name: "a formula with no saved value",
        cell: "Cases!D9",
        reason: "workbook-no-saved-value",
      },
      { name: "nothing it can't work out", cell: "Cases!D13", reason: null },
    ] as const)("$name: is $reason", async ({ cell, reason }) => {
      const units = (await extractXlsx(new Uint8Array(unsupportedWorkbook().xlsx()))).units;
      const { trace, context, recorded } = workbookPassage(units, language);
      await trace.call({ passage: "P1", cell, label: "Figure" }, context);
      const [figure] = recorded;
      if (!figure) throw new Error(`${cell} wasn't recorded.`);
      const claim =
        language === "en" ? `The figure is ${figure.shown}.` : `该数字为 ${figure.shown}。`;
      const { result } = await checkWith({
        figures: [
          {
            ...target("f1", figure.shown, "Figure", language),
            calculated: { id: "f1", figure, analysisId: null },
          },
        ],
        claim,
        units,
        body: units.map((unit) => unit.text).join("\n"),
        text: reply([{ ...item("f1"), source: null }]),
      });
      if (reason === null) {
        expect(result.figures?.[0]?.result.verdict).toBe("supported");
        expect(result.verdict).toBe("supported");
        return;
      }
      expect(result.figures?.[0]?.result).toMatchObject({ verdict: "not-checked", reason });
      expect(result.verdict).toBe("not-checked");
      expect(translate(language, `claim.reason.${reason}`)).not.toBe(`claim.reason.${reason}`);
    });
  },
);
