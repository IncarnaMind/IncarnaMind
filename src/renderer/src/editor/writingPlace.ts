/**
 * "Writing…" where the assistant writes next while its changes come in
 * (#202): over the paragraph it is writing anew, which is dimmed until its
 * change is in, or after the Block it wrote last, or at the Mind's end. Only
 * a mark on the screen: nothing is in the Mind until a Block is written.
 */

import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { BLOCK_ID_ATTRIBUTE, type WritingPlace as Place } from "../../../core/api";

/** Where the assistant writes next, what its line says, and its marks, made when that changes and moved with each edit. */
interface Writing {
  place: Place | null;
  label: string;
  marks: DecorationSet;
}

const writingPlaceKey = new PluginKey<Writing>("writingPlace");

/** Where the Block with this id is, at any depth; null when it isn't in the Mind. */
export function blockAt(
  doc: ProseMirrorNode,
  id: string,
): { pos: number; node: ProseMirrorNode } | null {
  let found: { pos: number; node: ProseMirrorNode } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs[BLOCK_ID_ATTRIBUTE] === id) found = { pos, node };
    return node.isBlock && !found;
  });
  return found;
}

// The label is drawn in the page's margin, so it sits at the top level: a Block in a table or a list has its top-level Block's edge.
function topBlockStart(doc: ProseMirrorNode, pos: number): number {
  const $pos = doc.resolve(pos);
  return $pos.depth === 0 ? pos : $pos.before(1);
}

function topBlockEnd(doc: ProseMirrorNode, pos: number, size: number): number {
  const $pos = doc.resolve(pos);
  return $pos.depth === 0 ? pos + size : $pos.after(1);
}

function decorations(doc: ProseMirrorNode, place: Place, label: string): Decoration[] {
  const widget = () => {
    const line = document.createElement("div");
    line.contentEditable = "false";
    line.dataset.testid = "mind-writing";
    line.className = "mind-writing";
    const text = document.createElement("span");
    text.className = "answer-writing";
    text.textContent = label;
    line.append(text);
    return line;
  };
  if ("over" in place) {
    const block = blockAt(doc, place.over);
    if (!block) return [];
    return [
      Decoration.widget(topBlockStart(doc, block.pos), widget, {
        side: -1,
        key: `writing:over:${place.over}`,
      }),
      Decoration.node(block.pos, block.pos + block.node.nodeSize, {
        class: "mind-rewriting",
        "data-testid": "mind-rewriting",
      }),
    ];
  }
  const block = place.after === null ? null : blockAt(doc, place.after);
  const at = block ? topBlockEnd(doc, block.pos, block.node.nodeSize) : doc.content.size;
  return [Decoration.widget(at, widget, { side: 1, key: `writing:${place.after ?? "end"}` })];
}

export const WritingPlace = Extension.create({
  name: "writingPlace",

  addProseMirrorPlugins() {
    return [
      new Plugin<Writing>({
        key: writingPlaceKey,
        state: {
          init: () => ({ place: null, label: "", marks: DecorationSet.empty }),
          apply: (tr, writing, _before, state) => {
            const meta = tr.getMeta(writingPlaceKey) as
              | { place: Place | null; label: string }
              | null
              | undefined;
            const place = meta === undefined ? writing.place : (meta?.place ?? null);
            const label = meta === undefined ? writing.label : (meta?.label ?? "");
            if (!place) return { place: null, label: "", marks: DecorationSet.empty };
            // The Mind's document rewrites the whole text on a change from the core: found again then.
            if (meta !== undefined || tr.getMeta(ySyncPluginKey)?.isChangeOrigin) {
              return {
                place,
                label,
                marks: DecorationSet.create(state.doc, decorations(state.doc, place, label)),
              };
            }
            return tr.docChanged
              ? { place, label, marks: writing.marks.map(tr.mapping, tr.doc) }
              : writing;
          },
        },
        props: {
          decorations: (state) => writingPlaceKey.getState(state)?.marks ?? null,
        },
      }),
    ];
  },
});

/** Shows "Writing…" where the assistant writes next, or takes it away (null). */
export function setWritingPlace(editor: Editor, place: Place | null, label = ""): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(writingPlaceKey, { place, label }));
}
