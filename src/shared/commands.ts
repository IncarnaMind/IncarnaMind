import type { MessageKey } from "./i18n";

/** What a command acts on, then what it does: "mind.new", "document.moveTo". */
export type CommandId = `${string}.${string}`;

/**
 * Keys written as an Electron accelerator ("CmdOrCtrl+Shift+M", "Ctrl+Tab",
 * "F2"), so the application menu shows the same keys the window binds.
 * CmdOrCtrl is ⌘ on macOS and Ctrl elsewhere.
 */
export type Keys = string;

export type ShortcutKeys = Keys | { readonly mac: Keys; readonly other: Keys };

/**
 * The application menu's items that are commands. The menu shows each one's
 * label and keys, and a click runs it in the window in front; the window's
 * keymap binds the keys.
 */
export const MENU_COMMANDS = {
  "mind.new": { label: "menu.newMind", keys: "CmdOrCtrl+T" },
  "folder.new": { label: "menu.newFolder", keys: "CmdOrCtrl+Shift+N" },
  "documents.add": { label: "sidebar.plus.addDocuments", keys: "CmdOrCtrl+O" },
  "linkedFolder.add": { label: "sidebar.plus.linkFolder", keys: undefined },
  "tab.close": { label: "menu.closeTab", keys: "CmdOrCtrl+W" },
  "tab.reopen": { label: "menu.reopenTab", keys: "CmdOrCtrl+Shift+T" },
  // ⌘\ is the sidebar's, as in Notion.
  "tab.split": { label: "menu.splitRight", keys: "CmdOrCtrl+Alt+\\" },
  "settings.open": { label: "menu.settings", keys: "CmdOrCtrl+," },
  "sidebar.toggle": { label: "menu.hideSidebar", keys: "CmdOrCtrl+\\" },
  // In a field the menu takes them back itself, as the field's own undo (src/main/menu.ts).
  "edit.undo": { label: "menu.undo", keys: "CmdOrCtrl+Z" },
  "edit.redo": { label: "menu.redo", keys: "CmdOrCtrl+Shift+Z" },
  // A list's own key selects its rows; anywhere else the system's Select All (src/renderer/src/commands/selection.ts).
  "edit.selectAll": { label: "menu.selectAll", keys: "CmdOrCtrl+A" },
  "mind.export": { label: "menu.export", keys: "CmdOrCtrl+Shift+E" },
  "examples.show": { label: "menu.showExamples", keys: undefined },
  "help.feedback": { label: "menu.sendFeedback", keys: undefined },
} as const satisfies Record<CommandId, { label: MessageKey; keys: Keys | undefined }>;

export type MenuCommandId = keyof typeof MENU_COMMANDS;

export const isCommandId = (value: unknown): value is CommandId =>
  typeof value === "string" && /^[\w-]+\.[\w.-]+$/.test(value);

/** What the assistant finds by name and acts on by id (#1110, #1421): what's in Recently deleted too. */
export const COMMAND_TARGETS = ["document", "mind", "folder", "tag", "deleted"] as const;
export type CommandTarget = (typeof COMMAND_TARGETS)[number];

/**
 * What only the User changes, never the assistant (#1421), each said with where they change it:
 * keys and sign-ins; consent, Local mode and Privacy, and what leaves the computer; the
 * assistant's own approval rules; the monthly spending cap; deleting for good (ADR-0013); and
 * what is the User's own word: "Checked by me" and marking text as theirs.
 */
export const YOURS = [
  "keys",
  "privacy",
  "approvals",
  "spending",
  "permanent",
  "signOff",
  "authorship",
] as const;
export type Yours = (typeof YOURS)[number];

/**
 * A command of the window's list, as the assistant is offered it (#1421): its name in English,
 * for the model, and what the window knows of it. `on` null: it acts on the window in front.
 * `deletes`: it sends things to Recently deleted; `final`: it can't be taken back; `listens`: it
 * can turn on the microphone or the computer's sound; `yours`: it is the User's alone.
 */
export interface OfferedCommand {
  id: CommandId;
  label: string;
  purpose: string | null;
  on: CommandTarget[] | null;
  deletes: boolean;
  final: boolean;
  listens: boolean;
  yours: Yours | null;
}
