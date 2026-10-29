/**
 * What a Mind imported from a Word file (#104) keeps beside its Blocks, in its
 * Yjs document: the file (`MIND_WORD_FIELD`), how far the import has got and
 * what it did, and where each node came from (`MIND_WORD_SOURCES_FIELD`), so
 * export can write into the original package (#105). Kept in maps rather than
 * in the nodes' attributes, as `textOrigins` is (ADR-0003). Shared by the
 * core, the editor and the tests.
 */
import * as Y from "yjs";
import {
  FOOTNOTE_NODE,
  MIND_WORD_FIELD,
  MIND_WORD_SOURCES_FIELD,
  PROPOSAL_ATTRIBUTE,
  WORD_LOOK_ATTRIBUTE,
  WORD_RUN_MARK,
  WORD_TAB_MARK,
  type WordAtomAttributes,
  type WordAtomKind,
  type WordFileInfo,
  type WordImportProgress,
  type WordImportReport,
  type WordNoteNumbering,
  type WordOrigin,
  type WordSource,
} from "../core/api";
import { targetHash } from "./proposals";

/** Atoms that show nothing: they only keep their place in the text. */
export const INVISIBLE_WORD_ATOMS: ReadonlySet<WordAtomKind> = new Set([
  "bookmark",
  "range",
  "columnBreak",
]);

/** Atoms drawn as a line across the text, as Word draws them with its marks shown (#746). */
export const BREAK_WORD_ATOMS: ReadonlySet<WordAtomKind> = new Set(["sectionBreak", "pageBreak"]);

