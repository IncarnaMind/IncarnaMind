import { getSchema, type JSONContent } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { createCalculationSession } from "../../src/core/answers/calculations";
import { tableCellFigurePlaces } from "../../src/core/answers/checks/figureOccurrences";
import { figuresNow } from "../../src/core/answers/checks/sentences";
import { createCitationSession } from "../../src/core/answers/citations";
import { CLAIM_CHECK_MARK, MIND_CONTENT_FIELD } from "../../src/core/api";
import { textBlocks } from "../../src/core/proposals/write";
import { claimsOf, figurePlacesOf } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { readNoteState } from "../../src/renderer/src/noteState";
import { setUpWithDocuments } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";

/*
 * One rule for a table's cells (#1459): a number's unit cell is its own row's, and a cell's old
 * whole-sentence verdict is checked again however deep the cell holds its number, as the editor,
 * Home and Check this Mind all read it.
 */

const LANGUAGES = [
  {
    language: "en" as const,
    unit: "thousand tonnes",
    scale: 1000,
    revenue: "Revenue",
    people: "People",
    item: "Item",
    amount: "Amount",
  },
  {
    language: "zh-CN" as const,
    unit: "万元",
    scale: 10_000,
    revenue: "收入",
    people: "人数",
    item: "项目",
    amount: "金额",
  },
];

describe("a quoted row's unit cell", () => {
  // protects=a unit cell states only its own row's unit: a headcount quoted under a row in thousand tonnes is never read as 7,000 tonnes, while the row's own 100 still is 100,000 (Codex2's review of #2132), in English and Chinese; fails_when=another row's unit scales the 7; no_claim=how the model is asked for a unit line.
  test.each(LANGUAGES)(
    "is never another row's ($language)",
    ({ language, unit, scale, revenue, people }) => {
      const body = `Item\tValue\tUnit\n${revenue}\t100\t${unit}\n${people}\t7\t`;
      const source = {
        passageId: "passage-1",
        documentId: "document-1",
        documentName: "Facts.pdf",
        documentKind: "pdf" as const,
        contentHash: "hash-1",
        text: body,
        pageFrom: 1,
        pageTo: 1,
        documentDeleted: false,
        notCited: false,
      };
      const shown = { ...source, seq: 1, position: 0, windowFrom: 0, windowTo: 0 };
      const documents = {
        searchableCount: () => 1,
        search: async () => [shown],
        citationSource: (id: string) => (id === source.passageId ? source : null),
        pageTexts: () => [{ page: 1, text: body, kind: "page" as const, label: null }],
        documentDate: () => null,
      };
      const quotes = createCitationSession(documents, { onRecord: () => undefined });
      quotes.show([shown]);
      const calculations = createCalculationSession({ documents, quotes: quotes.quotes, language });
      const read = (number: string) =>
        calculations.number({ name: "n", passage: "P1", location: "p. 1", quote: body, number });

      expect(read("100")).toMatchObject({ input: { number: { value: 100 * scale } } });
      expect(read("7")).not.toMatchObject({ input: { number: { value: 7 * scale } } });
    },
  );
});

/** A table whose numeric cell holds an old whole-sentence Supported mark: directly, or in a list in the cell. */
function legacyTable(words: (typeof LANGUAGES)[number], nested: boolean) {
  const schema = getSchema(noteExtensions());
  const old = {
    id: "legacy",
    request: "old",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    providerId: "provider",
    modelId: "model",
    text: "100",
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: true },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-20T12:46:23.507Z",
  };
  const value: JSONContent = {
    type: "paragraph",
    attrs: { id: "value" },
    content: [{ type: "text", text: "100", marks: [{ type: CLAIM_CHECK_MARK, attrs: old }] }],
  };
  const cell = (type: string, id: string, text: string): JSONContent => ({
    type,
    attrs: { colspan: 1, rowspan: 1 },
    content: [{ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] }],
  });
  const root = schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "table",
        attrs: { id: "table" },
        content: [
          {
            type: "tableRow",
            content: [
              cell("tableHeader", "label-head", words.item),
              cell("tableHeader", "amount-head", words.amount),
            ],
          },
          {
            type: "tableRow",
            content: [
              cell("tableCell", "label", words.revenue),
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1 },
                content: nested
                  ? [{ type: "bulletList", content: [{ type: "listItem", content: [value] }] }]
                  : [value],
              },
            ],
          },
        ],
      },
    ],
  });
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(MIND_CONTENT_FIELD));
  return { doc, root };
}

describe("an old verdict on a numeric table cell", () => {
  // protects=Home, Recent and the export menu read a numeric cell's old whole-sentence verdict as needing a check again, as the editor does, from the same places the core reads (Codex2's review of #2132), in English and Chinese, with the number directly in the cell or in a list there; fails_when=Home says Checked where the editor says Needs re-check; no_claim=the editor's own figure schedule.
  test.each(LANGUAGES.flatMap((words) => [false, true].map((nested) => ({ ...words, nested }))))(
    "needs a check again in the editor and on Home alike ($language, nested $nested)",
    ({ nested, ...words }) => {
      const { doc, root } = legacyTable(words, nested);
      const cellFigures = tableCellFigurePlaces(doc.getXmlFragment(MIND_CONTENT_FIELD));
      expect(cellFigures).toHaveLength(1);
      const context = { versions: new Map(), folderId: null, scope: null };
      const editor = claimsOf(root, { ...context, figurePlaces: figurePlacesOf(cellFigures) });
      expect(editor.claims[0]?.shown).toEqual({ state: "needs-recheck", why: "figures" });
      const home = readNoteState({
        doc,
        cellFigures,
        documents: [],
        keptCitationTexts: [],
        folderId: null,
      });
      expect(home.state).toMatchObject({ kind: "not-checked", mark: "recheck" });
    },
  );

  // protects=the core's own rule finds a cell however deep the cell holds its number, as its figure reader places it (Codex2's review of #2132), in English and Chinese; fails_when=a number in a list in a cell isn't the cell's; no_claim=none beyond protects.
  test.each(LANGUAGES)("is a cell's in a list in the cell too ($language)", (words) => {
    const { doc } = legacyTable(words, true);
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    const element = textBlocks(blocks).find(
      ({ element: each }) => each.getAttribute("id") === "value",
    )?.element;
    if (!element) throw new Error("No value paragraph");
    expect(figuresNow(blocks).figured({ element, from: 0, to: 3 })).toBe(true);
  });

  // protects=Check this Mind's changed mode plans a check again for an old verdict on a numeric cell, directly in the cell or in a list there (Codex2's review of #2132), in English and Chinese; fails_when=the nested cell's plan says nothing changed; no_claim=the check's result.
  test.each(LANGUAGES)(
    "is planned for a check again by Check this Mind ($language)",
    async (words) => {
      const { core } = await setUpWithDocuments(
        scriptedModel(() => ({ text: "No model call is needed." })),
        [{ name: "Facts.txt", contents: `${words.revenue} 90.` }],
      );
      for (const nested of [false, true]) {
        const { root } = legacyTable(words, nested);
        const mind = await core.createMind({ title: `Legacy ${nested}` });
        const client = await connectToMind(core, mind.id);
        writeMind(client, root.toJSON().content);
        await client.settled();
        expect(await core.planMindCheck(mind.id, "changed")).toMatchObject({
          kind: "ready",
          sentences: 1,
        });
      }
    },
  );
});
