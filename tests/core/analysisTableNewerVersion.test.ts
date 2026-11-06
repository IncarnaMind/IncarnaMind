import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  ANALYSIS_TABLE_NODE,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MindReadOnlyError,
} from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * The version before an Analysis's table was one calculated object (#2378): its core is this one
 * with the newest content schema it understands set back to 51.
 */
vi.mock("../../src/core/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTENT_SCHEMA_VERSION: 51,
}));

/** The content schema version a bound table came with: what a Note written since records. */
const BOUND = 52;
const BINDING = { id: "run-1", table: { result: "totals" } };

function noteWithBoundTable(): Y.Doc {
  const doc = new Y.Doc();
  const caption = new Y.XmlElement("paragraph");
  const marker = new Y.XmlElement(ANALYSIS_TABLE_NODE);
  marker.setAttribute(ANALYSIS_TABLE_ATTRIBUTE, BINDING as unknown as string);
  caption.insert(0, [new Y.XmlText("Total amount by region"), marker]);
  const table = new Y.XmlElement("table");
  table.setAttribute(ANALYSIS_TABLE_ATTRIBUTE, BINDING as unknown as string);
  const row = new Y.XmlElement("tableRow");
  for (const text of ["North", "9,450"]) {
    const cell = new Y.XmlElement("tableCell");
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(text)]);
    cell.insert(0, [paragraph]);
    row.push([cell]);
  }
  table.insert(0, [row]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([caption, table]);
  doc.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, BOUND);
  return doc;
}

const bindingOf = (doc: Y.Doc) => {
  const table = doc.getXmlFragment(MIND_CONTENT_FIELD).get(1);
  return table instanceof Y.XmlElement
    ? (table.getAttribute(ANALYSIS_TABLE_ATTRIBUTE) as unknown)
    : null;
};

describe("a version from before an Analysis's table was one calculated object", () => {
  test("opens a Note with a bound table read-only, so its write can't drop the binding", async () => {
    expect(CONTENT_SCHEMA_VERSION).toBe(51);
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Regions" });
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(noteWithBoundTable()));

    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, opened.state);
    expect(bindingOf(doc)).toEqual(BINDING);

    // Its editor drops the attribute and the marker it doesn't know: refused.
    const sent: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => sent.push(update));
    const table = doc.getXmlFragment(MIND_CONTENT_FIELD).get(1);
    if (!(table instanceof Y.XmlElement)) throw new Error("No table.");
    table.removeAttribute(ANALYSIS_TABLE_ATTRIBUTE);
    await expect(core.applyMindUpdate(mind.id, sent[0] as Uint8Array)).rejects.toThrow(
      MindReadOnlyError,
    );
    const again = new Y.Doc();
    Y.applyUpdate(again, (await core.openMind(mind.id)).state);
    expect(bindingOf(again)).toEqual(BINDING);
    core.close();
  });
});
