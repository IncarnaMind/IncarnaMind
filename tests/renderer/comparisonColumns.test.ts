import type { Editor } from "@tiptap/core";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import {
  type CheckClaimInput,
  type Citation,
  type ClaimCheckResult,
  type ComparisonProblem,
  type CoreEvents,
  MIND_CONTENT_FIELD,
} from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import type { ComparisonCellHandle } from "../../src/renderer/src/comparisonCellHandle";
import { useComparisonCells } from "../../src/renderer/src/comparisonCellState";
import {
  comparisonCellCopySlice,
  comparisonCellLocation,
  comparisonCellsSelected,
  comparisonCellText,
  editComparisonCell,
  startComparisonCellEdit,
  toggleComparisonCellsReviewed,
} from "../../src/renderer/src/comparisonCells";
import { refillComparison } from "../../src/renderer/src/comparisonRefill";
import {
  comparisonCellAt,
  comparisonCellRange,
  comparisonCellSelection,
} from "../../src/renderer/src/comparisonSelection";
import { comparisonTableAt } from "../../src/renderer/src/editor/comparisonCommands";
import { citationsIn, copiedText } from "../../src/renderer/src/editor/copyNotes";
import { comparisonCellOf } from "../../src/shared/comparisons";
import {
  comparisonCellReviewed,
  comparisonCellTarget,
  signOffsOf,
} from "../../src/shared/signOffs";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor } from "../helpers/editor";
import { connectToMind } from "../helpers/mindClient";

interface CellTarget {
  kind: "cell";
  tableId: string;
  documentId: string;
  questionId: string;
}

function comparisonCellSignOffs(doc: Y.Doc, target: CellTarget) {
  const wanted = comparisonCellTarget(target.tableId, target.documentId, target.questionId);
  return signOffsOf(doc).filter((record) => record.target.id === wanted.id);
}

function reviewed(doc: Y.Doc, target: CellTarget): boolean {
  return comparisonCellReviewed(
    signOffsOf(doc),
    comparisonCellTarget(target.tableId, target.documentId, target.questionId),
  );
}

/** Each fill the window asked the core for, as the column commands ask it. */
const fills = vi.hoisted(() => ({
  calls: [] as {
    mindId: string;
    tableId: string;
    questionIds?: readonly string[];
    documentIds?: readonly string[];
    cells?: readonly { documentId: string; questionId: string }[];
    mode?: "fill" | "refill" | "refill-all" | "refill-problems";
    pass?: string;
  }[],
}));

const checks = vi.hoisted(() => ({
  calls: [] as CheckClaimInput[],
  handler: null as ((input: CheckClaimInput) => Promise<ClaimCheckResult>) | null,
}));

