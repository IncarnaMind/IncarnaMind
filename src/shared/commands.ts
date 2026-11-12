import type { Language } from "../core/language";
import { type MessageKey, translate } from "./i18n";

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
  // The picture viewer's Copy, for the Edit menu while it is open (#2377): an image, not text.
  "picture.copy": { label: "menu.copy", keys: "CmdOrCtrl+C" },
  // A list's own key selects its rows; anywhere else the system's Select All (src/renderer/src/commands/selection.ts).
  "edit.selectAll": { label: "menu.selectAll", keys: "CmdOrCtrl+A" },
  "mind.export": { label: "menu.export", keys: "CmdOrCtrl+Shift+E" },
  "mind.print": { label: "menu.print", keys: "CmdOrCtrl+P" },
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
 * what is the User's own word: "Checked by me" and marking text as theirs; and whether a Folder
 * keeps its work inside it, a confidentiality control like Privacy (#1934).
 */
export const YOURS = [
  "wall",
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
 * What a refusal's button opens: a Settings page, at a spot on it, Recently deleted, or a Folder's
 * menu. The button is named after what it opens, so the two can't differ (#1741).
 */
export type YoursOpens =
  | { settings: "ai" | "privacy"; at?: "local-mode" | "spending-cap" }
  | "recentlyDeleted"
  | "folderMenu";

const YOURS_WORDS: Readonly<Record<Yours, { said: MessageKey; opens: YoursOpens | null }>> = {
  wall: { said: "commands.yours.wall", opens: null },
  keys: { said: "commands.yours.keys", opens: { settings: "ai" } },
  privacy: { said: "commands.yours.privacy", opens: { settings: "ai", at: "local-mode" } },
  approvals: { said: "commands.yours.approvals", opens: { settings: "privacy" } },
  spending: { said: "commands.yours.spending", opens: { settings: "ai", at: "spending-cap" } },
  permanent: { said: "commands.yours.permanent", opens: "recentlyDeleted" },
  signOff: { said: "commands.yours.signOff", opens: null },
  authorship: { said: "commands.yours.authorship", opens: null },
};

/**
 * What a refusal of what is the User's alone says, `{folder}` its Folder's name, and what its
 * button opens, the same on the card and in the reply; none for what is done on each thing itself,
 * where the line says it is. A Folder's wall names the Folder the request is about and opens its
 * ⋯ menu (#1934).
 */
export const yoursWordsOf = (
  what: Yours,
  folder?: { name: string } | null,
): { said: MessageKey; opens: YoursOpens | null } =>
  what === "wall" && folder
    ? { said: "commands.yours.wall.named", opens: "folderMenu" }
    : YOURS_WORDS[what];

/**
 * A refusal's sentence in `language`: the card's, and the one the core ends the reply with, so the
 * card leaves it out and shows only its button (#2252).
 */
export const yoursLine = (
  language: Language,
  what: Yours,
  folder?: { name: string } | null,
): string => translate(language, yoursWordsOf(what, folder).said, { folder: folder?.name ?? "" });

/** The same words, with a model's straight quotes read as the app's typographic ones (#2252). */
export const sameWords = (text: string): string => text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

/** The switch of a Folder's wall (#1934): the User's alone, never offered to the assistant. */
export const WALL_SWITCH = "folder.keepInside" satisfies CommandId;

/**
 * What a command does to a recording (#1421): "starts" can turn on the microphone or the
 * computer's sound, so the assistant always asks first; "ends" only stops one, which can't send
 * anything or start listening, so it asks only when the request may have come from text the User
 * didn't write: a stopped Meeting can't be picked up again.
 */
export type CommandRecording = "starts" | "ends";

/**
 * A command of the window's list, as the assistant is offered it (#1421): its name in English,
 * for the model, and what the window knows of it. `on` null: it acts on the window in front.
 * `deletes`: it sends things to Recently deleted; `final`: it can't be taken back, so it asks first
 * (stopping a recording isn't counted so: see `recording`); `recording`: it can turn on the
 * microphone or the computer's sound ("starts"), or it ends a recording ("ends"); `yours`: it is
 * the User's alone.
 */
export interface OfferedCommand {
  id: CommandId;
  label: string;
  purpose: string | null;
  on: CommandTarget[] | null;
  deletes: boolean;
  final: boolean;
  recording: CommandRecording | null;
  yours: Yours | null;
}
