import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { MIND_CONTENT_FIELD } from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import type { CoreEvents } from "../../src/core/api";
import { useComparisonColumns } from "../../src/renderer/src/comparisonColumnState";
import { addDocuments, moveRow, removeRow, stepRow } from "../../src/renderer/src/comparisonRows";
import { changeComparisonTitle } from "../../src/renderer/src/comparisonTableName";
import { useComparisonTables } from "../../src/renderer/src/comparisonTableState";
import { comparisonTableAt } from "../../src/renderer/src/editor/comparisonCommands";
import {
  redoNoteHistory,
  releaseStructureStep,
  reserveStructureStep,
  undoFromMenu,
  undoNoteHistory,
} from "../../src/renderer/src/editor/comparisonStructureUndo";
import { useUndo } from "../../src/renderer/src/undo";
import { comparisonCountOf, comparisonTitleOf } from "../../src/shared/comparisons";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { boundEditor, typeText } from "../helpers/editor";
import { connectToMind } from "../helpers/mindClient";

const fills = vi.hoisted(() => ({
  calls: [] as { mindId: string; tableId: string; documentIds?: readonly string[] }[],
}));

/** The core the window's commands ask, when a test bound it to one. */
const bridge = vi.hoisted(() => ({
  subscriptions: [] as (() => void)[],
  core: null as null | {
    addComparisonRows(input: unknown): Promise<unknown>;
    removeComparisonRow(input: unknown): Promise<unknown>;
    moveComparisonRow(input: unknown): Promise<unknown>;
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
      documentIds?: readonly string[];
    }) => {
      fills.calls.push(input);
      return { started: true, tableId: input.tableId };
    },
    addComparisonRows: (input: unknown) => bridge.core?.addComparisonRows(input),
    removeComparisonRow: (input: unknown) => bridge.core?.removeComparisonRow(input),
    moveComparisonRow: (input: unknown) => bridge.core?.moveComparisonRow(input),
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

const answer = (questionId: string, text: string): NodeJSON => ({
  type: "comparisonCell",
  attrs: { questionId, status: "done" },
  content: [paragraph(text)],
});

const table = (rows: readonly { id: string; name: string }[]): NodeJSON => ({
  type: "comparisonTable",
  attrs: {
    id: "table-1",
    questions: [
      { id: "q1", text: "Termination notice", label: "Notice" },
      { id: "q2", text: "Governing law" },
    ],
  },
  content: rows.map((document) => ({
    type: "comparisonRow",
    attrs: { documentId: document.id, documentName: document.name },
    content: [answer("q1", `${document.name} 90 days`), answer("q2", "New York")],
  })),
});

/** An editor bound to a Mind of that table, made from real Documents, and the core the window asks. */
async function boundTable() {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  onTestFinished(() => core.close());
  const sources = await createSourceFolder();
  const documents = await addAndProcess(core, [
    await writeSourceFile(
      sources,
      "Corvane.txt",
      "Corvane Agreement.\nTermination notice: 90 days.",
    ),
    await writeSourceFile(sources, "Halvard.txt", "Halvard MSA.\nTermination notice: 6 months."),
  ]);
  const mind = await core.createMind({ title: "Suppliers" });
  const client = await connectToMind(core, mind.id);
  client.doc.transact(() => {
    client.doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .push([
        createElement(paragraph("Shortlist")),
        createElement(
          table(documents.map((document) => ({ id: document.id, name: document.name }))),
        ),
      ]);
  });
  await client.settled();
  const editor = boundEditor(client);
  bridge.core = core;
  for (const subscribe of bridge.subscriptions.splice(0)) subscribe();
  onTestFinished(() => {
    bridge.core = null;
  });
  const handle = { editor, mindId: mind.id, tableId: "table-1" };
  const addDocument = async (name: string, contents: string) => {
    const [document] = await addAndProcess(core, [await writeSourceFile(sources, name, contents)]);
    if (!document) throw new Error("The Document wasn't added.");
    return document;
  };
  return { core, client, editor, mind, handle, documents, addDocument };
}

type Editor = Awaited<ReturnType<typeof boundTable>>["editor"];

const rowsOf = (editor: Editor) => {
  const pos = comparisonTableAt(editor, "table-1");
  const node = pos === null ? null : editor.state.doc.nodeAt(pos);
  const rows: { documentId: string; text: string }[] = [];
  node?.forEach((row) => {
    rows.push({ documentId: String(row.attrs.documentId ?? ""), text: row.textContent });
  });
  return rows;
};

const rowIds = (editor: Editor) => rowsOf(editor).map((row) => row.documentId);

const settled = async (client: Awaited<ReturnType<typeof boundTable>>["client"]) => {
  await client.settled();
};

describe("A comparison table's rows, all written by the core", () => {
  beforeEach(() => {
    fills.calls.length = 0;
    useUndo.setState({ done: [], undone: [], line: null, running: null, making: 0 });
    useComparisonColumns.setState({ holds: new Map(), focus: null, stale: {} });
    useComparisonTables.setState({ adding: null, renaming: null, focus: null, drag: null });
  });

  test("Documents added fill their new rows alone, and one ⌘Z takes them out whole", async () => {
    const { client, editor, handle, addDocument, documents } = await boundTable();
    const third = await addDocument(
      "Lumeric.txt",
      "Lumeric Order Form.\nTermination notice: 30 days.",
    );
    await addDocuments(handle, [third.id]);
    await settled(client);

    expect(rowIds(editor)).toEqual([...documents.map((each) => each.id), third.id]);
    expect(fills.calls).toEqual([
      { mindId: handle.mindId, tableId: "table-1", documentIds: [third.id] },
    ]);
    const entry = useUndo.getState().done.at(-1);
    expect(
      entry?.said(
        (key, params) => translate("en", key, params),
        (name) => name,
      ),
    ).toBe("Added 1 Document");
    expect(
      entry?.said(
        (key, params) => translate("zh-CN", key, params),
        (name) => name,
      ),
    ).toBe("已添加 1 个文档");

    expect(undoNoteHistory(editor)).toBe(true);
    await vi.waitFor(() => expect(rowIds(editor)).toEqual(documents.map((each) => each.id)));
    expect(redoNoteHistory(editor)).toBe(true);
    await vi.waitFor(() =>
      expect(rowIds(editor)).toEqual([...documents.map((each) => each.id), third.id]),
    );
  });

  test("a row removed comes back with ⌘Z, and a row moved lands where it was dropped", async () => {
    const { client, editor, handle, documents } = await boundTable();
    const [first, second] = documents;
    if (!first || !second) throw new Error("No two Documents.");
    await removeRow(handle, first.id);
    await settled(client);
    expect(rowIds(editor)).toEqual([second.id]);
    expect(undoFromMenu(editor)).toBe(true);
    await vi.waitFor(() => expect(rowIds(editor)).toEqual([first.id, second.id]));
    expect(rowsOf(editor)[0]?.text).toContain("90 days");

    await moveRow(handle, second.id, 0);
    await settled(client);
    expect(rowIds(editor)).toEqual([second.id, first.id]);
    expect(undoNoteHistory(editor)).toBe(true);
    await vi.waitFor(() => expect(rowIds(editor)).toEqual([first.id, second.id]));
    expect(redoNoteHistory(editor)).toBe(true);
    await vi.waitFor(() => expect(rowIds(editor)).toEqual([second.id, first.id]));
  });

  test("the move keys move a row one place, and ⌘Z takes it back", async () => {
    const { client, editor, handle, documents } = await boundTable();
    const [first, second] = documents;
    if (!first || !second) throw new Error("No two Documents.");
    await stepRow(handle, first.id, 1);
    await settled(client);
    expect(rowIds(editor)).toEqual([second.id, first.id]);
    expect(undoNoteHistory(editor)).toBe(true);
    await vi.waitFor(() => expect(rowIds(editor)).toEqual([first.id, second.id]));
  });

  test("a note edit after a row move is undone first, then the move", async () => {
    const { client, editor, handle, documents } = await boundTable();
    const [first, second] = documents;
    if (!first || !second) throw new Error("No two Documents.");
    await moveRow(handle, first.id, 1);
    await settled(client);
    const line = editor.state.doc.firstChild;
    if (!line) throw new Error("No note line.");
    editor.commands.setTextSelection(1 + line.content.size);
    typeText(editor, " edited");
    expect(editor.getText()).toContain("edited");

    expect(undoFromMenu(editor)).toBe(true);
    expect(editor.getText()).not.toContain("edited");
    expect(rowIds(editor)).toEqual([second.id, first.id]);
    expect(undoNoteHistory(editor)).toBe(true);
    await vi.waitFor(() => expect(rowIds(editor)).toEqual([first.id, second.id]));
  });

  test("⌘Z while a row change is being written waits for it, and takes no text step", async () => {
    const { core, client, editor, handle, documents } = await boundTable();
    const [first] = documents;
    if (!first) throw new Error("No first Document.");
    const line = editor.state.doc.firstChild;
    if (!line) throw new Error("No note line.");
    editor.commands.setTextSelection(1 + line.content.size);
    typeText(editor, " edited");

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remove = core.removeComparisonRow.bind(core);
    core.removeComparisonRow = async (input) => {
      await held;
      return remove(input);
    };
    const removing = removeRow(handle, first.id);
    await vi.waitFor(() => expect(useComparisonColumns.getState().holds.has("table-1")).toBe(true));
    expect(undoNoteHistory(editor)).toBe(true);
    expect(editor.getText()).toContain("edited");
    expect(rowIds(editor)).toEqual(documents.map((each) => each.id));

    release();
    await removing;
    await settled(client);
    expect(undoNoteHistory(editor)).toBe(true);
    await vi.waitFor(() => expect(rowIds(editor)).toEqual([documents[1]?.id]));
    expect(editor.getText()).toContain("edited");
  });
});

describe("The table's name and its counts", () => {
  test("the name is one line kept with the table, and one ⌘Z takes it back", async () => {
    const { client, editor } = await boundTable();
    const title = () => {
      const pos = comparisonTableAt(editor, "table-1");
      return comparisonTitleOf(editor.state.doc.nodeAt(pos ?? 0)?.attrs ?? {});
    };
    changeComparisonTitle(editor, "table-1", "  Refinancing   offers  ");
    await settled(client);
    expect(title()).toBe("Refinancing offers");
    const entry = useUndo.getState().done.at(-1);
    expect(
      entry?.said(
        (key, params) => translate("en", key, params),
        (name) => name,
      ),
    ).toBe("Renamed to “Refinancing offers”");
    expect(
      entry?.said(
        (key, params) => translate("zh-CN", key, params),
        (name) => name,
      ),
    ).toBe("已重命名为“Refinancing offers”");

    expect(editor.commands.undo()).toBe(true);
    await vi.waitFor(() => expect(title()).toBe(""));
    expect(editor.commands.redo()).toBe(true);
    await vi.waitFor(() => expect(title()).toBe("Refinancing offers"));
  });

  test("a rename the structure lock drops offers no Undo, and ⌘Z still takes back the typing before it", async () => {
    const { client, editor } = await boundTable();
    const title = () => {
      const pos = comparisonTableAt(editor, "table-1");
      return comparisonTitleOf(editor.state.doc.nodeAt(pos ?? 0)?.attrs ?? {});
    };
    reserveStructureStep(editor);
    // The note's history, as the window has it once a column or row change was reserved.
    releaseStructureStep(editor);
    const line = editor.state.doc.firstChild;
    if (!line) throw new Error("No note line.");
    editor.commands.setTextSelection(1 + line.content.size);
    typeText(editor, " edited");
    expect(editor.getText()).toContain("edited");
    const before = useUndo.getState().done.length;

    // Another window is changing the table: its lock drops this window's rename.
    useComparisonColumns.getState().hold("table-1", "other-window");
    changeComparisonTitle(editor, "table-1", "Refinancing offers");
    await settled(client);
    useComparisonColumns.getState().release("table-1", "other-window");

    expect(title()).toBe("");
    // No Undo line claimed the dropped rename: ⌘Z is still the typing's own step.
    expect(useUndo.getState().done.slice(before)).toEqual([]);
    expect(undoNoteHistory(editor)).toBe(true);
    await vi.waitFor(() => expect(editor.getText()).not.toContain("edited"));
  });

  test("a count says what a cell without an Answer came to: found nothing, failed, or nothing to look at", () => {
    for (const problem of ["not-found", "nothing-to-search", "scale-changed"] as const) {
      expect(comparisonCountOf(problem)).toBe("nothing");
    }
    for (const problem of [
      "auth",
      "rate-limit",
      "network",
      "out-of-credit",
      "region",
      "consent-declined",
      "local-mode",
      "too-long",
      "cost-cap",
      "plan-limit",
    ] as const) {
      expect(comparisonCountOf(problem)).toBe("failed");
    }
    for (const problem of ["left-out", "not-cited", "source-removed"] as const) {
      expect(comparisonCountOf(problem)).toBeNull();
    }
    expect(comparisonCountOf(null)).toBeNull();
  });
});
