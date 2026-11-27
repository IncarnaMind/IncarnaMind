import { getSchema, type JSONContent } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { tableCellFigurePlaces } from "../../src/core/answers/checks/figureOccurrences";
import {
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  type MindContentSnapshot,
} from "../../src/core/api";
import { noteFooting, readTableSnapshot } from "../../src/core/figureSchedule";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  createHomeNoteStateReader,
  type HomeSharedContext,
} from "../../src/renderer/src/homeNoteStates";
import {
  decodeHomeSnapshot,
  homeReading,
  type NoteReading,
  noteStateParts,
} from "../../src/renderer/src/noteState";
import { translate } from "../../src/shared/i18n";
import { sentenceKey, writeMindCheck } from "../../src/shared/mindCheck";
import { writeOpinionSentences } from "../../src/shared/opinions";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";

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

  test("moving another Note does not cancel an in-flight per-Note re-evaluation", async () => {
    const docId = "doc-wall";
    const sentence = "Harbour depth stayed at twelve metres.";
    const state = updateFromDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { [BLOCK_ID_ATTRIBUTE]: "p-a" },
          content: [
            {
              type: "text",
              text: sentence,
              marks: [
                {
                  type: CLAIM_CHECK_MARK,
                  attrs: checkedAttrs(sentence, {
                    scope: { folderId: "wall", widened: false },
                    versions: [{ documentId: docId, contentHash: "h1" }],
                  }),
                },
              ],
            },
            {
              type: CITATION_NODE,
              attrs: {
                passageId: "p-1",
                documentId: docId,
                documentName: "Wall.pdf",
                contentHash: "h1",
                pageFrom: 1,
                pageTo: 1,
                location: null,
                quote: sentence,
                check: "found",
                checkReason: null,
              },
            },
          ],
        },
      ],
    });
    const noteBState = paragraphDoc("Note B stays unchecked.", "p-b");
    const gateA = Promise.withResolvers<void>();
    let holdNextReadA = false;
    const seenFoldersA: (string | null)[] = [];
    let latest: ReadonlyMap<string, NoteReading> = new Map();

    const reader = createHomeNoteStateReader({
      readMindContents: async (mindIds) =>
        mindIds.map((mindId) => ({
          mindId,
          state: mindId === "a" ? state : noteBState,
          cellFigures: [],
          footing: [],
        })),
      decode: async (snapshot) => {
        const real = await decodeHomeSnapshot(snapshot);
        if (snapshot.state !== state) return real;
        return {
          ...real,
          async read(ctx) {
            if (holdNextReadA) {
              holdNextReadA = false;
              await gateA.promise;
            }
            seenFoldersA.push(ctx.folderId);
            return real.read(ctx);
          },
        };
      },
      onChange: (states) => {
        latest = states;
      },
      onError: (error) => {
        throw error;
      },
    });

    const walledLibrary = {
      groups: [{ id: "wall", name: "Private", parentId: null, keepInside: true }],
      documentWalls: { [docId]: { wallId: "wall", byUser: true } },
    };
    const shared = {
      documents: [{ id: docId, contentHash: "h1" }],
      keptCitationTexts: [],
      library: walledLibrary,
    };

    // Initial launch: Note A is outside the walled folder (its check cannot read Wall.pdf).
    reader.sync(
      [
        { id: "a", folderId: null },
        { id: "b", folderId: null },
      ],
      shared,
    );
    await flush();
    expect(seenFoldersA).toEqual([null]);
    const stateBeforeMove = latest.get("a")?.state;

    // Move Note A into the walled folder (hold its async read), then immediately move Note B.
    holdNextReadA = true;
    reader.sync(
      [
        { id: "a", folderId: "wall" },
        { id: "b", folderId: null },
      ],
      shared,
    );
    reader.sync(
      [
        { id: "a", folderId: "wall" },
        { id: "b", folderId: "wall" },
      ],
      shared,
    );

    // Release Note A's read: Note B's move must not have cancelled Note A's evaluation.
    gateA.resolve();
    await flush();
    expect(seenFoldersA).toEqual([null, "wall"]);
    expect(latest.get("a")?.state?.kind).toBe("checked");
    expect(latest.get("a")?.state).not.toEqual(stateBeforeMove);
    expect(latest.get("b")?.state?.kind).toBe("not-checked");

    reader.dispose();
  });

  test("a Note with figures in a table is read again when the Documents or the Library change, and decoded again only when it reads differently", async () => {
    const tableState = paragraphDoc("Total 30", "p-table");
    const proseState = paragraphDoc("Spring tides rise highest at full moon.", "p-prose");
    const place = { blockId: "p-table", from: 6, to: 8 };
    let footing: MindContentSnapshot["footing"] = [];
    const calls: string[][] = [];
    const decodedIds: string[] = [];
    let latest: ReadonlyMap<string, NoteReading> = new Map();
    const reader = createHomeNoteStateReader({
      readMindContents: async (mindIds) => {
        calls.push([...mindIds]);
        return mindIds.map((mindId) =>
          mindId === "table"
            ? { mindId, state: tableState, cellFigures: [place], footing }
            : { mindId, state: proseState, cellFigures: [], footing: [] },
        );
      },
      decode: async (snapshot) => {
        decodedIds.push(snapshot.state === tableState ? "table" : "prose");
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
      { id: "table", folderId: null },
      { id: "prose", folderId: null },
    ];
    reader.sync(minds, { documents: [], keptCitationTexts: [], library: null });
    await flush();
    expect(calls).toEqual([["table", "prose"]]);

    reader.sync(minds, {
      documents: [{ id: "doc-1", contentHash: "h1" }],
      keptCitationTexts: [],
      library: null,
    });
    await flush();
    expect(calls).toEqual([["table", "prose"], ["table"]]);
    expect(decodedIds).toEqual(["table", "prose"]);

    footing = [{ id: "fig-total", footing: [], waiting: true }];
    reader.sync(minds, {
      documents: [{ id: "doc-1", contentHash: "h1" }],
      keptCitationTexts: [],
      library: { groups: [], documentWalls: {} },
    });
    await flush();
    expect(calls).toEqual([["table", "prose"], ["table"], ["table"]]);
    expect(decodedIds).toEqual(["table", "prose", "table"]);
    expect(latest.get("table")).toBeDefined();
    expect(latest.get("prose")).toBeDefined();
    reader.dispose();
  });

  test("the state line of a short Note, a long one, one edited since and one whose Documents changed is a fresh read's", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const sources = await createSourceFolder();
    const [annual] = await addAndProcess(core, [
      await writeSourceFile(sources, "Annual.txt", "Revenue reached 120 million in 2025."),
    ]);
    if (!annual) throw new Error("The Document wasn't added.");
    const checked = "Revenue reached 120 million in 2025.";
    const short = await core.createMind({ title: "Short" });
    await core.applyMindUpdate(
      short.id,
      updateFromDoc({
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { [BLOCK_ID_ATTRIBUTE]: "p-checked" },
            content: [
              {
                type: "text",
                text: checked,
                marks: [
                  {
                    type: CLAIM_CHECK_MARK,
                    attrs: checkedAttrs(checked, {
                      versions: [{ documentId: annual.id, contentHash: annual.contentHash }],
                    }),
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const long = await core.createMind({ title: "Long" });
    await core.applyMindUpdate(
      long.id,
      updateFromDoc({
        type: "doc",
        content: Array.from({ length: 600 }, (_, at) => ({
          type: "paragraph",
          attrs: { [BLOCK_ID_ATTRIBUTE]: `long-${at}` },
          content: [
            {
              type: "text",
              text: `Clause ${at + 1}: fees of ${at + 10} thousand are invoiced monthly in arrears.`,
            },
          ],
        })),
      }),
    );
    await core.closeMind(short.id);
    await core.closeMind(long.id);

    let latest: ReadonlyMap<string, NoteReading> = new Map();
    const reader = createHomeNoteStateReader({
      readMindContents: (ids) => core.readMindContents(ids),
      onChange: (states) => {
        latest = states;
      },
      onError: (error) => {
        throw error;
      },
    });
    const minds = [
      { id: short.id, folderId: null },
      { id: long.id, folderId: null },
    ];
    // Each Note as a read of the whole Note now gives it, from what is stored.
    const freshReading = (mindId: string, context: HomeSharedContext) => {
      const rows = queryDatabase<{ data: Uint8Array }>(
        dataDir,
        "SELECT data FROM mind_updates WHERE mind_id = ? AND deleted_at IS NULL ORDER BY rowid",
        [mindId],
      );
      const state = Y.mergeUpdates(rows.map((row) => new Uint8Array(row.data)));
      return homeReading({ state, cellFigures: [], footing: [] }, { ...context, folderId: null });
    };
    const sameAsFresh = async (context: HomeSharedContext) => {
      await vi.waitFor(
        () => {
          for (const { id } of minds) {
            const shown = latest.get(id);
            const fresh = freshReading(id, context);
            expect(shown?.health).toEqual(fresh.health);
            expect(shown?.state).toEqual(fresh.state);
          }
        },
        { timeout: 5_000, interval: 20 },
      );
    };

    const started = { documents: await core.listDocuments(), keptCitationTexts: [], library: null };
    reader.sync(minds, started);
    await sameAsFresh(started);
    expect(latest.get(short.id)?.state?.kind).toBe("checked");
    expect(latest.get(long.id)?.health.toCheck.length).toBe(600);

    await core.applyMindUpdate(
      short.id,
      updateFromDoc({
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { [BLOCK_ID_ATTRIBUTE]: "p-added" },
            content: [{ type: "text", text: "Cargo volumes doubled after the dredging." }],
          },
        ],
      }),
    );
    reader.refresh([short.id]);
    await sameAsFresh(started);
    expect(latest.get(short.id)?.health.toCheck.length).toBe(1);

    await core.deleteDocument(annual.id);
    const changed = { documents: await core.listDocuments(), keptCitationTexts: [], library: null };
    expect(changed.documents).toEqual([]);
    reader.sync(minds, changed);
    await sameAsFresh(changed);
    expect(latest.get(short.id)?.state?.kind).not.toBe("checked");
    reader.dispose();
  });

  test("readTableSnapshot yields inside large table paragraph, fact, and place loops with identical output", async () => {
    const tableRows: JSONContent[] = [
      {
        type: "tableRow",
        content: [
          {
            type: "tableHeader",
            content: [
              {
                type: "paragraph",
                attrs: { [BLOCK_ID_ATTRIBUTE]: "h-0" },
                content: [{ type: "text", text: "Item" }],
              },
            ],
          },
          {
            type: "tableHeader",
            content: [
              {
                type: "paragraph",
                attrs: { [BLOCK_ID_ATTRIBUTE]: "h-1" },
                content: [{ type: "text", text: "Amount ($m)" }],
              },
            ],
          },
        ],
      },
    ];
    for (let r = 0; r < 25; r++) {
      tableRows.push({
        type: "tableRow",
        content: [
          {
            type: "tableCell",
            content: [
              {
                type: "paragraph",
                attrs: { [BLOCK_ID_ATTRIBUTE]: `c-${r}-0` },
                content: [{ type: "text", text: `Row ${r + 1}` }],
              },
            ],
          },
          {
            type: "tableCell",
            content: [
              {
                type: "paragraph",
                attrs: { [BLOCK_ID_ATTRIBUTE]: `c-${r}-1` },
                content: [{ type: "text", text: String((r + 1) * 10) }],
              },
            ],
          },
        ],
      });
    }
    const doc = new Y.Doc();
    try {
      prosemirrorToYXmlFragment(
        schema.nodeFromJSON({
          type: "doc",
          content: [
            {
              type: "table",
              attrs: { [BLOCK_ID_ATTRIBUTE]: "big-table" },
              content: tableRows,
            },
          ],
        }),
        doc.getXmlFragment(MIND_CONTENT_FIELD),
      );
      const frag = doc.getXmlFragment(MIND_CONTENT_FIELD);

      let yields = 0;
      const countingYield = async () => {
        yields++;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      };
      const now = { versions: new Map<string, string>(), folderId: null, scope: null };
      const asyncResult = await readTableSnapshot(frag, now, countingYield, 0);
      expect(yields).toBeGreaterThan(10);
      expect(asyncResult.cellFigures).toEqual(tableCellFigurePlaces(frag));
      expect(asyncResult.footing).toEqual(
        [...noteFooting(frag, now)].map(([id, live]) => ({ id, ...live })),
      );
      expect(asyncResult.cellFigures.length).toBeGreaterThan(0);
    } finally {
      doc.destroy();
    }
  });
});
