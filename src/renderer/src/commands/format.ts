import type { Editor } from "@tiptap/core";
import { SUBSCRIPT_MARK, SUPERSCRIPT_MARK } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import {
  type Align,
  changeIndent,
  formatState,
  LINE_SPACINGS,
  requestFormat,
  setAlign,
  setLineSpacing,
  toggleFirstLineIndent,
  toggleRaise,
  toggleSpaceAfter,
  toggleSpaceBefore,
} from "../editor/formatCommands";
import { requestNumbering } from "../editor/numbering";
import { noteHandle } from "./handles";
import type { Command, CommandContext } from "./registry";

/** From ⌘K, the Mind last written in; from the keys, only while its text has the focus. */
function noteOf(ctx: CommandContext): Editor | null {
  const editor = noteHandle.current?.editor;
  if (!editor || editor.isDestroyed || !editor.isEditable) return null;
  return ctx.surface === "palette" || editor.view.hasFocus() ? editor : null;
}

const KEYWORDS: readonly MessageKey[] = ["format.keywords"];

/** A command on the selected paragraphs, or the caret's; each one Undo step, taken back with the note's own undo (⌘Z). */
function onParagraphs(
  command: Omit<Command, "group" | "reversible" | "when" | "run" | "keywords">,
  run: (editor: Editor) => unknown,
): Command {
  return {
    ...command,
    keywords: KEYWORDS,
    group: "main",
    reversible: true,
    when: (ctx) => noteOf(ctx) !== null,
    run(ctx) {
      const editor = noteOf(ctx);
      if (editor) run(editor);
    },
  };
}

const align = (id: string, label: MessageKey, to: Align, keys?: string): Command =>
  onParagraphs({ id: `format.${id}`, label, ...(keys && { shortcut: { keys } }) }, (editor) =>
    setAlign(editor, to),
  );

const spacingLabel = (multiple: number): MessageKey | null =>
  multiple === 1
    ? "format.lineSpacing.single"
    : multiple === 2
      ? "format.lineSpacing.double"
      : null;

/**
 * Formatting, as Word's keys and ⌘K reach it (DESIGN.md › Typography): ⌘L, ⌘R and ⇧⌘J align,
 * ⌘] and ⌘[ indent. Centring has no keys, since ⌘E is inline code's, and superscript and
 * subscript have none, since ⌘= and ⇧⌘= zoom; the Aa menu and ⌘K reach them.
 */
export const formatCommands: readonly Command[] = [
  onParagraphs({ id: "format.open", label: "format.command" }, (editor) => requestFormat(editor)),
  align("alignLeft", "format.align.left", "left", "CmdOrCtrl+L"),
  align("alignCenter", "format.align.center", "center"),
  align("alignRight", "format.align.right", "right", "CmdOrCtrl+R"),
  align("justify", "format.align.justify", "justify", "CmdOrCtrl+Shift+J"),
  onParagraphs(
    { id: "format.indent", label: "format.indent.increase", shortcut: { keys: "CmdOrCtrl+]" } },
    (editor) => changeIndent(editor, 1),
  ),
  onParagraphs(
    { id: "format.outdent", label: "format.indent.decrease", shortcut: { keys: "CmdOrCtrl+[" } },
    (editor) => changeIndent(editor, -1),
  ),
  onParagraphs({ id: "format.firstLine", label: "format.firstLine" }, toggleFirstLineIndent),
  {
    ...onParagraphs({ id: "format.numbering", label: "numbering.command" }, requestNumbering),
    keywords: ["numbering.keywords"],
  },
  ...LINE_SPACINGS.map((multiple) =>
    onParagraphs(
      {
        id: `format.lineSpacing${String(multiple).replace(".", "_")}`,
        label: (_ctx, t) => {
          const named = spacingLabel(multiple);
          return t("format.lineSpacing.multiple", { spacing: named ? t(named) : String(multiple) });
        },
      },
      (editor) => setLineSpacing(editor, multiple),
    ),
  ),
  onParagraphs(
    { id: "format.lineSpacingCustom", label: "format.lineSpacing.customTitle" },
    (editor) => requestFormat(editor, "custom"),
  ),
  onParagraphs(
    {
      id: "format.spaceBefore",
      label: (ctx, t) => {
        const editor = noteOf(ctx);
        return t(
          editor && formatState(editor).spaceBefore
            ? "format.spaceBefore.remove"
            : "format.spaceBefore.add",
        );
      },
    },
    toggleSpaceBefore,
  ),
  onParagraphs(
    {
      id: "format.spaceAfter",
      label: (ctx, t) => {
        const editor = noteOf(ctx);
        return t(
          editor && !formatState(editor).spaceAfter
            ? "format.spaceAfter.add"
            : "format.spaceAfter.remove",
        );
      },
    },
    toggleSpaceAfter,
  ),
  onParagraphs({ id: "format.superscript", label: "format.superscript" }, (editor) =>
    toggleRaise(editor, SUPERSCRIPT_MARK),
  ),
  onParagraphs({ id: "format.subscript", label: "format.subscript" }, (editor) =>
    toggleRaise(editor, SUBSCRIPT_MARK),
  ),
];