const KINDS: ReadonlySet<string> = new Set<WordAtomKind>([
  "field",
  "control",
  "textBox",
  "shape",
  "smartArt",
  "chart",
  "picture",
  "object",
  "equation",
  "symbol",
  "footnote",
  "endnote",
  "comment",
  "insertion",
  "deletion",
  "bookmark",
  "range",
  "sectionBreak",
  "pageBreak",
  "columnBreak",
  "table",
  "header",
  "footer",
  "other",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** An atom's attributes as stored, with anything missing or malformed read as empty. */
export function readWordAtom(attributes: Record<string, unknown>): WordAtomAttributes {
  const kind = typeof attributes.kind === "string" && KINDS.has(attributes.kind);
  const info = isRecord(attributes.info) ? attributes.info : null;
  return {
    kind: kind ? (attributes.kind as WordAtomKind) : "other",
    label: text(attributes.label),
    text: text(attributes.text),
    source: typeof attributes.source === "string" ? attributes.source : null,
    info: info && {
      ...(typeof info.author === "string" && { author: info.author }),
      ...(typeof info.date === "string" && { date: info.date }),
      ...(typeof info.field === "string" && { field: info.field }),
      ...(info.display === true && { display: true }),
      ...(typeof info.name === "string" && { name: info.name }),
    },
  };
}

/** What an atom reads as, for Questions, search and copying: the text it holds, or what it shows. */
export function wordAtomText(atom: Pick<WordAtomAttributes, "kind" | "label" | "text">): string {
  if (INVISIBLE_WORD_ATOMS.has(atom.kind) || BREAK_WORD_ATOMS.has(atom.kind)) return "";
  if (atom.kind === "deletion") return "";
  // A comment and a footnote are notes beside the text, not part of it.
  if (atom.kind === "comment" || atom.kind === "footnote" || atom.kind === "endnote") return "";
  return atom.text || atom.label;
}

const wordMap = (doc: Y.Doc) => doc.getMap<unknown>(MIND_WORD_FIELD);
const sourcesMap = (doc: Y.Doc) => doc.getMap<unknown>(MIND_WORD_SOURCES_FIELD);

/** The Word file the Mind was imported from, or null for a Mind that wasn't. */
export function wordFileOf(doc: Y.Doc): WordFileInfo | null {
  const file = wordMap(doc).get("file");
  if (!isRecord(file)) return null;
  const { name, sha256, size, part, documentId } = file;
  if (typeof name !== "string" || typeof sha256 !== "string" || typeof part !== "string") {
    return null;
  }
  return {
    name,
    sha256,
    size: typeof size === "number" ? size : 0,
    part,
    documentId: typeof documentId === "string" && documentId !== "" ? documentId : null,
  };
}

/** How far the import has got; null once it is done, or for a Mind that wasn't imported. */
export function wordImportProgressOf(doc: Y.Doc): WordImportProgress | null {
  const progress = wordMap(doc).get("import");
  if (!isRecord(progress)) return null;
  const { done, total } = progress;
  if (typeof done !== "number" || typeof total !== "number" || done >= total) return null;
  return { done, total };
}

export function wordReportOf(doc: Y.Doc): WordImportReport | null {
  const report = wordMap(doc).get("report");
  return isRecord(report) ? (report as unknown as WordImportReport) : null;
}

export function setWordReport(doc: Y.Doc, report: WordImportReport): void {
  wordMap(doc).set("report", report);
}

const noteNumbering = (value: unknown) => {
  if (!isRecord(value)) return null;
  const { format, start } = value;
  return {
    format: typeof format === "string" && /^[A-Za-z]{1,40}$/.test(format) ? format : "decimal",
    start: typeof start === "number" && Number.isInteger(start) && start >= 0 ? start : 1,
  };
};

/**
 * How the Word file numbers its notes (#746); null for a Mind imported before
 * its notes were its own, which `convertWordParts` hasn't converted yet.
 */
export function wordNoteNumberingOf(doc: Y.Doc): WordNoteNumbering | null {
  const notes = wordMap(doc).get("notes");
  if (!isRecord(notes)) return null;
  return {
    footnote: noteNumbering(notes.footnote) ?? { format: "decimal", start: 1 },
    endnote: noteNumbering(notes.endnote) ?? { format: "lowerRoman", start: 1 },
  };
}

export function setWordNoteNumbering(doc: Y.Doc, numbering: WordNoteNumbering): void {
  wordMap(doc).set("notes", {
    footnote: { ...numbering.footnote },
    endnote: { ...numbering.endnote },
  });
}

export function wordOriginOf(doc: Y.Doc): WordOrigin | null {
  const origin = wordMap(doc).get("origin");
  return origin === "own" || origin === "someone-else" ? origin : null;
}

/** Records the file and whose it is, and that nothing of it has been written yet. Inside a transaction. */
export function startWordImport(
  doc: Y.Doc,
  file: WordFileInfo,
  origin: WordOrigin,
  report: WordImportReport,
  total: number,
): void {
  const map = wordMap(doc);
  map.set("file", { ...file });
  map.set("origin", origin);
  map.set("report", report);
  map.set("import", { done: 0, total } satisfies WordImportProgress);
}

/** Names the Document the original became after the import, when adding it then failed (#720). */
export function linkWordFileDocument(doc: Y.Doc, documentId: string): void {
  const map = wordMap(doc);
  const file = map.get("file");
  if (isRecord(file)) map.set("file", { ...file, documentId });
}

/** Records how many top-level Blocks have been written. Inside the transaction that wrote them. */
export function recordWordImportProgress(doc: Y.Doc, done: number, total: number): void {
  wordMap(doc).set("import", { done, total } satisfies WordImportProgress);
}

/** How many top-level Blocks the import has written so far: all of them once it is done. */
export function wordImportDone(doc: Y.Doc): number {
  const progress = wordMap(doc).get("import");
  return isRecord(progress) && typeof progress.done === "number" ? progress.done : 0;
}

export function wordSourceOf(doc: Y.Doc, nodeId: string): WordSource | null {
  const source = sourcesMap(doc).get(nodeId);
  if (!isRecord(source) || typeof source.n !== "string" || typeof source.f !== "string") {
    return null;
  }
  return typeof source.p === "string"
    ? { n: source.n, p: source.p, f: source.f }
    : { n: source.n, f: source.f };
}

export function setWordSource(doc: Y.Doc, nodeId: string, source: WordSource): void {
  sourcesMap(doc).set(nodeId, { ...source });
}

/** Calls `listener` whenever what the Mind keeps about its Word file changes. Returns how to stop. */
export function observeWordFile(doc: Y.Doc, listener: () => void): () => void {
  const map = wordMap(doc);
  map.observe(listener);
  return () => map.unobserve(listener);
}

/**
 * Attributes that don't change what a node is: its id, whether Questions read it, a Proposal on
 * it, its Word look (given later to earlier imports, which mustn't count as an edit).
 */
const NOT_CONTENT = new Set(["id", "includeInContext", PROPOSAL_ATTRIBUTE, WORD_LOOK_ATTRIBUTE]);
const NOT_TEXT_CONTENT = new Set([WORD_RUN_MARK, WORD_TAB_MARK]);
/** Mark attributes that are how a link opens, not where it leads. */
const NOT_MARK_CONTENT = new Set(["target", "rel", "class"]);

/** A value with its keys sorted and its empty ones left out, for hashing. */
export function sorted(value: unknown, skip: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((each) => sorted(each));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !skip.has(key) && value[key] !== null && value[key] !== undefined)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}

/**
 * A footnote's text is left out of what holds it: the note has a source and a
 * fingerprint of its own (#746), so editing it doesn't make its paragraph edited.
 */
function canonical(node: Y.XmlElement | Y.XmlText, rejoin = true, root = true): unknown {
  if (node instanceof Y.XmlText) {
    const runs: [string, Record<string, unknown>][] = [];
    for (const run of node.toDelta() as {
      insert: unknown;
      attributes?: Record<string, unknown>;
    }[]) {
      const marks = Object.fromEntries(
        Object.keys(run.attributes ?? {})
          .filter((mark) => !NOT_TEXT_CONTENT.has(mark))
          .sort()
          .map((mark) => [mark, sorted(run.attributes?.[mark], NOT_MARK_CONTENT)]),
      );
      const last = runs.at(-1);
      // Rejoin text that only a left-out mark split, so adding the mark keeps the fingerprint.
      if (
        rejoin &&
        typeof run.insert === "string" &&
        last &&
        last[0] !== "￼" &&
        JSON.stringify(last[1]) === JSON.stringify(marks)
      ) {
        last[0] += run.insert;
      } else {
        runs.push([typeof run.insert === "string" ? run.insert : "￼", marks]);
      }
    }
    return runs;
  }
  const children =
    !root && node.nodeName === FOOTNOTE_NODE
      ? []
      : node
          .toArray()
          .filter((child) => child instanceof Y.XmlElement || child instanceof Y.XmlText)
          .map((child) => canonical(child as Y.XmlElement | Y.XmlText, rejoin, false));
  return [node.nodeName, sorted(node.getAttributes(), NOT_CONTENT), children];
}

/**
 * A node's fingerprint: what it holds, its text, marks and attributes, but not
 * its id, so a node whose fingerprint has changed since it was imported was
 * edited. The same in the core and the editor.
 */
export function wordFingerprint(element: Y.XmlElement): string {
  return targetHash(JSON.stringify(canonical(element)));
}

/** As recorded by versions before Minds kept the Word look, which didn't rejoin text. */
export function wordFingerprintBeforeLook(element: Y.XmlElement): string {
  return targetHash(JSON.stringify(canonical(element, false)));
}
