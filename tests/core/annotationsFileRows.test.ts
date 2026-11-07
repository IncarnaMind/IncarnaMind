/**
 * A PDF's own highlights and notes are read once per version (#327): the User's
 * notes, colours and deletes stay with the same row as their words move between
 * versions and pages, and a row the version lacks says it is missing rather than
 * going away.
 */
import { join } from "node:path";
import { expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import {
  type AnnotationCiter,
  type CitationRecheckLike,
  createAnnotations,
} from "../../src/core/annotations";
import { type FileAnnotation, readFileAnnotations } from "../../src/core/documents/pdfAnnotations";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { buildPdf } from "../helpers/pdf";

type Cited = { quote: string } & CitationRecheckLike;

const found = (unit: number, text: string): Cited => ({
  quote: text.replace(/\s+/g, " ").trim(),
  check: "found",
  checkReason: null,
  contentHash: null,
  passageId: `passage-${unit}`,
  pageFrom: unit,
  pageTo: unit,
  location: { kind: "page", from: unit, to: unit },
});

const lost = (unit: number, text: string): Cited => ({
  quote: text,
  check: "not-found",
  checkReason: "quote-not-on-pages",
  contentHash: null,
  passageId: null,
  pageFrom: unit,
  pageTo: unit,
  location: { kind: "page", from: unit, to: unit },
});

/** A store over a PDF's own rows, its citer answering as the test says. */
async function harness() {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const sources = await createSourceFolder();
  const path = await writeSourceFile(
    sources,
    "Marks.pdf",
    buildPdf([{ lines: ["The first line of the note.", "The second line of it."] }]),
  );
  const [document] = await addAndProcess(core, [path]);
  if (!document) throw new Error("The Document wasn't added.");
  core.close();
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  // The real read's rows would be a version of their own: start each test from none.
  db.run("DELETE FROM document_annotations WHERE document_id = ?", [document.id]);
  let answer: (unit: number, text: string) => Cited = found;
  const citer: AnnotationCiter = {
    currentVersion: () => null,
    cite: (_documentId, anchor) =>
      answer(anchor.unit ?? anchor.parts[0]?.unit ?? 1, anchor.parts[0]?.text ?? ""),
  };
  const store = createAnnotations(db, () => new Date().toISOString(), citer);
  const read = (
    contentHash: string,
    rows: readonly FileAnnotation[],
    next: (unit: number, text: string) => Cited = found,
  ) => {
    answer = next;
    store.replaceFileAnnotations(document.id, contentHash, rows);
  };
  return { document, store, db, read };
}

const highlight = (
  quote: string,
  page = 1,
  note: string | null = null,
  order = 0,
  around: { before?: string; after?: string } = {},
  others: FileAnnotation["others"] = [],
): FileAnnotation => ({
  page,
  kind: "highlight",
  quote,
  note,
  colour: "yellow",
  author: "Priya Raman",
  order,
  before: around.before ?? "",
  after: around.after ?? "",
  others,
});

/** A sticky note the file holds, at `order` on its page, with the words around it. */
const fileNote = (
  page: number,
  said: string,
  order = 0,
  around: { before?: string; after?: string } = {},
): FileAnnotation => ({
  page,
  kind: "note",
  quote: "",
  note: said,
  colour: "yellow",
  author: "Priya Raman",
  order,
  before: around.before ?? "",
  after: around.after ?? "",
  others: [],
});

test("a re-read of the same version keeps the User's edit and delete", async () => {
  const { document, store, read, db } = await harness();
  const rows = [
    highlight("The first line of the note.", 1, "Compare with Table 3."),
    fileNote(1, "Check this figure."),
  ];
  read("version-a", rows);
  const [edited, deleted] = store.list(document.id);
  if (!edited || !deleted) throw new Error("The file's annotations weren't read.");
  store.update(edited.id, { note: "Mine", colour: "pink" });
  store.remove(deleted.id);
  read("version-a", rows);
  const reread = store.list(document.id);
  expect(
    reread.map((row) => ({ id: row.id, note: row.note, colour: row.colour })),
    "the same highlight, with the User's note and colour, and the note they deleted still gone",
  ).toEqual([{ id: edited.id, note: "Mine", colour: "pink" }]);
  db.close();
});

test("a new version keeps a one-line highlight's row, comment and colour", async () => {
  const { document, store, read, db } = await harness();
  read("version-a", [highlight("The first line of the note.")]);
  const [before] = store.list(document.id);
  if (!before) throw new Error("The highlight wasn't read.");
  store.update(before.id, { note: "Mine", colour: "pink" });

  read("version-b", [highlight("The first line of the note.")]);
  expect(store.list(document.id)).toMatchObject([
    { id: before.id, note: "Mine", colour: "pink", missing: false },
  ]);
  db.close();
});

test("a two-line highlight's comment and colour stay when the read's quote breaks the lines", async () => {
  const { document, store, read, db } = await harness();
  const raw = highlight("The first line of the note.\nThe second line of it.");
  read("version-a", [raw]);
  const [before] = store.list(document.id);
  if (!before) throw new Error("The highlight wasn't read.");
  store.update(before.id, { note: "Mine", colour: "pink" });

  read("version-b", [raw]);
  expect(store.list(document.id)).toMatchObject([
    {
      id: before.id,
      quote: "The first line of the note. The second line of it.",
      note: "Mine",
      colour: "pink",
    },
  ]);
  db.close();
});

test("a highlight keeps its row as its words move pages, and comes back", async () => {
  const { document, store, read, db } = await harness();
  const row = highlight("The first line of the note.");
  read("version-a", [row], (_unit, text) => found(1, text));
  const [before] = store.list(document.id);
  if (!before) throw new Error("The highlight wasn't read.");
  store.update(before.id, { note: "Mine", colour: "pink" });

  read("version-b", [row], (_unit, text) => found(2, text));
  expect(store.list(document.id)).toMatchObject([
    { id: before.id, pageFrom: 2, note: "Mine", colour: "pink", missing: false },
  ]);
  read("version-c", [row], (_unit, text) => found(3, text));
  expect(store.list(document.id)).toMatchObject([
    { id: before.id, pageFrom: 3, note: "Mine", colour: "pink", missing: false },
  ]);
  read("version-b", [row], (_unit, text) => found(2, text));
  expect(store.list(document.id)).toMatchObject([{ id: before.id, pageFrom: 2, missing: false }]);
  db.close();
});

test("a highlight a new version lacks says it is missing, and comes back in place", async () => {
  const { document, store, read, db } = await harness();
  const row = highlight("The first line of the note.");
  read("version-a", [row], (_unit, text) => found(1, text));
  const [before] = store.list(document.id);
  if (!before) throw new Error("The highlight wasn't read.");

  read("version-b", [row], (unit, text) => lost(unit, text));
  expect(store.list(document.id)).toMatchObject([
    { id: before.id, missing: true, check: "not-found" },
  ]);

  read("version-a", [row], (_unit, text) => found(1, text));
  expect(store.list(document.id)).toMatchObject([
    { id: before.id, missing: false, check: "found" },
  ]);
  db.close();
});

test("a row the new version lacks stays in the list, missing", async () => {
  const { document, store, read, db } = await harness();
  read("version-a", [highlight("The first line of the note.")]);
  const [before] = store.list(document.id);
  if (!before) throw new Error("The highlight wasn't read.");

  read("version-b", []);
  expect(store.list(document.id)).toMatchObject([{ id: before.id, missing: true }]);
  db.close();
});

test("a file highlight whose words aren't on its page is not found", async () => {
  const { document, store, read, db } = await harness();
  read("version-a", [highlight("The first line of the note.")], (unit, text) => lost(unit, text));
  expect(store.list(document.id)).toMatchObject([
    { quote: "The first line of the note.", check: "not-found", missing: true, passageId: null },
  ]);
  db.close();
});

test("a file highlight a version lacks keeps the current version and no Passage", async () => {
  const { document, store, read, db } = await harness();
  read("version-a", [highlight("The first line of the note.")]);
  const [before] = store.list(document.id);
  if (!before) throw new Error("The highlight wasn't read.");

  read("version-b", []);
  expect(store.list(document.id)).toMatchObject([
    {
      id: before.id,
      contentHash: "version-b",
      passageId: null,
      check: "not-found",
      missing: true,
    },
  ]);
  db.close();
});

test("the same words twice, with a page inserted in front, each comment follows its copy", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  read("version-a", [highlight(quote, 1), highlight(quote, 2)]);
  const [first, second] = store
    .list(document.id)
    .sort((a, b) => (a.pageFrom ?? 0) - (b.pageFrom ?? 0));
  if (!first || !second) throw new Error("Both highlights weren't read.");
  store.update(first.id, { note: "first" });
  store.update(second.id, { note: "second" });

  read("version-b", [highlight(quote, 2), highlight(quote, 3)]);
  const reread = store.list(document.id);
  // Every copy moved one page with its page: the comments follow their own copies, none missing.
  expect(reread.find((row) => row.id === first.id)).toMatchObject({
    pageFrom: 2,
    note: "first",
    missing: false,
  });
  expect(reread.find((row) => row.id === second.id)).toMatchObject({
    pageFrom: 3,
    note: "second",
    missing: false,
  });
  db.close();
});

