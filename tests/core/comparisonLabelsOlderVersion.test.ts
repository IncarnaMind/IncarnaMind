import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  COMPARISON_CELL_NODE,
  COMPARISON_ROW_NODE,
  COMPARISON_TABLE_NODE,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MindReadOnlyError,
} from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * The version before a comparison table's columns had a label (#1833): its core is this one
 * with the newest content schema it understands set back to 27, whose editor writes a column
 * back as `{ id, text }` when it changes one, which would lose its label.
 */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 27,
}));

/** The content schema version labels came with: what a Mind written since records. */
const LABELS = 28;

const QUESTION = "Termination notice";
const LABEL = "Notice";

const table: NodeJSON = {
  type: COMPARISON_TABLE_NODE,
  attrs: { id: "table-1", questions: [{ id: "q1", text: QUESTION, label: LABEL }] },
  content: [
    {
      type: COMPARISON_ROW_NODE,
      attrs: { documentId: "agreement", documentName: "Agreement.txt" },
      content: [
        {
          type: COMPARISON_CELL_NODE,
          attrs: { questionId: "q1", status: "waiting" },
          content: [{ type: "paragraph", attrs: { id: "block-1" } }],
        },
      ],
    },
  ],
};

describe("a version from before a comparison table's columns had a label", () => {
  // protects=a version that doesn't know a column's label opens a Mind holding one read-only, so its editor can't write the columns back as `{ id, text }` and lose the label; fails_when=it opens writable, or its write reaches the stored columns; no_claim=how the newer version shows it.
  test("opens a Mind with a labelled column read-only, and its columns can't be written back without the label", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(27);
    const doc = new Y.Doc();
    doc.getXmlFragment(MIND_CONTENT_FIELD).push([createElement(table)]);
    doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, LABELS);

    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Suppliers" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(doc));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");

    // Its editor, which doesn't know the label, writes the column back as `{ id, text }`: refused.
    const theirs = new Y.Doc();
    Y.applyUpdate(theirs, opened.state);
    const sent: Uint8Array[] = [];
    theirs.on("update", (update: Uint8Array) => sent.push(update));
    theirs.transact(() => {
      const own = theirs
        .getXmlFragment(MIND_CONTENT_FIELD)
        .toArray()
        .find(
          (element): element is Y.XmlElement =>
            element instanceof Y.XmlElement && element.nodeName === COMPARISON_TABLE_NODE,
        );
      if (!own) throw new Error("The Mind has no comparison table.");
      own.setAttribute("questions", [{ id: "q1", text: QUESTION }] as never);
    });
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );
    const stored = new Y.Doc();
    Y.applyUpdate(stored, (await core.openMind(mind.id)).state);
    const kept = stored
      .getXmlFragment(MIND_CONTENT_FIELD)
      .toArray()
      .find(
        (element): element is Y.XmlElement =>
          element instanceof Y.XmlElement && element.nodeName === COMPARISON_TABLE_NODE,
      );
    expect(kept?.getAttribute("questions")).toEqual([{ id: "q1", text: QUESTION, label: LABEL }]);
  });
});
