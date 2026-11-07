import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { BLOCK_ID_ATTRIBUTE } from "../../../core/api";

export const MEETING_FILL_SLOT = '[data-testid="meeting-fill-place"]';

interface FillPlace {
  addedBlockIds: readonly string[] | null;
  marks: DecorationSet;
}

const meetingFillPlaceKey = new PluginKey<FillPlace>("meetingFillPlace");

function decorations(doc: ProseMirrorNode, addedBlockIds: readonly string[]): DecorationSet {
  const ids = new Set(addedBlockIds);
  let first: number | null = null;
  doc.descendants((node, pos) => {
    if (first !== null) return false;
    if (node.isBlock && ids.has(node.attrs[BLOCK_ID_ATTRIBUTE])) first = pos;
    return node.isBlock && first === null;
  });
  return DecorationSet.create(doc, [
    Decoration.widget(
      first ?? doc.content.size,
      () => {
        const slot = document.createElement("div");
        slot.setAttribute("contenteditable", "false");
        slot.dataset.testid = "meeting-fill-place";
        slot.className = "my-3";
        return slot;
      },
      {
        key: "meeting-fill-place",
        side: -1,
        stopEvent: () => true,
        ignoreSelection: true,
      },
    ),
  ]);
}

export const MeetingFillPlace = Extension.create({
  name: "meetingFillPlace",

  addProseMirrorPlugins() {
    return [
      new Plugin<FillPlace>({
        key: meetingFillPlaceKey,
        state: {
          init: () => ({ addedBlockIds: null, marks: DecorationSet.empty }),
          apply: (tr, value, _before, state) => {
            const meta: readonly string[] | null | undefined = tr.getMeta(meetingFillPlaceKey);
            if (meta === undefined && !tr.docChanged) return value;
            const addedBlockIds = meta === undefined ? value.addedBlockIds : meta;
            return {
              addedBlockIds,
              marks:
                addedBlockIds === null
                  ? DecorationSet.empty
                  : decorations(state.doc, addedBlockIds),
            };
          },
        },
        props: { decorations: (state) => meetingFillPlaceKey.getState(state)?.marks ?? null },
      }),
    ];
  },
});

/** Null clears the slot; an empty list keeps it at the Note's end until added Blocks arrive. */
export function setMeetingFillPlace(editor: Editor, addedBlockIds: readonly string[] | null): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(meetingFillPlaceKey, addedBlockIds).setMeta("addToHistory", false),
  );
}
