import { isMacOS } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import type { MessageKey } from "../../../shared/i18n";
import { keysHere } from "../commands/keymap";
import { menuItemClass, menuItemUnavailableClass } from "../components/ui";
import { files } from "../core";
import { useT } from "../i18n";
import { useNotices } from "../notices";
import { keepSelection } from "./menuKeys";

export type ClipboardEdit = "cut" | "copy" | "paste";

/** Cut, Copy and Paste, as a right-click in the Note's text offers them first: Cut and Copy need a selection. */
export const clipboardEdits = (selected: boolean) =>
  [
    { id: "cut", label: "menu.cut", keys: "CmdOrCtrl+X", on: selected },
    {
      id: "copy",
      label: isMacOS() ? "menu.copy" : "menu.copy.other",
      keys: "CmdOrCtrl+C",
      on: selected,
    },
    { id: "paste", label: "menu.paste", keys: "CmdOrCtrl+V", on: true },
  ] as const satisfies readonly {
    id: ClipboardEdit;
    label: MessageKey;
    keys: string;
    on: boolean;
  }[];

/** Does `edit` at the Note's selection; a Cut or Copy the system refuses says so in `failed`. */
export function clipboardEdit(editor: Editor, edit: ClipboardEdit, failed: string): void {
  // Focused at once, not a frame later as Tiptap's focus does: each acts where the focus is.
  editor.view.focus();
  if (edit === "paste") files.paste();
  else if (!document.execCommand(edit)) useNotices.getState().showError(new Error(failed));
}

/** Cut, Copy and Paste as the first items of an object's menu opened by a right-click in the text. */
export function ClipboardMenuItems({ editor, close }: { editor: Editor; close: () => void }) {
  const t = useT();
  return clipboardEdits(!editor.state.selection.empty).map((edit) => (
    <button
      key={edit.id}
      type="button"
      role="menuitem"
      aria-disabled={!edit.on || undefined}
      aria-keyshortcuts={keysHere(edit.keys)}
      data-testid={`text-${edit.id}`}
      onMouseDown={keepSelection}
      onClick={() => {
        if (!edit.on) return;
        close();
        clipboardEdit(editor, edit.id, t("menu.clipboardFailed"));
      }}
      className={`${menuItemClass} ${menuItemUnavailableClass} pl-2`}
    >
      <span className="flex-1">{t(edit.label)}</span>
      <span className="pl-4 text-[13px] text-ink-meta">{keysHere(edit.keys)}</span>
    </button>
  ));
}
