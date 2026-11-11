/**
 * The check of one sentence holds its own gates to Supported (#2898). A sentence's parts are put
 * together with gates of their own, so a check without one of these still read right through the
 * core: these check one sentence alone.
 */
import { describe, expect, test } from "vitest";
import { createClaimCheck } from "../../src/core/answers/checks/claimCheck";
import { createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import type { CheckFigure } from "../../src/core/api";
import type { CitationSource } from "../../src/core/documents";
import type { PageText } from "../../src/core/documents/passages";
import { resolveCapabilities } from "../../src/core/providers/capabilities";
import { readFigures } from "../../src/shared/figures";
import {
  checkGenerate,
  checkingModel,
  requestedFigures,
  SAME_DETAIL,
  sentenceOf,
} from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import {
  type GenerateCall,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
} from "../helpers/models";

type Model = ReturnType<typeof scriptedModel>;

/** `claim` checked alone against one Document of one page, `page`, by `model`, with its `figures`. */
function checked(claim: string, model: Model, page: PageText, figures?: readonly CheckFigure[]) {
  const source: CitationSource = {
    passageId: "passage-1",
    documentId: "document-1",
    documentName: "Board update",
    documentKind: "pdf",
    contentHash: "hash-1",
    text: page.text,
    pageFrom: 1,
    pageTo: 1,
    documentDeleted: false,
    notCited: false,
    yourNoteAt: null,
  };
  const passage = { ...source, seq: 1, position: 0, windowFrom: 0, windowTo: 0 };
  const check = createClaimCheck({
    language: () => "en",
    walledDocument: () => null,
    walledFolderName: () => null,
    engine: createAiSdkAnswerEngine(),
    evidence: { search: async () => ({ passages: [passage], excluded: [] }) },
    documents: {
      searchableCount: () => 1,
      searchableLanguages: () => [],
      searchableBySize: () => [{ id: "document-1", name: "Board update", size: page.text.length }],
      passagesBetween: () => [passage],
      savedBySearch: () => false,
      unitCounts: () => new Map([["document-1", 1]]),
      citationSource: (id) => (id === source.passageId ? source : null),
      pageTexts: () => [page],
      documentDate: () => null,
    },
  });
  return check({
    claim,
    ...(figures && { figures }),
    scope: { documentIds: null, excluded: new Map() },
    model: {
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
        catalog: { tools: true, calculates: true, checkCalculates: true, temperature: true },
      }),
    },
    signal: new AbortController().signal,
  });
}

const page = (text: string, unsure?: [number, number][]): PageText => ({
  page: 1,
  text,
  kind: "page",
  label: unsure ? { scan: { reader: "test", unsure } } : null,
});

const searched = (call: ModelCall) =>
  call.results.filter((result) => result.tool === "search_documents");

describe("A quantified sentence's own check (#2898)", () => {
  const CLAIM = "All stores passed the inspection.";
  const NORTH = "North passed the inspection.";
  const NETWORK = "North and South are the complete store network.";

  /** A model that cites both lines and replies with `reply`. */
  const citing = (reply: string) =>
    scriptedModel(
      (call): ScriptedReply => {
        const searches = call.results.filter((result) => result.tool === "search_documents");
        if (searches.length === 0)
          return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
        if (!call.results.some((result) => result.tool === "cite")) {
          const [shown] = searches.flatMap((result) => shownPassages(result.text));
          const citations = [NORTH, NETWORK].map((quote, index) => ({
            marker: index + 1,
            passage: shown?.id,
            quote,
          }));
          return { calls: [{ tool: "cite", input: { citations } }] };
        }
        return { text: reply };
      },
      { generate: checkGenerate({}) },
    );

  /** A Supported reply that names its members on its Coverage line. */
  const reply = (complete: boolean, south: "supported" | "unsupported") =>
    [
      "Verdict: supported",
      "Absence: no",
      "Topic: found",
      SAME_DETAIL,
      "Evidence: [1, 2]",
      `Coverage: ${JSON.stringify({
        unit: "stores",
        quantifier: "all",
        complete,
        members: [
          { label: "North", verdict: "supported", evidence: [1] },
          { label: "South", verdict: south, evidence: south === "supported" ? [2] : [] },
        ],
        domainEvidence: [2],
      })}`,
      "Calculation: none",
    ].join("\n");

  // protects=a Supported reply whose Coverage line doesn't back every member of the whole set is Unsupported in the check itself; fails_when=the check takes the reply's verdict over its coverage; no_claim=how a sentence's parts are put together, which holds it too.
  test.each([
    ["its members aren't the whole set", false, "supported"],
    ["a member of the whole set isn't backed", true, "unsupported"],
  ] as const)("is not Supported when %s", async (_, complete, south) => {
    const result = await checked(
      CLAIM,
      citing(reply(complete, south)),
      page(`${NORTH} ${NETWORK}`),
    );
    expect(result.verdict).toBe("unsupported");
    expect(result.coverage?.members.map((member) => [member.label, member.verdict])).toEqual([
      ["North", "supported"],
      ["South", south],
    ]);
  });

  // protects=the same reply with every member of the whole set backed is Supported, so the cases above turn on coverage alone; fails_when=the harness can't reach Supported; no_claim=none beyond protects.
  test("is Supported when every member of the whole set is backed", async () => {
    const result = await checked(
      CLAIM,
      citing(reply(true, "supported")),
      page(`${NORTH} ${NETWORK}`),
    );
    expect(result.verdict).toBe("supported");
  });
});

