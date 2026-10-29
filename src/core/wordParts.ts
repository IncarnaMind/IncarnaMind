/**
 * A Note imported from Word before its footnotes, endnotes and page breaks
 * were its own (#746) holds them as read-only atoms. When it is opened they
 * become the Note's own, read from its kept package as an import reads them
 * now: each atom is replaced where it is, so the Note's text stays as the
 * User left it. A Block that was still as imported is fingerprinted again,
 * so export still finds it unchanged; one the User edited stays edited. A
 * note a footnote can't hold stays an atom, and a column break, read as a
 * page break before, becomes an atom of its own kind.
 */
import * as Y from "yjs";
import type { NodeJSON } from "../shared/blockJson";
import {
  setWordNoteNumbering,
  setWordReport,
  setWordSource,
  wordFingerprint,
  wordFingerprintBeforeLook,
  wordNoteNumberingOf,
  wordReportOf,
  wordSourceOf,
} from "../shared/wordFiles";
import { createElement } from "./answers/blocks";
import {
  BLOCK_ID_ATTRIBUTE,
  FOOTNOTE_NODE,
  PAGE_BREAK_NODE,
  WORD_ATOM_NODE,
  type WordAtomKind,
} from "./api";
import type { WordStructure } from "./documents/formats/docxImport";

export interface PartsConverted {
  footnotes: number;
  endnotes: number;
  pageBreaks: number;
}

/** What an import now reads at each place of the document: a note, a page break, a column break. */
function readByPlace(structure: WordStructure): Map<string, NodeJSON> {
  const found = new Map<string, NodeJSON>();
  const visit = (node: NodeJSON) => {
    const source = node.attrs?.source;
    if (
      typeof source === "string" &&
      (node.type === FOOTNOTE_NODE ||
        node.type === PAGE_BREAK_NODE ||
        (node.type === WORD_ATOM_NODE && node.attrs?.kind === "columnBreak"))
    ) {
      found.set(source, node);
      return;
    }
    for (const each of node.content ?? []) visit(each);
  };
  for (const block of structure.blocks) visit(block);
  return found;
}

const OLD_KINDS: ReadonlySet<WordAtomKind> = new Set(["footnote", "endnote", "pageBreak"]);

/** Whether the Note still holds what an import before #746 made, and needs converting. */
export const needsPartsConverted = (doc: Y.Doc): boolean => wordNoteNumberingOf(doc) === null;

/**
 * Converts the Note's old atoms in one change; does nothing for a Note
 * already converted, or imported since. Inside a transaction.
 */
export function convertWordParts(
  doc: Y.Doc,
  blocks: Y.XmlFragment,
  structure: WordStructure,
): PartsConverted | null {
  if (!needsPartsConverted(doc)) return null;
  const read = readByPlace(structure);
  const replaced: { atom: Y.XmlElement; node: NodeJSON }[] = [];
  const visit = (element: Y.XmlElement) => {
    for (const child of element.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName !== WORD_ATOM_NODE) {
        visit(child);
        continue;
      }
      const kind = child.getAttribute("kind") as WordAtomKind | undefined;
      const source = child.getAttribute("source");
      const now = typeof source === "string" ? read.get(source) : undefined;
      if (kind && OLD_KINDS.has(kind) && now) replaced.push({ atom: child, node: now });
    }
  };
  for (const child of blocks.toArray()) if (child instanceof Y.XmlElement) visit(child);

  // What holds a converted atom and was as imported is fingerprinted again once it is converted.
  const unchanged = new Set<Y.XmlElement>();
  for (const { atom } of replaced) {
    for (let at = atom.parent; at instanceof Y.XmlElement; at = at.parent) {
      const id = at.getAttribute(BLOCK_ID_ATTRIBUTE);
      const source = typeof id === "string" ? wordSourceOf(doc, id) : null;
      if (
        source &&
        (wordFingerprint(at) === source.f || wordFingerprintBeforeLook(at) === source.f)
      ) {
        unchanged.add(at);
      }
    }
  }

  const converted: PartsConverted = { footnotes: 0, endnotes: 0, pageBreaks: 0 };
  const notes: Y.XmlElement[] = [];
  for (const { atom, node } of replaced) {
    const parent = atom.parent;
    if (!(parent instanceof Y.XmlElement)) continue;
    if (node.type === WORD_ATOM_NODE) {
      atom.setAttribute("kind", "columnBreak");
      continue;
    }
    const index = parent.toArray().indexOf(atom);
    const element = createElement(node);
    parent.delete(index, 1);
    parent.insert(index, [element]);
    if (node.type === PAGE_BREAK_NODE) converted.pageBreaks++;
    else {
      notes.push(element);
      if (node.attrs?.endnote === true) converted.endnotes++;
      else converted.footnotes++;
    }
  }
  for (const note of notes) {
    const id = note.getAttribute(BLOCK_ID_ATTRIBUTE);
    const source = note.getAttribute("source");
    if (typeof id === "string" && typeof source === "string") {
      setWordSource(doc, id, { n: source, f: wordFingerprint(note) });
    }
  }
  for (const element of unchanged) {
    const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
    const source = typeof id === "string" ? wordSourceOf(doc, id) : null;
    if (typeof id === "string" && source) {
      setWordSource(doc, id, { ...source, f: wordFingerprint(element) });
    }
  }

  setWordNoteNumbering(doc, structure.noteNumbering);
  const report = wordReportOf(doc);
  if (report) {
    const { footnote, endnote, pageBreak, columnBreak, ...kept } = report.kept;
    const left = (count: number | undefined, less: number) =>
      (count ?? 0) > less ? (count ?? 0) - less : undefined;
    const keptNotes = {
      footnote: left(footnote, converted.footnotes),
      endnote: left(endnote, converted.endnotes),
      columnBreak: left((pageBreak ?? 0) + (columnBreak ?? 0), converted.pageBreaks),
    };
    setWordReport(doc, {
      ...report,
      kept: {
        ...kept,
        ...Object.fromEntries(Object.entries(keptNotes).filter(([, count]) => count !== undefined)),
      },
      footnotes: converted.footnotes,
      endnotes: converted.endnotes,
      pageBreaks: converted.pageBreaks,
    });
  }
  return converted;
}
