import type { Editor } from "@tiptap/core";
import { expect, onTestFinished, test, vi } from "vitest";
import type * as Y from "yjs";
import type { Core } from "../../src/core";
import { MIND_CONTENT_FIELD } from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import type { CoreEvents } from "../../src/core/api";
import { comparisonTableAt } from "../../src/renderer/src/editor/comparisonCommands";
import { comparisonQuestionsOf } from "../../src/shared/comparisons";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";

let windowsOpened = 0;

const bridge = vi.hoisted(() => ({
  core: null as null | Core,
  /** Calls to acknowledge a column change, and the gate each waits behind. */
  acked: 0,
  ackGate: Promise.resolve() as Promise<void>,
}));

function coreNow(): Core {
  if (!bridge.core) throw new Error("No core yet.");
  return bridge.core;
}

/** The bridge a window's modules see, as the preload hands it to the renderer. */
function mockModules() {
  return {
    core: {
      on: <E extends keyof CoreEvents>(event: E, listener: (payload: CoreEvents[E]) => void) => {
        if (!bridge.core) return () => undefined;
        return bridge.core.on(event, listener);
      },
      openMind: (mindId: string) => coreNow().openMind(mindId),
      closeMind: (mindId: string) => coreNow().closeMind(mindId),
      applyMindUpdate: (mindId: string, update: Uint8Array) =>
        coreNow().applyMindUpdate(mindId, update),
      watchComparisonMind: (input: Parameters<Core["watchComparisonMind"]>[0]) =>
        coreNow().watchComparisonMind(input),
      unwatchComparisonMind: (input: Parameters<Core["unwatchComparisonMind"]>[0]) =>
        coreNow().unwatchComparisonMind(input),
      acknowledgeComparisonStructure: async (
        input: Parameters<Core["acknowledgeComparisonStructure"]>[0],
      ) => {
        bridge.acked += 1;
        await bridge.ackGate;
        return coreNow().acknowledgeComparisonStructure(input);
      },
      moveComparisonColumn: (input: Parameters<Core["moveComparisonColumn"]>[0]) =>
        coreNow().moveComparisonColumn(input),
    },
    files: {},
  };
}

const paragraph = (text: string): NodeJSON => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const answer = (questionId: string, text: string): NodeJSON => ({
  type: "comparisonCell",
  attrs: { questionId, status: "done" },
  content: [paragraph(text)],
});

const row = (documentId: string, cells: NodeJSON[]): NodeJSON => ({
  type: "comparisonRow",
  attrs: { documentId },
  content: cells,
});

/** Two Documents by three Questions, each cell an Answer. */
const table = (): NodeJSON => ({
  type: "comparisonTable",
  attrs: {
    id: "table-1",
    questions: [
      { id: "q1", text: "Termination notice" },
      { id: "q2", text: "Liability cap" },
      { id: "q3", text: "Governing law" },
    ],
  },
  content: [
    row("doc-a", [
      answer("q1", "90 days"),
      answer("q2", "12 months of fees"),
      answer("q3", "New York"),
    ]),
    row("doc-b", [answer("q1", "30 days"), answer("q2", "6 months"), answer("q3", "Delaware")]),
  ],
});

async function boundMind(): Promise<{ core: Core; mindId: string }> {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  onTestFinished(() => core.close());
  const mind = await core.createMind({ title: "Two windows" });
  const client = await connectToMind(core, mind.id);
  client.doc.transact(() => {
    client.doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .push([createElement(paragraph("Shortlist")), createElement(table())]);
  });
  await client.settled();
  bridge.core = core;
  onTestFinished(() => {
    bridge.core = null;
  });
  return { core, mindId: mind.id };
}

interface WindowGraph {
  core: { applyMindUpdate: Core["applyMindUpdate"] };
  columns: typeof import("../../src/renderer/src/comparisonColumns");
  editorHelper: typeof import("../helpers/editor");
  open(mindId: string): Promise<{ doc: Y.Doc; close: () => void }>;
}