describe("A sentence's own check of a figure worked out (#2898)", () => {
  const CLAIM = "Net debt and EBITDA come to £2,176m.";
  const BOARD = "Net debt was £1,234m at the end of 2025. EBITDA was £942m in 2025.";
  const plans = {
    [CLAIM]: {
      verdict: "supported",
      calculation: {
        inputs: [
          { name: "nd", label: "Net debt 2025", quote: "Net debt was £1,234m", number: "£1,234m" },
          { name: "e", label: "EBITDA 2025", quote: "EBITDA was £942m", number: "£942m" },
        ],
        formula: "nd + e",
        stated: "£2,176m",
      },
    },
  } as const;

  // protects=a calculation that agrees backs Supported only when every input's quote is found; fails_when=an input whose quote the check can't confirm, as a scan's unsure word, backs the sentence; no_claim=how the Note shows the input, which its own Calculation check decides.
  test("an input whose quote holds a word the scan was unsure of backs nothing", async () => {
    const at = BOARD.indexOf("EBITDA");
    const result = await checked(
      CLAIM,
      checkingModel(plans),
      page(BOARD, [[at, at + "EBITDA".length]]),
    );
    expect(result.verdict).not.toBe("supported");
  });

  // protects=the same calculation from a clean page is Supported, so the case above turns on the input's quote alone; fails_when=the harness can't reach Supported; no_claim=none beyond protects.
  test("the same calculation from a clean page is Supported", async () => {
    const result = await checked(CLAIM, checkingModel(plans), page(BOARD));
    expect(result).toMatchObject({ verdict: "supported", calculation: { agrees: true } });
  });
});

