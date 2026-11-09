/**
 * The check of one sentence holds its own gates to Supported (#2898). A sentence's parts are put
 * together with gates of their own, so a check without one of these still read right through the
 * core: these check one sentence alone.
 */
import { describe, expect, test } from "vitest";
import { createClaimCheck } from "../../src/core/answers/checks/claimCheck";
import { createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import type { CitationSource } from "../../src/core/documents";
import type { PageText } from "../../src/core/documents/passages";
import { resolveCapabilities } from "../../src/core/providers/capabilities";
import { checkGenerate, checkingModel, SAME_DETAIL, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { type ScriptedReply, scriptedModel } from "../helpers/models";

type Model = ReturnType<typeof scriptedModel>;

/** `claim` checked alone against one Document of one page, `page`, by `model`. */
function checked(claim: string, model: Model, page: PageText) {
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
