/**
 * What a Word import kept as is (#104) and where export writes it (#105).
 * Each atom's XML is written once, by the paragraph it came from while that
 * paragraph is in the Mind, else by the first that holds it. A copy is
 * written as its text, except what has no id to clash (a field, an
 * equation, a symbol, a page break). Marks that come in pairs (a bookmark's
 * start and end, a comment's range and its mark) are left out when their
 * other half is gone, as Word would repair the file. What can't be kept,
 * someone's comment or tracked change on deleted text, is said.
 *
 * When the User's edits are tracked (#107), what they deleted stays in the
 * file as their deletion, with whatever is kept as is in it: nothing is left
 * out, and every pair stays whole.
 */
import type { NodeJSON } from "../../../shared/blockJson";
import { readWordAtom, wordAtomText } from "../../../shared/wordFiles";
import type { WordAtomKind, WordExportLoss } from "../../api";
import type { Places } from "../../documents/formats/docxImport";
import { type Counterpart, counterpartsOf } from "./mind";
import { sourceOf } from "./paragraph";

/** What an atom's copy can be written as again, having no id that would clash. */
const COPYABLE: ReadonlySet<WordAtomKind> = new Set(["field", "equation", "symbol", "pageBreak"]);

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
  /** The paragraph or Block it is in, or is. */
  owner: NodeJSON;
  ownerKey: string | null;
}

export class AtomPlan {
  /** The node that writes each atom's XML. */
  private readonly writer = new Map<string, NodeJSON>();
  /** Atoms nothing writes: deleted, or the other half of their pair is. */
  private readonly unwritten = new Set<string>();
  /** Atoms written where they were, in what the User deleted, as their deletion. */
  private readonly removed = new Set<string>();
  readonly losses: WordExportLoss[] = [];

  constructor(
    base: readonly NodeJSON[],
    current: readonly NodeJSON[],
    baseKey: (node: NodeJSON) => string | null,
    currentKey: (node: NodeJSON) => string | null,
    places: Places,
    /** The User's edits are tracked: what they deleted stays, as deleted. */
    track = false,
  ) {
    const baseAtoms = occurrences(base, baseKey);
    const now = occurrences(current, currentKey);
    const presentKeys = new Set(
      [...now.values()].flat().flatMap((each) => (each.ownerKey ? [each.ownerKey] : [])),
    );
    for (const [source, found] of now) {
      const home = baseAtoms.get(source)?.[0]?.ownerKey ?? null;
      const atHome =
        home && presentKeys.has(home) ? found.find((each) => each.ownerKey === home) : undefined;
      this.writer.set(source, (atHome ?? (found[0] as Occurrence)).owner);
    }
    for (const source of baseAtoms.keys()) {
      if (!this.writer.has(source)) (track ? this.removed : this.unwritten).add(source);
    }

    // Pairs: a half whose other half isn't written goes too.
    const halves = new Map<string, Map<"start" | "end" | "mark", string>>();
    for (const source of baseAtoms.keys()) {
      const element = places.get(source);
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
   * Whether `owner` writes the atom's XML: the one chosen, or anyone for one
   * that can be copied, unless nothing may.
   */
  writes(source: string, owner: NodeJSON, kind: WordAtomKind): boolean {
    if (this.unwritten.has(source)) return false;
    return this.writer.get(source) === owner || COPYABLE.has(kind);
  }

  /** The paragraph or Block that writes the atom's XML, if one does. */
  ownerOf(source: string): NodeJSON | undefined {
    return this.writer.get(source);
  }

  /** Whether the atom is written somewhere. */
  written(source: string): boolean {
    return this.writer.has(source) || this.removed.has(source);
  }

  /** Whether the atom is written by something in the Mind, rather than where it was, as deleted. */
  writtenElsewhere(source: string): boolean {
    return this.writer.has(source);
  }

  /** A copy written as its text: said, unless it shows nothing. */
  copied(node: NodeJSON): void {
    const atom = readWordAtom(node.attrs ?? {});
    const text = (atom.label || atom.text || wordAtomText(atom)).trim();
    if (!text && atom.kind !== "picture" && atom.kind !== "textBox" && atom.kind !== "shape")
      return;
    const key = `copy:${atom.source ?? ""}`;
    if (this.losses.some((each) => each.key === key)) return;
    this.losses.push({ key, kind: "copy", author: null, text: text.slice(0, QUOTED) });
  }
}

/** Every atom in some Blocks, by source, with the paragraph or Block it is in. */
function occurrences(
  blocks: readonly NodeJSON[],
  keyOf: (node: NodeJSON) => string | null,
): Map<string, Occurrence[]> {
  const found = new Map<string, Occurrence[]>();
  const add = (source: string, occurrence: Occurrence) =>
    found.set(source, [...(found.get(source) ?? []), occurrence]);
  const visit = (counterparts: readonly Counterpart[]) => {
    for (const counterpart of counterparts) {
      if (counterpart.kind === "kept") {
        const source = readWordAtom(counterpart.node.attrs ?? {}).source;
        if (source)
          add(source, {
            node: counterpart.node,
            owner: counterpart.node,
            ownerKey: counterpart.key,
          });
      } else if (counterpart.kind === "table") {
        for (const row of counterpart.node.content ?? []) {
          for (const cell of row.content ?? []) visit(counterpartsOf(cell.content ?? [], keyOf));
        }
      } else if (counterpart.kind === "paragraph") {
        for (const node of counterpart.node.content ?? []) {
          const source = sourceOf(node);
          if (source) add(source, { node, owner: counterpart.node, ownerKey: counterpart.key });
        }
      }
    }
  };
  visit(counterpartsOf(blocks, keyOf));
  return found;
}