describe("A sentence's own check with a calculation left pending (#2898)", () => {
  const CLAIM = "Net debt and EBITDA come to £2,300m, and capex was £50m.";
  const BOARD = "Net debt was £1,234m at the end of 2025. EBITDA was £942m in 2025.";
  /** An input on a Citation never recorded, so `calculate` works nothing out for its figure. */
  const PENDING = [{ name: "c", label: "Capex 2025", citation: 7, number: "£50m" }];
  const reply = (...lines: string[]) =>
    [
      lines[0],
      "Absence: no",
      "Topic: found",
      ...lines.slice(1),
      SAME_DETAIL,
      "Evidence: []",
      "Calculation: £2,300m",
    ].join("\n");

  /** Searches, calls `calculate` once for the sum (£2,176m against £2,300m) and for capex, then replies `text`. */
  const calculating = (text: string, capex: (passage: string | undefined) => unknown[]) =>
    scriptedModel(
      (call): ScriptedReply => {
        const searches = searched(call);
        if (searches.length === 0)
          return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
        if (call.results.some((result) => result.tool === "calculate")) return { text };
        const [shown] = searches.flatMap((result) => shownPassages(result.text));
        const figures = [
          {
            marker: 1,
            label: "Net debt and EBITDA",
            relation: "equals",
            formula: "nd + e",
            stated: "£2,300m",
            inputs: [
              {
                name: "nd",
                label: "Net debt 2025",
                quote: "Net debt was £1,234m",
                number: "£1,234m",
                passage: shown?.id,
              },
              {
                name: "e",
                label: "EBITDA 2025",
                quote: "EBITDA was £942m",
                number: "£942m",
                passage: shown?.id,
              },
            ],
          },
          {
            marker: 2,
            label: "Capex",
            relation: "equals",
            formula: "c",
            stated: "£50m",
            inputs: capex(shown?.id),
          },
        ];
        return { calls: [{ tool: "calculate", input: { figures } }] };
      },
      { generate: checkGenerate({}) },
    );

  // protects=while one of a sentence's calculations is still pending, a figure that disagrees neither contradicts the sentence nor lets it read as someone else's: it is Not checked; fails_when=the check decides on the calculations worked out so far; no_claim=what each figure's own mark shows.
  test.each([
    ["a figure that disagrees doesn't contradict it", ["Verdict: contradicted"]],
    [
      "nor is it Unsupported as someone else's sentence",
      [
        "Verdict: unsupported",
        "Roles: the Group / another company, other",
        "The Passage is about another company.",
      ],
    ],
  ] as const)("%s", async (_, lines) => {
    const result = await checked(
      CLAIM,
      calculating(reply(...lines), () => PENDING),
      page(BOARD),
    );
    expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
  });

  // protects=with both calculations worked out, the one that disagrees contradicts the sentence, so the cases above turn on the pending one alone; fails_when=the harness can't reach Contradicted; no_claim=none beyond protects.
  test("with every calculation worked out, the one that disagrees contradicts it", async () => {
    const result = await checked(
      CLAIM,
      calculating(reply("Verdict: contradicted"), (passage) => [
        { name: "c", label: "Capex 2025", quote: "Capex was £50m", number: "£50m", passage },
      ]),
      page(`${BOARD} Capex was £50m in 2025.`),
    );
    expect(result).toMatchObject({ verdict: "contradicted", calculation: { agrees: false } });
  });
});

describe("A sentence's own check of quotes given only after its verdict (#2898)", () => {
  const CLAIM = "Pell Logistics opened a depot in Derby.";
  const STATES = "Pell Logistics opened a depot in Derby in May 2026.";
  const AGAIN = "In May, Pell Logistics opened a depot in Derby, its third in the Midlands.";
  const STRAY = "The office is closed on public holidays.";
  const PAGE = `${AGAIN} ${STATES} ${STRAY}`;
  const REPLY = [
    "Verdict: supported",
    "Absence: no",
    "Scope: none, same",
    "Topic: found",
    `Roles: ${CLAIM} / ${STATES}, same`,
    SAME_DETAIL,
    "The Documents establish this.",
    "Evidence: [1, 2]",
    "Calculation: none",
  ].join("\n");

  /**
   * Replies Supported naming [1] and [2] with neither recorded, then gives `first` and `second`
   * when asked for them. Its strict judge finds the holiday line alone says nothing of the
   * sentence, and any other quote, or several together, the same as it.
   */
  const recordingLate = (first: string, second: string) => {
    const fallback = checkGenerate({});
    return scriptedModel(
      (call): ScriptedReply =>
        searched(call).length === 0
          ? { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] }
          : { text: REPLY },
      {
        generate(call: GenerateCall) {
          if (call.question === "evidence") {
            const passage = /<passage id="([^"]+)">/.exec(call.prompt)?.[1];
            const citations = [first, second].map((quote, index) => ({
              marker: index + 1,
              passage,
              location: null,
              quote,
            }));
            return { text: JSON.stringify({ citations }) };
          }
          if (call.question === "strict") {
            const quote = /<quote>\n([\s\S]*?)\n<\/quote>/.exec(call.prompt)?.[1] ?? "";
            return { text: quote.trim() === STRAY ? "neither" : "same" };
          }
          return fallback(call);
        },
      },
    );
  };

  // protects=each quote given after the verdict is judged on its own, so one that says nothing of the sentence leaves it Not checked and is never shown as evidence (#2816); fails_when=the late quotes are judged in one look and the one that states the sentence carries the other through; no_claim=a late quote beside a recorded one, which the claim-check tests cover.
  test("an unrelated one is not carried through by one that states the sentence", async () => {
    const result = await checked(CLAIM, recordingLate(STATES, STRAY), page(PAGE));
    expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
    expect(result.checkedEvidence).toBeUndefined();
  });

  // protects=two late quotes that each state the sentence back it, so the case above turns on the unrelated quote alone; fails_when=the harness can't reach Supported; no_claim=none beyond protects.
  test("two that each state the sentence back it", async () => {
    const result = await checked(CLAIM, recordingLate(STATES, AGAIN), page(PAGE));
    expect(result.verdict).toBe("supported");
    expect(result.checkedEvidence?.map((citation) => citation.quote)).toEqual([STATES, AGAIN]);
  });
});

