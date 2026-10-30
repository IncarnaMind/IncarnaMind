/**
 * Which command runs where (#1421). The window's command list, the one ⌘K shows, is the one list
 * the assistant is offered (`OfferedCommand`): a command added to it is the assistant's at once,
 * run in the window as ⌘K runs it. The core runs those that need arguments the window would ask
 * the User for (a name, a Folder, a style, a setting), and those of the Library that ⌘K has no
 * entry for, each with what it acts on and what it does, which decides whether it asks first
 * (./policy). An entry the window marks as the User's alone is never run.
 */
import {
  ACCEPT_SUGGESTIONS,
  type CommandId,
  type CommandTarget,
  type OfferedCommand,
  WALL_SWITCH,
} from "../../../shared/commands";
import type { Effect } from "../../api";
import { InvalidInputError } from "../../errors";
import type { Findable } from "./find";
import { FOLDER_CHECKERS } from "./folders";
import { organizeChecker } from "./organize";
import { restoreChecker } from "./restore";
import {
  type CheckedCommand,
  type Checker,
  COMMAND_EXPORT_FORMATS,
  type CommandInput,
  type CommandPlace,
  type CommandsHost,
  type CommandTouch,
  IN_APP,
  LIBRARY_CHECKERS,
  text,
} from "./run";
import { SETTINGS_TAKEN, settingsChecker } from "./settings";
import { STYLE_CHECKERS } from "./styles";
import { type WindowRun, windowChecked, yoursChecked } from "./window";

/** What a command the core runs acts on and does, its arguments as the model reads them, and its check. */
interface CoreCommand {
  /** Listed with what `list_commands` finds of this kind; "library" and "settings": with neither. */
  on: CommandTarget | "library" | "settings";
  /** A change inside IncarnaMind; a Mind saved as a file; a folder's files read and added. */
  does: "app" | "export" | "add";
  /** It sends what it acts on to Recently deleted, which always asks first. */
  deletes?: true;
  takes: string;
  check: Checker;
}

const RECENTLY_DELETED = "sent to Recently deleted, where the User can restore them";

