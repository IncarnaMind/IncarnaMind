import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { readTableSnapshot } from "../../src/core/figureSchedule";
import { createMindContent, type MindContent } from "../../src/core/mindContent";
import { createMindSnapshots, type TableReadInput } from "../../src/core/mindSnapshots";
import { migrate, openDatabase } from "../../src/core/storage";

const now = () => new Date().toISOString();

function paragraphsUpdate(texts: readonly string[]): Uint8Array {
  const doc = new Y.Doc();
  doc.getXmlFragment(MIND_CONTENT_FIELD).push(
    texts.map((text) => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText(text)]);
      return paragraph;
    }),
  );
  return Y.encodeStateAsUpdate(doc);
}

const clauses = Array.from(
  { length: 800 },
  (_, at) =>
    `Clause ${at + 1}: The Supplier shall deliver the Services to the agreed timetable, and fees are invoiced monthly in arrears.`,
);

function tableUpdate(): Uint8Array {
  const doc = new Y.Doc();
  const table = new Y.XmlElement("table");
  table.setAttribute("id", "tbl-1");
  const row = (cells: readonly string[], header = false) => {
    const element = new Y.XmlElement("tableRow");
    for (const [index, text] of cells.entries()) {
      const cell = new Y.XmlElement(header ? "tableHeader" : "tableCell");
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.setAttribute("id", `${header ? "h" : "c"}-${text}-${index}`);
      paragraph.insert(0, [new Y.XmlText(text)]);
      cell.push([paragraph]);
      element.push([cell]);
    }
    return element;
  };
  table.push([
    row(["Item", "Amount"], true),
    row(["A", "10"]),
    row(["B", "20"]),
    row(["Total", "30"]),
  ]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([table]);
  return Y.encodeStateAsUpdate(doc);
}

/** A Note's content store as the core has it, counting each time a Note's whole content is read. */
function setUp(db = migrated()) {
  const content = createMindContent(db, now, () => {});
  const readWhole: string[] = [];
  const counted: MindContent = {
    ...content,
    inspectStored: (mindId, ...rest) => {
      readWhole.push(mindId);
      return content.inspectStored(mindId, ...rest);
    },
  };
  return { db, content, readWhole, snapshots: createMindSnapshots(counted) };
}

function migrated() {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

const noTables: TableReadInput = { versions: new Map(), folderId: null };

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return doc.getXmlFragment(MIND_CONTENT_FIELD).toString();
  } finally {
    doc.destroy();
  }
};

