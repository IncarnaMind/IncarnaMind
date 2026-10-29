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
 * The version before a comparison table had a title (#1837): a build that reads
 * content schema 36, the release before this one, whose editor writes a table
 * back without the name it doesn't know.
 */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 36,
}));

/** The content schema version titles came with: what a Note written since records. */
const TITLES = 37;

const TITLE = "Refinancing offers";

const table: NodeJSON = {
  type: COMPARISON_TABLE_NODE,
  attrs: { id: "table-1", title: TITLE, questions: [{ id: "q1", text: "Termination notice" }] },
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

describe("a version from before a comparison table had a title", () => {
  // protects=a version that doesn't know a table's title opens a Note holding one read-only, so its editor can't write the table back and lose the name; fails_when=it opens writable, or its write reaches the stored table; no_claim=how the newer version shows it.
  test("opens a Note with a named table read-only, and its table can't be written back without the name", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(36);
    const doc = new Y.Doc();
    doc.getXmlFragment(MIND_CONTENT_FIELD).push([createElement(table)]);
    doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, TITLES);

    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Suppliers" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(doc));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");

    // Its editor, which doesn't know the title, writes the table back without it: refused.
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
      if (!own) throw new Error("The Note has no comparison table.");
      own.removeAttribute("title");
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
    expect(kept?.getAttribute("title")).toBe(TITLE);
  });
});
