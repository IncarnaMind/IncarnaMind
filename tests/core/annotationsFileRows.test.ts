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
    cite: (_documentId, anchor) => answer(anchor.unit ?? 1, anchor.parts[0]?.text ?? ""),
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
  read("version-a", [row], (unit, text) => found(1, text));
  const [before] = store.list(document.id);
  if (!before) throw new Error("The highlight wasn't read.");
  store.update(before.id, { note: "Mine", colour: "pink" });

  read("version-b", [row], (unit, text) => found(2, text));
  expect(store.list(document.id)).toMatchObject([
    { id: before.id, pageFrom: 2, note: "Mine", colour: "pink", missing: false },
  ]);
  read("version-c", [row], (unit, text) => found(3, text));
  expect(store.list(document.id)).toMatchObject([
    { id: before.id, pageFrom: 3, note: "Mine", colour: "pink", missing: false },
  ]);
  read("version-b", [row], (unit, text) => found(2, text));
  expect(store.list(document.id)).toMatchObject([{ id: before.id, pageFrom: 2, missing: false }]);
  db.close();
});

test("a highlight a new version lacks says it is missing, and comes back in place", async () => {
  const { document, store, read, db } = await harness();
  const row = highlight("The first line of the note.");
  read("version-a", [row], (unit, text) => found(1, text));
  const [before] = store.list(document.id);
  if (!before) throw new Error("The highlight wasn't read.");

  read("version-b", [row], (unit, text) => lost(unit, text));
  expect(store.list(document.id)).toMatchObject([
    { id: before.id, missing: true, check: "not-found" },
  ]);

  read("version-a", [row], (unit, text) => found(1, text));
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
