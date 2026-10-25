import type { Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import {
  GENERATED_MARK,
  NOTE_BLOCK_TYPES,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";

/** What the selection menu's "Text ›" turns the selected Blocks into. */
export interface TurnInto {
  id: string;
  label: MessageKey;
  /** Whether the selection already is this. */
  active(editor: Editor): boolean;
  run(editor: Editor): boolean;
}

/** Lifts the selection out of lists and quotes first, so a list item turned into a heading isn't nested. */
const fresh = (editor: Editor) => editor.chain().focus().clearNodes();

const BLOCK_KINDS: readonly TurnInto[] = [
  ...([1, 2, 3] as const).map(
    (level): TurnInto => ({
      id: `heading-${level}`,
      label: `editor.slash.heading${level}`,
      active: (editor) => editor.isActive("heading", { level }),
      run: (editor) => fresh(editor).setHeading({ level }).run(),
    }),
  ),
  {
    id: "bullet-list",
    label: "editor.turnInto.bulletList",
    active: (editor) => editor.isActive("bulletList"),
    run: (editor) => fresh(editor).toggleBulletList().run(),
  },
  {
    id: "ordered-list",
    label: "editor.turnInto.orderedList",
    active: (editor) => editor.isActive("orderedList"),
    run: (editor) => fresh(editor).toggleOrderedList().run(),
  },
  {
    id: "quote",
    label: "editor.turnInto.quote",
    active: (editor) => editor.isActive("blockquote"),
    run: (editor) => fresh(editor).setBlockquote().run(),
  },
  {
    id: "table",
    label: "editor.slash.table",
    active: (editor) => editor.isActive("table"),
    run: (editor) => turnIntoTable(editor),
  },
];

/** A line's inline content split into cells at its tabs, its marks and Citations kept. */
function cellsOf(line: Fragment): Fragment[] {
  const cells: ProseMirrorNode[][] = [[]];
  line.forEach((node) => {
    const parts = node.isText ? (node.text ?? "").split("\t") : [null];
    parts.forEach((part, index) => {
      if (index > 0) cells.push([]);
      const cell = cells[cells.length - 1] as ProseMirrorNode[];
      if (part === null) cell.push(node);
      else if (part) cell.push(node.type.schema.text(part, node.marks));
    });
  });
  return cells.map((nodes) => Fragment.fromArray(nodes));
}

/**
 * Each line of the Blocks the selection touches becomes a row, cut into cells
 * at tabs, as text copied from a sheet has them. No heading row: whether the
 * first line is one is the User's call, as in Word's Convert Text to Table.
 */
function turnIntoTable(editor: Editor): boolean {
  const { doc, schema, selection } = editor.state;
  const { $from, $to } = selection;
  if ($from.depth === 0 || $to.depth === 0) return false;
  const from = $from.before(1);
  const to = $to.after(1);
  const lines: Fragment[][] = [];
  doc.nodesBetween(from, to, (node) => {
    if (!node.isTextblock) return true;
    const texts = node.type.spec.code
      ? node.textContent.split("\n").map((line) => Fragment.from(line ? schema.text(line) : null))
      : [node.content];
    for (const text of texts) lines.push(cellsOf(text));
    return false;
  });
  const { table, tableRow, tableCell, paragraph } = schema.nodes;
  if (lines.length === 0 || !table || !tableRow || !tableCell || !paragraph) return false;
  const columns = Math.max(...lines.map((cells) => cells.length));
  const rows = lines.map((cells) =>
    tableRow.create(
      null,
      Array.from({ length: columns }, (_, column) =>
        tableCell.create(null, paragraph.create(null, cells[column] ?? Fragment.empty)),
      ),
    ),
  );
  return editor.commands.command(({ tr }) => {
    tr.replaceWith(from, to, table.create(null, rows));
    tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1)));
    return true;
  });
}

const TEXT: TurnInto = {
  id: "text",
  label: "editor.slash.text",
  active: (editor) => !BLOCK_KINDS.some((kind) => kind.active(editor)),
  run: (editor) => fresh(editor).run(),
};

export const TURN_INTO: readonly TurnInto[] = [TEXT, ...BLOCK_KINDS];

