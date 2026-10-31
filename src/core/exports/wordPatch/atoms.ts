/**
 * What a Word import kept as is (#104) and where export writes it (#105).
 * Each atom's XML is written once, by one occurrence: the node the import
 * read it into, wherever it is now, else the first in the paragraph it came
 * from while that paragraph is in the Mind, else the first anywhere. A copy
 * is written as its text, or a note's mark, a page break or a picture as a
 * new one (#746), except what has no id to clash (a field, an equation, a
 * symbol, a page break). So is a node whose place this file doesn't have, or
 * has as something else (another picture, another field or note), which was
 * pasted from another file's Note, and one with no place at all.
 * Marks that come in pairs (a bookmark's start and end, a comment's range
 * and its mark) are left out when their other half is gone, as Word would
 * repair the file. What can't be kept, someone's comment or tracked change
 * on deleted text, is said.
 *
 * When the User's edits are tracked (#107), what they deleted stays in the
 * file as their deletion, with whatever is kept as is in it: nothing is left
 * out, and every pair stays whole.
 */
import type { NodeJSON } from "../../../shared/blockJson";
import {
  BREAK_WORD_ATOMS,
  COPYABLE_WORD_ATOMS,
  INVISIBLE_WORD_ATOMS,
  readWordAtom,
  wordAtomText,
} from "../../../shared/wordFiles";
import {
  FOOTNOTE_NODE,
  IMAGE_NODE,
  PAGE_BREAK_NODE,
  WORD_ATOM_NODE,
  WORD_BLOCK_NODE,
  type WordAtomKind,
  type WordExportLoss,
} from "../../api";
import { type PlaceFile, placeHash } from "../../documents/formats/docxImport";
import { type Counterpart, counterpartsOf } from "./mind";
import { sourceOf } from "./paragraph";

/** Marks that come in pairs, by element: which pair, and which half. */
const PAIRED: Readonly<Record<string, { family: string; half: "start" | "end" | "mark" }>> = {
  "w:bookmarkStart": { family: "bookmark", half: "start" },
  "w:bookmarkEnd": { family: "bookmark", half: "end" },
  "w:commentRangeStart": { family: "comment", half: "start" },
  "w:commentRangeEnd": { family: "comment", half: "end" },
  "w:commentReference": { family: "comment", half: "mark" },
  "w:permStart": { family: "perm", half: "start" },
  "w:permEnd": { family: "perm", half: "end" },
  "w:moveFromRangeStart": { family: "moveFrom", half: "start" },
  "w:moveFromRangeEnd": { family: "moveFrom", half: "end" },
  "w:moveToRangeStart": { family: "moveTo", half: "start" },
  "w:moveToRangeEnd": { family: "moveTo", half: "end" },
  "w:customXmlInsRangeStart": { family: "customXmlIns", half: "start" },
  "w:customXmlInsRangeEnd": { family: "customXmlIns", half: "end" },
  "w:customXmlDelRangeStart": { family: "customXmlDel", half: "start" },
  "w:customXmlDelRangeEnd": { family: "customXmlDel", half: "end" },
  "w:customXmlMoveFromRangeStart": { family: "customXmlMoveFrom", half: "start" },
  "w:customXmlMoveFromRangeEnd": { family: "customXmlMoveFrom", half: "end" },
  "w:customXmlMoveToRangeStart": { family: "customXmlMoveTo", half: "start" },
  "w:customXmlMoveToRangeEnd": { family: "customXmlMoveTo", half: "end" },
};

/** The longest a lost comment's or change's text is quoted. */
const QUOTED = 120;

interface Occurrence {
  node: NodeJSON;
  /** The key of the paragraph or Block it is in, or is. */
  ownerKey: string | null;
}

export class AtomPlan {
  /** The occurrence that writes each atom's XML. */
  private readonly writer = new Map<string, NodeJSON>();
  /** Atoms nothing writes: deleted, or the other half of their pair is. */
  private readonly unwritten = new Set<string>();
  /** Atoms written where they were, in what the User deleted, as their deletion. */
  private readonly removed = new Set<string>();
  /** Nodes naming a place this file doesn't have as what they are: from another file. */
  private readonly foreign = new Set<NodeJSON>();
  readonly losses: WordExportLoss[] = [];