test("a new sticky note on another page leaves the old note its comment", async () => {
  const { document, store, read, db } = await harness();
  const note = (page: number, said: string): FileAnnotation => fileNote(page, said);
  read("version-a", [note(1, "Mine")]);
  const [before] = store.list(document.id);
  if (!before) throw new Error("The note wasn't read.");
  store.update(before.id, { note: "Mine, rewritten" });

  read("version-b", [note(2, "New remark")]);
  const [old, fresh] = store
    .list(document.id)
    .sort((a, b) => (a.pageFrom ?? 0) - (b.pageFrom ?? 0));
  expect(old).toMatchObject({ id: before.id, pageFrom: 1, note: "Mine, rewritten", missing: true });
  expect(fresh).toMatchObject({ pageFrom: 2, note: "New remark" });
  expect(fresh?.id).not.toBe(before.id);
  db.close();
});

test("a two-line highlight matches a read whose cite lost the line break", async () => {
  const { document, store, read, db } = await harness();
  const raw = highlight("The first line of the note.\nThe second line of it.");
  read("version-a", [raw]);
  const [before] = store.list(document.id);
  if (!before) throw new Error("The highlight wasn't read.");
  store.update(before.id, { note: "Mine" });

  read("version-b", [raw], (unit, text) => lost(unit, text));
  expect(store.list(document.id)).toMatchObject([{ id: before.id, missing: true, note: "Mine" }]);
  db.close();
});

test("the same version with one of two marks still keeps that mark's row", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  read("version-a", [highlight(quote, 1), highlight(quote, 2)]);
  const second = store.list(document.id).find((row) => row.pageFrom === 2);
  if (!second) throw new Error("The second highlight wasn't read.");
  store.update(second.id, { note: "second" });

  read("version-a", [highlight(quote, 2)]);
  const reread = store.list(document.id).sort((a, b) => (a.pageFrom ?? 0) - (b.pageFrom ?? 0));
  expect(reread).toMatchObject([
    { pageFrom: 1, missing: true },
    { id: second.id, pageFrom: 2, note: "second", missing: false },
  ]);
  db.close();
});

test("a file's own note follows the file until the User edits it", async () => {
  const { document, store, read, db } = await harness();
  read("version-a", [highlight("The first line of the note.", 1, "Compare with Table 3.")]);
  expect(store.list(document.id)[0]).toMatchObject({ note: "Compare with Table 3." });

  read("version-b", [highlight("The first line of the note.", 1, "Compare with Table 4.")]);
  expect(store.list(document.id)[0]).toMatchObject({ note: "Compare with Table 4." });

  const [row] = store.list(document.id);
  if (!row) throw new Error("The highlight wasn't read.");
  store.update(row.id, { note: "Mine" });
  read("version-c", [highlight("The first line of the note.", 1, "Compare with Table 5.")]);
  expect(store.list(document.id)[0]).toMatchObject({ note: "Mine" });
  db.close();
});

test("identical words that did not pair do not add missing rows on each version", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const copy = (page: number) =>
    highlight(quote, page, null, page, { before: `Before ${page}.`, after: `After ${page}.` });
  read("version-a", [copy(1), copy(2), copy(3)]);
  // Three words, two marks: the words around the two that stayed find their rows.
  read("version-b", [copy(1), copy(3)]);
  expect(store.list(document.id)).toHaveLength(3);
  // Read again: the rows pair in place, and no empty row is added.
  read("version-c", [copy(1), copy(3)]);
  expect(store.list(document.id)).toHaveLength(3);
  db.close();
});

test("two notes on one page keep their own comments when one is dropped", async () => {
  const { document, store, read, db } = await harness();
  const note = (said: string): FileAnnotation => fileNote(1, said);
  read("version-a", [note("First"), note("Second")]);
  const first = store.list(document.id).find((row) => row.note === "First");
  if (!first) throw new Error("The first note wasn't read.");
  store.update(first.id, { note: "Mine" });

  read("version-b", [note("Second")]);
  const rows = store.list(document.id);
  expect(rows.find((row) => row.id === first.id)).toMatchObject({
    note: "Mine",
    missing: true,
  });
  expect(rows.find((row) => row.id !== first.id)).toMatchObject({ note: "Second", missing: false });
  db.close();
});

test("a file's colour follows the file until the User recolours", async () => {
  const { document, store, read, db } = await harness();
  const coloured = (colour: "yellow" | "pink"): FileAnnotation => ({
    page: 1,
    kind: "highlight",
    quote: "The first line of the note.",
    note: null,
    colour,
    author: "Priya Raman",
    order: 10,
    before: "",
    after: "",
    others: [],
  });
  read("version-a", [coloured("yellow")]);
  read("version-b", [coloured("pink")]);
  expect(store.list(document.id)[0]).toMatchObject({ colour: "pink" });

  const [row] = store.list(document.id);
  if (!row) throw new Error("The highlight wasn't read.");
  store.update(row.id, { colour: "green" });
  read("version-c", [coloured("pink")]);
  expect(store.list(document.id)[0]).toMatchObject({ colour: "green" });
  db.close();
});

test("a note the file drops does not hand the User's rewritten comment to a new one", async () => {
  const { document, store, read, db } = await harness();
  const note = (said: string): FileAnnotation => fileNote(1, said);
  read("version-a", [note("X text.")]);
  const [before] = store.list(document.id);
  if (!before) throw new Error("The note wasn't read.");
  store.update(before.id, { note: "Mine about X." });

  read("version-b", [note("Z text.")]);
  const rows = store.list(document.id).sort((a, b) => (a.pageFrom ?? 0) - (b.pageFrom ?? 0));
  expect(rows.find((row) => row.id === before.id)).toMatchObject({
    note: "Mine about X.",
    missing: true,
  });
  expect(rows.find((row) => row.id !== before.id)).toMatchObject({
    note: "Z text.",
    missing: false,
  });
  db.close();
});

