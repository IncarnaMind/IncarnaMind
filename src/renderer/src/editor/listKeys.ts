import { Extension } from "@tiptap/core";
import { isInTable } from "@tiptap/pm/tables";
import { changeIndent } from "./formatCommands";

export const ListKeys = Extension.create({
  name: "listKeys",
  // Before the list item's own Tab, which would also let the focus leave the page.
  priority: 1000,

  addKeyboardShortcuts() {
    const change = (direction: 1 | -1) => () => {
      const { editor } = this;
      // In a table, Tab moves between cells.
      if (isInTable(editor.state)) return false;
      if (!editor.isActive("listItem") && !editor.isActive("taskItem")) return false;
      changeIndent(editor, direction);
      return true;
    };
    return { Tab: change(1), "Shift-Tab": change(-1) };
  },
});
