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
import type { FileAnnotation } from "../../src/core/documents/pdfAnnotations";
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

const highlight = (quote: string, page = 1, note: string | null = null): FileAnnotation => ({
  page,
  kind: "highlight",
  quote,
  note,
  colour: "yellow",
  author: "Priya Raman",
});

test("a re-read of the same version keeps the User's edit and delete", async () => {
  const { document, store, read, db } = await harness();
  const rows = [
    highlight("The first line of the note.", 1, "Compare with Table 3."),
    {
      page: 1,
      kind: "note" as const,
      quote: "",
      note: "Check this figure.",
      colour: "yellow" as const,
      author: "Priya Raman",
    },
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

test("the same words twice, with a page inserted, fail closed rather than move a comment", async () => {
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
  // A copy still on its page did not move with the rest: the comments stay where they were.
  expect(reread.find((row) => row.id === second.id)).toMatchObject({
    pageFrom: 2,
    note: "second",
    missing: false,
  });
  expect(reread.find((row) => row.id === first.id)).toMatchObject({ note: "first", missing: true });
  db.close();
});

test("a new sticky note on another page leaves the old note its comment", async () => {
  const { document, store, read, db } = await harness();
  const note = (page: number, said: string): FileAnnotation => ({
    page,
    kind: "note",
    quote: "",
    note: said,
    colour: "yellow",
    author: "Priya Raman",
  });
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
  read("version-a", [highlight(quote, 1), highlight(quote, 2), highlight(quote, 3)]);
  // Three words, two marks: no count match, so the new read makes its own rows.
  read("version-b", [highlight(quote, 1), highlight(quote, 3)]);
  expect(store.list(document.id)).toHaveLength(3);
  // Read again: the rows pair in place, and no empty row is added.
  read("version-c", [highlight(quote, 1), highlight(quote, 3)]);
  expect(store.list(document.id)).toHaveLength(3);
  db.close();
});

test("two notes on one page keep their own comments when one is dropped", async () => {
  const { document, store, read, db } = await harness();
  const note = (said: string): FileAnnotation => ({
    page: 1,
    kind: "note",
    quote: "",
    note: said,
    colour: "yellow",
    author: "Priya Raman",
  });
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
  const note = (said: string): FileAnnotation => ({
    page: 1,
    kind: "note",
    quote: "",
    note: said,
    colour: "yellow",
    author: "Priya Raman",
  });
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
  const note = (page: number, said: string): FileAnnotation => ({
    page,
    kind: "note",
    quote: "",
    note: said,
    colour: "yellow",
    author: "Priya Raman",
  });
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
  const note = (page: number): FileAnnotation => ({
    page,
    kind: "note",
    quote: "",
    note: "Same.",
    colour: "yellow",
    author: "Priya Raman",
  });
  read("version-a", [note(1), note(4)]);
  read("version-b", [note(2), note(7)]);
  const rows = store.list(document.id).sort((a, b) => (a.pageFrom ?? 0) - (b.pageFrom ?? 0));
  expect(rows.filter((row) => row.missing).map((row) => row.pageFrom)).toEqual([1, 4]);
  expect(rows.filter((row) => !row.missing).map((row) => row.pageFrom)).toEqual([2, 7]);
  db.close();
});

test("an untouched note the file replaces on its page follows the file", async () => {
  const { document, store, read, db } = await harness();
  const note = (said: string): FileAnnotation => ({
    page: 1,
    kind: "note",
    quote: "",
    note: said,
    colour: "yellow",
    author: "Priya Raman",
  });
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
  const note = (page: number): FileAnnotation => ({
    page,
    kind: "note",
    quote: "",
    note: "Check.",
    colour: "yellow",
    author: "Priya Raman",
  });
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
  read("version-a", [
    highlight(quote, 1, "First mention."),
    highlight(quote, 1, "Second mention."),
  ]);
  const first = store.list(document.id).find((row) => row.note === "First mention.");
  if (!first) throw new Error("The first copy wasn't read.");
  store.update(first.id, { note: "Mine about the first." });
  const changes = () => db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0;
  const before = changes();
  read("version-a", [
    highlight(quote, 1, "First mention."),
    highlight(quote, 1, "Second mention."),
  ]);
  expect(store.list(document.id).find((row) => row.id === first.id)?.note).toBe(
    "Mine about the first.",
  );
  expect(changes()).toBe(before);
  db.close();
});

test("a file flipping between two copies and one stops growing rows", async () => {
  const { document, store, read, db } = await harness();
  const quote = "About page one.";
  const two = () => [highlight(quote, 1), highlight(quote, 2)];
  read("version-two", two());
  const first = store.list(document.id).find((row) => row.pageFrom === 1);
  if (!first) throw new Error("The page-1 copy wasn't read.");
  store.update(first.id, { note: "Mine on page 1." });

  read("version-one", [highlight(quote, 1)]);
  expect(store.list(document.id)).toHaveLength(2);
  read("version-two-again", two());
  expect(store.list(document.id)).toHaveLength(2);
  const pageOne = store.list(document.id).find((row) => row.id === first.id);
  expect(pageOne).toMatchObject({ note: "Mine on page 1.", missing: false });
  read("version-one-again", [highlight(quote, 1)]);
  expect(store.list(document.id)).toHaveLength(2);
  db.close();
});

test("a note of the same version on its page is carried when the group cannot pair", async () => {
  const { document, store, read, db } = await harness();
  const note = (page: number): FileAnnotation => ({
    page,
    kind: "note",
    quote: "",
    note: "Check.",
    colour: "yellow",
    author: "Priya Raman",
  });
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
  const note = (page: number): FileAnnotation => ({
    page,
    kind: "note",
    quote: "",
    note: "Check.",
    colour: "yellow",
    author: "Priya Raman",
  });
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
  const note = (said: string): FileAnnotation => ({
    page: 1,
    kind: "note",
    quote: "",
    note: said,
    colour: "yellow",
    author: "Priya Raman",
  });
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