/** The core the window's structure commands ask, when a test bound it to one. */
const bridge = vi.hoisted(() => ({
  subscriptions: [] as (() => void)[],
  core: null as null | {
    editComparisonColumn(input: unknown): Promise<unknown>;
    insertComparisonColumn(input: unknown): Promise<unknown>;
    duplicateComparisonColumn(input: unknown): Promise<unknown>;
    removeComparisonColumn(input: unknown): Promise<unknown>;
    resizeComparisonColumn(input: unknown): Promise<unknown>;
    setComparisonColumnHidden(input: unknown): Promise<unknown>;
    moveComparisonColumn(input: unknown): Promise<unknown>;
    undoComparisonStructure(input: unknown): Promise<unknown>;
    redoComparisonStructure(input: unknown): Promise<unknown>;
    watchComparisonMind(input: unknown): Promise<unknown>;
    unwatchComparisonMind(input: unknown): Promise<unknown>;
    acknowledgeComparisonStructure(input: unknown): Promise<unknown>;
    on<E extends keyof CoreEvents>(
      event: E,
      listener: (payload: CoreEvents[E]) => void,
    ): () => void;
  },
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: <E extends keyof CoreEvents>(event: E, listener: (payload: CoreEvents[E]) => void) => {
      if (!bridge.core) {
        bridge.subscriptions.push(() => bridge.core?.on(event, listener));
        return () => undefined;
      }
      return bridge.core.on(event, listener);
    },
    fillComparisonTable: async (input: {
      mindId: string;
      tableId: string;
      questionIds?: readonly string[];
      documentIds?: readonly string[];
      cells?: readonly { documentId: string; questionId: string }[];
      mode?: "fill" | "refill" | "refill-all" | "refill-problems";
      pass?: string;
    }) => {
      fills.calls.push(input);
      return { started: true, tableId: input.tableId };
    },
    stopComparisonTable: async () => undefined,
    checkClaim: async (input: CheckClaimInput) => {
      checks.calls.push(input);
      if (!checks.handler) throw new Error("No claim-check result scripted.");
      return checks.handler(input);
    },
    editComparisonColumn: (input: unknown) => bridge.core?.editComparisonColumn(input),
    insertComparisonColumn: (input: unknown) => bridge.core?.insertComparisonColumn(input),
    duplicateComparisonColumn: (input: unknown) => bridge.core?.duplicateComparisonColumn(input),
    removeComparisonColumn: (input: unknown) => bridge.core?.removeComparisonColumn(input),
    resizeComparisonColumn: (input: unknown) => bridge.core?.resizeComparisonColumn(input),
    setComparisonColumnHidden: (input: unknown) => bridge.core?.setComparisonColumnHidden(input),
    moveComparisonColumn: (input: unknown) => bridge.core?.moveComparisonColumn(input),
    undoComparisonStructure: (input: unknown) => bridge.core?.undoComparisonStructure(input),
    redoComparisonStructure: (input: unknown) => bridge.core?.redoComparisonStructure(input),
    watchComparisonMind: (input: unknown) => bridge.core?.watchComparisonMind(input),
    unwatchComparisonMind: (input: unknown) => bridge.core?.unwatchComparisonMind(input),
    acknowledgeComparisonStructure: (input: unknown) =>
      bridge.core?.acknowledgeComparisonStructure(input),
  },
  files: {},
}));

const paragraph = (text: string): NodeJSON => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const answer = (
  questionId: string,
  text: string,
  { problem, documentId }: { problem?: ComparisonProblem; documentId?: string } = {},
): NodeJSON => ({
  type: "comparisonCell",
  attrs: problem ? { questionId, status: "failed", problem } : { questionId, status: "done" },
  content: problem
    ? [paragraph("")]
    : [
        {
          type: "paragraph",
          content: [
            { type: "text", text },
            {
              type: "citation",
              attrs: {
                passageId: `${questionId}-${documentId}`,
                documentId,
                documentName: documentId,
                contentHash: `${documentId}-hash`,
                pageFrom: 1,
                pageTo: 1,
                quote: `${text} quote`,
                check: "found",
              },
            },
          ],
        },
      ],
});

/** A table of two columns and two rows, its Answers cited, as the core fills one. */
const table = (firstProblem?: ComparisonProblem, documentIds = ["doc-a", "doc-b"]): NodeJSON => ({
  type: "comparisonTable",
  attrs: {
    id: "table-1",
    questions: [
      { id: "q1", text: "Termination notice", label: "Notice" },
      { id: "q2", text: "Liability cap" },
    ],
  },
  content: documentIds.map((documentId) => ({
    type: "comparisonRow",
    attrs: { documentId, documentName: documentId },
    content: [
      answer("q1", "90 days", { problem: firstProblem, documentId }),
      answer("q2", "12 months", { documentId }),
    ],
  })),
});

/** A Mind's editor holding that table, bound to Yjs so ⌘Z is the note's own. */
async function boundTable(firstProblem?: ComparisonProblem, documentIds?: string[]) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  onTestFinished(() => core.close());
  const mind = await core.createMind({ title: "Suppliers" });
  const client = await connectToMind(core, mind.id);
  client.doc.transact(() => {
    client.doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .push([
        createElement(paragraph("Shortlist")),
        createElement(table(firstProblem, documentIds)),
      ]);
  });
  await client.settled();
  const editor = boundEditor(client);
  const before = editor.getJSON();
  bridge.core = core;
  for (const subscribe of bridge.subscriptions.splice(0)) subscribe();
  onTestFinished(() => {
    bridge.core = null;
  });
  return { core, client, editor, mind, before };
}

