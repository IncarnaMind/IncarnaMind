import { getSchema, type JSONContent } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { tableCellFigurePlaces } from "../../src/core/answers/checks/figureOccurrences";
import {
  BLOCK_ID_ATTRIBUTE,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  type MindContentSnapshot,
} from "../../src/core/api";
import { noteFooting } from "../../src/core/figureSchedule";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { createHomeNoteStateReader } from "../../src/renderer/src/homeNoteStates";
import {
  decodeHomeSnapshot,
  homeReading,
  type NoteReading,
  noteStateParts,
} from "../../src/renderer/src/noteState";
import { translate } from "../../src/shared/i18n";
import { sentenceKey, writeMindCheck } from "../../src/shared/mindCheck";
import { writeOpinionSentences } from "../../src/shared/opinions";
import { createTempDataFolder, startCore } from "../helpers/core";

const AT = "2026-10-26T12:00:00.000Z";
const schema = getSchema(noteExtensions());
const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);

function updateFromDoc(content: JSONContent, mutate?: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  try {
    prosemirrorToYXmlFragment(schema.nodeFromJSON(content), doc.getXmlFragment(MIND_CONTENT_FIELD));
    mutate?.(doc);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

function paragraphDoc(text: string, id = "p-1"): Uint8Array {
  return updateFromDoc({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { [BLOCK_ID_ATTRIBUTE]: id },
        content: [{ type: "text", text }],
      },
    ],
  });
}