test("after a page is inserted, a rewritten note moves with its page", async () => {
  const { document, store, read, db } = await harness();
  const note = (page: number, said: string): FileAnnotation => fileNote(page, said);
  read("version-a", [note(1, "Check."), note(2, "Check.")]);
  const second = store.list(document.id).find((row) => row.pageFrom === 2);
  if (!second) throw new Error("The page-2 note wasn't read.");
  store.update(second.id, { note: "Mine about page two." });

  read("version-b", [note(2, "Check."), note(3, "Check.")]);
  const rows = store.list(document.id).sort((a, b) => (a.pageFrom ?? 0) - (b.pageFrom ?? 0));
  expect(rows.find((row) => row.pageFrom === 2)).toMatchObject({ note: "Check.", missing: false });
  expect(rows.find((row) => row.id === second.id)).toMatchObject({
    pageFrom: 3,
    note: "Mine about page two.",
    missing: false,
  });
  db.close();
});

test("notes with equal counts and uneven shifts keep their rows apart", async () => {
  const { document, store, read, db } = await harness();
  const note = (page: number): FileAnnotation => fileNote(page, "Same.");
  read("version-a", [note(1), note(4)]);
  read("version-b", [note(2), note(7)]);
  const rows = store.list(document.id).sort((a, b) => (a.pageFrom ?? 0) - (b.pageFrom ?? 0));
  expect(rows.filter((row) => row.missing).map((row) => row.pageFrom)).toEqual([1, 4]);
  expect(rows.filter((row) => !row.missing).map((row) => row.pageFrom)).toEqual([2, 7]);
  db.close();
});

test("an untouched note the file replaces on its page follows the file", async () => {
  const { document, store, read, db } = await harness();
  const note = (said: string): FileAnnotation => fileNote(1, said);
  read("version-a", [note("X text.")]);
  const [before] = store.list(document.id);
  if (!before) throw new Error("The note wasn't read.");
  read("version-b", [note("Z text.")]);
  expect(store.list(document.id)).toMatchObject([
    { id: before.id, note: "Z text.", missing: false },
  ]);
  db.close();
});

test("a note group counts its live rows first, so missing rows do not pile up", async () => {
  const { document, store, read, db } = await harness();
  const note = (page: number): FileAnnotation => fileNote(page, "Check.");
  read("version-a", [note(1), note(2), note(3)]);
  for (const row of store.list(document.id))
    store.update(row.id, { note: `Mine ${row.pageFrom}.` });
  // A page inserted after page 1 moves two notes and leaves one: no single shift pairs them.
  read("version-b", [note(1), note(3), note(4)]);
  expect(store.list(document.id)).toHaveLength(6);
  // Only an end page added: the live rows pair in place and no empty rows are added.
  read("version-c", [note(1), note(3), note(4)]);
  expect(store.list(document.id)).toHaveLength(6);
  expect(store.list(document.id).filter((row) => row.note?.startsWith("Mine"))).toHaveLength(3);
  db.close();
});

test("a re-read of the same version changes nothing", async () => {
  const { document, store, read, db } = await harness();
  const rows = [highlight("The first line of the note.")];
  read("version-a", rows);
  const [before] = store.list(document.id);
  if (!before) throw new Error("The highlight wasn't read.");
  read("version-a", rows);
  const [after] = store.list(document.id);
  expect(after?.updatedAt).toBe(before.updatedAt);
  expect(after?.id).toBe(before.id);
  db.close();
});

test("a deleted missing row does not hide a new copy", async () => {
  const { document, store, read, db } = await harness();
  read("version-a", [highlight("The fee is fixed.", 1)]);
  const [row] = store.list(document.id);
  if (!row) throw new Error("The highlight wasn't read.");
  store.remove(row.id);

  read("version-b", []);
  read("version-c", [highlight("The fee is fixed.", 6), highlight("The fee is fixed.", 7)]);
  const live = store.list(document.id).sort((a, b) => (a.pageFrom ?? 0) - (b.pageFrom ?? 0));
  expect(live.map((each) => each.pageFrom)).toEqual([6, 7]);
  expect(live.every((each) => !each.missing)).toBe(true);
  db.close();
});

test("a second re-read writes no database change", async () => {
  const { read, db } = await harness();
  const rows = [highlight("Same.", 1), highlight("Same.", 2)];
  read("version-a", rows);
  const changes = () => db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0;
  const before = changes();
  read("version-a", rows);
  expect(changes()).toBe(before);
  db.close();
});

test("two copies of the same words on one page keep their own comments on a re-read", async () => {
  const { document, store, read, db } = await harness();
  const quote = "the Seller";
  const copies = () => [
    highlight(quote, 1, "First mention.", 10, around("first")),
    highlight(quote, 1, "Second mention.", 20, around("second")),
  ];
  read("version-a", copies());
  const first = store.list(document.id).find((row) => row.note === "First mention.");
  if (!first) throw new Error("The first copy wasn't read.");
  store.update(first.id, { note: "Mine about the first." });
  const changes = () => db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0;
  const before = changes();
  read("version-a", copies());
  expect(store.list(document.id).find((row) => row.id === first.id)?.note).toBe(
    "Mine about the first.",
  );
  expect(changes()).toBe(before);
  db.close();
});

test("a file flipping between two copies and one stops growing rows", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const copy = (page: number) =>
    highlight(quote, page, null, page, { before: `Before ${page}.`, after: `After ${page}.` });
  const two = () => [copy(1), copy(2)];
  read("version-two", two());
  const first = store.list(document.id).find((row) => row.pageFrom === 1);
  if (!first) throw new Error("The page-1 copy wasn't read.");
  store.update(first.id, { note: "Mine on page 1." });

  read("version-one", [copy(1)]);
  expect(store.list(document.id)).toHaveLength(2);
  read("version-two-again", two());
  expect(store.list(document.id)).toHaveLength(2);
  const pageOne = store.list(document.id).find((row) => row.id === first.id);
  expect(pageOne).toMatchObject({ note: "Mine on page 1.", missing: false });
  read("version-one-again", [copy(1)]);
  expect(store.list(document.id)).toHaveLength(2);
  db.close();
});

test("a note of the same version on its page is carried when the group cannot pair", async () => {
  const { document, store, read, db } = await harness();
  const note = (page: number): FileAnnotation => fileNote(page, "Check.");
  read("version-a", [note(1), note(2)]);
  const second = store.list(document.id).find((row) => row.pageFrom === 2);
  if (!second) throw new Error("The page-2 note wasn't read.");
  store.update(second.id, { note: "Mine." });

  read("version-a", [note(2)]);
  const rows = store.list(document.id);
  expect(rows.find((row) => row.id === second.id)).toMatchObject({
    note: "Mine.",
    pageFrom: 2,
    missing: false,
  });
  expect(rows.find((row) => row.id !== second.id)?.missing).toBe(true);
  db.close();
});