/** A renderer window of its own: a fresh module graph, store and lock. */
async function freshWindow(): Promise<WindowGraph> {
  vi.resetModules();
  // Two windows of the app have a sessionStorage each; here each module graph gets an id.
  vi.doMock("../../src/renderer/src/clientId", () => ({ clientId: `window-${++windowsOpened}` }));
  vi.doMock("../../src/renderer/src/core", mockModules);
  const coreModule = await import("../../src/renderer/src/core");
  const [columns, , editorHelper, mindCopies] = await Promise.all([
    import("../../src/renderer/src/comparisonColumns"),
    // Imported for what it registers: the window's own listener for a structure change.
    import("../../src/renderer/src/comparisons"),
    import("../helpers/editor"),
    import("../../src/renderer/src/mindCopies"),
  ]);
  return {
    core: coreModule.core,
    columns,
    editorHelper,
    open: (mindId) =>
      new Promise((resolve, reject) => {
        const close = mindCopies.openMindCopy(
          mindId,
          (copy) => {
            if (!copy.doc) {
              reject(new Error("The Mind can't be shown."));
              return;
            }
            resolve({ doc: copy.doc, close });
          },
          reject,
        );
      }),
  };
}

const questionsOf = (editor: Editor) => {
  const pos = comparisonTableAt(editor, "table-1");
  const found = pos === null ? null : editor.state.doc.nodeAt(pos);
  return found ? comparisonQuestionsOf(found.attrs) : [];
};

const orderOf = (editor: Editor) => questionsOf(editor).map((question) => question.id);

/** The words of a Question's cell in the first row, where this test types. */
const cellText = (editor: Editor, questionId: string) => {
  const pos = comparisonTableAt(editor, "table-1");
  let words = "";
  editor.state.doc
    .nodeAt(pos ?? 0)
    ?.child(0)
    .forEach((cell) => {
      if (cell.attrs.questionId === questionId) words = cell.textContent;
    });
  return words;
};

/** Clicks into the first row's first cell and types there, as an editor's view does. */
function typeInCell(graph: WindowGraph, editor: Editor, text: string): void {
  const pos = comparisonTableAt(editor, "table-1");
  if (pos === null) throw new Error("No table.");
  const line = editor.state.doc.nodeAt(pos)?.child(0).child(0).child(0);
  if (!line) throw new Error("No cell paragraph.");
  editor.commands.setTextSelection(pos + 4 + line.content.size);
  graph.editorHelper.typeText(editor, text);
}

/**
 * Two windows on one Note, each with its own renderer modules: its own store,
 * its own lock, its own pending changes and its own `comparisons.ts` listener.
 * What one window's edit sees around the other's column change depends on those
 * being separate, as they are in two windows of the app.
 */
test("two windows: the second's edit reaches the core before the first's move, and its lock drops an edit made during it", async () => {
  const { mindId } = await boundMind();
  const firstGraph = await freshWindow();
  const secondGraph = await freshWindow();
  const first = await firstGraph.open(mindId);
  const second = await secondGraph.open(mindId);
  onTestFinished(first.close);
  onTestFinished(second.close);
  const firstEditor = firstGraph.editorHelper.boundEditorTo(first.doc);
  const secondEditor = secondGraph.editorHelper.boundEditorTo(second.doc);

  // The second window's change is on its way when the first asks for the move.
  let releaseSends = () => {};
  const sendGate = new Promise<void>((resolve) => {
    releaseSends = resolve;
  });
  const applySecond = secondGraph.core.applyMindUpdate;
  secondGraph.core.applyMindUpdate = async (mindIdToApply, update) => {
    await sendGate;
    return applySecond(mindIdToApply, update);
  };
  typeInCell(secondGraph, secondEditor, " by the second window");
  expect(secondEditor.getText()).toContain("by the second window");

  bridge.acked = 0;
  let releaseAcks = () => {};
  bridge.ackGate = new Promise<void>((resolve) => {
    releaseAcks = resolve;
  });
  const moving = firstGraph.columns.moveColumn(
    { editor: firstEditor, mindId, tableId: "table-1" },
    "q1",
    1,
  );
  // The first window has answered; the second is still flushing its change.
  await vi.waitFor(() => expect(bridge.acked).toBeGreaterThan(0));

  // The second window's lock holds the table: its edit made now is dropped.
  const before = secondEditor.getJSON();
  typeInCell(secondGraph, secondEditor, " during the move");
  expect(secondEditor.getJSON()).toEqual(before);

  // Let a change written by a window that answered early go first, then release the flush.
  releaseAcks();
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseSends();
  await moving;

  await vi.waitFor(() => expect(orderOf(firstEditor)).toEqual(["q2", "q1", "q3"]));
  await vi.waitFor(() => expect(orderOf(secondEditor)).toEqual(["q2", "q1", "q3"]));
  for (const editor of [firstEditor, secondEditor]) {
    expect(cellText(editor, "q1")).toContain("by the second window");
    expect(cellText(editor, "q1")).not.toContain("during the move");
  }
});
