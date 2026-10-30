import type { Editor } from "@tiptap/core";
import { core } from "../core";
import { mindEditor } from "../editor/openEditors";
import { tidyNote } from "../editor/tidyNote";
import { insertTableOfContents } from "../editor/tocCommands";
import type { Command, CommandContext } from "./registry";
import { mindShown, onlyOne } from "./targets";

/** The open editor of the Mind a command names, or the one in front: null when it isn't open. */
function openNote(ctx: CommandContext): Editor | null {
  const mindId = mindShown(ctx);
  const editor = mindId === null ? null : mindEditor(mindId);
  return editor && !editor.isDestroyed && editor.isEditable ? editor : null;
}

/**
 * Printing, the table of contents and tidying Chinese text (#1935). Each is in
 * the Note's menu, its tab's and ⌘K; Print has ⌘P, and the table of contents
 * is in the "/" menu too.
 */
export const noteBasicsCommands: readonly Command[] = [
  {
    id: "mind.print",
    assistant: false,
    label: "menu.print",
    keywords: ["print.keywords"],
    shortcut: { keys: "CmdOrCtrl+P" },
    group: "main",
    appliesTo: ["mind", "tab"],
    // Printing changes nothing.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindShown(ctx) !== null,
    async run(ctx) {
      const mindId = mindShown(ctx);
      if (mindId) await core.printMind(mindId);
    },
  },
  {
    id: "mind.tableOfContents",
    label: "editor.toc.insert",
    keywords: ["editor.toc.keywords"],
    group: "main",
    appliesTo: ["mind", "tab", "block"],
    // The note's own undo (⌘Z) takes it back.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && openNote(ctx) !== null,
    run(ctx) {
      const editor = openNote(ctx);
      if (editor) insertTableOfContents(editor);
    },
  },
  {
    id: "mind.tidy",
    label: "editor.tidy.command",
    keywords: ["editor.tidy.keywords"],
    group: "edit",
    appliesTo: ["mind", "tab", "block"],
    // The note's own undo (⌘Z) takes it back, and its line offers Undo.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && openNote(ctx) !== null,
    run(ctx) {
      const editor = openNote(ctx);
      if (editor) tidyNote(editor);
    },
  },
];
