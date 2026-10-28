import { combineTransactionSteps, findChildrenInRange, getChangedRanges } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { NodeType, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { citationElementId } from "../../../shared/signOffs";
import { proposalKindOf } from "./arrivedChanges";

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
 * theirs on its first edit here, all at once and never on opening it; the assistant's waiting text
 * is left as it wrote it. One an edit changes is given it from the node it was, and one an edit
 * deletes gets it on its element before the edit reaches Yjs, so Undo brings it back with it.
 */
export function citationIds(type: NodeType): Plugin {
  /** Whether the Note's older Citations still wait for their ids. */
  let olderWaiting = true;
  return new Plugin({
    key: citationIdsKey,
    appendTransaction(transactions, oldState, newState) {
      const local = transactions.filter((tr) => tr.docChanged && !isChangeOrigin(tr));
      if (local.length === 0 || oldState.doc.eq(newState.doc)) return null;
      const tr = newState.tr;
      let elements: Map<ProseMirrorNode, Y.XmlElement> | null | undefined;
      const given = new Set<number>();
      const give = (node: ProseMirrorNode, pos: number, id: string) => {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
        given.add(pos);
      };
      /** An older Citation's element, as the Note's last sync left it. */
      const elementOf = (node: ProseMirrorNode | null | undefined) => {
        if (!node || node.type !== type || hasId(node)) return null;
        if (elements === undefined) elements = elementsOf(oldState);
        return elements?.get(node) ?? null;
      };
      const olderId = (node: ProseMirrorNode | null | undefined) => {
        const element = elementOf(node);
        return element ? citationElementId(element) : null;
      };

      const transform = combineTransactionSteps(oldState.doc, [...transactions]);
      const back = transform.mapping.invert();
      const changed = getChangedRanges(transform);
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
          // Left as it was, or changed in place (Keep citing the old version): the Citation it was.
          const own = olderId(node) ?? olderId(oldState.doc.nodeAt(back.map(pos)));
          if (own === null) give(node, pos, crypto.randomUUID());
          else if (!proposalKindOf(node)) give(node, pos, own);
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

      const gone: Y.XmlElement[] = [];
      for (const { oldRange } of changed) {
        for (const { node, pos } of findChildrenInRange(
          oldState.doc,
          oldRange,
          (each) => each.type === type,
        )) {
          const element = elementOf(node);
          if (element && transform.mapping.mapResult(pos).deleted) gone.push(element);
        }
      }
      const binding = ySyncPluginKey.getState(oldState)?.binding;
      if (gone.length > 0 && binding)
        // Kept out of Undo and of this editor: the edit deletes the element right after.
        binding.mux(() =>
          binding.doc.transact(() => {
            for (const element of gone) {
              const id = citationElementId(element);
              if (id) element.setAttribute("id", id);
            }
          }, citationIdsKey),
        );

      if (olderWaiting) {
        if (elements === undefined) elements = elementsOf(oldState);
        if (elements) {
          olderWaiting = false;
          newState.doc.descendants((node, pos) => {
            if (node.type !== type || hasId(node) || given.has(pos) || proposalKindOf(node)) return;
            const id = olderId(node);
            if (id) give(node, pos, id);
          });
        }
      }

      if (!tr.docChanged) return null;
      // As the edit it rides on: kept out of Undo where that edit is.
      if (local.at(-1)?.getMeta("addToHistory") === false) tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}
