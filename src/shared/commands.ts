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

/**
 * What a command the assistant runs does, which decides whether it asks the User first
 * (ADR-0013, amended for #1110): "app", a change inside IncarnaMind that Undo takes back;
 * "export" saves a Mind as a file; "add" reads a folder's files and adds them to the Library.
 * `deletes`: it sends things to Recently deleted.
 */
export interface AssistantCommand {
  on: "document" | "mind" | "library";
  does: "app" | "export" | "add";
  deletes: boolean;
}

/**
 * The commands of the list the assistant may run for the User (#1110), and what each does. A
 * command not here is never offered to it: nothing that changes consent, Local mode, keys,
 * sign-ins, approvals or Privacy settings, and nothing that deletes for good (a delete goes to
 * Recently deleted, as the User's own does).
 */
export const ASSISTANT_COMMANDS = {
  "document.rename": { on: "document", does: "app", deletes: false },
  "document.moveTo": { on: "document", does: "app", deletes: false },
  "document.tags": { on: "document", does: "app", deletes: false },
  "document.delete": { on: "document", does: "app", deletes: true },
  "mind.rename": { on: "mind", does: "app", deletes: false },
  "mind.moveTo": { on: "mind", does: "app", deletes: false },
  "mind.delete": { on: "mind", does: "app", deletes: true },
  "mind.export": { on: "mind", does: "export", deletes: false },
  "documents.addFromFolder": { on: "library", does: "add", deletes: false },
} as const satisfies Record<CommandId, AssistantCommand>;

export type AssistantCommandId = keyof typeof ASSISTANT_COMMANDS;

/** The commands that change things inside IncarnaMind, which Undo takes back. */
export type AppCommandId = {
  [Id in AssistantCommandId]: (typeof ASSISTANT_COMMANDS)[Id]["does"] extends "app" ? Id : never;
}[AssistantCommandId];

export const isAppCommand = (id: AssistantCommandId): id is AppCommandId =>
  ASSISTANT_COMMANDS[id].does === "app";