const cellHandle = (
  editor: Editor,
  documentId = "doc-a",
  questionId = "q1",
): ComparisonCellHandle => ({
  editor,
  mindId: "mind-1",
  tableId: "table-1",
  documentId,
  questionId,
  anchor: { focus: () => undefined } as unknown as HTMLElement,
});

function cellStateForTest(): void {
  resetCellState();
  onTestFinished(resetCellState);
}

function resetCellState(): void {
  checks.calls.length = 0;
  checks.handler = null;
  useComparisonCells.setState({
    current: null,
    selected: {},
    card: null,
    editing: null,
    checkProblems: {},
    checking: {},
  });
}

const citationFor = (documentId: string, quote: string): Citation => ({
  passageId: `passage-${documentId}`,
  documentId,
  documentName: documentId,
  contentHash: `${documentId}-hash`,
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote,
  check: "found",
  checkReason: null,
});

const claimResult = (evidence: Citation | null): ClaimCheckResult => ({
  verdict: evidence ? "supported" : "unsupported",
  evidence,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  versions: [],
  excluded: [],
});

describe("A targeted refill in the editor", () => {
  const handleFor = (editor: Editor) => ({ editor, mindId: "mind-1", tableId: "table-1" });
  const targets = [
    { documentId: "doc-a", questionId: "q1" },
    { documentId: "doc-b", questionId: "q1" },
  ] as const;

  function protectAll(editor: Editor): void {
    const pos = comparisonTableAt(editor, "table-1");
    if (pos === null) throw new Error("The table is gone.");
    const table = editor.state.doc.nodeAt(pos);
    if (!table) throw new Error("The table is gone.");
    const tr = editor.state.tr;
    table.forEach((row, rowOffset) => {
      row.forEach((_cell, cellOffset) => {
        const at = pos + 1 + rowOffset + 1 + cellOffset;
        tr.setNodeAttribute(at, "edited", true);
      });
    });
    editor.view.dispatch(tr);
  }

  test("prepare is one Undo step and the fill request has the same cells, mode and pass", async () => {
    const { editor, before } = await boundTable();
    fills.calls.length = 0;
    const started = refillComparison(handleFor(editor), "refill", [targets[0]]);
    expect(started).toMatchObject({ started: true });
    const call = fills.calls.at(-1);
    expect(call?.mode).toBe("refill");
    expect(call?.cells).toEqual([targets[0]]);
    expect(call?.pass).toEqual(expect.any(String));
    const pos = comparisonTableAt(editor, "table-1");
    const table = pos === null ? null : editor.state.doc.nodeAt(pos);
    expect(table?.child(0).child(0).attrs.fillId).toBe(call?.pass);

    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });

  test("Undo after the Core writes the replacement restores the whole old cell", async () => {
    const { editor, client } = await boundTable();
    const original = comparisonCellLocation(cellHandle(editor));
    if (!original) throw new Error("The cell is missing.");
    editor.view.dispatch(editor.state.tr.setNodeAttribute(original.pos, "edited", true));
    const before = editor.getJSON();
    fills.calls.length = 0;
    expect(refillComparison(handleFor(editor), "refill", [targets[0]])).toMatchObject({
      started: true,
    });
    const table = client.doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .toArray()
      .find(
        (element): element is Y.XmlElement =>
          element instanceof Y.XmlElement && element.getAttribute("id") === "table-1",
      );
    const row = table
      ?.toArray()
      .find(
        (element): element is Y.XmlElement =>
          element instanceof Y.XmlElement && element.getAttribute("documentId") === "doc-a",
      );
    const cell = row
      ?.toArray()
      .find(
        (element): element is Y.XmlElement =>
          element instanceof Y.XmlElement && element.getAttribute("questionId") === "q1",
      );
    const paragraph = cell?.get(0);
    if (!cell || !(paragraph instanceof Y.XmlElement)) {
      throw new Error("The refilled paragraph is gone.");
    }
    client.doc.transact(() => {
      cell.removeAttribute("edited");
      paragraph.delete(0, paragraph.length);
      paragraph.insert(0, [new Y.XmlText("Replacement from the model")]);
    });
    await vi.waitFor(() => {
      const after = comparisonCellLocation(cellHandle(editor));
      expect(after && comparisonCellText(after.cell)).toBe("Replacement from the model");
    });

    editor.commands.undo();
    await vi.waitFor(() => {
      expect(editor.getJSON()).toEqual(before);
    });
  });

  test("Undo restores several refilled cells when their new content has different sizes", async () => {
    const { editor, before, client } = await boundTable();
    fills.calls.length = 0;
    expect(refillComparison(handleFor(editor), "refill", targets)).toMatchObject({
      started: true,
    });
    const table = client.doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .toArray()
      .find(
        (element): element is Y.XmlElement =>
          element instanceof Y.XmlElement && element.getAttribute("id") === "table-1",
      );
    const replace = (documentId: string, text: string) => {
      const row = table
        ?.toArray()
        .find(
          (element): element is Y.XmlElement =>
            element instanceof Y.XmlElement && element.getAttribute("documentId") === documentId,
        );
      const cell = row
        ?.toArray()
        .find(
          (element): element is Y.XmlElement =>
            element instanceof Y.XmlElement && element.getAttribute("questionId") === "q1",
        );
      const paragraph = cell?.get(0);
      if (!(paragraph instanceof Y.XmlElement)) throw new Error("The refilled paragraph is gone.");
      client.doc.transact(() => {
        paragraph.delete(0, paragraph.length);
        paragraph.insert(0, [new Y.XmlText(text)]);
      });
    };
    replace("doc-a", "A much longer replacement from the model, with several words");
    replace("doc-b", "x");
    await vi.waitFor(() => {
      const first = comparisonCellLocation(cellHandle(editor));
      const second = comparisonCellLocation(cellHandle(editor, "doc-b"));
      expect(first && comparisonCellText(first.cell)).toContain("A much longer replacement");
      expect(second && comparisonCellText(second.cell)).toBe("x");
    });

    editor.commands.undo();
    await vi.waitFor(() => {
      expect(editor.getJSON()).toEqual(before);
    });
  });

  test("a protected bulk with an unfillable neighbour has no model call; Fill all overrides only protection", async () => {
    const { editor, before } = await boundTable();
    protectAll(editor);
    const removed = comparisonCellLocation(cellHandle(editor, "doc-b"));
    if (!removed) throw new Error("The second cell is gone.");
    const tr = editor.state.tr;
    tr.setNodeAttribute(removed.pos, "status", "failed");
    tr.setNodeAttribute(removed.pos, "problem", "source-removed");
    editor.view.dispatch(tr);
    const protectedJson = editor.getJSON();
    fills.calls.length = 0;
    expect(refillComparison(handleFor(editor), "refill", targets)).toEqual({
      started: false,
      reason: "nothing-to-fill",
    });
    expect(fills.calls).toHaveLength(0);
    expect(editor.getJSON()).toEqual(protectedJson);

    expect(refillComparison(handleFor(editor), "refill-all", targets)).toMatchObject({
      started: true,
    });
    expect(fills.calls.at(-1)?.mode).toBe("refill-all");
    expect(fills.calls.at(-1)?.cells).toEqual([targets[0]]);
    expect(before).not.toEqual(protectedJson);
  });
});