function checkedAttrs(
  text: string,
  overrides: Partial<ClaimCheckAttributes> = {},
): ClaimCheckAttributes {
  return {
    id: "check-1",
    request: "req-1",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    providerId: null,
    modelId: null,
    text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: true },
    versions: [],
    excluded: [],
    checkedAt: AT,
    ...overrides,
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("createHomeNoteStateReader (#3822)", () => {
  test("(a) calls readMindContents once per Mind per launch and re-evaluates in memory when library or documents arrive", async () => {
    const checkedSentence = "Revenue reached 120 million in 2025.";
    const docId = "doc-walled";
    const contractState = updateFromDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { [BLOCK_ID_ATTRIBUTE]: "p-contract" },
          content: [
            {
              type: "text",
              text: checkedSentence,
              marks: [
                {
                  type: CLAIM_CHECK_MARK,
                  attrs: checkedAttrs(checkedSentence, {
                    versions: [{ documentId: docId, contentHash: "h1" }],
                    evidence: {
                      passageId: "p-1",
                      documentId: docId,
                      documentName: "Annual.pdf",
                      contentHash: "h1",
                      pageFrom: 1,
                      pageTo: 1,
                      location: null,
                      quote: checkedSentence,
                      check: "found",
                      checkReason: null,
                    },
                  }),
                },
              ],
            },
          ],
        },
      ],
    });
    const otherState = paragraphDoc("Spring tides rise highest at full moon.", "p-other");

    const snapshots = new Map<string, MindContentSnapshot>([
      ["contract", { mindId: "contract", state: contractState, cellFigures: [], footing: [] }],
      ["other", { mindId: "other", state: otherState, cellFigures: [], footing: [] }],
    ]);

    const calls: string[][] = [];
    const decodedIds: string[] = [];
    const firstFetch = Promise.withResolvers<void>();

    let latest: ReadonlyMap<string, NoteReading> = new Map();
    const errors: unknown[] = [];
    const reader = createHomeNoteStateReader({
      readMindContents: async (mindIds) => {
        calls.push([...mindIds]);
        if (calls.length === 1) await firstFetch.promise;
        return mindIds.flatMap((id) => {
          const snap = snapshots.get(id);
          return snap ? [snap] : [];
        });
      },
      decode: async (snapshot) => {
        const match = [...snapshots.entries()].find(([, s]) => s === snapshot)?.[0] ?? "unknown";
        decodedIds.push(match);
        return decodeHomeSnapshot(snapshot);
      },
      onChange: (states) => {
        latest = states;
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    const minds = [
      { id: "contract", folderId: null },
      { id: "other", folderId: null },
    ];
    const documents = [{ id: docId, contentHash: "h1" }];

    // 1. Initial launch with library still null (before refreshLibrary finishes).
    reader.sync(minds, { documents, keptCitationTexts: [], library: null });
    expect(calls).toEqual([["contract", "other"]]);

    // 2. Library arrives while Call #1 is STILL in flight: must NOT trigger a 2nd readMindContents.
    const openLibrary = {
      groups: [],
      documentWalls: {},
    };
    reader.sync(minds, { documents, keptCitationTexts: [], library: openLibrary });
    expect(calls).toHaveLength(1);

    // Let Call #1 finish.
    firstFetch.resolve();
    await flush();
    expect(errors).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(decodedIds).toEqual(["contract", "other"]);
    expect(latest.get("contract")?.state?.kind).toBe("checked");
    expect(latest.get("other")?.state?.kind).toBe("not-checked");

    // 3. Library and documents update AFTER Call #1 resolved: still ZERO new readMindContents or decodes,
    //    and in-memory re-evaluation sees the document's contentHash change (requiring a recheck)
    //    and a walled Folder update.
    const walledLibrary = {
      groups: [{ id: "wall", name: "Private", parentId: null, keepInside: true }],
      documentWalls: { [docId]: { wallId: "wall", byUser: true } },
    };
    reader.sync(minds, {
      documents: [{ id: docId, contentHash: "h2" }],
      keptCitationTexts: [],
      library: walledLibrary,
    });
    await flush();
    expect(calls).toHaveLength(1);
    expect(decodedIds).toEqual(["contract", "other"]);
    expect(latest.get("contract")?.health.recheck.length).toBe(1);
    expect(latest.get("contract")?.state?.kind).toBe("not-checked");

    reader.dispose();
  });

  test("(b) mind.update on another Note reads only that Note and never re-reads the long Note", async () => {
    const longState = paragraphDoc(
      "First clause holds true. Second clause holds true. Third clause holds true.",
      "p-long",
    );
    let otherState = paragraphDoc("Initial sentence here.", "p-other");

    const calls: string[][] = [];
    const decodedIds: string[] = [];
    let latest: ReadonlyMap<string, NoteReading> = new Map();

    const reader = createHomeNoteStateReader({
      readMindContents: async (mindIds) => {
        calls.push([...mindIds]);
        return mindIds.map((mindId) => ({
          mindId,
          state: mindId === "long" ? longState : otherState,
          cellFigures: [],
          footing: [],
        }));
      },
      decode: async (snapshot) => {
        decodedIds.push(snapshot.state === longState ? "long" : "other");
        return decodeHomeSnapshot(snapshot);
      },
      onChange: (states) => {
        latest = states;
      },
      onError: (error) => {
        throw error;
      },
    });

    const minds = [
      { id: "long", folderId: null },
      { id: "other", folderId: null },
    ];
    reader.sync(minds, { documents: [], keptCitationTexts: [], library: null });
    await flush();

    expect(calls).toEqual([["long", "other"]]);
    expect(decodedIds).toEqual(["long", "other"]);
    expect(latest.get("long")?.health.toCheck.length).toBe(3);
    expect(latest.get("other")?.health.toCheck.length).toBe(1);

    // Save "other": refresh only "other".
    otherState = paragraphDoc("Updated first sentence. Updated second sentence.", "p-other");
    reader.refresh(["other"]);
    await flush();

    expect(calls).toEqual([["long", "other"], ["other"]]);
    expect(decodedIds).toEqual(["long", "other", "other"]);
    expect(latest.get("long")?.health.toCheck.length).toBe(3);
    expect(latest.get("other")?.health.toCheck.length).toBe(2);

    // A mind.update for a Mind Home does not list causes zero calls.
    reader.refresh(["unlisted"]);
    await flush();
    expect(calls).toHaveLength(2);

    reader.dispose();
  });

  test("state line numbers (checked, not checked yet, skipped, opinion) and table snapshot match before and after", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mind = await core.createMind({ title: "Mixed Note" });

    const supportedText = "Harbour dredging finished in March 2025.";
    const uncheckedText = "Quarterly cargo throughput rose by twelve percent.";
    const skippedText = "See the appendix for definitions.";
    const opinionText = "The design looks cleaner than the previous version.";

    const update = updateFromDoc(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { [BLOCK_ID_ATTRIBUTE]: "b-checked" },
            content: [
              {
                type: "text",
                text: supportedText,
                marks: [{ type: CLAIM_CHECK_MARK, attrs: checkedAttrs(supportedText) }],
              },
            ],
          },
          {
            type: "paragraph",
            attrs: { [BLOCK_ID_ATTRIBUTE]: "b-unchecked" },
            content: [{ type: "text", text: uncheckedText }],
          },
          {
            type: "paragraph",
            attrs: { [BLOCK_ID_ATTRIBUTE]: "b-skipped" },
            content: [{ type: "text", text: skippedText }],
          },
          {
            type: "paragraph",
            attrs: { [BLOCK_ID_ATTRIBUTE]: "b-opinion" },
            content: [{ type: "text", text: opinionText }],
          },
          {
            type: "table",
            attrs: { [BLOCK_ID_ATTRIBUTE]: "t-1" },
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableHeader",
                    content: [
                      {
                        type: "paragraph",
                        attrs: { [BLOCK_ID_ATTRIBUTE]: "h-1" },
                        content: [{ type: "text", text: "Region" }],
                      },
                    ],
                  },
                  {
                    type: "tableHeader",
                    content: [
                      {
                        type: "paragraph",
                        attrs: { [BLOCK_ID_ATTRIBUTE]: "h-2" },
                        content: [{ type: "text", text: "Amount ($m)" }],
                      },
                    ],
                  },
                ],
              },
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    content: [
                      {
                        type: "paragraph",
                        attrs: { [BLOCK_ID_ATTRIBUTE]: "c-1" },
                        content: [{ type: "text", text: "North" }],
                      },
                    ],
                  },
                  {
                    type: "tableCell",
                    content: [
                      {
                        type: "paragraph",
                        attrs: { [BLOCK_ID_ATTRIBUTE]: "c-2" },
                        content: [{ type: "text", text: "100" }],
                      },
                    ],
                  },
                ],
              },
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    content: [
                      {
                        type: "paragraph",
                        attrs: { [BLOCK_ID_ATTRIBUTE]: "c-3" },
                        content: [{ type: "text", text: "South" }],
                      },
                    ],
                  },
                  {
                    type: "tableCell",
                    content: [
                      {
                        type: "paragraph",
                        attrs: { [BLOCK_ID_ATTRIBUTE]: "c-4" },
                        content: [{ type: "text", text: "200" }],
                      },
                    ],
                  },
                ],
              },
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    content: [
                      {
                        type: "paragraph",
                        attrs: { [BLOCK_ID_ATTRIBUTE]: "c-5" },
                        content: [{ type: "text", text: "Total" }],
                      },
                    ],
                  },
                  {
                    type: "tableCell",
                    content: [
                      {
                        type: "paragraph",
                        attrs: { [BLOCK_ID_ATTRIBUTE]: "c-6" },
                        content: [{ type: "text", text: "300" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      (doc) => {
        writeMindCheck(doc.getMap(MIND_SETTINGS_FIELD), {
          at: AT,
          sentences: 4,
          stop: null,
          skipped: [sentenceKey(skippedText)],
          unexamined: [],
        });
        writeOpinionSentences(doc, [
          {
            id: "op-1",
            blockId: "b-opinion",
            text: opinionText,
            occurrence: 0,
            parts: [
              {
                kind: "opinion",
                span: { start: 0, end: opinionText.length },
                verdict: null,
                reason: null,
                detail: null,
                evidence: [],
                says: null,
                unsupported: null,
                calculation: null,
                versions: [],
                excluded: [],
                citedCaseUnchecked: false,
                citedCaseFound: false,
              },
            ],
          },
        ]);
      },
    );

    await core.applyMindUpdate(mind.id, update);
    await core.closeMind(mind.id);

    const [snapshot] = await core.readMindContents([mind.id]);
    expect(snapshot).toBeDefined();
    if (!snapshot) return;

    // Compare against the direct synchronous baseline on the same Y.Doc.
    const baselineDoc = new Y.Doc();
    try {
      Y.applyUpdate(baselineDoc, snapshot.state);
      const frag = baselineDoc.getXmlFragment(MIND_CONTENT_FIELD);
      const expectedCells = tableCellFigurePlaces(frag);
      const expectedFooting = [
        ...noteFooting(frag, { versions: new Map(), folderId: null, scope: null }),
      ].map(([id, live]) => ({ id, ...live }));
      expect(snapshot.cellFigures).toEqual(expectedCells);
      expect(snapshot.footing).toEqual(expectedFooting);
      expect(snapshot.cellFigures.length).toBeGreaterThan(0);
    } finally {
      baselineDoc.destroy();
    }

    const ctx = {
      documents: [],
      keptCitationTexts: [],
      library: null,
      folderId: null,
    };
    const syncReading = homeReading(snapshot, ctx);
    const decoded = await decodeHomeSnapshot(snapshot);
    try {
      const asyncReading = await decoded.read(ctx);
      expect(asyncReading.health).toEqual(syncReading.health);
      expect(asyncReading.state).toEqual(syncReading.state);
      expect([...asyncReading.filedAnswers]).toEqual([...syncReading.filedAnswers]);

      // Verify the state line carries all categories accurately (1 supported, 1 unchecked paragraph + table cells, 1 skipped and 1 opinion omitted from checkable).
      expect(asyncReading.health.supported).toBe(1);
      expect(asyncReading.health.toCheck.length).toBeGreaterThanOrEqual(1);
      expect(asyncReading.health.checkable).toBe(
        asyncReading.health.supported + asyncReading.health.toCheck.length,
      );
      // Skipped and omitted-opinion sentences do not inflate toCheck or checkable.
      expect(asyncReading.health.toCheck.length - asyncReading.health.tableCells.length).toBe(1);
      expect(asyncReading.state).not.toBeNull();
      if (asyncReading.state && syncReading.state) {
        const now = new Date(AT);
        expect(noteStateParts(asyncReading.state, t, "en", now)).toEqual(
          noteStateParts(syncReading.state, t, "en", now),
        );
      }
    } finally {
      decoded.dispose();
    }
  });

  test("(e) decodeHomeSnapshot yields on long Notes (>100 KB) and matches homeReading", async () => {
    const blocks: JSONContent[] = [];
    for (let i = 0; i < 400; i++) {
      blocks.push({
        type: "paragraph",
        attrs: { [BLOCK_ID_ATTRIBUTE]: `long-${i}` },
        content: [
          {
            type: "text",
            text: `Clause ${i + 1}: The Supplier shall deliver the Services in accordance with the agreed timetable and quality standards. Fees are invoiced monthly in arrears and payable within thirty days of receipt.`,
          },
        ],
      });
    }
    const state = updateFromDoc({ type: "doc", content: blocks });
    expect(state.byteLength).toBeGreaterThan(100_000);

    const snapshot = { state, cellFigures: [], footing: [] };
    const ctx = { documents: [], keptCitationTexts: [], library: null, folderId: null };
    let yields = 0;
    const yieldTurn = async () => {
      yields++;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };

    const decoded = await decodeHomeSnapshot(snapshot, yieldTurn);
    try {
      const asyncReading = await decoded.read(ctx, yieldTurn);
      const syncReading = homeReading(snapshot, ctx);
      expect(yields).toBeGreaterThanOrEqual(3);
      expect(asyncReading.health).toEqual(syncReading.health);
      expect(asyncReading.state).toEqual(syncReading.state);
      expect(asyncReading.health.toCheck.length).toBe(800);
    } finally {
      decoded.dispose();
    }
  });
});