  constructor(
    base: readonly NodeJSON[],
    current: readonly NodeJSON[],
    baseKey: (node: NodeJSON) => string | null,
    currentKey: (node: NodeJSON) => string | null,
    /** The document part as the file has it. */
    file: PlaceFile,
    /** The User's edits are tracked: what they deleted stays, as deleted. */
    track = false,
    /** Whether a node is the one the import read its atom into, not a copy with a new id. */
    imported: (node: NodeJSON) => boolean = () => false,
  ) {
    const baseAtoms = occurrences(base, baseKey);
    const placeless: NodeJSON[] = [];
    const now = occurrences(current, currentKey, placeless);
    for (const node of placeless) this.copied(node);
    const presentKeys = new Set(
      [...now.values()].flat().flatMap((each) => (each.ownerKey ? [each.ownerKey] : [])),
    );
    for (const [source, all] of now) {
      const found = all.filter((each) => {
        const fits = isAt(each.node, file, baseAtoms.get(source)?.[0]?.node);
        if (!fits) this.foreign.add(each.node);
        return fits;
      });
      const home = baseAtoms.get(source)?.[0]?.ownerKey ?? null;
      const atHome =
        home && presentKeys.has(home) ? found.find((each) => each.ownerKey === home) : undefined;
      const chosen = found.find((each) => imported(each.node)) ?? atHome ?? found[0];
      if (chosen) this.writer.set(source, chosen.node);
    }
    for (const source of baseAtoms.keys()) {
      if (!this.writer.has(source)) (track ? this.removed : this.unwritten).add(source);
    }

    // Pairs: a half whose other half isn't written goes too.
    const halves = new Map<string, Map<"start" | "end" | "mark", string>>();
    for (const source of baseAtoms.keys()) {
      const element = file.places.get(source);
      const pair = element && PAIRED[element.name];
      const id = element?.attrs["w:id"];
      if (!pair || id === undefined) continue;
      const key = `${pair.family}:${id}`;
      const found = halves.get(key) ?? new Map();
      found.set(pair.half, source);
      halves.set(key, found);
    }
    for (const [key, found] of halves) {
      const written = (half: "start" | "end" | "mark") => {
        const source = found.get(half);
        return source !== undefined && !this.unwritten.has(source);
      };
      const drop = (half: "start" | "end" | "mark") => {
        const source = found.get(half);
        if (source) this.unwritten.add(source);
      };
      if (key.startsWith("comment:") && found.has("mark") && !written("mark")) {
        drop("start");
        drop("end");
      }
      if (found.has("start") && found.has("end") && written("start") !== written("end")) {
        drop("start");
        drop("end");
      }
    }
    for (const source of this.unwritten) this.writer.delete(source);

    for (const [source, [first]] of baseAtoms) {
      if (!first || !this.unwritten.has(source)) continue;
      const atom = readWordAtom(first.node.attrs ?? {});
      const kind =
        atom.kind === "comment"
          ? "comment"
          : atom.kind === "insertion" || atom.kind === "deletion"
            ? "change"
            : null;
      if (!kind) continue;
      const text = (kind === "comment" ? atom.text : atom.label).trim();
      this.losses.push({
        key: `${kind}:${source}`,
        kind,
        author: atom.info?.author ?? null,
        text: text.length > QUOTED ? `${text.slice(0, QUOTED - 1)}…` : text,
      });
    }
  }

  /**
   * Whether `node` (the atom in a paragraph, or a kept Block) writes the
   * atom's XML: the occurrence chosen, or any for one that can be copied,
   * unless nothing may.
   */
  writes(source: string, node: NodeJSON, kind: WordAtomKind): boolean {
    if (this.unwritten.has(source) || this.foreign.has(node)) return false;
    return this.writer.get(source) === node || COPYABLE_WORD_ATOMS.has(kind);
  }

  /** Whether the node names a place this file doesn't have as what it is: it is written new. */
  isForeign(node: NodeJSON): boolean {
    return this.foreign.has(node);
  }

  /** Whether the atom is written somewhere. */
  written(source: string): boolean {
    return this.writer.has(source) || this.removed.has(source);
  }

  /** Whether the atom is written by something in the Mind, rather than where it was, as deleted. */
  writtenElsewhere(source: string): boolean {
    return this.writer.has(source);
  }

