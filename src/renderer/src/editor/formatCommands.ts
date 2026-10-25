/**
 * What the selection menu's Aa, the keyboard and ⌘K do to the selected paragraphs, or the
 * caret's when nothing is selected: alignment, indents, line spacing and space around the
 * paragraph (`ParagraphFormat`), and the text's colour, font, size and raise. Each is one Undo
 * step. A setting is the User's over the paragraph's Word look, which says what it is until then.
 */

import type { Editor } from "@tiptap/core";
import type { MarkType, Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  PARAGRAPH_FORMAT_ATTRIBUTE,
  type ParagraphFormat,
  SUBSCRIPT_MARK,
  SUPERSCRIPT_MARK,
  TEXT_COLOR_MARK,
  TEXT_FONT_MARK,
  TEXT_SIZE_MARK,
  WORD_LOOK_ATTRIBUTE,
  type WordParagraphLook,
} from "../../../core/api";
import { readParagraphFormat, storedFormat } from "../../../shared/paragraphFormat";
import { mindLookOf, wordLookOf } from "../../../shared/wordLook";
import { FORMATTED_TYPES } from "./formatSchema";
import { deepenList, raiseFromStartLevel } from "./numbering";
import { editorDoc } from "./proposalReview";
import { asOwnUndoStep } from "./selectionCommands";

export type Align = "left" | "center" | "right" | "justify";
export const ALIGNS: readonly Align[] = ["left", "center", "right", "justify"];

export const LINE_SPACINGS = [1, 1.15, 1.5, 2] as const;

/** Word's: an indent goes to the next half inch, the default tab stop. */
const INDENT_STEP = 36;
/** What Word's "Add Space Before Paragraph" adds. */
const ADDED_SPACE = 12;

export const TEXT_COLORS = [
  { id: "grey", color: "6B7280" },
  { id: "brown", color: "8B5E34" },
  { id: "red", color: "B42318" },
  { id: "orange", color: "C2410C" },
  { id: "yellow", color: "A16207" },
  { id: "green", color: "15803D" },
  { id: "blue", color: "1D4ED8" },
  { id: "purple", color: "7E22CE" },
] as const;

/** Opens the Aa menu at the selection, or its custom line spacing (`part`), from ⌘K. */
export const FORMAT_OPEN = "format-open";

export const requestFormat = (editor: Editor, part: "custom" | null = null): boolean =>
  editor.view.dom.dispatchEvent(new CustomEvent(FORMAT_OPEN, { detail: part }));

/** Word's own list of sizes. */
export const TEXT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

interface Paragraph {
  node: ProseMirrorNode;
  pos: number;
}

function paragraphsOf(editor: Editor): Paragraph[] {
  const found: Paragraph[] = [];
  const { doc, selection } = editor.state;
  for (const range of selection.ranges) {
    doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
      if (FORMATTED_TYPES.includes(node.type.name)) found.push({ node, pos });
      return !node.isTextblock;
    });
  }
  return found;
}

function lookOf(editor: Editor, node: ProseMirrorNode): WordParagraphLook | null {
  const doc = editorDoc(editor);
  const key: unknown = node.attrs[WORD_LOOK_ATTRIBUTE];
  if (!doc || typeof key !== "string" || mindLookOf(doc) !== "word") return null;
  return wordLookOf(doc)?.paragraphs[key] ?? null;
}

const formatOf = (node: ProseMirrorNode) =>
  readParagraphFormat(node.attrs[PARAGRAPH_FORMAT_ATTRIBUTE]);

function changeFormat(
  editor: Editor,
  change: (format: ParagraphFormat, look: WordParagraphLook | null) => ParagraphFormat,
): boolean {
  const { tr } = editor.state;
  for (const { node, pos } of paragraphsOf(editor)) {
    const format = formatOf(node);
    const next = storedFormat(change({ ...format }, lookOf(editor, node)));
    if (JSON.stringify(next) !== JSON.stringify(storedFormat(format))) {
      tr.setNodeAttribute(pos, PARAGRAPH_FORMAT_ATTRIBUTE, next);
    }
  }
  if (!tr.docChanged) return false;
  asOwnUndoStep(editor, () => editor.view.dispatch(tr));
  return true;
}

const spaceBefore = (format: ParagraphFormat, look: WordParagraphLook | null) =>
  (format.before ?? look?.before ?? 0) > 0;
// Without a Word look, the Mind's style puts space after every paragraph.
const lookSpaceAfter = (look: WordParagraphLook | null) => (look ? (look.after ?? 0) > 0 : true);
const spaceAfter = (format: ParagraphFormat, look: WordParagraphLook | null) =>
  format.after !== undefined ? format.after > 0 : lookSpaceAfter(look);

export interface FormatState {
  align: ParagraphFormat["align"];
  line: ParagraphFormat["line"] | null;
  firstLineChars: boolean;
  spaceBefore: boolean;
  spaceAfter: boolean;
  color: string | null;
  font: string | null;
  superscript: boolean;
  subscript: boolean;
}

/** What the first paragraph and text of the selection have, as the Aa menu shows it. */
export function formatState(editor: Editor): FormatState {
  const first = paragraphsOf(editor)[0];
  const format = first ? formatOf(first.node) : {};
  const look = first ? lookOf(editor, first.node) : null;
  const marks = marksAt(editor);
  const attribute = (type: string, name: string) => {
    const value: unknown = marks.find((mark) => mark.type.name === type)?.attrs[name];
    return typeof value === "string" ? value : null;
  };
  return {
    align: format.align ?? look?.align ?? "left",
    line: format.line ?? look?.line ?? null,
    firstLineChars: format.firstLineChars === 2,
    spaceBefore: spaceBefore(format, look),
    spaceAfter: spaceAfter(format, look),
    color: attribute(TEXT_COLOR_MARK, "color"),
    font: attribute(TEXT_FONT_MARK, "family"),
    superscript: allHave(editor, SUPERSCRIPT_MARK),
    subscript: allHave(editor, SUBSCRIPT_MARK),
  };
}