test("a note of another version is not carried by the same-page fallback", async () => {
  const { document, store, read, db } = await harness();
  const note = (page: number): FileAnnotation => fileNote(page, "Check.");
  read("version-a", [note(1), note(2)]);
  const second = store.list(document.id).find((row) => row.pageFrom === 2);
  if (!second) throw new Error("The page-2 note wasn't read.");
  store.update(second.id, { note: "Mine." });

  read("version-b", [note(2)]);
  const rows = store.list(document.id);
  expect(rows.find((row) => row.id === second.id)).toMatchObject({ note: "Mine.", missing: true });
  expect(rows.filter((row) => !row.missing && row.pageFrom === 2)).toHaveLength(1);
  db.close();
});

test("two untouched notes on a page are not handed one new note's row", async () => {
  const { document, store, read, db } = await harness();
  const note = (said: string): FileAnnotation => fileNote(1, said);
  read("version-a", [note("X."), note("Y.")]);
  read("version-b", [note("Z.")]);
  const rows = store.list(document.id);
  expect(rows).toHaveLength(3);
  expect(rows.filter((row) => row.missing)).toHaveLength(2);
  expect(rows.find((row) => row.note === "Z.")?.missing).toBe(false);
  db.close();
});

test("identical words that come back bring their comments back", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  read("version-a", [highlight(quote, 1), highlight(quote, 2)]);
  const [first, second] = store
    .list(document.id)
    .sort((a, b) => (a.pageFrom ?? 0) - (b.pageFrom ?? 0));
  if (!first || !second) throw new Error("Both highlights weren't read.");
  store.update(first.id, { note: "first" });
  store.update(second.id, { note: "second" });

  read("version-b", []);
  expect(store.list(document.id).every((row) => row.missing)).toBe(true);
  read("version-c", [highlight(quote, 1), highlight(quote, 2)]);
  const back = store.list(document.id).sort((a, b) => (a.pageFrom ?? 0) - (b.pageFrom ?? 0));
  expect(back).toMatchObject([
    { id: first.id, note: "first", missing: false },
    { id: second.id, note: "second", missing: false },
  ]);
  db.close();
});

test("an unpaired deleted row says it is missing, and Undo brings it back not-found", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  read("version-a", [highlight(quote, 1), highlight(quote, 2)]);
  const second = store.list(document.id).find((row) => row.pageFrom === 2);
  if (!second) throw new Error("The page-2 highlight wasn't read.");
  store.remove(second.id);

  read("version-b", [highlight(quote, 1)]);
  store.restore(second.id);
  expect(store.list(document.id).find((row) => row.id === second.id)).toMatchObject({
    missing: true,
    check: "not-found",
    passageId: null,
  });
  db.close();
});

test("a re-read whose citer loses one copy writes no row", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  read("version-a", [highlight(quote, 1), highlight(quote, 2)]);
  const ids = store
    .list(document.id)
    .map((row) => row.id)
    .sort();

  read("version-a", [highlight(quote, 1), highlight(quote, 2)], (unit, text) =>
    unit === 2 ? lost(unit, text) : found(unit, text),
  );
  const rows = store.list(document.id);
  expect(rows.map((row) => row.id).sort()).toEqual(ids);
  expect(rows.find((row) => row.pageFrom === 2)?.missing).toBe(true);
  db.close();
});

test("a deleted file highlight stays deleted when a new version still has its words", async () => {
  const { document, store, read, db } = await harness();
  const row = highlight("The first line of the note.");
  read("version-a", [row]);
  const [before] = store.list(document.id);
  if (!before) throw new Error("The highlight wasn't read.");
  store.remove(before.id);

  read("version-b", [row]);
  expect(store.list(document.id)).toEqual([]);
  db.close();
});

/** The words around a copy, which stay with it as its page moves. */
const around = (id: string) => ({ before: `Before ${id}.`, after: `After ${id}.` });

/** The live row at `order` on its page, from the file's own place for it. */
function rowAt(
  db: ReturnType<typeof openDatabase>,
  documentId: string,
  order: number,
): { id: string } | undefined {
  return db.get<{ id: string }>(
    "SELECT id FROM document_annotations WHERE document_id = ? AND file_order = ? AND deleted_at IS NULL",
    [documentId, order],
  );
}

test("a cover page in front keeps each comment with its own copy", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const copy = (page: number, id: string, order: number) =>
    highlight(quote, page, null, order, around(id));
  read("version-a", [copy(1, "a", 10), copy(2, "b", 20)]);
  const first = store.list(document.id).find((row) => row.pageFrom === 1);
  const second = store.list(document.id).find((row) => row.pageFrom === 2);
  if (!first || !second) throw new Error("Both highlights weren't read.");
  store.update(first.id, { note: "first" });
  store.update(second.id, { note: "second" });

  read("version-b", [copy(2, "a", 10), copy(3, "b", 20)]);
  const rows = store.list(document.id);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.id === first.id)).toMatchObject({
    pageFrom: 2,
    note: "first",
    missing: false,
  });
  expect(rows.find((row) => row.id === second.id)).toMatchObject({
    pageFrom: 3,
    note: "second",
    missing: false,
  });
  db.close();
});

test("two or three copies, pages put in front, keep every comment", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const copy = (page: number, id: string, order: number) =>
    highlight(quote, page, null, order, around(id));

  read("first-a", [copy(1, "a", 10), copy(3, "b", 30)]);
  const pair = store.list(document.id);
  const low = pair.find((row) => row.pageFrom === 1);
  const high = pair.find((row) => row.pageFrom === 3);
  if (!low || !high) throw new Error("Both highlights weren't read.");
  store.update(low.id, { note: "a" });
  store.update(high.id, { note: "b" });
  read("first-b", [copy(3, "a", 10), copy(5, "b", 30)]);
  expect(store.list(document.id).find((row) => row.id === low.id)).toMatchObject({
    pageFrom: 3,
    note: "a",
    missing: false,
  });
  expect(store.list(document.id).find((row) => row.id === high.id)).toMatchObject({
    pageFrom: 5,
    note: "b",
    missing: false,
  });

  const three = [copy(1, "c", 11), copy(2, "d", 22), copy(3, "e", 33)];
  read("second-a", three);
  for (const [page, said] of [
    [1, "c"],
    [2, "d"],
    [3, "e"],
  ] as const) {
    const row = store.list(document.id).find((each) => each.pageFrom === page);
    if (!row) throw new Error(`The page-${page} copy wasn't read.`);
    store.update(row.id, { note: said });
  }
  read("second-b", [copy(2, "c", 11), copy(3, "d", 22), copy(4, "e", 33)]);
  for (const [page, said] of [
    [2, "c"],
    [3, "d"],
    [4, "e"],
  ] as const) {
    expect(store.list(document.id).find((row) => row.pageFrom === page)).toMatchObject({
      note: said,
      missing: false,
    });
  }
  db.close();
});

test("a page added after page one leaves page three's comment on page three's copy", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const copy = (page: number, id: string, order: number) =>
    highlight(quote, page, null, order, around(id));
  read("version-a", [copy(1, "a", 10), copy(2, "b", 20), copy(3, "c", 30)]);
  const rows = new Map(
    (
      [
        [1, "a"],
        [2, "b"],
        [3, "c"],
      ] as const
    ).map(([page, said]) => {
      const row = store.list(document.id).find((each) => each.pageFrom === page);
      if (!row) throw new Error(`The page-${page} copy wasn't read.`);
      store.update(row.id, { note: said });
      return [said, row.id] as const;
    }),
  );

  read("version-b", [copy(1, "a", 10), copy(3, "b", 20), copy(4, "c", 30)]);
  expect(store.list(document.id).find((row) => row.id === rows.get("a"))).toMatchObject({
    pageFrom: 1,
    note: "a",
    missing: false,
  });
  expect(store.list(document.id).find((row) => row.id === rows.get("b"))).toMatchObject({
    pageFrom: 3,
    note: "b",
    missing: false,
  });
  expect(store.list(document.id).find((row) => row.id === rows.get("c"))).toMatchObject({
    pageFrom: 4,
    note: "c",
    missing: false,
  });
  db.close();
});