  /**
   * A copy written as its text, or a note kept as is as a new footnote: said,
   * unless it shows nothing (a bookmark, a range, a break).
   */
  copied(node: NodeJSON): void {
    const atom = readWordAtom(node.attrs ?? {});
    const note = atom.kind === "footnote" || atom.kind === "endnote";
    const text = (note ? atom.text : atom.label || atom.text || wordAtomText(atom)).trim();
    if (!text && (INVISIBLE_WORD_ATOMS.has(atom.kind) || BREAK_WORD_ATOMS.has(atom.kind))) return;
    const key = `copy:${atom.source ?? `${atom.kind}:${text}`}`;
    if (this.losses.some((each) => each.key === key)) return;
    const kind = note && !text ? "note" : "copy";
    this.losses.push({ key, kind, author: null, text: text.slice(0, QUOTED) });
  }
}

/**
 * Whether a node is at the place it names: the file has a note's mark of its
 * kind or a page break there, the same picture (`imported`, what the import
 * read there), or the atom itself (`isFilesAtom`).
 */
function isAt(node: NodeJSON, file: PlaceFile, imported: NodeJSON | undefined): boolean {
  const source = sourceOf(node);
  const element = source ? file.places.get(source) : undefined;
  if (node.type === IMAGE_NODE) {
    return imported?.type === IMAGE_NODE && imported.attrs?.src === node.attrs?.src;
  }
  if (node.type === FOOTNOTE_NODE) {
    const mark = node.attrs?.endnote === true ? "w:endnoteReference" : "w:footnoteReference";
    return element?.name === mark;
  }
  if (node.type === PAGE_BREAK_NODE) {
    return element?.name === "w:br" && element.attrs["w:type"] === "page";
  }
  return isFilesAtom(node, file);
}

/**
 * Whether what the import kept as is is the file's own at the place it names
 * (#746), judged by what the file has there, never by the text an import
 * read, which another version reads otherwise: the file's XML there hashes as
 * it did when the atom was imported. One imported before the hash was
 * recorded is the file's where the file has something there, a note's mark
 * for a note.
 */
export function isFilesAtom(node: NodeJSON, file: PlaceFile): boolean {
  const { kind, source, hash } = readWordAtom(node.attrs ?? {});
  if (!source) return false;
  const now = placeHash(file, source);
  if (hash !== null || now === null) return now !== null && now === hash;
  const mark = file.places.get(source)?.name;
  if (kind === "footnote") return mark === "w:footnoteReference";
  if (kind === "endnote") return mark === "w:endnoteReference";
  return true;
}

/** What a copy of an atom written as its text reads: a note's text for a note kept as is. */
export function copiedText(node: NodeJSON): string {
  if (node.type !== WORD_ATOM_NODE && node.type !== WORD_BLOCK_NODE) return "";
  const atom = readWordAtom(node.attrs ?? {});
  return atom.kind === "footnote" || atom.kind === "endnote" ? atom.text : wordAtomText(atom);
}

/**
 * Every atom in some Blocks, by source, with the paragraph or Block it is in;
 * those with no source, a copy from another file's Note, into `placeless`.
 */
function occurrences(
  blocks: readonly NodeJSON[],
  keyOf: (node: NodeJSON) => string | null,
  placeless: NodeJSON[] = [],
): Map<string, Occurrence[]> {
  const found = new Map<string, Occurrence[]>();
  const add = (source: string, occurrence: Occurrence) =>
    found.set(source, [...(found.get(source) ?? []), occurrence]);
  const visit = (counterparts: readonly Counterpart[]) => {
    for (const counterpart of counterparts) {
      if (counterpart.kind === "kept") {
        const source = readWordAtom(counterpart.node.attrs ?? {}).source;
        if (source) add(source, { node: counterpart.node, ownerKey: counterpart.key });
        else placeless.push(counterpart.node);
      } else if (counterpart.kind === "table") {
        for (const row of counterpart.node.content ?? []) {
          for (const cell of row.content ?? []) visit(counterpartsOf(cell.content ?? [], keyOf));
        }
      } else if (counterpart.kind === "paragraph") {
        for (const node of counterpart.node.content ?? []) {
          const source = sourceOf(node);
          if (source) add(source, { node, ownerKey: counterpart.key });
          else if (node.type === WORD_ATOM_NODE) placeless.push(node);
        }
      }
    }
  };
  visit(counterpartsOf(blocks, keyOf));
  return found;
}
