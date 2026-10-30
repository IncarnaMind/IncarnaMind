import { combineTransactionSteps, findChildrenInRange, getChangedRanges } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { Fragment, type Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { FOOTNOTE_NODE, IMAGE_NODE, PAGE_BREAK_NODE } from "../../../core/api";
import { wordFileOf } from "../../../shared/wordFiles";

/** A Word file's note, page break or picture: it names its place in the file. */
const isPlaced = (node: ProseMirrorNode) =>
  (node.type.name === FOOTNOTE_NODE &&
    (typeof node.attrs.source === "string" || node.attrs.endnote === true)) ||
  ((node.type.name === PAGE_BREAK_NODE || node.type.name === IMAGE_NODE) &&
    typeof node.attrs.source === "string");

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
        node.type.create({ ...node.attrs, source: place(node) }, node.content, node.marks),
      );
    else if (node.isText || node.childCount === 0) nodes.push(node);
    else nodes.push(node.copy(withPlaces(node.content, place)));
  });
  return Fragment.fromArray(nodes);
}

/**
 * A copy of a Word file's note, page break or picture (#746) is a new one
 * of the User's own, as ADR-0011 has export write it. Copied, it takes the file it
 * came from with it, by its hash before its place (places hold no space);
 * pasted or dropped into a Note of another file or of none, or while the
 * original is still in the Note, it loses its place and its being an endnote,
 * so the Note numbers and shows it as the new footnote the file gets. A note
 * moved within its file's Note (cut and pasted, dragged) is the only one with
 * its place, and stays the file's. Only this device's own edits are read, as
 * for Citations' ids (`citationIds`).
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
        if (place && fromWord && holding === 1) {
          if (place !== node.attrs.source)
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, source: place });
          continue;
        }
        if (place) holders.set(place, holding - 1);
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, source: null, endnote: null });
      }
      if (!tr.docChanged) return null;
      // Kept out of Undo where the edit it rides on is.
      if (local.at(-1)?.getMeta("addToHistory") === false) tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}
