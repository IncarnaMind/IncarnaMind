import { mergeAttributes, Node } from "@tiptap/core";
import { NOTE_TAB_NODE, NOTE_TAB_TITLE_ATTRIBUTE } from "../../../core/api";
import { MIND_BLOCK_GROUP } from "./questionSchema";

/**
 * Where a tab of the Note starts (#3414): a top-level Block holding the tab's title, drawn in the
 * tabs' panel, never on the page. The cursor never rests on it, and no paste makes one: a tab is
 * made, renamed, moved and deleted in the panel (`noteTabs`).
 *
 * It holds no text, but could: a Yjs render keeps the cursor's place by its number, and a Note
 * starting with a tab Block has its place 1 inside it, which only text can take.
 */
export const NoteTab = Node.create({
  name: NOTE_TAB_NODE,
  group: MIND_BLOCK_GROUP,
  content: "text*",
  marks: "",
  atom: true,
  isolating: true,
  selectable: false,

  addAttributes() {
    return {
      [NOTE_TAB_TITLE_ATTRIBUTE]: { default: "", rendered: false },
    };
  },

  parseHTML() {
    return [];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": NOTE_TAB_NODE, hidden: "" }), 0];
  },
});