test("page one of three removed leaves each comment with its own words", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const copy = (page: number, id: string, order: number) =>
    highlight(quote, page, null, order, around(id));
  read("version-a", [copy(1, "alpha", 10), copy(2, "beta", 20), copy(3, "gamma", 30)]);
  const alpha = store.list(document.id).find((row) => row.pageFrom === 1);
  const beta = store.list(document.id).find((row) => row.pageFrom === 2);
  const gamma = store.list(document.id).find((row) => row.pageFrom === 3);
  if (!alpha || !beta || !gamma) throw new Error("The three highlights weren't read.");
  store.update(alpha.id, { note: "alpha" });
  store.update(beta.id, { note: "beta" });
  store.update(gamma.id, { note: "gamma" });

  read("version-b", [copy(1, "beta", 20), copy(2, "gamma", 30)]);
  const rows = store.list(document.id);
  expect(rows.find((row) => row.id === alpha.id)).toMatchObject({ note: "alpha", missing: true });
  expect(rows.find((row) => row.id === beta.id)).toMatchObject({
    pageFrom: 1,
    note: "beta",
    missing: false,
  });
  expect(rows.find((row) => row.id === gamma.id)).toMatchObject({
    pageFrom: 2,
    note: "gamma",
    missing: false,
  });
  db.close();
});

test("three copies on one page, one dropped, keep their own comments", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const copy = (id: string, order: number) => highlight(quote, 1, null, order, around(id));
  read("version-a", [copy("a", 10), copy("b", 20), copy("c", 30)]);
  const ids = new Map<string, string>();
  for (const [, order, said] of [
    ["a", 10, "A"],
    ["b", 20, "B"],
    ["c", 30, "C"],
  ] as const) {
    const row = rowAt(db, document.id, order);
    if (!row) throw new Error(`The copy at ${order} wasn't read.`);
    store.update(row.id, { note: said });
    ids.set(said, row.id);
  }

  read("version-b", [copy("a", 10), copy("c", 30)]);
  const rows = store.list(document.id);
  expect(rows).toHaveLength(3);
  expect(rows.find((row) => row.id === ids.get("A"))).toMatchObject({
    note: "A",
    missing: false,
  });
  expect(rows.find((row) => row.id === ids.get("B"))).toMatchObject({ note: "B", missing: true });
  expect(rows.find((row) => row.id === ids.get("C"))).toMatchObject({
    note: "C",
    missing: false,
  });
  db.close();
});

test("a missing row is not handed to a new copy elsewhere", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  read("version-a", [highlight(quote, 1, null, 10, around("one"))]);
  const [before] = store.list(document.id);
  if (!before) throw new Error("The highlight wasn't read.");
  store.update(before.id, { note: "Mine" });

  read("version-b", []);
  read("version-c", [highlight(quote, 2, null, 20, around("two"))]);
  const rows = store.list(document.id);
  expect(rows.find((row) => row.id === before.id)).toMatchObject({
    note: "Mine",
    missing: true,
  });
  const fresh = rows.find((row) => row.id !== before.id);
  expect(fresh).toMatchObject({ pageFrom: 2, missing: false });
  expect(fresh?.note).not.toBe("Mine");
  db.close();
});

test("a re-read of the same version writes nothing and moves nothing, over repeats", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const rows = () => [
    highlight(quote, 1, null, 10, around("a")),
    highlight(quote, 2, null, 20, around("b")),
  ];
  read("version-a", rows());
  const [first, second] = store
    .list(document.id)
    .sort((a, b) => (a.pageFrom ?? 0) - (b.pageFrom ?? 0));
  if (!first || !second) throw new Error("Both highlights weren't read.");
  store.update(first.id, { note: "first" });
  store.update(second.id, { note: "second" });

  const changes = () => db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0;
  const before = changes();
  for (let repeat = 0; repeat < 5; repeat++) read("version-a", rows());
  expect(changes()).toBe(before);
  expect(store.list(document.id).find((row) => row.id === first.id)).toMatchObject({
    pageFrom: 1,
    note: "first",
    missing: false,
  });
  expect(store.list(document.id).find((row) => row.id === second.id)).toMatchObject({
    pageFrom: 2,
    note: "second",
    missing: false,
  });
  db.close();
});

test("a re-read after a copy returns writes nothing and keeps the comment", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const a = () => highlight(quote, 1, null, 10, around("a"));
  const b = () => highlight(quote, 3, null, 30, around("b"));
  read("version-a", [a(), b()]);
  const pageThree = store.list(document.id).find((row) => row.pageFrom === 3);
  if (!pageThree) throw new Error("The page-3 copy wasn't read.");
  store.update(pageThree.id, { note: "Mine on page three." });

  // The version keeps only page 3's copy, and the one after adds a copy below it, on page 3.
  const below = () => highlight(quote, 3, null, 40, around("c"));
  read("version-b", [b()]);
  read("version-c", [b(), below()]);
  const settled = store.list(document.id);
  const changes = () => db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0;
  const before = changes();
  read("version-c", [b(), below()]);
  expect(changes()).toBe(before);
  const reread = store.list(document.id);
  expect(reread.map((row) => row.id).sort()).toEqual(settled.map((row) => row.id).sort());
  expect(reread.find((row) => row.id === pageThree.id)).toMatchObject({
    pageFrom: 3,
    note: "Mine on page three.",
    missing: false,
  });
  db.close();
});

test("same-page copies the file lists in another order keep their own comments, over trials", async () => {
  const { document, store, read, db } = await harness();
  const quote = "the Seller";
  const copies = () => [
    highlight(quote, 1, "First mention.", 10, around("first")),
    highlight(quote, 1, "Second mention.", 20, around("second")),
  ];
  read("version-a", copies());
  const first = rowAt(db, document.id, 10);
  if (!first) throw new Error("The first copy wasn't read.");
  store.update(first.id, { note: "Mine about the first." });

  const changes = () => db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0;
  const before = changes();
  for (let trial = 0; trial < 30; trial++) {
    const marks = copies();
    // The file lists them the other way round on some reads.
    read("version-a", trial % 2 === 0 ? marks : marks.reverse());
    expect(rowAt(db, document.id, 10)?.id, `trial ${trial}`).toBe(first.id);
    expect(store.list(document.id).find((row) => row.id === first.id)).toMatchObject({
      note: "Mine about the first.",
      missing: false,
    });
  }
  expect(changes()).toBe(before);
  db.close();
});

test("both readings fit, so neither comment moves to the other copy", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const shared = { before: "The same words.", after: "The same words." };
  const copy = (order: number) => highlight(quote, 1, null, order, shared);
  read("version-a", [copy(10), copy(20)]);
  const first = rowAt(db, document.id, 10);
  const second = rowAt(db, document.id, 20);
  if (!first || !second) throw new Error("Both copies weren't read.");
  store.update(first.id, { note: "first" });
  store.update(second.id, { note: "second" });

  // One copy dropped, another added: the words around each fit both rows, so neither comment
  // is guessed onto another copy; the new copies show without them.
  read("version-b", [copy(20), copy(30)]);
  const rows = store.list(document.id);
  expect(rows.find((row) => row.id === first.id)).toMatchObject({ note: "first", missing: true });
  expect(rows.find((row) => row.id === second.id)).toMatchObject({
    note: "second",
    missing: true,
  });
  expect(rows.filter((row) => !row.missing)).toHaveLength(2);
  expect(rows.filter((row) => !row.missing && row.note !== null && row.note !== "")).toHaveLength(
    0,
  );
  db.close();
});