describe("Note snapshots for Home's state line (#3822)", () => {
  test("a long Note with no table is never read whole, and reads the same each time", async () => {
    const { db, content, readWhole, snapshots } = setUp();
    content.apply(
      "long",
      paragraphsUpdate([...clauses, "An acceptable timetable, as the table says."]),
    );
    content.close("long");

    const first = await snapshots.read("long", () => noTables);
    const again = await snapshots.read("long", () => noTables);

    expect(readWhole).toEqual([]);
    expect(first.state.byteLength).toBeGreaterThan(100_000);
    expect(textOf(first.state)).toContain("Clause 800");
    expect(first.cellFigures).toEqual([]);
    expect(first.footing).toEqual([]);
    expect(again).toEqual(first);
    db.close();
  });

  test("a Note with a table is read whole, and one whose table was deleted shows no table figures", async () => {
    const { db, content, readWhole, snapshots } = setUp();
    content.apply("table", tableUpdate());
    content.close("table");
    content.apply("gone", tableUpdate());
    content.peek("gone", () => undefined);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, content.storedState("gone"));
    const known = Y.encodeStateVector(doc);
    doc.getXmlFragment(MIND_CONTENT_FIELD).delete(0, 1);
    doc.getXmlFragment(MIND_CONTENT_FIELD).push([new Y.XmlElement("paragraph")]);
    content.apply("gone", Y.encodeStateAsUpdate(doc, known));
    doc.destroy();
    content.close("gone");

    const table = await snapshots.read("table", () => noTables);
    const gone = await snapshots.read("gone", () => noTables);

    expect(readWhole[0]).toBe("table");
    expect(table.cellFigures.length).toBeGreaterThan(0);
    expect(gone.cellFigures).toEqual([]);
    db.close();
  });

  test("saving another Note doesn't read the long Note again", async () => {
    const { db, content, readWhole, snapshots } = setUp();
    content.apply("long", paragraphsUpdate(clauses));
    content.close("long");
    content.apply("other", paragraphsUpdate(["A short Note."]));
    content.close("other");
    await snapshots.read("long", () => noTables);
    await snapshots.read("other", () => noTables);

    content.apply("other", paragraphsUpdate(["Typed while Home is shown."]));
    const other = await snapshots.read("other", () => noTables);
    const long = await snapshots.read("long", () => noTables);
    expect(readWhole).toEqual(["other"]);
    expect(textOf(other.state)).toContain("Typed while Home is shown.");
    expect(textOf(long.state)).toContain("Clause 800");

    content.apply("long", paragraphsUpdate(["A clause added later."]));
    content.close("long");
    const edited = await snapshots.read("long", () => noTables);
    expect(readWhole).toEqual(["other"]);
    expect(textOf(edited.state)).toContain("A clause added later.");
    db.close();
  });

  test("a Note with figures in a table is read again when the Documents' versions or its Folder change", async () => {
    const { db, content, readWhole, snapshots } = setUp();
    content.apply("table", tableUpdate());
    content.close("table");
    const fresh = async (input: TableReadInput) => {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, content.storedState("table"));
        return readTableSnapshot(
          doc.getXmlFragment(MIND_CONTENT_FIELD),
          { ...input, scope: null },
          async () => {},
        );
      } finally {
        doc.destroy();
      }
    };
    const before: TableReadInput = { versions: new Map([["doc-1", "h1"]]), folderId: null };
    const changed: TableReadInput = { versions: new Map([["doc-1", "h2"]]), folderId: null };
    const moved: TableReadInput = { versions: new Map([["doc-1", "h2"]]), folderId: "folder-1" };

    const first = await snapshots.read("table", () => before);
    expect(first.cellFigures.length).toBeGreaterThan(0);
    await snapshots.read("table", () => ({ versions: new Map(before.versions), folderId: null }));
    expect(readWhole).toEqual(["table"]);

    const afterChange = await snapshots.read("table", () => changed);
    expect(readWhole).toEqual(["table", "table"]);
    const expected = await fresh(changed);
    expect({ cellFigures: afterChange.cellFigures, footing: afterChange.footing }).toEqual(
      expected,
    );

    await snapshots.read("table", () => moved);
    expect(readWhole).toEqual(["table", "table", "table"]);
    db.close();
  });

  test("a Note stored while it is being read is read again the next time", async () => {
    const { db, content, readWhole, snapshots } = setUp();
    content.apply("table", tableUpdate());
    content.close("table");

    const reading = snapshots.read("table", () => noTables);
    content.apply("table", paragraphsUpdate(["Typed during the read."]));
    await reading;
    const next = await snapshots.read("table", () => noTables);

    expect(readWhole).toEqual(["table", "table"]);
    expect(textOf(next.state)).toContain("Typed during the read.");
    db.close();
  });

  test("a Note stored in several rows reads the same each time", async () => {
    const db = migrated();
    const writer = createMindContent(db, now, () => {});
    writer.apply("rows", paragraphsUpdate(["One."]));
    writer.apply("rows", paragraphsUpdate(["Two."]));
    // As after a restart: nothing is loaded, and the rows wait to be compacted.
    const { readWhole, snapshots } = setUp(db);

    const first = await snapshots.read("rows", () => noTables);
    const again = await snapshots.read("rows", () => noTables);

    expect(textOf(first.state)).toContain("One.");
    expect(textOf(first.state)).toContain("Two.");
    expect(textOf(again.state)).toBe(textOf(first.state));
    expect(readWhole).toEqual(["rows", "rows"]);
    db.close();
  });
});
