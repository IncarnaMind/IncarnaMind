import type { Editor } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { tidyChinese } from "../../../shared/tidyChinese";
import { useUndo } from "../undo";
import { asOneStep, offerEditorUndo } from "./editorUndo";

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

interface Run {
  /** Its index among the textblock's children, so only adjacent runs take a space. */
  child: number;
  pos: number;
  text: string;
  marks: readonly Mark[];
  start: number;
  end: number;
  tidied: string;
}

/**
 * Tidies Chinese typography (docs/agents/zh-CN.md, rules 2–4) in the selection,
 * or in the whole Note when nothing is selected: spaces between Chinese and
 * Latin text, full-width punctuation in Chinese sentences, Chinese quotation
 * marks. Code keeps its characters, and so do file names, addresses and
 * paths. Each text run keeps its own marks, and a space between two runs is
 * written once, between them. Words inside lists, quotes, tables and Answers
 * are tidied too. Each changed Block is written once, in one transaction, so
 * a long Note stays responsive; the change is one step of the note's Undo,
 * and its line says how many places changed.
 */
export function tidyNote(editor: Editor): void {
  const { doc, selection } = editor.state;
  const whole = selection.empty;
  const from = whole ? 0 : selection.from;
  const to = whole ? doc.content.size : selection.to;
  let total = 0;

  const tidyTextblock = (
    block: ProseMirrorNode,
    blockPos: number,
  ): { node: ProseMirrorNode; changed: boolean } => {
    const runs: Run[] = [];
    let childAt = 0;
    block.forEach((child, offset) => {
      const index = childAt++;
      if (!child.isText || !child.text) return;
      if (child.marks.some((mark) => mark.type.name === "code")) return;
      const pos = blockPos + 1 + offset;
      const start = Math.max(from, pos) - pos;
      const end = Math.min(to, pos + child.text.length) - pos;
      runs.push({
        child: index,
        pos,
        text: child.text,
        marks: child.marks,
        start,
        end,
        tidied: "",
      });
    });
    if (runs.length === 0) return { node: block, changed: false };

    let blockChanges = 0;
    runs.forEach((run, at) => {
      const slice = run.start < run.end ? run.text.slice(run.start, run.end) : "";
      run.tidied = slice;
      if (slice.trim() === "") return;
      const before = run.start > 0 ? run.text[run.start - 1] : runs[at - 1]?.text.at(-1);
      const after = run.end < run.text.length ? run.text[run.end] : runs[at + 1]?.text[0];
      run.tidied = edgeSpace(
        tidyChinese(slice, { before, after, edgeSpaces: false }),
        before,
        after,
        run.pos + run.start === from,
        run.pos + run.end === to,
      );
      if (run.tidied !== slice) blockChanges++;
    });

    const spaceAfter = new Set<number>();
    for (let at = 0; at + 1 < runs.length; at++) {
      const left = runs[at];
      const right = runs[at + 1];
      if (!left || !right || right.child !== left.child + 1) continue;
      const boundary = left.pos + left.text.length;
      if (boundary < from || boundary > to) continue;
      if (left.start >= left.end || right.start >= right.end) continue;
      if (left.end !== left.text.length || right.start !== 0) continue;
      const before = left.tidied.at(-1);
      const after = right.tidied[0];
      if (before === undefined || after === undefined) continue;
      if (isSpace(before) || isSpace(after)) continue;
      if ((isHan(before) && isWord(after)) || (isWord(before) && isHan(after))) {
        spaceAfter.add(at);
        blockChanges++;
      }
    }
    if (blockChanges === 0) return { node: block, changed: false };

    const content: ProseMirrorNode[] = [];
    let at = 0;
    childAt = 0;
    block.forEach((child) => {
      const index = childAt++;
      if (!child.isText || !child.text) {
        content.push(child);
        return;
      }
      const run = runs[at];
      if (!run || run.child !== index) {
        content.push(child);
        return;
      }
      const runIndex = at++;
      const text = child.text.slice(0, run.start) + run.tidied + child.text.slice(run.end);
      if (text !== child.text) content.push(editor.state.schema.text(text, run.marks));
      else content.push(child);
      if (spaceAfter.has(runIndex)) content.push(editor.state.schema.text(" "));
    });
    total += blockChanges;
    return {
      node: block.type.create(block.attrs, content, block.marks),
      changed: true,
    };
  };

  const rebuild = (
    node: ProseMirrorNode,
    pos: number,
  ): { node: ProseMirrorNode; changed: boolean } => {
    if (node.type.spec.code) return { node, changed: false };
    if (node.isTextblock) return tidyTextblock(node, pos);
    let changed = false;
    const content: ProseMirrorNode[] = [];
    node.forEach((child, offset) => {
      const rebuilt = rebuild(child, pos + 1 + offset);
      changed ||= rebuilt.changed;
      content.push(rebuilt.node);
    });
    return changed
      ? { node: node.type.create(node.attrs, content, node.marks), changed: true }
      : { node, changed: false };
  };

  const top: { from: number; to: number; node: ProseMirrorNode; changed: boolean }[] = [];
  doc.forEach((child, offset) => {
    const rebuilt = rebuild(child, offset);
    top.push({ from: offset, to: offset + child.nodeSize, ...rebuilt });
  });
  const groups: { from: number; to: number; nodes: ProseMirrorNode[] }[] = [];
  for (let i = 0; i < top.length; ) {
    const first = top[i];
    if (!first?.changed) {
      i++;
      continue;
    }
    let last = i;
    while (top[last + 1]?.changed) last++;
    const range = top.slice(i, last + 1);
    const end = range.at(-1);
    if (end) groups.push({ from: first.from, to: end.to, nodes: range.map((each) => each.node) });
    i = last + 1;
  }

  if (total === 0 || groups.length === 0) {
    useUndo.getState().tell({ says: (translate) => translate("editor.tidy.none") });
    return;
  }

  const count = total;
  asOneStep(editor, () => {
    const tr = editor.state.tr;
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index];
      if (group) tr.replaceWith(group.from, group.to, group.nodes);
    }
    editor.view.dispatch(tr);
  });
  offerEditorUndo(editor, (translate) =>
    translate(count === 1 ? "editor.tidy.done.one" : "editor.tidy.done.other", { count }),
  );
}