test("a file flipping between two copies and one brings both comments back over versions", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const a = () => highlight(quote, 1, null, 10, around("a"));
  const b = () => highlight(quote, 2, null, 20, around("b"));
  read("v0", [a(), b()]);
  const [first, second] = store
    .list(document.id)
    .sort((one, other) => (one.pageFrom ?? 0) - (other.pageFrom ?? 0));
  if (!first || !second) throw new Error("Both highlights weren't read.");
  store.update(first.id, { note: "first" });
  store.update(second.id, { note: "second" });

  for (let step = 1; step <= 12; step++) {
    read(`v${step}`, step % 2 === 1 ? [a()] : [a(), b()]);
    const rows = store.list(document.id);
    expect(rows, `version ${step}`).toHaveLength(2);
    expect(rows.find((row) => row.id === first.id)).toMatchObject({
      note: "first",
      missing: false,
    });
    expect(rows.find((row) => row.id === second.id)).toMatchObject({
      note: "second",
      missing: step % 2 !== 0,
    });
  }
  db.close();
});

test("a deleted sticky note does not hide a new note on its page", async () => {
  const { document, store, read, db } = await harness();
  read("version-a", [fileNote(3, "Old remark.")]);
  const [old] = store.list(document.id);
  if (!old) throw new Error("The note wasn't read.");
  store.remove(old.id);

  read("version-b", []);
  read("version-c", [fileNote(3, "A new remark.")]);
  const live = store.list(document.id);
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({ pageFrom: 3, note: "A new remark.", missing: false });
  expect(live[0]?.id).not.toBe(old.id);
  db.close();
});

test("a copied page in front does not hide the note the copy repeats", async () => {
  const { document, store, read, db } = await harness();
  const same = { before: "Page words.", after: "Page words." };
  read("version-a", [fileNote(1, "Same remark.", 10, same)]);
  const [old] = store.list(document.id);
  if (!old) throw new Error("The note wasn't read.");
  store.remove(old.id);

  // The page is copied in front, so the same note is on pages 1 and 2, with the same
  // words around it as the deleted row.
  read("version-b", [fileNote(1, "Same remark.", 10, same), fileNote(2, "Same remark.", 10, same)]);
  const live = store.list(document.id);
  expect(live).toHaveLength(2);
  expect(live.map((row) => row.pageFrom).sort()).toEqual([1, 2]);
  expect(live.some((row) => row.id === old.id)).toBe(false);
  db.close();
});

test("copies whose words around them are the same keep their comments on a save", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const same = { before: "Alpha words.", after: "Alpha words." };
  const other = { before: "Beta words.", after: "Beta words." };
  const marks = () => [
    highlight(quote, 1, "One.", 10, same),
    highlight(quote, 2, "Two.", 10, same),
    highlight(quote, 3, null, 10, other),
  ];
  read("version-a", marks());
  const one = store.list(document.id).find((row) => row.pageFrom === 1);
  const two = store.list(document.id).find((row) => row.pageFrom === 2);
  if (!one || !two) throw new Error("The copies weren't read.");
  store.update(one.id, { note: "Mine one" });
  store.update(two.id, { note: "Mine two" });

  read("version-b", marks());
  expect(store.list(document.id)).toHaveLength(3);
  expect(store.list(document.id).find((row) => row.id === one.id)).toMatchObject({
    pageFrom: 1,
    note: "Mine one",
    missing: false,
  });
  expect(store.list(document.id).find((row) => row.id === two.id)).toMatchObject({
    pageFrom: 2,
    note: "Mine two",
    missing: false,
  });

  read("version-c", marks());
  expect(store.list(document.id)).toHaveLength(3);
  expect(store.list(document.id).find((row) => row.id === one.id)).toMatchObject({
    note: "Mine one",
    missing: false,
  });
  db.close();
});

test("identical forms with one removed keep their rows on later saves", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const same = { before: "Form words.", after: "Form words." };
  const form = (page: number) => highlight(quote, page, null, 10, same);
  read("version-a", [form(1), form(2), form(3)]);

  const copy = [form(1), form(2)];
  read("version-b", copy);
  expect(store.list(document.id)).toHaveLength(3);
  read("version-c", copy);
  expect(store.list(document.id)).toHaveLength(3);
  read("version-d", copy);
  expect(store.list(document.id)).toHaveLength(3);
  db.close();
});

test("a deleted highlight's row does not take a copy back at its page and place", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const mark = () => highlight(quote, 1, null, 10, around("one"));
  read("version-a", [mark()]);
  const [old] = store.list(document.id);
  if (!old) throw new Error("The highlight wasn't read.");
  store.remove(old.id);

  read("version-b", []);
  read("version-c", [mark()]);
  const live = store.list(document.id);
  expect(live).toHaveLength(1);
  expect(live[0]?.id).not.toBe(old.id);
  expect(live[0]).toMatchObject({ pageFrom: 1, missing: false });
  db.close();
});

test("a mark's new place and the words around it are written to its row", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  read("version-a", [highlight(quote, 1, null, 10, around("one"))]);
  const [row] = store.list(document.id);
  if (!row) throw new Error("The highlight wasn't read.");

  read("version-b", [highlight(quote, 1, null, 20, around("two"))]);
  const stored = db.get<{ file_order: number; anchor: string }>(
    "SELECT file_order, anchor FROM document_annotations WHERE id = ?",
    [row.id],
  );
  expect(stored?.file_order).toBe(20);
  expect(stored?.anchor).toContain("Before two.");
  expect(store.list(document.id).find((each) => each.id === row.id)).toMatchObject({
    missing: false,
  });
  db.close();
});

test("two copies on one line keep their own comments over re-reads", async () => {
  const { document, store, read, db } = await harness();
  const quote = "the Seller";
  const copies = () => [
    highlight(quote, 1, "Left.", 10, around("left")),
    highlight(quote, 1, "Right.", 10.5, around("right")),
  ];
  read("version-a", copies());
  const left = rowAt(db, document.id, 10);
  if (!left) throw new Error("The left copy wasn't read.");
  store.update(left.id, { note: "Mine left" });

  const changes = () => db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0;
  const before = changes();
  for (let trial = 0; trial < 10; trial++) {
    const marks = copies();
    read("version-a", trial % 2 === 0 ? marks : marks.reverse());
    expect(rowAt(db, document.id, 10)?.id, `trial ${trial}`).toBe(left.id);
    expect(store.list(document.id).find((row) => row.id === left.id)).toMatchObject({
      note: "Mine left",
      missing: false,
    });
  }
  expect(changes()).toBe(before);
  db.close();
});