/** What the selection is now. */
export const currentTurnInto = (editor: Editor): TurnInto =>
  BLOCK_KINDS.find((kind) => kind.active(editor)) ?? TEXT;

const NOT_TURNED: readonly string[] = ["codeBlock", "blockMath", "table", "chart", "wordBlock"];

/**
 * Whether the selection lies in Notes of text: Questions and Answers are not
 * turned into anything else, and neither are code blocks, formulas, tables,
 * charts and what a Word import kept as it is.
 */
export function canTurnInto(editor: Editor): boolean {
  const { doc, selection } = editor.state;
  let ok = true;
  doc.nodesBetween(selection.from, selection.to, (node, _pos, parent) => {
    if (parent === doc) {
      const name = node.type.name;
      ok =
        ok && (NOTE_BLOCK_TYPES as readonly string[]).includes(name) && !NOT_TURNED.includes(name);
    }
    return ok;
  });
  return ok;
}

/** Whether the selection sits inside one line of text, which a formula can replace. */
export function inOneTextblock(editor: Editor): boolean {
  const { $from, $to } = editor.state.selection;
  return $from.sameParent($to) && $from.parent.isTextblock;
}

/** The selected text replaced by an inline formula written in it; where the formula is, for its LaTeX field to open at, or null. */
export function selectionToMath(editor: Editor): number | null {
  if (!inOneTextblock(editor)) return null;
  const { from, to } = editor.state.selection;
  const latex = editor.state.doc.textBetween(from, to);
  const inserted = editor.commands.insertContentAt(
    { from, to },
    { type: "inlineMath", attrs: { latex } },
  );
  return inserted ? from : null;
}

/** Marks that say whose words they are, or what a change does, rather than how the words look. */
const NOT_FORMATTING: ReadonlySet<string> = new Set([
  GENERATED_MARK,
  PROPOSAL_INSERT_MARK,
  PROPOSAL_DELETE_MARK,
]);

/** Clear formatting: every mark off the selected text, but those `NOT_FORMATTING`. */
export function clearFormatting(editor: Editor): boolean {
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      const formats = Object.values(tr.doc.type.schema.marks).filter(
        (type) => !NOT_FORMATTING.has(type.name),
      );
      for (const { $from, $to } of tr.selection.ranges) {
        for (const type of formats) tr.removeMark($from.pos, $to.pos, type);
      }
      return true;
    })
    .run();
}

/** A typed address as a link target: "example.com" is taken as https. */
export function linkTarget(typed: string): string {
  const value = typed.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
}

/** Runs a change as an Undo step of its own, rather than merged with the typing just before or after it. */
export function asOwnUndoStep<T>(editor: Editor, run: () => T): T {
  const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
  undo?.stopCapturing();
  const result = run();
  undo?.stopCapturing();
  return result;
}

/**
 * Sets the link of the selected text, or of the whole link the cursor is in, to
 * the address typed; an empty address takes the link off. One Undo step.
 */
export function applyLink(editor: Editor, typed: string): void {
  asOwnUndoStep(editor, () => {
    const chain = editor.chain().focus();
    if (typed.trim() === "") return chain.extendMarkRange("link").unsetLink().run();
    // Editing a link changes all of it, not just the part selected.
    if (editor.isActive("link")) chain.extendMarkRange("link");
    return chain.setLink({ href: linkTarget(typed) }).run();
  });
}

/** What the editor's element is told when ⌘K asks to edit the link at the selection. */
export const LINK_EDIT = "link-edit";

export const requestLinkEdit = (editor: Editor): boolean =>
  editor.view.dom.dispatchEvent(new CustomEvent(LINK_EDIT));

export const EDIT_FIELD = "edit-field";

/**
 * Asks the selection menu to take the cursor in its Edit with AI field, from
 * the text or with the focus anywhere (`anywhere`). True when it did: it
 * cancels the event, and doesn't when the menu can't open over the selection.
 */
export const requestEditField = (editor: Editor, anywhere = false): boolean =>
  !editor.view.dom.dispatchEvent(
    new CustomEvent(EDIT_FIELD, { cancelable: true, detail: { anywhere } }),
  );