describe("Comparison cells", () => {
  test("a Shift range is rectangular and arrows do not cross a row's edge", async () => {
    cellStateForTest();
    const { editor } = await boundTable();
    const handle = cellHandle(editor);
    expect(
      comparisonCellRange(
        handle,
        { documentId: "doc-a", questionId: "q1" },
        {
          documentId: "doc-b",
          questionId: "q2",
        },
      ),
    ).toEqual([
      { documentId: "doc-a", questionId: "q1" },
      { documentId: "doc-a", questionId: "q2" },
      { documentId: "doc-b", questionId: "q1" },
      { documentId: "doc-b", questionId: "q2" },
    ]);
    expect(comparisonCellAt(handle, "left")).toBeNull();
    expect(comparisonCellAt(handle, "up")).toBeNull();
    expect(comparisonCellAt(handle, "right")).toEqual({ documentId: "doc-a", questionId: "q2" });
    expect(comparisonCellAt(handle, "down")).toEqual({ documentId: "doc-b", questionId: "q1" });
    expect(comparisonCellAt(cellHandle(editor, "doc-a", "q2"), "right")).toBeNull();
  });

  test("a deselected current cell is absent from keyboard targets but remains the context target", async () => {
    cellStateForTest();
    const { editor } = await boundTable();
    const deselected = cellHandle(editor, "doc-a", "q2");
    useComparisonCells.setState({
      current: { tableId: "table-1", documentId: "doc-a", questionId: "q2" },
      selected: {
        "table-1": {
          anchor: { documentId: "doc-a", questionId: "q1" },
          cells: [{ documentId: "doc-a", questionId: "q1" }],
        },
      },
    });
    const selected = useComparisonCells.getState().selected["table-1"]?.cells;
    expect(comparisonCellSelection(deselected, selected, false)).toEqual([
      { documentId: "doc-a", questionId: "q1" },
    ]);
    expect(comparisonCellSelection(deselected, selected, true)).toEqual([
      { documentId: "doc-a", questionId: "q2" },
    ]);
  });

  test("Checked by me records the selected cells and restores them in one Undo step", async () => {
    cellStateForTest();
    const { editor, before, client } = await boundTable();
    const handle = cellHandle(editor);
    const selected = [
      { documentId: "doc-a", questionId: "q1" },
      { documentId: "doc-b", questionId: "q1" },
    ];
    const first = selected[0];
    if (!first) throw new Error("No cell selected.");
    useComparisonCells.setState({
      current: { tableId: "table-1", ...first },
      selected: { "table-1": { anchor: first, cells: selected } },
    });
    expect(comparisonCellsSelected(handle)).toEqual(selected);
    expect(toggleComparisonCellsReviewed(handle, selected)).toBe(true);
    for (const target of selected) {
      expect(reviewed(client.doc, { kind: "cell", tableId: "table-1", ...target })).toBe(true);
      expect(
        comparisonCellSignOffs(client.doc, { kind: "cell", tableId: "table-1", ...target }),
      ).toMatchObject([
        {
          id: expect.any(String),
          at: expect.any(String),
          contentHash: expect.any(String),
          deletedAt: null,
        },
      ]);
    }
    expect(
      reviewed(client.doc, {
        kind: "cell",
        tableId: "table-1",
        documentId: "doc-a",
        questionId: "q2",
      }),
    ).toBe(false);
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
    for (const target of selected)
      expect(
        comparisonCellSignOffs(client.doc, { kind: "cell", tableId: "table-1", ...target }),
      ).toEqual([]);
    editor.commands.redo();
    for (const target of selected)
      expect(
        comparisonCellSignOffs(client.doc, { kind: "cell", tableId: "table-1", ...target })[0]
          ?.deletedAt,
      ).toBeNull();
  });

  test("a hand edit keeps a supported Citation, preserves a literal marker and is one Undo step", async () => {
    cellStateForTest();
    const { editor, before } = await boundTable();
    const handle = cellHandle(editor);
    checks.handler = async () => claimResult(citationFor("doc-a", "The agreement allows 30 days."));
    await expect(editComparisonCell(handle, "30 days[^1]")).resolves.toBe(true);
    expect(checks.calls).toHaveLength(1);
    expect(checks.calls[0]).toMatchObject({
      claim: "30 days[^1]",
      scope: { folderIds: [], tagIds: [], documentIds: ["doc-a"] },
      cited: [{ quote: "90 days quote", documentId: "doc-a" }],
    });
    const location = comparisonCellLocation(handle);
    if (!location) throw new Error("The edited cell is gone.");
    expect(comparisonCellOf(location.cell.attrs)).toMatchObject({ edited: true, reviewed: false });
    expect(citationsIn(location.cell.content)).toHaveLength(1);
    expect(citationsIn(location.cell.content)[0]).toMatchObject({
      quote: "The agreement allows 30 days.",
      check: "found",
    });
    expect(comparisonCellText(location.cell)).toBe("30 days[^1]");
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });

  test("an unsupported edit keeps no Citation, and a failed check leaves the original for Retry", async () => {
    cellStateForTest();
    const { editor, before } = await boundTable();
    const handle = cellHandle(editor);
    checks.handler = async () => claimResult(null);
    await expect(editComparisonCell(handle, "30 days[^1]")).resolves.toBe(true);
    let location = comparisonCellLocation(handle);
    if (!location) throw new Error("The edited cell is gone.");
    expect(citationsIn(location.cell.content)).toHaveLength(0);
    expect(comparisonCellText(location.cell)).toBe("30 days[^1]");
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);

    let attempts = 0;
    checks.handler = async () => {
      attempts++;
      if (attempts === 1) throw new Error("Provider unavailable");
      return claimResult(citationFor("doc-a", "Thirty days."));
    };
    await expect(editComparisonCell(handle, "30 days")).resolves.toBe(false);
    expect(editor.getJSON()).toEqual(before);
    const problem = useComparisonCells.getState().checkProblems["table-1:doc-a:q1"];
    expect(problem?.message).toBe("Couldn’t check the edited cell’s Citations. Try again.");
    await problem?.retry();
    location = comparisonCellLocation(handle);
    if (!location) throw new Error("The retried cell is gone.");
    expect(attempts).toBe(2);
    expect(comparisonCellText(location.cell)).toBe("30 days");
    expect(citationsIn(location.cell.content)).toHaveLength(1);
    expect(useComparisonCells.getState().checkProblems["table-1:doc-a:q1"]).toBeUndefined();
  });

  test("Undo and a newer edit invalidate a late Citation result", async () => {
    cellStateForTest();
    const { editor, before } = await boundTable();
    const handle = cellHandle(editor);
    let finish: (result: ClaimCheckResult) => void = () => {
      throw new Error("The claim check was not started.");
    };
    checks.handler = () =>
      new Promise<ClaimCheckResult>((resolve) => {
        finish = resolve;
      });
    const pending = editComparisonCell(handle, "30 days");
    expect(useComparisonCells.getState().checking["table-1:doc-a:q1"]).toBe(true);
    expect(toggleComparisonCellsReviewed(handle, comparisonCellsSelected(handle))).toBe(true);
    editor.commands.undo();
    finish(claimResult(citationFor("doc-a", "Thirty days.")));
    await expect(pending).resolves.toBe(false);
    expect(editor.getJSON()).toEqual(before);
    expect(useComparisonCells.getState().checking["table-1:doc-a:q1"]).toBeUndefined();

    const later = editComparisonCell(handle, "45 days");
    startComparisonCellEdit(handle);
    finish(claimResult(citationFor("doc-a", "Forty-five days.")));
    await expect(later).resolves.toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  test("copy uses the selected cells and the Notes clipboard's Sources", async () => {
    cellStateForTest();
    const { editor } = await boundTable();
    const handle = cellHandle(editor);
    const selected = [
      { documentId: "doc-a", questionId: "q1" },
      { documentId: "doc-a", questionId: "q2" },
    ];
    const first = selected[0];
    if (!first) throw new Error("No cell selected.");
    useComparisonCells.setState({
      current: { tableId: "table-1", ...first },
      selected: { "table-1": { anchor: first, cells: selected } },
    });
    const slice = comparisonCellCopySlice(handle);
    if (!slice) throw new Error("Nothing was copied.");
    const copied = copiedText(slice.content, editor.state.schema, {
      language: "en",
      documents: [],
    });
    expect(copied).toContain("Document\tNotice\tLiability cap\tSources");
    expect(copied).toContain("doc-a\t90 days[1]\t12 months[1]\tNotice: doc-a, p. 1");
    expect(copied).toContain("Sources");
    expect(copied).toContain("90 days quote");
    expect(copied).toContain("12 months quote");
  });
});