test("a PDF mark carries the page's words around it and its place", () => {
  const items = [
    { str: "Alpha words.", transform: [11, 0, 0, 11, 72, 760], width: 60, height: 11 },
    { str: "Middle line.", transform: [11, 0, 0, 11, 72, 746], width: 60, height: 11 },
    { str: "Lower words.", transform: [11, 0, 0, 11, 72, 732], width: 60, height: 11 },
  ];
  const mark = (baseline: number) => ({
    subtype: "Highlight",
    rect: [72, baseline - 2, 300, baseline + 10],
    quadPoints: [72, baseline + 10, 300, baseline + 10, 72, baseline - 2, 300, baseline - 2],
  });
  const found = readFileAnnotations(1, [mark(760), mark(732)], items);
  expect(found).toHaveLength(2);
  const [upper, lower] = found;
  expect(upper?.quote).toBe("Alpha words.");
  expect(upper?.after).toContain("Middle line.");
  expect(lower?.quote).toBe("Lower words.");
  expect(lower?.before).toContain("Middle line.");
  expect(upper?.order).toBeLessThan(lower?.order ?? 0);
});

test("identical forms with one removed do not move their comments", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const same = { before: "Form words.", after: "Form words." };
  const form = (page: number) => highlight(quote, page, null, 10, same);
  read("version-a", [form(1), form(2), form(3)]);
  const ids = new Map<number, string>();
  for (const [page, said] of [
    [1, "Form 1."],
    [2, "Form 2."],
    [3, "Form 3."],
  ] as const) {
    const row = store.list(document.id).find((each) => each.pageFrom === page);
    if (!row) throw new Error(`The page-${page} form wasn't read.`);
    store.update(row.id, { note: said });
    ids.set(page, row.id);
  }

  // The middle form is removed: copies whose words fit the same rows keep their comments
  // on missing rows rather than landing on another form.
  read("version-b", [form(1), form(2)]);
  const rows = store.list(document.id);
  expect(rows.find((row) => row.id === ids.get(1))).toMatchObject({
    note: "Form 1.",
    missing: true,
  });
  expect(rows.find((row) => row.id === ids.get(2))).toMatchObject({
    note: "Form 2.",
    missing: true,
  });
  expect(rows.find((row) => row.id === ids.get(3))).toMatchObject({
    note: "Form 3.",
    missing: true,
  });
  expect(
    rows.filter((row) => !row.missing && row.note !== null && row.note.startsWith("Form ")),
  ).toHaveLength(0);

  // The next save reuses the untouched new rows and does not grow.
  read("version-c", [form(1), form(2)]);
  expect(store.list(document.id)).toHaveLength(5);
  db.close();
});

test("a newer untouched row is taken before an older missing one at the same place", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const same = { before: "Page words.", after: "Page words." };
  const mark = (page: number) => highlight(quote, page, null, 10, same);
  read("version-a", [mark(1)]);
  const [older] = store.list(document.id);
  if (!older) throw new Error("The highlight wasn't read.");
  store.update(older.id, { note: "Mine" });

  read("version-b", []);
  read("version-c", [mark(1), mark(2)]);
  read("version-d", [mark(1), mark(2)]);
  const rows = store.list(document.id);
  expect(rows.find((row) => row.id === older.id)).toMatchObject({
    note: "Mine",
    missing: true,
  });
  const pageOne = rows.filter((row) => row.pageFrom === 1 && !row.missing);
  expect(pageOne).toHaveLength(1);
  expect(pageOne[0]?.note).not.toBe("Mine");
  db.close();
});

test("an untouched row the User recoloured is not reused for a new copy", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const same = { before: "Page words.", after: "Page words." };
  const mark = (page: number) => highlight(quote, page, null, 10, same);
  read("version-a", [mark(1)]);
  const [row] = store.list(document.id);
  if (!row) throw new Error("The highlight wasn't read.");
  store.update(row.id, { colour: "pink" });

  read("version-b", []);
  read("version-c", [mark(1), mark(2)]);
  const rows = store.list(document.id);
  expect(rows.find((each) => each.id === row.id)).toMatchObject({
    colour: "pink",
    missing: true,
  });
  expect(rows.filter((each) => !each.missing)).toHaveLength(2);
  expect(rows.find((each) => each.id === row.id)?.missing).toBe(true);
  db.close();
});

test("a note row a version left missing does not take a new note on its page", async () => {
  const { document, store, read, db } = await harness();
  read("version-a", [fileNote(1, "Old remark.")]);
  const [old] = store.list(document.id);
  if (!old) throw new Error("The note wasn't read.");

  read("version-b", []);
  read("version-c", [fileNote(1, "A new remark.")]);
  const rows = store.list(document.id);
  expect(rows.find((each) => each.id === old.id)).toMatchObject({
    note: "Old remark.",
    missing: true,
  });
  const live = rows.find((each) => !each.missing);
  expect(live).toMatchObject({ note: "A new remark." });
  expect(live?.id).not.toBe(old.id);
  db.close();
});

test("one fitting row is not taken by two marks", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const same = { before: "Page words.", after: "Page words." };
  read("version-a", [highlight(quote, 1, null, 10, same)]);
  // Two copies now fit the one row by their words; neither mark may vanish.
  read("version-b", [highlight(quote, 1, null, 10, same), highlight(quote, 2, null, 20, same)]);
  expect(store.list(document.id).filter((row) => !row.missing)).toHaveLength(2);
  db.close();
});

test("a same-version re-read carries the row at the mark's own place", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const same = { before: "Page words.", after: "Page words." };
  read("version-a", [highlight(quote, 1, null, 10, same), highlight(quote, 1, null, 20, same)]);
  const upper = rowAt(db, document.id, 10);
  const lower = rowAt(db, document.id, 20);
  if (!upper || !lower) throw new Error("Both copies weren't read.");

  // A read of the same version with one copy left: the one at place 20 is carried there.
  read("version-a", [highlight(quote, 1, null, 20, same)]);
  const rows = store.list(document.id);
  expect(rows.find((row) => row.id === lower.id)).toMatchObject({
    pageFrom: 1,
    missing: false,
  });
  expect(rows.find((row) => row.id === upper.id)).toMatchObject({ missing: true });
  db.close();
});

test("a same-version re-read carries a row on the mark's page when its words changed", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  read("version-a", [highlight(quote, 1, null, 10, around("one"))]);
  const [row] = store.list(document.id);
  if (!row) throw new Error("The highlight wasn't read.");

  // A version drops it, then the exact version that paired it is read again with the words
  // around it changed: the same-page carry keeps its row.
  read("version-b", []);
  read("version-a", [highlight(quote, 1, null, 20, around("two"))]);
  const carried = store.list(document.id).find((each) => each.id === row.id);
  expect(carried).toMatchObject({ pageFrom: 1, missing: false });
  const stored = db.get<{ file_order: number }>(
    "SELECT file_order FROM document_annotations WHERE id = ?",
    [row.id],
  );
  expect(stored?.file_order).toBe(20);
  db.close();
});

test("a PDF highlight's Float32Array quads quote the marked runs, not the gap", () => {
  const items = [
    { str: "Alpha words.", transform: [11, 0, 0, 11, 72, 760], width: 60, height: 11 },
    { str: "Unmarked gap words.", transform: [11, 0, 0, 11, 72, 746], width: 120, height: 11 },
    { str: "Beta words.", transform: [11, 0, 0, 11, 72, 732], width: 60, height: 11 },
  ];
  const quads = new Float32Array([
    72, 770, 300, 770, 72, 758, 300, 758, 72, 742, 300, 742, 72, 730, 300, 730,
  ]);
  const found = readFileAnnotations(1, [{ subtype: "Highlight", quadPoints: quads }], items);
  expect(found).toHaveLength(1);
  expect(found[0]?.quote).toBe("Alpha words.\nBeta words.");
  expect(found[0]?.quote).not.toContain("Unmarked gap words.");
});

