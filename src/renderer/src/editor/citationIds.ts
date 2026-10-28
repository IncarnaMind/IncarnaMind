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
 * The Note's older Citations, written before Citations had ids, get theirs on its first edit here,
 * all at once and never on opening it, each its element's (`citationElementId`), so two devices
 * give the same one. The assistant's waiting text is left as it wrote it.
 */
export function citationIds(type: NodeType): Plugin {
  let older = true;
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
      /** An older Citation's id: its element's, which the edit left as it was. */
      const synced = (node: ProseMirrorNode) => {
        if (elements === undefined) elements = elementsOf(oldState);
        const element = elements?.get(node);
        return element ? citationElementId(element) : null;
      };

      const transform = combineTransactionSteps(oldState.doc, [...transactions]);
      const back = transform.mapping.invert();
      const added: { node: ProseMirrorNode; pos: number }[] = [];
      for (const { newRange } of getChangedRanges(transform)) {
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
          const own = synced(node);
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

      if (elements === undefined && older) elements = elementsOf(oldState);
      if (older && elements) {
        older = false;
        newState.doc.descendants((node, pos) => {
          if (node.type !== type || hasId(node) || given.has(pos) || proposalKindOf(node)) return;
          const id = synced(node);
          if (id) give(node, pos, id);
        });
      }

      if (!tr.docChanged) return null;
      // As the edit it rides on: kept out of Undo where that edit is.
      if (local.at(-1)?.getMeta("addToHistory") === false) tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}
