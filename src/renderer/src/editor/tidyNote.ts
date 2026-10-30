import type { Editor } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import { tidyChinese } from "../../../shared/tidyChinese";
import { useUndo } from "../undo";
import { asOneStep, offerEditorUndo } from "./editorUndo";

interface Replacement {
  from: number;
  to: number;
  text: string;
  marks: readonly Mark[];
}

const isSpace = (char: string | undefined) =>
  char === " " || char === "\t" || char === "\n" || char === undefined;

const isHan = (char: string) => /\p{Script=Han}/u.test(char);
const isWord = (char: string) => /[A-Za-z0-9]/u.test(char);

/** A space at the selection's own edge, where the text outside it is of the other script. */
function edgeSpace(
  text: string,
  before: string | undefined,
  after: string | undefined,
  leading: boolean,
  trailing: boolean,
): string {
  let out = text;
  const first = out[0];
  if (
    leading &&
    first !== undefined &&
    before !== undefined &&
    !isSpace(first) &&
    !isSpace(before) &&
    ((isHan(first) && isWord(before)) || (isWord(first) && isHan(before)))
  ) {
    out = ` ${out}`;
  }
  const last = out.at(-1);
  if (
    trailing &&
    last !== undefined &&
    after !== undefined &&
    !isSpace(last) &&
    !isSpace(after) &&
    ((isHan(last) && isWord(after)) || (isWord(last) && isHan(after)))
  ) {
    out = `${out} `;
  }
  return out;
}

/**
 * Tidies Chinese typography (docs/agents/zh-CN.md, rules 2–4) in the selection,
 * or in the whole Note when nothing is selected: spaces between Chinese and
 * Latin text, full-width punctuation in Chinese sentences, Chinese quotation
 * marks. Code keeps its characters, and so do file names, addresses and
 * paths. Each text run keeps its own marks, and a space between two runs is
 * written once, between them. Words inside lists, quotes, tables and Answers
 * are tidied too. The change is one step of the note's Undo, and its line says
 * how many places changed.
 */
export function tidyNote(editor: Editor): void {
  const { doc, selection } = editor.state;
  const whole = selection.empty;
  const from = whole ? 0 : selection.from;
  const to = whole ? doc.content.size : selection.to;
  const replacements: Replacement[] = [];
  const spaces: number[] = [];

  doc.descendants((block, blockPos) => {
    if (block.type.spec.code) return false;
    // A container holds Blocks: a list, a quote, a table, an Answer.
    if (!block.isTextblock) return true;
    const runs: {
      pos: number;
      text: string;
      marks: readonly Mark[];
      start: number;
      end: number;
      tidied?: string;
    }[] = [];
    block.forEach((child, offset) => {
      if (!child.isText || !child.text) return;
      if (child.marks.some((mark) => mark.type.name === "code")) return;
      runs.push({
        pos: blockPos + 1 + offset,
        text: child.text,
        marks: child.marks,
        start: 0,
        end: 0,
      });
    });
    runs.forEach((run, at) => {
      const nodeFrom = run.pos;
      const nodeTo = run.pos + run.text.length;
      const start = Math.max(from, nodeFrom) - nodeFrom;
      const end = Math.min(to, nodeTo) - nodeFrom;
      run.start = start;
      run.end = end;
      if (start >= end) return;
      const slice = run.text.slice(start, end);
      if (slice.trim() === "") return;
      const before = start > 0 ? run.text[start - 1] : runs[at - 1]?.text.at(-1);
      const after = end < run.text.length ? run.text[end] : runs[at + 1]?.text[0];
      const tidied = edgeSpace(
        tidyChinese(slice, { before, after, edgeSpaces: false }),
        before,
        after,
        nodeFrom + start === from,
        nodeFrom + end === to,
      );
      if (tidied === slice) return;
      run.tidied = tidied;
      replacements.push({
        from: nodeFrom + start,
        to: nodeFrom + end,
        text: tidied,
        marks: run.marks,
      });
    });
    for (let at = 0; at + 1 < runs.length; at++) {
      const left = runs[at];
      const right = runs[at + 1];
      if (!left || !right) continue;
      const boundary = left.pos + left.text.length;
      // An inline node between two runs is not a place for a space.
      if (right.pos !== boundary) continue;
      if (boundary < from || boundary > to) continue;
      if (left.end !== left.text.length || right.start !== 0) continue;
      const leftText = left.tidied ?? left.text.slice(left.start, left.end);
      const rightText = right.tidied ?? right.text.slice(right.start, right.end);
      const before = leftText.at(-1);
      const after = rightText[0];
      if (before === undefined || after === undefined) continue;
      if (isSpace(before) || isSpace(after)) continue;
      if ((isHan(before) && isWord(after)) || (isWord(before) && isHan(after))) {
        spaces.push(boundary);
      }
    }
    return false;
  });

  if (replacements.length === 0 && spaces.length === 0) {
    useUndo.getState().tell({ says: (translate) => translate("editor.tidy.none") });
    return;
  }

  const count = replacements.length + spaces.length;
  asOneStep(editor, () => {
    const tr = editor.state.tr;
    const edits: { at: number; replacement?: Replacement }[] = [
      ...replacements.map((replacement) => ({ at: replacement.from, replacement })),
      ...spaces.map((at) => ({ at })),
    ];
    edits.sort((a, b) => b.at - a.at || (a.replacement ? -1 : 1));
    for (const edit of edits) {
      if (edit.replacement) {
        tr.replaceWith(
          edit.replacement.from,
          edit.replacement.to,
          editor.state.schema.text(edit.replacement.text, edit.replacement.marks),
        );
      } else {
        tr.insert(edit.at, editor.state.schema.text(" "));
      }
    }
    editor.view.dispatch(tr);
  });
  offerEditorUndo(editor, (translate) =>
    translate(count === 1 ? "editor.tidy.done.one" : "editor.tidy.done.other", { count }),
  );
}
