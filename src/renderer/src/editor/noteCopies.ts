import { combineTransactionSteps, findChildrenInRange, getChangedRanges } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { FOOTNOTE_NODE } from "../../../core/api";
import { wordFileOf } from "../../../shared/wordFiles";

const isWordNote = (node: ProseMirrorNode) =>
  node.type.name === FOOTNOTE_NODE &&
  (typeof node.attrs.source === "string" || node.attrs.endnote === true);

/**
 * A copy of a Word file's note (#746) is a footnote of the User's own, as
 * ADR-0011 has export write it: pasted or duplicated while the note is still
 * in the Note, or pasted into a Note not imported from Word, it loses the
 * note's place in the file and its being an endnote, so the Note numbers and
 * shows it as the new footnote the file gets. A note moved (cut and pasted,
 * dragged) is the only one with its place, and stays the file's. Only this
 * device's own edits are read, as for Citations' ids (`citationIds`).
 */
export function noteCopies(): Plugin {
  return new Plugin({
    key: new PluginKey("noteCopies"),
    appendTransaction(transactions, before, after) {
      const local = transactions.filter((tr) => tr.docChanged && !isChangeOrigin(tr));
      if (local.length === 0) return null;
      const transform = combineTransactionSteps(before.doc, [...transactions]);
      const back = transform.mapping.invert();
      const added = getChangedRanges(transform).flatMap(({ newRange }) =>
        findChildrenInRange(after.doc, newRange, isWordNote).filter(
          ({ pos }) => back.mapResult(pos).deleted,
        ),
      );
      if (added.length === 0) return null;

      const doc: Y.Doc | undefined = ySyncPluginKey.getState(after)?.binding?.doc;
      const fromWord = !doc || wordFileOf(doc) !== null;
      const holders = new Map<string, number>();
      after.doc.descendants((node) => {
        const source: unknown = node.attrs.source;
        if (node.type.name === FOOTNOTE_NODE && typeof source === "string")
          holders.set(source, (holders.get(source) ?? 0) + 1);
      });
      const tr = after.tr;
      const seen = new Set<number>();
      for (const { node, pos } of added) {
        if (seen.has(pos)) continue;
        seen.add(pos);
        const source: unknown = node.attrs.source;
        const holding = typeof source === "string" ? (holders.get(source) ?? 0) : 0;
        if (fromWord && holding === 1) continue;
        if (typeof source === "string") holders.set(source, holding - 1);
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, source: null, endnote: null });
      }
      if (!tr.docChanged) return null;
      // Kept out of Undo where the edit it rides on is.
      if (local.at(-1)?.getMeta("addToHistory") === false) tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}
