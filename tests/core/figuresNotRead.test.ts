/**
 * A text the figure reader gives up on is never read as one that holds no figures (#2510): the
 * sentence is not checked, and its card says in plain words where the figures couldn't be read.
 * No text makes the reader give up since it reads in one pass, so these tests make it give up on
 * any text that holds the word GARBLED, or starts with SCRAMBLED, as it did on a garbled table.
 */
import { expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import { createClaimCheck } from "../../src/core/answers/checks/claimCheck";
import { figuresInMind } from "../../src/core/answers/checks/figureOccurrences";
import { createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import type { CheckFigure, ClaimCheckResult } from "../../src/core/api";
import type { CitationSource } from "../../src/core/documents";
import { resolveCapabilities } from "../../src/core/providers/capabilities";
import type { PreparedChatModel } from "../../src/core/providers/chat";
import { reasonText } from "../../src/renderer/src/cost";
import { readFigures } from "../../src/shared/figures";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { SAME_DETAIL } from "../helpers/checks";
import { type ModelCall, scriptedModel } from "../helpers/models";

vi.mock(import("../../src/shared/figures"), async (importOriginal) => {
  const reader = await importOriginal();
  return {
    ...reader,
    readFigures: (text, context) => {
      if (text.includes("GARBLED") || text.startsWith("SCRAMBLED"))
        throw new reader.FiguresNotRead(text, new RangeError("Maximum call stack size exceeded"));
      return reader.readFigures(text, context);
    },
  };
});

const says = (language: "en" | "zh-CN", result: ClaimCheckResult) => {
  if (result.verdict !== "not-checked") throw new Error(`Checked: ${result.verdict}`);
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  return reasonText(t, language, result.reason, result.detail);
};

const target = (shown: string, offset: number): CheckFigure => {
  const reading = readFigures(shown, { language: "en" })[0];
  if (!reading) throw new Error("Missing target reading");
  return {
    id: "f1",
    locator: {
      kind: "text",
      from: { blockId: "p", offset },
      to: { blockId: "p", offset: offset + shown.length },
    },
    reading,
    calculated: null,
    context: "Revenue in 2024",
    label: "Revenue in 2024",
  };
};

const FIGURES_REPLY = `Verdict: supported\nAbsence: no\n${SAME_DETAIL}\nFigures: ${JSON.stringify({
  items: [
    {
      id: "F1",
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      says: null,
      relation: "equals",
      source: { citation: 1, position: 1, reading: null, unitQuote: null },
      calculation: null,
    },
  ],
  remainder: null,
})}`;

async function check(
  claim: string,
  body: string,
  options: {
    quote?: string;
    calculation?: unknown;
    calls?: ModelCall[];
    /** A second Passage the search finds after the first, in another Document's p. 3. */
    second?: string;
  } = {},
) {
  const model = scriptedModel((call) => {
    options.calls?.push(call);
    if (!call.results.some((result) => result.tool === "search_documents"))
      return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
    if (!call.results.some((result) => result.tool === "cite"))
      return {
        calls: [
          {
            tool: "cite",
            input: {
              citations: [
                { marker: 1, passage: "P1", location: "p. 14", quote: options.quote ?? body },
              ],
            },
          },
        ],
      };
    if (options.calculation && !call.results.some((result) => result.tool === "calculate"))
      return { calls: [{ tool: "calculate", input: { figures: [options.calculation] } }] };
    return { text: FIGURES_REPLY };
  });
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
      catalog: { tools: true, calculates: true, checkCalculates: true, temperature: true },
    }),
  };
  const source: CitationSource = {
    passageId: "passage-1",
    documentId: "document-1",
    documentName: "Annual report",
    documentKind: "pdf",
    contentHash: "hash-1",
    text: body,
    pageFrom: 14,
    pageTo: 14,
    documentDeleted: false,
    notCited: false,
    yourNoteAt: null,
  };
  const second: CitationSource | null =
    options.second === undefined
      ? null
      : {
          ...source,
          passageId: "passage-2",
          documentId: "document-2",
          documentName: "Garbled report",
          contentHash: "hash-2",
          text: options.second,
          pageFrom: 3,
          pageTo: 3,
        };
  const sources = [source, ...(second ? [second] : [])];
  const passages = sources.map((each, index) => ({
    ...each,
    seq: index + 1,
    position: 0,
    windowFrom: 0,
    windowTo: 0,
  }));
  const checkClaim = createClaimCheck({
    language: () => "en",
    walledDocument: () => null,
    walledFolderName: () => null,
    engine: createAiSdkAnswerEngine(),
    evidence: { search: async () => ({ passages, excluded: [] }) },
    documents: {
      searchableCount: () => sources.length,
      searchableLanguages: () => [],
      searchableBySize: () =>
        sources.map((each) => ({ id: each.documentId, name: each.documentName, size: 100 })),
      passagesBetween: (documentId) => passages.filter((each) => each.documentId === documentId),
      savedBySearch: () => false,
      unitCounts: () => new Map(sources.map((each) => [each.documentId, 1])),
      citationSource: (id) => sources.find((each) => each.passageId === id) ?? null,
      pageTexts: (documentId) => {
        const each = sources.find((one) => one.documentId === documentId) ?? source;
        return [{ page: each.pageFrom ?? 1, text: each.text, kind: "page", label: null }];
      },
      documentDate: () => null,
    },
  });
  return checkClaim({
    claim,
    figures: [target("£20", claim.indexOf("£20"))],
    scope: { documentIds: null, excluded: new Map() },
    model: prepared,
    signal: new AbortController().signal,
  });
}