export const CORE_COMMANDS = {
  "document.rename": {
    on: "document",
    does: "app",
    takes: "ids: one Document; name: its new name",
    check: LIBRARY_CHECKERS["document.rename"],
  },
  "document.moveTo": {
    on: "document",
    does: "app",
    takes: "ids; folder: a Folder's name, made if there is none",
    check: LIBRARY_CHECKERS["document.moveTo"],
  },
  "document.tags": {
    on: "document",
    does: "app",
    takes: "ids; tag: a Tag's name, made if there is none",
    check: LIBRARY_CHECKERS["document.tags"],
  },
  "document.delete": {
    deletes: true,
    on: "document",
    does: "app",
    takes: `ids: ${RECENTLY_DELETED}`,
    check: LIBRARY_CHECKERS["document.delete"],
  },
  "documents.organize": {
    on: "document",
    does: "app",
    takes:
      "ids: the Documents to sort, or none for every Document in no Folder; folder: the Folder the request is about, made if there is none; about: what belongs in it, in the User's words. Organize reads what each Document says and suggests a Folder; its suggestions wait in To review for the User to accept, and nothing moves before that",
    check: organizeChecker,
  },
  "mind.rename": {
    on: "mind",
    does: "app",
    takes: "ids: one Note; name: its new name",
    check: LIBRARY_CHECKERS["mind.rename"],
  },
  "mind.moveTo": {
    on: "mind",
    does: "app",
    takes: "ids; folder: a Folder's name, made if there is none",
    check: LIBRARY_CHECKERS["mind.moveTo"],
  },
  "mind.delete": {
    deletes: true,
    on: "mind",
    does: "app",
    takes: `ids: ${RECENTLY_DELETED}`,
    check: LIBRARY_CHECKERS["mind.delete"],
  },
  "mind.export": {
    on: "mind",
    does: "export",
    takes: `ids: one Note; format: ${COMMAND_EXPORT_FORMATS.join(", ")}; folder: an absolute path, or none for the Output location; marks: "mark" or "leave", only when the User's request says whether a Word file marks the text IncarnaMind wrote`,
    check: LIBRARY_CHECKERS["mind.export"],
  },
  "mind.citationStyle": {
    on: "mind",
    does: "app",
    takes:
      "ids: one Note; style: a citation style's name, such as APA 7, Chicago, MLA or GB/T 7714",
    check: STYLE_CHECKERS["mind.citationStyle"],
  },
  "mind.style": {
    on: "mind",
    does: "app",
    takes:
      "ids: one Note; font: default, serif, mono or a font installed on the computer; size: small, default or large",
    check: STYLE_CHECKERS["mind.style"],
  },
  "folder.new": {
    on: "library",
    does: "app",
    takes: "name: the Folder's name; about: what belongs in it, which Organize reads",
    check: FOLDER_CHECKERS["folder.new"],
  },
  "folder.rename": {
    on: "folder",
    does: "app",
    takes: "ids: one Folder; name: its new name",
    check: FOLDER_CHECKERS["folder.rename"],
  },
  "folder.delete": {
    deletes: true,
    on: "folder",
    does: "app",
    takes: `ids: ${RECENTLY_DELETED}; what they hold goes to no Folder`,
    check: FOLDER_CHECKERS["folder.delete"],
  },
  "tag.new": {
    on: "library",
    does: "app",
    takes: "name: the Tag's name",
    check: FOLDER_CHECKERS["tag.new"],
  },
  "tag.rename": {
    on: "tag",
    does: "app",
    takes: "ids: one Tag; name: its new name",
    check: FOLDER_CHECKERS["tag.rename"],
  },
  "tag.delete": {
    deletes: true,
    on: "tag",
    does: "app",
    takes: `ids: ${RECENTLY_DELETED}`,
    check: FOLDER_CHECKERS["tag.delete"],
  },
  "deleted.restore": {
    on: "deleted",
    does: "app",
    takes: "ids: what list_commands found in Recently deleted; each goes back where it was",
    check: restoreChecker,
  },
  "documents.addFromFolder": {
    on: "library",
    does: "add",
    takes:
      "folder: an absolute path or ~/…; kinds: file extensions such as pdf, or none for every kind",
    check: LIBRARY_CHECKERS["documents.addFromFolder"],
  },
  "settings.change": {
    on: "settings",
    does: "app",
    takes: `setting and value: ${SETTINGS_TAKEN}`,
    check: settingsChecker,
  },
} as const satisfies Record<CommandId, CoreCommand>;

export type CoreCommandId = keyof typeof CORE_COMMANDS;

export const isCoreCommand = (value: unknown): value is CoreCommandId =>
  typeof value === "string" && Object.hasOwn(CORE_COMMANDS, value);

export const coreCommandsOn = (on: CoreCommand["on"]): CoreCommandId[] =>
  (Object.keys(CORE_COMMANDS) as CoreCommandId[]).filter((id) => CORE_COMMANDS[id].on === on);

/**
 * What a call can do, from its command's own metadata: a change inside IncarnaMind, a file
 * saved in the Output location or in the folder named, or a folder read and its files added. A
 * command of the window's acts inside IncarnaMind.
 */
export function commandEffects(input: Record<string, unknown>): Effect[] {
  if (!isCoreCommand(input.command)) {
    return typeof input.command === "string"
      ? IN_APP
      : [{ action: "write", scope: { kind: "anywhere" } }];
  }
  const folder = text(input.folder);
  switch (CORE_COMMANDS[input.command].does) {
    case "app":
      return IN_APP;
    case "export":
      return [
        { action: "write", scope: folder ? { kind: "folder", path: folder } : { kind: "output" } },
      ];
    case "add":
      return [{ action: "read", scope: { kind: "folder", path: folder ?? "" } }, ...IN_APP];
  }
}

