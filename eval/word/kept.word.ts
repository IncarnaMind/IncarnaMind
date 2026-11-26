/**
 * `npm run eval:word` (eval/word/README.md): what an edit keeps in the 32 documents (#746).
 *
 * Each file of `documents/` is imported as a Note through the core, as the app imports one,
 * edited in its Yjs document as the editor edits it, exported, and read back:
 * - **Unedited**, the export is the file byte for byte, every entry.
 * - **Numbering**: a word changed in one numbered paragraph, then in every paragraph, and a
 *   clause added after the first paragraph of each list. Every paragraph's number, read as Word
 *   reads it (through its own numbering or its style chain, ./wordNumbering), must be the file's,
 *   or the one Word gives the file with that clause in it.
 * - **Fields**: the file's TOC, REF and PAGEREF fields, and how many each export marks to refresh.
 * - **Formatting**: three exports, every paragraph edited one way each: a word changed, a word
 *   made bold, and the paragraph split in two with Enter. Every character the edit didn't touch
 *   must keep its run properties (the bold word all but its bold), counted by character and by
 *   property.
 *
 * It prints a line per file and the totals, then holds the bars: nothing unedited changes, every
 * file with numbering keeps it, and at least 95% of the untouched characters keep all their
 * formatting.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import { MIND_CONTENT_FIELD, PROPOSAL_DELETE_MARK, PROPOSAL_INSERT_MARK } from "../../src/core/api";
import { readWordDocument } from "../../src/core/documents/formats/docxImport";
import { openWordPackage, reviewOf } from "../../src/core/documents/formats/docxPackage";
import { partOfType, relationshipsOf } from "../../src/core/documents/formats/officePackage";
import {
  levelOf,
  paragraphNumbers,
  readWordNumbering,
  type WordNumbering,
} from "../../src/core/documents/formats/wordNumbering";
import {
  readStyleTable,
  type WordStyleTable,
} from "../../src/core/documents/formats/wordStyleTable";
import { descendants, parseXml, walk, type XmlElement } from "../../src/core/documents/formats/xml";
import { openPackage } from "../../src/core/documents/formats/zip";
import { hasMarkIn } from "../../src/shared/markKeys";
import { wordSourceOf } from "../../src/shared/wordFiles";
import { createTempDataFolder, startCore } from "../../tests/helpers/core";
import { type RunCharacter, runCharacters } from "../../tests/helpers/docx";
import type { MindClient } from "../../tests/helpers/mindClient";
import { importWordBytes } from "../../tests/helpers/wordMinds";
import { readManifest, WORD_DIR } from "./corpus";

// ---------------------------------------------------------------------------
// A package read back

interface Read {
  /** The main part as the import reads it: its places are the Note's sources. */
  places: { placeOf(element: XmlElement): string | null };
  root: XmlElement;
  paragraphs: XmlElement[];
  numbering: WordNumbering;
  styles: WordStyleTable;
}

async function readPackage(bytes: Uint8Array): Promise<Read> {
  const pkg = await openWordPackage(bytes);
  const rels = await relationshipsOf(pkg.zip, pkg.part);
  const part = async (type: string, usual: string) => {
    const text = await pkg.zip.readText(partOfType(rels, type, usual));
    return text ? parseXml(text) : undefined;
  };
  const document = await readWordDocument(pkg, await reviewOf(pkg));
  const styles = readStyleTable(await part("/styles", "word/styles.xml"));
  return {
    places: document.places,
    root: document.root,
    paragraphs: descendants(document.root, "w:p"),
    numbering: readWordNumbering(await part("/numbering", "word/numbering.xml"), styles),
    styles,
  };
}

/** The number Word draws before each paragraph, or null; a bullet as its character. */
const numbersOf = (read: Read, paragraphs = read.paragraphs) =>
  paragraphNumbers(read.numbering, read.styles, paragraphs).map((each) =>
    each ? `${each.text ?? "?"}` : null,
  );