test("a page whose figures the reader gave up on is not checked, and the card names it", async () => {
  const result = await check(
    "Revenue in 2024 was £20.",
    "Revenue in 2024 was £20. GARBLED 1,2.3,4.5,1,2.3,4.5,",
  );
  expect(result.verdict).toBe("not-checked");
  expect(result.figures?.map((figure) => figure.result.verdict)).toEqual(["not-checked"]);
  expect(says("en", result)).toBe("The figures in “Annual report”, p. 14, couldn’t be read.");
  expect(says("zh-CN", result)).toBe("无法读取“Annual report”第 14 页中的数字。");
});

test("a sentence whose own figures the reader gave up on is not checked, and says so", async () => {
  const result = await check(
    "Revenue in 2024 was £20 GARBLED.",
    "Revenue in 2024 was £20. The licence has expired.",
  );
  expect(result.verdict).toBe("not-checked");
  expect(says("en", result)).toBe("The figures in this sentence couldn’t be read.");
  expect(says("zh-CN", result)).toBe("无法读取这句话中的数字。");
});

test("a Note's other paragraphs are still read when the reader gives up on one", () => {
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const blocks = doc.getXmlFragment("blocks");
  const paragraph = (id: string, text: string) =>
    createElement({ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] });
  blocks.insert(0, [
    paragraph("garbled", "The scan reads GARBLED 1,2.3,4.5,1,2.3,4.5,."),
    paragraph("revenue", "Revenue in 2024 was £20."),
  ]);
  expect(
    figuresInMind(blocks).map((figure) => [figure.reading.chars, figure.reading.value]),
  ).toEqual([["£20", 20]]);
});

test("a quote the reader gives up on in a calculation stops the check, unseen by the model", async () => {
  const calls: ModelCall[] = [];
  const result = await check(
    "Revenue in 2024 was £20.",
    "Revenue in 2024 was £20.\nSCRAMBLED 1,2.3,4.5,1,2.3,4.5,",
    {
      quote: "Revenue in 2024 was £20.",
      calls,
      calculation: {
        marker: 1,
        label: "Revenue 2024",
        formula: "rev",
        stated: "£20",
        relation: "equals",
        inputs: [
          {
            name: "rev",
            label: "Revenue 2024",
            passage: "P1",
            location: "p. 14",
            quote: "SCRAMBLED 1,2.3,4.5,",
            number: "1,2",
          },
        ],
      },
    },
  );
  expect(calls.at(-1)?.results.map((each) => each.tool)).toEqual(["search_documents", "cite"]);
  expect(calls.flatMap((call) => call.results).some((each) => each.tool === "calculate")).toBe(
    false,
  );
  expect(says("en", result)).toBe("The figures in “Annual report”, p. 14, couldn’t be read.");
  expect(says("zh-CN", result)).toBe("无法读取“Annual report”第 14 页中的数字。");
});

test("of the Passages a search found, the card names the one whose figures couldn't be read", async () => {
  const result = await check("Revenue in 2024 was £20.", "Revenue in 2024 was £20.", {
    second: "Costs were GARBLED 1,2.3,4.5,1,2.3,4.5,",
  });
  expect(says("en", result)).toBe("The figures in “Garbled report”, p. 3, couldn’t be read.");
  expect(says("zh-CN", result)).toBe("无法读取“Garbled report”第 3 页中的数字。");
});
