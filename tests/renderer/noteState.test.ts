import { getSchema, type JSONContent } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { CITATION_NODE, MIND_CONTENT_FIELD, MIND_SETTINGS_FIELD } from "../../src/core/api";
import { messageReference } from "../../src/core/references";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { noteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { readNoteState } from "../../src/renderer/src/noteState";
import { setOrigins } from "../../src/shared/blockOrigins";
import { citationState } from "../../src/shared/citations";
import { sentenceKey, writeMindCheck } from "../../src/shared/mindCheck";
import { checked } from "../helpers/claimChecks";

const schema = getSchema(noteExtensions());
const paragraph = (words: string, id?: string): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text: words }],
});
const source = (content: JSONContent[]) => {
  const doc = new Y.Doc();
  const root = schema.nodeFromJSON({ type: "doc", content });
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(MIND_CONTENT_FIELD));
  return { doc, root };
};

describe("the shared note reader", () => {
  test.each([
    ["Revenue grew 12%.", "Costs grew 5%.", "Thanks!"],
    ["本季度收入增长了 12%。", "本季度成本增长了 5%。", "谢谢！"],
  ])("matches the badge for mixed text and table claims: %s", (words, tableWords, skipped) => {
    const kept = "Online sales grew 12% in the quarter.";
    const { doc, root } = source([
      paragraph(words, "answer"),
      {
        type: "paragraph",
        attrs: { id: "kept" },
        content: [checked(kept, "unsupported", null, { kept: true })],
      },
      paragraph(kept, "duplicate"),
      paragraph(skipped, "skipped"),
      {
        type: "table",
        content: [
          { type: "tableRow", content: [{ type: "tableCell", content: [paragraph(tableWords)] }] },
        ],
      },
      {
        ...paragraph(words, "proposal"),
        attrs: { id: "proposal", proposal: { id: "p", request: "r", kind: "insert" } },
      },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: words }] },
    ]);
    setOrigins(doc, ["answer"], {
      from: messageReference("conversation", "answer-1"),
      question: "How did it go?",
    });
    writeMindCheck(doc.getMap(MIND_SETTINGS_FIELD), {
      at: "2026-10-12T09:00:00.000Z",
      sentences: 1,
      stop: null,
      skipped: [sentenceKey(skipped)],
    });
    const { claims, kept: spans } = claimsOf(root, {
      versions: new Map(),
      folderId: null,
      scope: null,
    });
    const expected = noteHealth(root, {
      claims,
      kept: spans,
      skipped: new Set([sentenceKey(skipped)]),
      citationCheck: (attrs) => citationState(attrs, [], []).check,
      writtenByAnswer: (id) => id === "answer",
    });
    const state = readNoteState({ doc, documents: [], keptCitationTexts: [], folderId: null });
    expect(state.health).toEqual(expected);
    expect(state.health.toCheck).toHaveLength(3);
    expect(state.health.tableCells).toHaveLength(1);
    expect(state.filedAnswers).toEqual(new Set(["answer-1"]));
    doc.destroy();
  });

  test("counts live Citation failures and ignores a deleted block's retained origin", () => {
    const { doc } = source([
      {
        type: "paragraph",
        attrs: { id: "live" },
        content: [
          { type: "text", text: "Spring tides come at full moon " },
          {
            type: CITATION_NODE,
            attrs: {
              documentId: "results",
              contentHash: "version",
              documentName: "Tides",
              quote: "full moon",
              check: "not-found",
            },
          },
          { type: "text", text: "." },
        ],
      },
    ]);
    setOrigins(doc, ["deleted"], {
      from: messageReference("conversation", "deleted-answer"),
      question: "Old question",
    });
    const state = readNoteState({
      doc,
      documents: [{ id: "results", contentHash: "version" }],
      keptCitationTexts: [],
      folderId: null,
    });
    expect(state.health.notFound).toHaveLength(1);
    expect(state.filedAnswers.size).toBe(0);
    doc.destroy();
  });
});
