import type { Editor } from "@tiptap/core";
import { tidyChinese } from "../../../shared/tidyChinese";
import { useUndo } from "../undo";
import { asOneStep, offerEditorUndo } from "./editorUndo";

interface Replacement {
  from: number;
  to: number;
  text: string;
}

/**
 * Tidies Chinese typography (docs/agents/zh-CN.md, rules 2–4) in the selection,
 * or in the whole Note when nothing is selected: spaces between Chinese and
 * Latin text, full-width punctuation in Chinese sentences, Chinese quotation
 * marks. Code keeps its characters. The change is one step of the note's Undo,
 * and its line says how many places changed.
 */
export function tidyNote(editor: Editor): void {
  const { doc, selection } = editor.state;
  const whole = selection.empty;
  const from = whole ? 0 : selection.from;
  const to = whole ? doc.content.size : selection.to;
  const replacements: Replacement[] = [];

  doc.descendants((block, blockPos) => {
    if (!block.isTextblock || block.type.spec.code) return false;
    const texts: { pos: number; text: string }[] = [];
    block.forEach((child, offset) => {
      if (!child.isText || !child.text) return;
      if (child.marks.some((mark) => mark.type.name === "code")) return;
      texts.push({ pos: blockPos + 1 + offset, text: child.text });
    });
    texts.forEach((node, at) => {
      const nodeFrom = node.pos;
      const nodeTo = node.pos + node.text.length;
      const start = Math.max(from, nodeFrom) - nodeFrom;
      const end = Math.min(to, nodeTo) - nodeFrom;
      if (start >= end) return;
      if (from >= nodeTo || to <= nodeFrom) return;
      const slice = node.text.slice(start, end);
      if (slice.trim() === "") return;
      const before = start > 0 ? node.text[start - 1] : (texts[at - 1]?.text.at(-1) ?? undefined);
      const after = end < node.text.length ? node.text[end] : (texts[at + 1]?.text[0] ?? undefined);
      const tidied = tidyChinese(slice, { before, after });
      if (tidied === slice) return;
      replacements.push({ from: nodeFrom + start, to: nodeFrom + end, text: tidied });
    });
    return false;
  });

  if (replacements.length === 0) {
    useUndo.getState().tell({ says: (translate) => translate("editor.tidy.none") });
    return;
  }

  const count = replacements.length;
  asOneStep(editor, () => {
    const tr = editor.state.tr;
    // Last first, so the places before them stay where they are.
    for (const replacement of [...replacements].reverse()) {
      const marks = tr.doc.resolve(replacement.from).marks();
      tr.replaceWith(
        replacement.from,
        replacement.to,
        editor.state.schema.text(replacement.text, marks),
      );
    }
    editor.view.dispatch(tr);
  });
  offerEditorUndo(editor, (translate) =>
    translate(count === 1 ? "editor.tidy.done.one" : "editor.tidy.done.other", { count }),
  );
}