describe("A sentence's own check of a figure resting on a calculation (#2898)", () => {
  const CLAIM = "Revenue was £20 and the licence is valid.";
  const ACCOUNTS = "Revenue in 2024 was £20; revenue in 2025 was £21. The licence has expired.";
  const QUOTE = "Revenue in 2024 was £20";
  const [reading] = readFigures("£20", { language: "en" });
  if (!reading) throw new Error("Missing fixture reading");
  const FIGURES: CheckFigure[] = [
    {
      id: "f1",
      locator: {
        kind: "text",
        from: { blockId: "f1", offset: 0 },
        to: { blockId: "f1", offset: "£20".length },
      },
      reading,
      calculated: null,
      context: "Revenue in 2024",
      label: "Revenue in 2024",
    },
  ];

  /**
   * Records the quote as [^1], calls `calculate` with its one input on Citation `citation`, then
   * replies that the figure is Unsupported, resting on that calculation.
   */
  const restingOn = (citation: number) =>
    scriptedModel(
      (call): ScriptedReply => {
        const searches = searched(call);
        if (searches.length === 0)
          return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
        const [shown] = searches.flatMap((result) => shownPassages(result.text));
        if (!call.results.some((result) => result.tool === "cite")) {
          const citations = [{ marker: 1, passage: shown?.id, location: "p. 1", quote: QUOTE }];
          return { calls: [{ tool: "cite", input: { citations } }] };
        }
        if (!call.results.some((result) => result.tool === "calculate")) {
          const figures = [
            {
              marker: 1,
              label: "Revenue 2024",
              relation: "equals",
              formula: "r",
              stated: "£20",
              inputs: [{ name: "r", citation, number: "£20" }],
            },
          ];
          return { calls: [{ tool: "calculate", input: { figures } }] };
        }
        const items = requestedFigures(call).map(({ id }) => ({
          id,
          verdict: "unsupported",
          scope: "same",
          topic: "not found",
          roles: "same",
          says: null,
          relation: "equals",
          source: null,
          calculation: 1,
        }));
        return {
          text: `Verdict: supported\nAbsence: no\n${SAME_DETAIL}\nFigures: ${JSON.stringify({ items, remainder: null })}`,
        };
      },
      { generate: checkGenerate({}) },
    );

  // protects=a figure's verdict that rests on a calculation never worked out, its input on a Citation never recorded, leaves the sentence and the figure Not checked (#2719); fails_when=the reply's verdict for the figure is taken with nothing worked out behind it; no_claim=a calculation whose inputs are found, which the figure-check tests cover.
  test("is Not checked when that calculation was never worked out", async () => {
    const result = await checked(CLAIM, restingOn(9), page(ACCOUNTS), FIGURES);
    expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
    expect(result.figures?.map((figure) => figure.result.verdict)).toEqual(["not-checked"]);
  });

  // protects=the same reply with its calculation worked out is decided, so the case above turns on the missing calculation alone; fails_when=the harness can't reach a verdict; no_claim=none beyond protects.
  test("the same reply with the calculation worked out is decided", async () => {
    const result = await checked(CLAIM, restingOn(1), page(ACCOUNTS), FIGURES);
    expect(result.verdict).toBe("unsupported");
    expect(result.figures?.map((figure) => figure.result.verdict)).toEqual(["unsupported"]);
  });
});