/** The TOC, REF and PAGEREF fields of a main part, in order, and whether Word is asked to refresh each. */
function fieldsIn(root: XmlElement): { type: string; dirty: boolean }[] {
  const found: { type: string; dirty: boolean }[] = [];
  const open: { instruction: string; dirty: boolean; separated: boolean }[] = [];
  const dirty = (element: XmlElement) => /^(?:true|1|on)$/.test(element.attrs["w:dirty"] ?? "");
  const add = (instruction: string, isDirty: boolean) => {
    const type = instruction.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
    if (type === "TOC" || type === "REF" || type === "PAGEREF")
      found.push({ type, dirty: isDirty });
  };
  for (const element of walk(root)) {
    const top = open.at(-1);
    if (element.name === "w:fldSimple") add(element.attrs["w:instr"] ?? "", dirty(element));
    else if (element.name === "w:fldChar") {
      const kind = element.attrs["w:fldCharType"];
      if (kind === "begin") open.push({ instruction: "", dirty: dirty(element), separated: false });
      else if (kind === "separate" && top) top.separated = true;
      else if (kind === "end" && top) {
        open.pop();
        add(top.instruction, top.dirty);
      }
    } else if (element.name === "w:instrText" && top && !top.separated) {
      top.instruction += element.children.filter((part) => typeof part === "string").join("");
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The edits, as the editor makes them in the Note's Yjs document

type EditKind = "word" | "bold" | "split";
const KINDS: readonly EditKind[] = ["word", "bold", "split"];

type Delta = { insert: unknown; attributes?: Record<string, unknown> }[];

/** A word of a text that no change still waiting adds or removes: two Han characters, or three letters or more. */
function plainWord(text: Y.XmlText): { index: number; word: string; attributes: object } | null {
  let at = 0;
  for (const run of text.toDelta() as Delta) {
    const length = typeof run.insert === "string" ? run.insert.length : 1;
    const changed =
      hasMarkIn(PROPOSAL_INSERT_MARK, run.attributes) ||
      hasMarkIn(PROPOSAL_DELETE_MARK, run.attributes);
    const found =
      typeof run.insert === "string" && !changed
        ? /\p{Script=Han}{2}|\p{L}{3,}/u.exec(run.insert)
        : null;
    if (found) return { index: at + found.index, word: found[0], attributes: run.attributes ?? {} };
    at += length;
  }
  return null;
}

/** A text from `from` on, as a delta for a new text; null when it holds more than text. */
function deltaFrom(text: Y.XmlText, from: number) {
  const out: { insert: string; attributes?: Record<string, unknown> }[] = [];
  let at = 0;
  for (const run of text.toDelta() as Delta) {
    if (typeof run.insert !== "string") return null;
    const end = at + run.insert.length;
    if (end > from) {
      out.push({
        insert: run.insert.slice(Math.max(from - at, 0)),
        ...(run.attributes && { attributes: run.attributes }),
      });
    }
    at = end;
  }
  return out;
}

/** Where Enter splits a text: after the space nearest its middle, or in the middle of Chinese. */
function splitPoint(text: string): number | null {
  const middle = Math.floor(text.length / 2);
  let best: number | null = null;
  for (const found of text.matchAll(/\s+/gu)) {
    const at = (found.index ?? 0) + found[0].length;
    if (at <= 0 || at >= text.length) continue;
    if (best === null || Math.abs(at - middle) < Math.abs(best - middle)) best = at;
  }
  if (best !== null) return best;
  return /\p{Script=Han}/u.test(text) && text.length >= 4 ? middle : null;
}

/** The Note's imported paragraphs and headings, with their places in the file. */
function importedParagraphs(doc: Y.Doc): { element: Y.XmlElement; place: string }[] {
  const found: { element: Y.XmlElement; place: string }[] = [];
  const visit = (element: Y.XmlElement) => {
    if (element.nodeName === "paragraph" || element.nodeName === "heading") {
      const id = element.getAttribute("id");
      const source = typeof id === "string" ? wordSourceOf(doc, id) : null;
      if (source) found.push({ element, place: source.n });
    }
    for (const each of element.toArray()) if (each instanceof Y.XmlElement) visit(each);
  };
  for (const each of doc.getXmlFragment(MIND_CONTENT_FIELD).toArray())
    if (each instanceof Y.XmlElement) visit(each);
  return found;
}

/** A new Block of `element`'s kind and look, as Enter makes one: its id is its own. */
function like(element: Y.XmlElement): Y.XmlElement {
  const fresh = new Y.XmlElement(element.nodeName);
  for (const [key, value] of Object.entries(element.getAttributes()))
    if (key !== "id") fresh.setAttribute(key, value as never);
  return fresh;
}

/** Puts `fresh` after `element`: in a list, as a new item after its item. */
function insertAfter(element: Y.XmlElement, fresh: Y.XmlElement): boolean {
  const parent = element.parent;
  if (parent instanceof Y.XmlElement && parent.nodeName === "listItem") {
    const list = parent.parent;
    if (!(list instanceof Y.XmlElement)) return false;
    const item = new Y.XmlElement("listItem");
    item.insert(0, [fresh]);
    list.insert(list.toArray().indexOf(parent) + 1, [item]);
    return true;
  }
  if (parent instanceof Y.XmlElement || parent instanceof Y.XmlFragment) {
    parent.insert(parent.toArray().indexOf(element) + 1, [fresh]);
    return true;
  }
  return false;
}

/** Edits each imported paragraph `chosen` picks, by its place, as `kind` says; returns the places edited. */
function editParagraphs(
  doc: Y.Doc,
  kind: EditKind,
  chosen: (place: string) => boolean,
): Set<string> {
  const edited = new Set<string>();
  doc.transact(() => {
    for (const { element, place } of importedParagraphs(doc)) {
      if (!chosen(place)) continue;
      const content = element.toArray();
      if (kind === "split") {
        const only = content[0];
        if (content.length !== 1 || !(only instanceof Y.XmlText)) continue;
        // Its text alone: `toString` writes its marks around it.
        const text = (only.toDelta() as Delta)
          .map((run) => (typeof run.insert === "string" ? run.insert : ""))
          .join("");
        const at = splitPoint(text);
        const rest = at === null ? null : deltaFrom(only, at);
        if (at === null || !rest) continue;
        const second = like(element);
        const carried = new Y.XmlText();
        second.insert(0, [carried]);
        if (!insertAfter(element, second)) continue;
        only.delete(at, only.length - at);
        carried.applyDelta(rest);
        edited.add(place);
        continue;
      }
      for (const text of content) {
        if (!(text instanceof Y.XmlText)) continue;
        const word = plainWord(text);
        if (!word) continue;
        if (kind === "bold") text.format(word.index, word.word.length, { bold: true });
        else {
          text.delete(word.index, word.word.length);
          text.insert(
            word.index,
            /\p{Script=Han}/u.test(word.word) ? "改写" : "Roundtripped",
            word.attributes,
          );
        }
        edited.add(place);
        break;
      }
    }
  });
  return edited;
}

/**
 * Adds a clause after the imported paragraph at `place`, as Enter at its end does: a new item
 * of its list, or a new paragraph of its kind. Only after an item with no list inside it, so the
 * clause is the paragraph after it in the file. Returns whether it was added.
 */
function addClause(doc: Y.Doc, place: string): boolean {
  const target = importedParagraphs(doc).find((each) => each.place === place)?.element;
  const item = target?.parent;
  if (!target) return false;
  if (item instanceof Y.XmlElement && item.nodeName === "listItem") {
    const nested = item
      .toArray()
      .some((each) => each instanceof Y.XmlElement && /List$/.test(each.nodeName));
    if (nested) return false;
  }
  let added = false;
  doc.transact(() => {
    const fresh = like(target);
    if (!insertAfter(target, fresh)) return;
    fresh.insert(0, [new Y.XmlText("A new clause.")]);
    added = true;
  });
  return added;
}

// ---------------------------------------------------------------------------
// The measure

interface NumberingOutcome {
  numbered: number;
  kept: number;
  /** The first paragraphs whose number changed: "before → after". */
  changed: string[];
}

function compareNumbers(before: (string | null)[], after: (string | null)[]): NumberingOutcome {
  const outcome: NumberingOutcome = { numbered: 0, kept: 0, changed: [] };
  if (before.length !== after.length) {
    outcome.changed.push(`${before.length} paragraphs became ${after.length}`);
    return outcome;
  }
  before.forEach((was, index) => {
    const now = after[index] ?? null;
    if (was !== null) outcome.numbered++;
    if (was !== null && was === now) outcome.kept++;
    else if (was !== now && outcome.changed.length < 3)
      outcome.changed.push(`#${index} ${was ?? "none"} → ${now ?? "none"}`);
  });
  return outcome;
}

interface FormatOutcome {
  characters: number;
  charactersKept: number;
  properties: number;
  propertiesKept: number;
  paragraphs: number;
  /** The first characters whose formatting changed: in which paragraph, and what each lost and gained. */
  changed: string[];
}

const NO_FORMAT: FormatOutcome = {
  characters: 0,
  charactersKept: 0,
  properties: 0,
  propertiesKept: 0,
  paragraphs: 0,
  changed: [],
};

const addFormats = (into: FormatOutcome, more: FormatOutcome): FormatOutcome => ({
  characters: into.characters + more.characters,
  charactersKept: into.charactersKept + more.charactersKept,
  properties: into.properties + more.properties,
  propertiesKept: into.propertiesKept + more.propertiesKept,
  paragraphs: into.paragraphs + more.paragraphs,
  changed: [...into.changed, ...more.changed].slice(0, 2),
});

const BOLD = /^w:bC?s?\{/;

/**
 * Each edited paragraph as it was and as it is now (the two a split made, joined), compared
 * character by character outside what the edit replaced; a bold word's bold is the edit itself.
 */
function compareFormats(
  kind: EditKind,
  pairs: readonly { was: RunCharacter[]; now: RunCharacter[] }[],
): FormatOutcome {
  const outcome: FormatOutcome = { ...NO_FORMAT, changed: [] };
  for (const { was, now } of pairs) {
    outcome.paragraphs++;
    let prefix = 0;
    while (prefix < was.length && prefix < now.length && was[prefix]?.char === now[prefix]?.char)
      prefix++;
    let suffix = 0;
    while (
      suffix < was.length - prefix &&
      suffix < now.length - prefix &&
      was[was.length - 1 - suffix]?.char === now[now.length - 1 - suffix]?.char
    )
      suffix++;
    const matched: [RunCharacter, RunCharacter][] = [];
    for (let at = 0; at < prefix; at++)
      matched.push([was[at] as RunCharacter, now[at] as RunCharacter]);
    for (let at = 1; at <= suffix; at++)
      matched.push([was[was.length - at] as RunCharacter, now[now.length - at] as RunCharacter]);
    for (const [old, kept] of matched) {
      const ignore = (each: string) => kind === "bold" && BOLD.test(each);
      const before = old.format.filter((each) => !ignore(each));
      const after = kept.format.filter((each) => !ignore(each));
      outcome.characters++;
      outcome.properties += before.length;
      outcome.propertiesKept += before.filter((each) => after.includes(each)).length;
      if (before.length === after.length && before.every((each, at) => each === after[at]))
        outcome.charactersKept++;
      else if (outcome.changed.length < 2) {
        const lost = before.filter((each) => !after.includes(each));
        const gained = after.filter((each) => !before.includes(each));
        const text = was.map((each) => each.char).join("");
        outcome.changed.push(
          `${kind}: "${old.char}" of "${text.slice(0, 40)}" lost ${lost.join(" ") || "nothing"}, gained ${gained.join(" ") || "nothing"}`,
        );
      }
    }
  }
  return outcome;
}

async function identical(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  const read = async (bytes: Uint8Array) => {
    const zip = openPackage(bytes);
    const map = new Map<string, Buffer>();
    for (const name of zip.names()) map.set(name, Buffer.from((await zip.read(name)) ?? []));
    return map;
  };
  const [left, right] = [await read(a), await read(b)];
  return (
    left.size === right.size && [...left].every(([name, data]) => right.get(name)?.equals(data))
  );
}

interface FileOutcome {
  file: string;
  identical: boolean;
  numbered: number;
  bullets: number;
  /** Numbered paragraphs whose numbering only their style gives. */
  styled: number;
  one: NumberingOutcome | null;
  all: NumberingOutcome;
  /** A clause added in each list, one export each; null when no list had an item to add after. */
  added: NumberingOutcome | null;
  clauses: number;
  formats: Record<EditKind, FormatOutcome>;
  /** Its TOC, REF and PAGEREF fields, and how many are marked to refresh: in the file, after the words, after a clause added. */
  fields: {
    types: string[];
    dirtyBefore: number;
    dirtyAfterWords: number;
    dirtyAfterClause: number;
  };
}

/** The Note a file imports as, each time a new one, to edit and export as the app does. */
type Notes = (
  bytes: Uint8Array,
  name: string,
) => Promise<{ client: MindClient; export(): Promise<Uint8Array> }>;

function notesIn(core: Core, dataDir: string): Notes {
  let made = 0;
  return async (bytes, name) => {
    const { mindId, client } = await importWordBytes(core, dataDir, Buffer.from(bytes), {
      origin: "own",
      name: `${made++}-${name}`,
    });
    return {
      client,
      export: async () => {
        await client.settled();
        return (await core.exportMind(mindId, { format: "docx" })).data;
      },
    };
  };
}

async function measure(notes: Notes, file: string): Promise<FileOutcome> {
  const bytes = new Uint8Array(readFileSync(join(WORD_DIR, file)));
  const name = basename(file);
  const original = await readPackage(bytes);
  const numbers = numbersOf(original);
  const lists = paragraphNumbers(original.numbering, original.styles, original.paragraphs);
  const placeOf = (p: XmlElement) => original.places.placeOf(p);
  const numberedPlaces = original.paragraphs.flatMap((p, index) => {
    const place = placeOf(p);
    return numbers[index] !== null && place ? [place] : [];
  });

  const same = await identical(bytes, await (await notes(bytes, name)).export());

  const exported = async (edit: (doc: Y.Doc) => Set<string> | boolean) => {
    const note = await notes(bytes, name);
    const edited = edit(note.client.doc);
    return { edited, again: await readPackage(await note.export()) };
  };

  let one: NumberingOutcome | null = null;
  const first = numberedPlaces[0];
  if (first) {
    const { edited, again } = await exported((doc) =>
      editParagraphs(doc, "word", (place) => place === first),
    );
    if (edited instanceof Set && edited.size > 0) one = compareNumbers(numbers, numbersOf(again));
  }

  // A clause added after the first paragraph of each list: the file then numbers as Word numbers
  // it with that paragraph twice.
  const added: NumberingOutcome = { numbered: 0, kept: 0, changed: [] };
  let clauses = 0;
  let dirtyAfterClause = 0;
  for (const numId of new Set(lists.flatMap((each) => (each ? [each.list.numId] : [])))) {
    const index = lists.findIndex((each) => each?.list.numId === numId);
    const p = original.paragraphs[index];
    const place = p ? placeOf(p) : null;
    if (!p || !place) continue;
    const { edited, again } = await exported((doc) => addClause(doc, place));
    if (edited !== true) continue;
    const expected = numbersOf(original, [
      ...original.paragraphs.slice(0, index + 1),
      p,
      ...original.paragraphs.slice(index + 1),
    ]);
    const outcome = compareNumbers(expected, numbersOf(again));
    dirtyAfterClause = Math.max(
      dirtyAfterClause,
      fieldsIn(again.root).filter((each) => each.dirty).length,
    );
    clauses++;
    added.numbered += outcome.numbered;
    added.kept += outcome.kept;
    added.changed.push(...outcome.changed.slice(0, 3 - added.changed.length));
  }

  const formats = {} as Record<EditKind, FormatOutcome>;
  let all: NumberingOutcome = { numbered: 0, kept: 0, changed: [] };
  let dirtyAfterWords = 0;
  for (const kind of KINDS) {
    const { edited, again } = await exported((doc) => editParagraphs(doc, kind, () => true));
    if (!(edited instanceof Set)) continue;
    if (kind === "word") {
      all = compareNumbers(numbers, numbersOf(again));
      dirtyAfterWords = fieldsIn(again.root).filter((each) => each.dirty).length;
    }
    const pairs: { was: RunCharacter[]; now: RunCharacter[] }[] = [];
    let at = 0;
    for (const p of original.paragraphs) {
      const place = placeOf(p);
      const isEdited = place !== null && edited.has(place);
      const now = again.paragraphs[at];
      const second = kind === "split" && isEdited ? again.paragraphs[at + 1] : undefined;
      at += second ? 2 : 1;
      if (!isEdited || !now) continue;
      pairs.push({
        was: runCharacters(p),
        now: [...runCharacters(now), ...(second ? runCharacters(second) : [])],
      });
    }
    formats[kind] = compareFormats(kind, pairs);
  }
  const fields = fieldsIn(original.root);
  return {
    file,
    identical: same,
    numbered: numbers.filter((each) => each !== null).length,
    bullets: lists.filter(
      (each) =>
        each && levelOf(original.numbering, each.list.numId, each.list.level).format === "bullet",
    ).length,
    styled: lists.filter((each) => each && !each.list.own).length,
    one,
    all,
    added: clauses > 0 ? added : null,
    clauses,
    formats,
    fields: {
      types: fields.map((each) => each.type),
      dirtyBefore: fields.filter((each) => each.dirty).length,
      dirtyAfterWords,
      dirtyAfterClause,
    },
  };
}

const percent = (part: number, whole: number) =>
  whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`;

const keptAll = (each: FileOutcome) =>
  each.all.kept === each.all.numbered &&
  each.all.changed.length === 0 &&
  (each.one === null || each.one.changed.length === 0);
const addedRight = (each: FileOutcome) =>
  each.added === null ||
  (each.added.kept === each.added.numbered && each.added.changed.length === 0);
const sum = (outcomes: readonly FileOutcome[], of: (each: FileOutcome) => number) =>
  outcomes.reduce((total, each) => total + of(each), 0);

function line(each: FileOutcome): string {
  const changed = [...(each.one?.changed ?? []), ...each.all.changed];
  const added = each.added
    ? `; a clause added in ${each.clauses} lists ${each.added.kept}/${each.added.numbered} as Word numbers them${each.added.changed.length > 0 ? ` [${each.added.changed.join("; ")}]` : ""}`
    : "";
  const numbering =
    each.numbered === 0
      ? "no numbering"
      : `numbering: ${each.numbered} paragraphs (${each.bullets} bullets, ${each.styled} by their style); one edited ${
          each.one ? `${each.one.kept}/${each.one.numbered} kept` : "(none with a word)"
        }; all edited ${each.all.kept}/${each.all.numbered} kept${changed.length > 0 ? ` [${changed.join("; ")}]` : ""}${added}`;
  const counts = ["TOC", "REF", "PAGEREF"]
    .map((type) => [type, each.fields.types.filter((found) => found === type).length] as const)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${count} ${type}`);
  const fields =
    counts.length === 0
      ? ""
      : `; fields: ${counts.join(", ")}, marked to refresh ${each.fields.dirtyBefore} in the file, ${each.fields.dirtyAfterWords} after the words, ${each.fields.dirtyAfterClause} after a clause added`;
  const format = KINDS.map((kind) => {
    const outcome = each.formats[kind];
    return `${kind} ${percent(outcome.charactersKept, outcome.characters)} of ${outcome.characters}`;
  }).join(", ");
  const why = KINDS.flatMap((kind) => each.formats[kind].changed);
  return `${each.file}  unedited ${each.identical ? "identical" : "DIFFERS"}; ${numbering}${fields}; formatting kept: ${format}${why.length > 0 ? ` [${why.slice(0, 3).join("; ")}]` : ""}`;
}

describe("what an edit keeps in the documents", () => {
  it("keeps every file's numbering and the formatting the edit didn't touch", async () => {
    const dataDir = await createTempDataFolder();
    const notes = notesIn(startCore(dataDir), dataDir);
    const outcomes: FileOutcome[] = [];
    for (const entry of readManifest().filter((each) => each.set === "documents"))
      outcomes.push(await measure(notes, entry.file));

    const withNumbering = outcomes.filter((each) => each.numbered > 0);
    const withClauses = withNumbering.filter((each) => each.added);
    const totals = KINDS.map(
      (kind) =>
        [
          kind,
          outcomes.reduce((total, each) => addFormats(total, each.formats[kind]), NO_FORMAT),
        ] as const,
    );
    const everything = totals.reduce((total, [, outcome]) => addFormats(total, outcome), NO_FORMAT);
    const short = outcomes.filter((each) => {
      const own = KINDS.reduce((total, kind) => addFormats(total, each.formats[kind]), NO_FORMAT);
      return own.characters > 0 && own.charactersKept / own.characters < 0.95;
    });
    const fieldCounts = ["TOC", "REF", "PAGEREF"].map((type) => {
      const holding = outcomes.filter((each) => each.fields.types.includes(type));
      const count = sum(
        outcomes,
        (each) => each.fields.types.filter((found) => found === type).length,
      );
      return `${count} ${type} in ${holding.length} files`;
    });
    console.log(
      [
        ...outcomes.map(line),
        `${outcomes.length} files; unedited identical: ${outcomes.filter((each) => each.identical).length}/${outcomes.length}`,
        `numbering kept after edits: ${withNumbering.filter(keptAll).length}/${withNumbering.length} files with numbering (${sum(outcomes, (each) => each.all.kept)}/${sum(outcomes, (each) => each.all.numbered)} paragraphs with every paragraph edited)`,
        `a clause added: ${withClauses.filter(addedRight).length}/${withClauses.length} files number every paragraph as Word does with it (${sum(outcomes, (each) => each.added?.kept ?? 0)}/${sum(outcomes, (each) => each.added?.numbered ?? 0)} paragraphs, ${sum(outcomes, (each) => each.clauses)} clauses)`,
        `fields: ${fieldCounts.join(", ")}; marked to refresh after a clause added: ${sum(outcomes, (each) => each.fields.dirtyAfterClause)}, after the words: ${sum(outcomes, (each) => each.fields.dirtyAfterWords)}`,
        ...totals.map(
          ([kind, outcome]) =>
            `formatting kept, ${kind}: ${percent(outcome.charactersKept, outcome.characters)} of ${outcome.characters} untouched characters, ${percent(outcome.propertiesKept, outcome.properties)} of ${outcome.properties} properties, in ${outcome.paragraphs} paragraphs`,
        ),
        `formatting kept in edited paragraphs, all edits: ${percent(everything.charactersKept, everything.characters)} of characters, ${percent(everything.propertiesKept, everything.properties)} of properties; files under 95%: ${short.map((each) => each.file).join(", ") || "none"}`,
      ].join("\n"),
    );
    expect(outcomes.filter((each) => !each.identical).map((each) => each.file)).toEqual([]);
    expect(withNumbering.filter((each) => !keptAll(each)).map((each) => each.file)).toEqual([]);
    expect(withClauses.filter((each) => !addedRight(each)).map((each) => each.file)).toEqual([]);
    expect(everything.charactersKept / everything.characters).toBeGreaterThanOrEqual(0.95);
  });
});
