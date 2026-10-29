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
 * The last version before a comparison cell recorded a hand edit and the refill pass allowed to
 * write it (#1836): a build that reads content schema 33, whose editor would write the cell back
 * without `edited` and `fillId`. It is pinned there, not at this version minus one, so the test
 * fails if these fields ever share a schema version with that build.
 */
const schema = vi.hoisted(() => ({ beforeCellFields: 33, real: 0 }));

vi.mock("../../src/core/api", async (importOriginal) => {
  const actual = await importOriginal<{ CONTENT_SCHEMA_VERSION: number }>();
  schema.real = actual.CONTENT_SCHEMA_VERSION;
  return { ...actual, CONTENT_SCHEMA_VERSION: schema.beforeCellFields };
});

const table: NodeJSON = {
  type: COMPARISON_TABLE_NODE,
  attrs: {
    id: "table-1",
    questions: [{ id: "q1", text: "Termination notice" }],
  },
  content: [
    {
      type: COMPARISON_ROW_NODE,
      attrs: { documentId: "agreement", documentName: "Agreement.txt" },
      content: [
        {
          type: COMPARISON_CELL_NODE,
          attrs: { questionId: "q1", status: "done", edited: "true", fillId: "pass-1" },
          content: [{ type: "paragraph", attrs: { id: "block-1" } }],
        },
      ],
    },
  ],
};

function firstCell(fragment: Y.XmlFragment): Y.XmlElement {
  const table = fragment
    .toArray()
    .find(
      (element): element is Y.XmlElement =>
        element instanceof Y.XmlElement && element.nodeName === COMPARISON_TABLE_NODE,
    );
  const row = table
    ?.toArray()
    .find((element): element is Y.XmlElement => element instanceof Y.XmlElement);
  const cell = row
    ?.toArray()
    .find((element): element is Y.XmlElement => element instanceof Y.XmlElement);
  if (!cell) throw new Error("The comparison table has no cell.");
  return cell;
}

describe("a version from before a comparison cell recorded a hand edit and its refill pass", () => {
  // protects=the last build without `edited` and `fillId` opens a Note whose cell has them read-only, so its editor can't write the cell back without them; fails_when=the content schema wasn't raised for them, it opens writable, or its write reaches the stored cell; no_claim=how the newer version shows them.
  test("opens a Note with an edited, refilled cell read-only, and the cell keeps both", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(schema.beforeCellFields);
    expect(schema.real).toBeGreaterThan(schema.beforeCellFields);
    const doc = new Y.Doc();
    doc.getXmlFragment(MIND_CONTENT_FIELD).push([createElement(table)]);
    doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, schema.real);

    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Suppliers" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(doc));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");

    // Its editor, which doesn't know the cell's fields, writes the cell back without them: refused.
    const theirs = new Y.Doc();
    Y.applyUpdate(theirs, opened.state);
    const sent: Uint8Array[] = [];
    theirs.on("update", (update: Uint8Array) => sent.push(update));
    theirs.transact(() => {
      const cell = firstCell(theirs.getXmlFragment(MIND_CONTENT_FIELD));
      cell.removeAttribute("edited");
      cell.removeAttribute("fillId");
    });
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );

    const stored = new Y.Doc();
    Y.applyUpdate(stored, (await core.openMind(mind.id)).state);
    const cell = firstCell(stored.getXmlFragment(MIND_CONTENT_FIELD));
    expect(cell.getAttribute("edited")).toBe("true");
    expect(cell.getAttribute("fillId")).toBe("pass-1");
  });
});