export const setAlign = (editor: Editor, align: Align) =>
  changeFormat(editor, (format) => ({ ...format, align }));

/** In a list, the item moves a level in or out, as Google Docs moves it; elsewhere the left indent moves a step. */
export function changeIndent(editor: Editor, direction: 1 | -1): boolean {
  for (const item of ["listItem", "taskItem"]) {
    if (!editor.isActive(item)) continue;
    return asOwnUndoStep(editor, () =>
      direction > 0
        ? editor.chain().focus().sinkListItem(item).run() || deepenList(editor)
        : raiseFromStartLevel(editor) || editor.chain().focus().liftListItem(item).run(),
    );
  }
  return changeFormat(editor, (format, look) => {
    const current = format.left ?? look?.left ?? 0;
    const steps = current / INDENT_STEP;
    const next =
      direction > 0
        ? (Math.floor(steps + 1e-6) + 1) * INDENT_STEP
        : Math.max(0, (Math.ceil(steps - 1e-6) - 1) * INDENT_STEP);
    if (next === (look?.left ?? 0)) delete format.left;
    else format.left = next;
    return format;
  });
}

export function toggleFirstLineIndent(editor: Editor): boolean {
  const on = formatState(editor).firstLineChars;
  return changeFormat(editor, (format) => {
    delete format.firstLineChars;
    delete format.firstLine;
    return on ? format : { ...format, firstLineChars: 2 };
  });
}

/** Null: the paragraph's own, as its look or the Mind's style has it. */
export const setLineSpacing = (editor: Editor, multiple: number | null) =>
  changeFormat(editor, (format) => {
    delete format.line;
    return multiple === null ? format : { ...format, line: { rule: "auto", value: multiple } };
  });

export function toggleSpaceBefore(editor: Editor): boolean {
  const has = formatState(editor).spaceBefore;
  return changeFormat(editor, (format, look) => {
    delete format.before;
    if (!has) format.before = ADDED_SPACE;
    else if ((look?.before ?? 0) > 0) format.before = 0;
    return format;
  });
}

export function toggleSpaceAfter(editor: Editor): boolean {
  const has = formatState(editor).spaceAfter;
  return changeFormat(editor, (format, look) => {
    delete format.after;
    if (has) format.after = 0;
    else if (!lookSpaceAfter(look)) format.after = ADDED_SPACE;
    return format;
  });
}

function textRanges(editor: Editor): { from: number; to: number }[] {
  const { selection } = editor.state;
  if (!selection.empty)
    return selection.ranges.map((range) => ({ from: range.$from.pos, to: range.$to.pos }));
  return paragraphsOf(editor).map(({ node, pos }) => ({
    from: pos + 1,
    to: pos + node.nodeSize - 1,
  }));
}

function marksAt(editor: Editor) {
  const texts: ProseMirrorNode[] = [];
  for (const { from, to } of textRanges(editor)) {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (node.isText) texts.push(node);
      return texts.length === 0;
    });
  }
  return texts[0]?.marks ?? editor.state.selection.$from.marks();
}

function allHave(editor: Editor, name: string): boolean {
  const type = editor.schema.marks[name];
  if (!type) return false;
  let texts = 0;
  let marked = 0;
  for (const { from, to } of textRanges(editor)) {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return true;
      texts++;
      if (type.isInSet(node.marks)) marked++;
      return false;
    });
  }
  return texts > 0 && marked === texts;
}

function setMark(
  editor: Editor,
  type: MarkType | undefined,
  attrs: Record<string, unknown> | null,
) {
  if (!type) return false;
  const { tr } = editor.state;
  for (const { from, to } of textRanges(editor)) {
    if (attrs) tr.addMark(from, to, type.create(attrs));
    else tr.removeMark(from, to, type);
  }
  if (editor.state.selection.empty) {
    if (attrs) tr.addStoredMark(type.create(attrs));
    else tr.removeStoredMark(type);
  }
  if (!tr.docChanged && !tr.storedMarksSet) return false;
  asOwnUndoStep(editor, () => editor.view.dispatch(tr));
  return true;
}

export const setTextColor = (editor: Editor, color: string | null) =>
  setMark(editor, editor.schema.marks[TEXT_COLOR_MARK], color ? { color } : null);

export const setTextFont = (editor: Editor, family: string | null) =>
  setMark(editor, editor.schema.marks[TEXT_FONT_MARK], family ? { family } : null);

export const setTextSize = (editor: Editor, size: number | null) =>
  setMark(editor, editor.schema.marks[TEXT_SIZE_MARK], size ? { size } : null);

/** Raised or lowered text, or back on the line; one takes the other's place. */
export function toggleRaise(editor: Editor, name: typeof SUPERSCRIPT_MARK | typeof SUBSCRIPT_MARK) {
  return setMark(editor, editor.schema.marks[name], allHave(editor, name) ? null : {});
}

/** The size the selection's text is drawn at, in points as the Mind measures them; null where it can't tell. */
export function shownSize(editor: Editor): number | null {
  const { node } = editor.view.domAtPos(editor.state.selection.from);
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return null;
  const style = getComputedStyle(element);
  const point = Number.parseFloat(style.getPropertyValue("--word-pt"));
  const size = Number.parseFloat(style.fontSize);
  return point > 0 && size > 0 ? Math.round((size / point) * 2) / 2 : null;
}