test("a PDF highlight that covers only part of a text item is not quoted by the whole item", () => {
  const items = [
    {
      str: "Rent increases annually but service charges stay fixed.",
      transform: [11, 0, 0, 11, 72, 760],
      width: 260,
      height: 11,
    },
  ];
  // A rect over "Rent" alone, inside a single text item that holds the whole line.
  const partial = readFileAnnotations(
    1,
    [{ subtype: "Highlight", quadPoints: [72, 770, 102, 770, 72, 758, 102, 758] }],
    items,
  );
  expect(partial).toHaveLength(0);

  // The whole line, covered whole, still quotes whole.
  const whole = readFileAnnotations(
    1,
    [{ subtype: "Highlight", quadPoints: [72, 770, 332, 770, 72, 758, 332, 758] }],
    items,
  );
  expect(whole).toHaveLength(1);
  expect(whole[0]?.quote).toBe("Rent increases annually but service charges stay fixed.");
});

test("a mark whose words around it contradict the shift is a different copy", async () => {
  const { document, store, read, db } = await harness();
  const quote = "The fee is fixed.";
  read("version-a", [
    highlight(quote, 2, null, 10, { before: "Roof works.", after: "Roof works." }),
  ]);
  const [alpha] = store.list(document.id);
  if (!alpha) throw new Error("The highlight wasn't read.");
  store.update(alpha.id, { note: "Roof note" });

  // One page removed, and the same words marked elsewhere under other words: not the same copy.
  read("version-b", [
    highlight(quote, 1, null, 10, { before: "Garden works.", after: "Garden works." }),
  ]);
  const rows = store.list(document.id);
  expect(rows.find((row) => row.id === alpha.id)).toMatchObject({
    note: "Roof note",
    missing: true,
  });
  const fresh = rows.find((row) => row.id !== alpha.id);
  expect(fresh).toMatchObject({ pageFrom: 1, missing: false });
  expect(fresh?.note).not.toBe("Roof note");
  db.close();
});

test("a PDF highlight over part of an item's glyphs is not quoted with the glyphs it leaves out", () => {
  // "100%" in Helvetica at 11 pt, one text item: each digit is 0.556 em, the percent sign 0.889.
  const width = 11 * (3 * 0.556 + 0.889);
  const items = [{ str: "100%", transform: [11, 0, 0, 11, 72, 760], width, height: 11 }];
  const quad = (right: number) => [72, 770, right, 770, 72, 758, right, 758];
  const digits = readFileAnnotations(
    1,
    [{ subtype: "Highlight", quadPoints: quad(72 + 11 * 3 * 0.556) }],
    items,
  );
  expect(digits).toEqual([]);

  const whole = readFileAnnotations(
    1,
    [{ subtype: "Highlight", quadPoints: quad(72 + width) }],
    items,
  );
  expect(whole.map((each) => each.quote)).toEqual(["100%"]);

  // A space the quad stops before is no unmarked word: the item is still the marked words.
  const spaced = [
    { str: "Rent rises ", transform: [11, 0, 0, 11, 72, 760], width: 55, height: 11 },
  ];
  const beforeSpace = readFileAnnotations(
    1,
    [{ subtype: "Highlight", quadPoints: quad(72 + 55 - 11 * 0.278) }],
    spaced,
  );
  expect(beforeSpace.map((each) => each.quote)).toEqual(["Rent rises"]);
});

test("a PDF highlight carries the words around every other place on its page with its words", () => {
  const line = (words: readonly string[], baseline: number) =>
    words.map((str, at) => ({
      str,
      transform: [11, 0, 0, 11, 72 + at * 100, baseline],
      width: 90,
      height: 11,
    }));
  const items = [
    ...line(["Roof works.", "The fee is fixed.", "Roof works."], 760),
    ...line(["Garden works.", "The fee is fixed.", "Garden works."], 740),
  ];
  const [garden] = readFileAnnotations(
    1,
    [{ subtype: "Highlight", quadPoints: [172, 750, 262, 750, 172, 738, 262, 738] }],
    items,
  );
  const page =
    "Roof works. The fee is fixed. Roof works.\nGarden works. The fee is fixed. Garden works.";
  const roofAt = page.indexOf("The fee is fixed.");
  const gardenAt = page.lastIndexOf("The fee is fixed.");
  expect(garden).toMatchObject({
    quote: "The fee is fixed.",
    before: page.slice(0, gardenAt),
    after: page.slice(gardenAt + "The fee is fixed.".length),
    others: [
      { before: page.slice(0, roofAt), after: page.slice(roofAt + "The fee is fixed.".length) },
    ],
  });
});

test("a mark moved to other words on its own page, its row's copy still there, is another copy", async () => {
  const { document, store, read, db } = await harness();
  const quote = "The fee is fixed.";
  const roof = { before: "Roof works. ", after: " Roof works." };
  const garden = { before: "Garden works. ", after: " Garden works." };
  read("version-a", [highlight(quote, 1, null, 10, roof, [garden])]);
  const [alpha] = store.list(document.id);
  if (!alpha) throw new Error("The highlight wasn't read.");
  store.update(alpha.id, { note: "Roof note", colour: "pink" });

  // Only the mark moves, from the roof's copy to the garden's on the same page.
  read("version-b", [highlight(quote, 1, null, 20, garden, [roof])]);
  const rows = store.list(document.id);
  expect(rows.find((row) => row.id === alpha.id)).toMatchObject({
    note: "Roof note",
    colour: "pink",
    missing: true,
  });
  const beta = rows.find((row) => row.id !== alpha.id);
  expect(beta).toMatchObject({ pageFrom: 1, missing: false, note: null, colour: "yellow" });
  db.close();
});

test("a deleted mark's row does not hide the copy the mark moves to on its page", async () => {
  const { document, store, read, db } = await harness();
  const quote = "The fee is fixed.";
  const roof = { before: "Roof works. ", after: " Roof works." };
  const garden = { before: "Garden works. ", after: " Garden works." };
  read("version-a", [highlight(quote, 1, null, 10, roof, [garden])]);
  const [alpha] = store.list(document.id);
  if (!alpha) throw new Error("The highlight wasn't read.");
  store.remove(alpha.id);

  read("version-b", [highlight(quote, 1, null, 20, garden, [roof])]);
  const shown = store.list(document.id);
  expect(shown.map((row) => row.id)).not.toContain(alpha.id);
  expect(shown).toMatchObject([{ quote, missing: false }]);

  // Its Undo brings back the roof's copy, not the garden's.
  store.restore(alpha.id);
  const restored = store.list(document.id).find((row) => row.id === alpha.id);
  expect(restored?.anchor?.parts[0]).toMatchObject(roof);
  db.close();
});

test("a mark whose words around it were edited, with no other copy on its page, keeps its row", async () => {
  const { document, store, read, db } = await harness();
  const quote = "Highlighted words here.";
  read("version-a", [highlight(quote, 1, null, 10, { before: "Alpha report cover.\n" })]);
  const [kept] = store.list(document.id);
  if (!kept) throw new Error("The highlight wasn't read.");
  store.update(kept.id, { note: "Mine" });

  read("version-b", [
    highlight(quote, 1, null, 20, { before: "Added line above.\nAlpha report cover.\n" }),
  ]);
  expect(store.list(document.id)).toMatchObject([{ id: kept.id, note: "Mine", missing: false }]);
  db.close();
});
