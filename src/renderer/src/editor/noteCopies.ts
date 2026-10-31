import { combineTransactionSteps, findChildrenInRange, getChangedRanges } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { type Attrs, Fragment, type Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import {
  FOOTNOTE_NODE,
  IMAGE_NODE,
  PAGE_BREAK_NODE,
  WORD_ATOM_NODE,
  WORD_BLOCK_NODE,
} from "../../../core/api";
import { COPYABLE_WORD_ATOMS, wordFileOf } from "../../../shared/wordFiles";

/** What the import kept as is: a field, a note or a picture kept as is, a content control. */
const KEPT: ReadonlySet<string> = new Set([WORD_ATOM_NODE, WORD_BLOCK_NODE]);
const SOURCED: ReadonlySet<string> = new Set([PAGE_BREAK_NODE, IMAGE_NODE, ...KEPT]);

/** A Word file's note, page break or picture, or what its import kept as is: it names its place in the file. */
const isPlaced = (node: ProseMirrorNode) =>
  (node.type.name === FOOTNOTE_NODE &&
    (typeof node.attrs.source === "string" || node.attrs.endnote === true)) ||
  (SOURCED.has(node.type.name) && typeof node.attrs.source === "string");

/** A copy of a node, with no place in the file: a footnote, as export writes a note's copy. */
function withoutPlace(node: ProseMirrorNode): Attrs {
  if (node.type.name === FOOTNOTE_NODE) return { ...node.attrs, source: null, endnote: null };
  if (!KEPT.has(node.type.name)) return { ...node.attrs, source: null };
  const kind: unknown = node.attrs.kind === "endnote" ? "footnote" : node.attrs.kind;
  return { ...node.attrs, source: null, hash: null, kind };
}

/** The Note's Word file, by its content's hash; undefined for an editor not bound to a Note. */
function fileOf(state: EditorState): string | null | undefined {
  const doc: Y.Doc | undefined = ySyncPluginKey.getState(state)?.binding?.doc;
  return doc ? (wordFileOf(doc)?.sha256 ?? null) : undefined;
}

function withPlaces(fragment: Fragment, place: (node: ProseMirrorNode) => unknown): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (isPlaced(node))
      nodes.push(
        node.type.create(
          { ...node.attrs, source: place(node) },
          withPlaces(node.content, place),
          node.marks,
        ),
      );
    else if (node.isText || node.childCount === 0) nodes.push(node);
    else nodes.push(node.copy(withPlaces(node.content, place)));
  });
  return Fragment.fromArray(nodes);
}

/**
 * A copy of a Word file's note, page break or picture (#746), or of what its
 * import kept as is (a field, a note or a picture kept as is), is the User's
 * own, as ADR-0011 has export write it. Copied, it takes the file it
 * came from with it, by its hash before its place (places hold no space);
 * pasted or dropped into a Note of another file or of none, or while the
 * original is still in the Note, it loses its place and its being an endnote,
 * so the Note numbers and shows it as the new footnote the file gets. What
 * the file can hold twice (a field, an equation) keeps its place in a Note
 * of its own file, as export writes it again. A note moved within its file's
 * Note (cut and pasted, dragged) is the only one with its place, and stays
 * the file's. Only this device's own edits are read, as for Citations' ids
 * (`citationIds`).
 */
export function noteCopies(): Plugin {
  return new Plugin({
    key: new PluginKey("noteCopies"),
    props: {
      transformCopied: (slice, view) => {
        const file = fileOf(view.state) ?? "";
        return new Slice(
          withPlaces(slice.content, (node) => `${file} ${String(node.attrs.source ?? "")}`),
          slice.openStart,
          slice.openEnd,
        );
      },
    },
    appendTransaction(transactions, before, after) {
      const local = transactions.filter((tr) => tr.docChanged && !isChangeOrigin(tr));
      if (local.length === 0) return null;
      const transform = combineTransactionSteps(before.doc, [...transactions]);
      const back = transform.mapping.invert();
      const added = getChangedRanges(transform).flatMap(({ newRange }) =>
        findChildrenInRange(after.doc, newRange, isPlaced).filter(
          ({ pos }) => back.mapResult(pos).deleted,
        ),
      );
      if (added.length === 0) return null;

      const file = fileOf(after);
      /** Where a node is in the Note's file: a copy from another file, or from none, is nowhere. */
      const placeOf = (node: ProseMirrorNode): string | null => {
        const source: unknown = node.attrs.source;
        if (typeof source !== "string" || source === "") return null;
        const cut = source.indexOf(" ");
        if (cut < 0) return source;
        return file && source.slice(0, cut) === file ? source.slice(cut + 1) || null : null;
      };
      const holders = new Map<string, number>();
      after.doc.descendants((node) => {
        const place = isPlaced(node) ? placeOf(node) : null;
        if (place) holders.set(place, (holders.get(place) ?? 0) + 1);
      });
      const tr = after.tr;
      const seen = new Set<number>();
      for (const { node, pos } of added) {
        if (seen.has(pos)) continue;
        seen.add(pos);
        const place = placeOf(node);
        const holding = place ? (holders.get(place) ?? 0) : 0;
        const fromWord = file !== null;
        const twice = KEPT.has(node.type.name) && COPYABLE_WORD_ATOMS.has(node.attrs.kind);
        if (place && fromWord && (holding === 1 || twice)) {
          if (place !== node.attrs.source)
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, source: place });
          continue;
        }
        if (place) holders.set(place, holding - 1);
        tr.setNodeMarkup(pos, undefined, withoutPlace(node));
      }
      if (!tr.docChanged) return null;
      // Kept out of Undo where the edit it rides on is.
      if (local.at(-1)?.getMeta("addToHistory") === false) tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}