/**
 * The live Documents waiting in a suggested Folder, as To review lists them, and what names them;
 * refused when none waits. A suggestion counts as behind its Folder's wall, which the gate holds
 * it to, though a Note there doesn't search it yet: so they are named here, not by what is found.
 */
async function waitingSuggestions(host: CommandsHost): Promise<{ ids: string[]; named: Findable }> {
  const [library, listed] = await Promise.all([host.core.getLibrary(), host.core.listDocuments()]);
  const waiting = new Set(library.assignments.filter((a) => a.suggested).map((a) => a.documentId));
  const documents = listed.filter((each) => waiting.has(each.id));
  if (documents.length === 0) throw new InvalidInputError({ key: "error.commands.nothingWaiting" });
  const named = { documents, minds: [], library, tags: [], deleted: [] };
  return { ids: documents.map((each) => each.id), named };
}

/** The Folder a request for a wall's switch is about: the one it names, the Note's, or the only walled one. */
async function wallAskedAbout(
  input: CommandInput,
  host: CommandsHost,
  mindId: string | null,
): Promise<{ id: string; name: string } | undefined> {
  const { groups } = await host.core.getLibrary();
  const own =
    mindId === null
      ? null
      : ((await host.core.listMinds()).find((mind) => mind.id === mindId)?.folderId ?? null);
  const walled = groups.filter((group) => group.keepInside);
  const folder =
    groups.find((group) => input.ids.includes(group.id)) ??
    groups.find((group) => group.id === own) ??
    (walled.length === 1 ? walled[0] : undefined);
  return folder && { id: folder.id, name: folder.name };
}

export interface CheckContext extends WindowRun, CommandPlace {
  /** The window's commands, as it offered them for this Answer. */
  offered: readonly OfferedCommand[];
  findable(): Promise<Findable>;
  /** The Folder wall the Answer was asked behind; left out: the Note's own (#1934). */
  wallId?: string | null;
}

/**
 * Checks a call: what it would do, and whether it asks first. A command the window marks as the
 * User's alone is refused before anything else; the core runs its own; the window runs the rest
 * it offered. Throws for one that can't run.
 */
export async function checkCommand(
  input: CommandInput,
  host: CommandsHost,
  context: CheckContext,
): Promise<CheckedCommand> {
  // A Folder's wall is the User's alone, whatever the window offered (#1934).
  if (input.command === WALL_SWITCH) {
    return yoursChecked(WALL_SWITCH, "wall", await wallAskedAbout(input, host, context.mindId));
  }
  const offered = context.offered.find((each) => each.id === input.command);
  // Accept all names no ids: it acts on the suggestions waiting now, which the wall gate checks
  // and the window then accepts alone, so one that lands meanwhile isn't filed unchecked (#2243).
  const acceptAll = offered?.id === ACCEPT_SUGGESTIONS && offered.yours === null;
  const waiting = acceptAll ? await waitingSuggestions(host) : null;
  const call = waiting ? { ...input, ids: waiting.ids } : input;
  const entry: OfferedCommand | undefined =
    acceptAll && offered ? { ...offered, on: ["document"] } : offered;
  // Every command, the core's and the window's, is held to the Folder wall first, by what it
  // declares it touches (#1934); one the gate can't place is refused there.
  const touches: CommandTouch[] = isCoreCommand(call.command)
    ? [CORE_COMMANDS[call.command].on]
    : entry
      ? (entry.on ?? ["front"])
      : [];
  await host.allows?.(call, touches, context.mindId, context.wallId);
  if (entry && (entry.yours !== null || !isCoreCommand(entry.id))) {
    const findable = waiting?.named ?? (await context.findable());
    return windowChecked(entry, call.ids, findable, context, host.window);
  }
  if (isCoreCommand(input.command)) {
    const command: CoreCommand = CORE_COMMANDS[input.command];
    const checked = await command.check(input, host, context);
    return command.deletes ? { ...checked, deletes: true } : checked;
  }
  throw new InvalidInputError({
    key: "error.commands.unknown",
    values: { command: input.command || "?" },
  });
}
