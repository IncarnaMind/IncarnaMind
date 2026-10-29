import { combineTransactionSteps, findChildrenInRange, getChangedRanges } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { NodeType, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { nameOlderCitations } from "../../../shared/signOffs";

export const citationIdsKey = new PluginKey("citationIds");

const hasId = (node: ProseMirrorNode) => typeof node.attrs.id === "string";

/** The Note's nodes by the Yjs element each was last synced to; null outside a synced Note. */
function elementsOf(state: EditorState): Map<ProseMirrorNode, Y.XmlElement> | null {
  const mapping = ySyncPluginKey.getState(state)?.binding?.mapping;
  if (!mapping) return null;
  const elements = new Map<ProseMirrorNode, Y.XmlElement>();
  for (const [type, node] of mapping)
    if (type instanceof Y.XmlElement && !Array.isArray(node)) elements.set(node, type);
  return elements;
}

/**
 * Gives each Citation its own id as it is written (#1933), so "Checked by me" finds it through any
 * edit, Undo or restore: Yjs makes a new element for a Citation Undo brings back, and a restore
 * copies it, but both keep its id. Only this device's own edits give ids, in the ranges they
 * changed; one synced from the core or another device brings its own. A copy pasted beside its
 * Citation gets a new one (`withoutRepeatedIds`).
 *
 * A Citation written before Citations had ids goes by its element's (`citationElementId`), which
 * the versions kept before share, and two devices give the same one. The Note's older ones get
 * theirs on its first edit here, all at once and never on opening it, and so does one a later edit
 * touches: named in Yjs before the edit reaches it and outside Undo, so however the sync drops its
 * element (deleted, changed in place, its Block turned into another kind), Undo brings it back
 * with the id. The assistant's waiting text is left as it wrote it.
 */
export function citationIds(type: NodeType): Plugin {
  let olderWaiting = true;
  return new Plugin({
    key: citationIdsKey,
    appendTransaction(transactions, oldState, newState) {
      const local = transactions.filter((tr) => tr.docChanged && !isChangeOrigin(tr));
      if (local.length === 0 || oldState.doc.eq(newState.doc)) return null;
      const tr = newState.tr;
      const given = new Set<number>();
      const give = (node: ProseMirrorNode, pos: number, id: string) => {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
        given.add(pos);
      };
      const transform = combineTransactionSteps(oldState.doc, [...transactions]);
      const back = transform.mapping.invert();
      const changed = getChangedRanges(transform);

      const binding = ySyncPluginKey.getState(oldState)?.binding;
      const olderTouched = changed.some(
        ({ oldRange }) =>
          findChildrenInRange(oldState.doc, oldRange, (each) => each.type === type && !hasId(each))
            .length > 0,
      );
      let elements: Map<ProseMirrorNode, Y.XmlElement> | null = null;
      if (binding && (olderWaiting || olderTouched)) {
        olderWaiting = false;
        binding.mux(() => nameOlderCitations(binding.type));
        elements = elementsOf(oldState);
      }
      const named = (node: ProseMirrorNode | null | undefined) => {
        const id = node && elements?.get(node)?.getAttribute("id");
        return typeof id === "string" ? id : null;
      };
      const older = (node: ProseMirrorNode | null | undefined) =>
        node !== null && node !== undefined && elements?.has(node) === true;

      const added: { node: ProseMirrorNode; pos: number }[] = [];
      for (const { newRange } of changed) {
        for (const { node, pos } of findChildrenInRange(
          newState.doc,
          newRange,
          (each) => each.type === type,
        )) {
          if (given.has(pos)) continue;
          if (hasId(node)) {
            if (back.mapResult(pos).deleted) added.push({ node, pos });
            continue;
          }
          // Changed in place (Keep citing the old version): the Citation it was.
          const was = older(node) ? node : oldState.doc.nodeAt(back.map(pos));
          const own = named(was);
          if (own) give(node, pos, own);
          else if (!older(was)) give(node, pos, crypto.randomUUID());
        }
      }
      // Written with an id another Citation of the Note holds: a copy, which is a Citation of its own.
      if (added.length > 0) {
        const holders = new Map<string, number>();
        newState.doc.descendants((node) => {
          if (node.type === type && hasId(node))
            holders.set(node.attrs.id, (holders.get(node.attrs.id) ?? 0) + 1);
        });
        for (const { node, pos } of added)
          if ((holders.get(node.attrs.id) ?? 0) > 1) {
            holders.set(node.attrs.id, (holders.get(node.attrs.id) ?? 0) - 1);
            give(node, pos, crypto.randomUUID());
          }
      }
      // The editor's nodes say what Yjs now holds, or the sync would take the ids out again.
      if (elements)
        newState.doc.descendants((node, pos) => {
          if (node.type !== type || hasId(node) || given.has(pos)) return;
          const id = named(node);
          if (id) give(node, pos, id);
        });

      if (!tr.docChanged) return null;
      // Kept out of Undo where the edit it rides on is.
      if (local.at(-1)?.getMeta("addToHistory") === false) tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}
