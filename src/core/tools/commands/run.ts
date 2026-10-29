/**
 * What the core's commands do (#1110): each checked first, with what it would do outside
 * IncarnaMind worked out from the arguments (`CheckedCommand.outside`), then run. Each run says
 * what it changed and how to take it back, from what the core returned. A command that changes
 * several things changes all of them or none. Which command runs where is ./catalogue's.
 */
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CommandId, CommandTarget, Yours } from "../../../shared/commands";
import { displayName } from "../../../shared/documentNames";
import { mindName } from "../../../shared/naming";
import { tagLinks } from "../../../shared/tagLinks";
import type {
  CommandAsk,
  CommandDone,
  CommandItem,
  CoreApi,
  Document,
  Effect,
  ExportMarking,
  FolderMove,
  LibraryGroup,
  MarkAiTextChoice,
  Mind,
  SavedFile,
  UserAnswer,
  UserQuestion,
  WindowCommandRequest,
  WindowCommandResult,
} from "../../api";
import { RECENTLY_DELETED_DAYS } from "../../api";
import { isInside, kindOf } from "../../documents/files";
import { InvalidInputError, NotFoundError } from "../../errors";
import type { CommandStep } from "./steps";

/** The core's calls the commands make: the same the window's own clicks make. */
export type CommandsCore = Pick<
  CoreApi,
  | "listDocuments"
  | "listMinds"
  | "getLibrary"
  | "listTags"
  | "renameDocument"
  | "renameMind"
  | "isExampleDocument"
  | "moveToFolder"
  | "restoreAssignment"
  | "createLibraryGroup"
  | "deleteLibraryGroup"
  | "restore"
  | "createTag"
  | "deleteTag"
  | "addTagToDocuments"
  | "revertDocumentTags"
  | "deleteDocuments"
  | "deleteMind"
  | "deletePermanently"
  | "listConversations"
  | "addDocuments"
  | "previewMindExport"
  | "updateLibraryGroup"
  | "updateTag"
  | "classifyDocuments"
  | "getMindCitationStyle"
  | "setMindCitationStyle"
  | "listCitationStyles"
  | "getMindStyle"
  | "setMindStyle"
  | "getSettings"
  | "updateSettings"
  | "getOutputSettings"
  | "setOutputLocation"
  | "listChatModels"
>;

export const COMMAND_EXPORT_FORMATS = ["docx", "pdf", "markdown", "html"] as const;
export type CommandExportFormat = (typeof COMMAND_EXPORT_FORMATS)[number];

/** What a command may ask the User, in the tray, while it runs; null when the Answer has no tray. */
export type CommandAsking = ((question: UserQuestion) => Promise<UserAnswer>) | null;

/** How a Word file's choice about marking the text IncarnaMind wrote was settled for an export. */
export type MarkingSettled = ExportMarking;

export interface CommandsHost {
  core: CommandsCore;
  /** The Output location, links followed; null while none is chosen. */
  outputFolder(): Promise<string | null>;
  /**
   * Saves a Mind as a file with the User's export choices for the format: in the Output location
   * (`folder` null), in a folder inside it, or, `approved`, in a folder the User allowed for this
   * one file. A Word file marks the text IncarnaMind wrote, as the saved choice or the default
   * has it, or as the request named it (`named`) for this file alone (#1945). Throws, saying why,
   * when nothing was saved.
   */
  exportMind(
    mindId: string,
    format: CommandExportFormat,
    folder: string | null,
    approved: boolean,
    marking: { named: MarkAiTextChoice | null },
  ): Promise<{ file: SavedFile; marking: MarkingSettled | null }>;
  /**
   * Runs a command of the window's list in the window that asked (#1421), as ⌘K runs it; absent
   * where there is no window, so only the core's own commands run.
   */
  window?(
    request: Omit<WindowCommandRequest, "requestId">,
    signal: AbortSignal,
  ): Promise<WindowCommandResult>;
}

/** A call's arguments, as the model gives them, every one checked. */
export interface CommandInput {
  command: string;
  ids: string[];
  name: string | null;
  folder: string | null;
  tag: string | null;
  format: CommandExportFormat;
  /** A Word export's choice about marking the text IncarnaMind wrote, when the User's request names it. */
  marks: MarkAiTextChoice | null;
  kinds: string[];
  /** What belongs in a Folder, in the User's words: what Organize reads of it (#1421). */
  about: string | null;
  style: string | null;
  font: string | null;
  size: string | null;
  setting: string | null;
  value: string | null;
}

/** What a command changed, how to take it back, and what the model is told. */
export interface Ran {
  done: Omit<CommandDone, "command" | "run">;
  step: CommandStep | null;
  said: string;
}

/**
 * A command checked at the gate: what it can do, what it would change inside IncarnaMind, what
 * it would do outside it (`outside`: what its approval shows; null: nothing), and the run.
 * Whether it asks first is the gate's to decide (`askOf`).
 */
export interface CheckedCommand {
  command: CommandId;
  effects: Effect[];
  /** What it acts on, as named now. */
  items: CommandItem[];
  /** The Folder or Tag it puts them in, by name. */
  into: string | null;
  outside: CommandAsk | null;
  /** It changes `items` inside IncarnaMind: they count towards the Answer's limit (`COMMAND_AT_ONCE`). */
  changes: boolean;
  /** It sends `items` to Recently deleted. */
  deletes: boolean;
  /** It can't be taken back. */
  final: boolean;
  /** Never the assistant's (#1421): it runs nothing, and the User is told where they change it. */
  yours: Yours | null;
  run(asking: CommandAsking, signal: AbortSignal): Promise<Ran>;
}

export const IN_APP: Effect[] = [{ action: "write", scope: { kind: "library" } }];

export const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap((each) => text(each) ?? []) : [];

/** A call's arguments; which command it names is checked where it runs (./catalogue). */
export function parseCommandInput(input: Record<string, unknown>): CommandInput {
  return {
    command: typeof input.command === "string" ? input.command.trim() : "",
    ids: texts(input.ids),
    name: text(input.name),
    folder: text(input.folder),
    tag: text(input.tag),
    format: COMMAND_EXPORT_FORMATS.find((each) => each === input.format) ?? "docx",
    marks: input.marks === "mark" || input.marks === "leave" ? input.marks : null,
    kinds: texts(input.kinds).map((kind) => kind.replace(/^\./, "").toLowerCase()),
    about: text(input.about),
    style: text(input.style),
    font: text(input.font),
    size: text(input.size),
    setting: text(input.setting),
    value: text(input.value),
  };
}

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const markingSaid = (marking: MarkingSettled | null): string => {
  if (marking === null) return "";
  const leaves =
    marking.choice === "mark"
      ? "marks the text IncarnaMind wrote with comments"
      : "leaves the text IncarnaMind wrote unmarked";
  switch (marking.how) {
    case "this-file":
      return ` This file ${leaves}, as the User asked for it; their saved choice for Word exports is unchanged.`;
    case "earlier":
      return ` This file ${leaves}, following the choice saved for Word exports.`;
    case "default":
      return ` This file ${leaves}, using the default for Word exports; that choice is now saved.`;
  }
};

export const same = (a: string, b: string) =>
  a.normalize("NFKC").trim().toLowerCase() === b.normalize("NFKC").trim().toLowerCase();

type Missing =
  | "error.commands.noName"
  | "error.commands.noFolderName"
  | "error.commands.noTag"
  | "error.commands.noFolderPath"
  | "error.commands.noStyle"
  | "error.commands.noSetting"
  | "error.commands.noValue";

export function needs<T>(value: T | null, missing: Missing): T {
  if (value === null) throw new InvalidInputError({ key: missing });
  return value;
}

export async function documentsOf(core: CommandsCore, ids: readonly string[]): Promise<Document[]> {
  if (ids.length === 0) throw new InvalidInputError({ key: "error.commands.noIds" });
  const all = await core.listDocuments();
  return [...new Set(ids)].map((id) => {
    const document = all.find((each) => each.id === id);
    if (!document) throw new NotFoundError({ key: "error.commands.noDocument", values: { id } });
    return document;
  });
}

export async function mindsOf(core: CommandsCore, ids: readonly string[]): Promise<Mind[]> {
  if (ids.length === 0) throw new InvalidInputError({ key: "error.commands.noIds" });
  const all = await core.listMinds();
  return [...new Set(ids)].map((id) => {
    const mind = all.find((each) => each.id === id);
    if (!mind) throw new NotFoundError({ key: "error.commands.noMind", values: { id } });
    return mind;
  });
}

export function onlyOne<T>(items: readonly T[]): T {
  const [item] = items;
  if (!item || items.length > 1) throw new InvalidInputError({ key: "error.commands.oneOnly" });
  return item;
}

export async function folderOnDisk(given: string): Promise<string> {
  const path = given === "~" ? homedir() : given.replace(/^~(?=[\\/])/, homedir());
  if (!isAbsolute(path)) {
    throw new InvalidInputError({ key: "error.commands.notAbsolute", values: { folder: given } });
  }
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new NotFoundError({ key: "error.commands.noFolder", values: { folder: given } });
  }
  if (!(await stat(real)).isDirectory()) {
    throw new InvalidInputError({ key: "error.path.notFolder" });
  }
  return real;
}

async function filesIn(folder: string, kinds: readonly string[]): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(folder, entry.name);
    const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
    if (kindOf(path) === undefined || (kinds.length > 0 && !kinds.includes(extension))) continue;
    // A link that leads out of the folder isn't read.
    const real = entry.isSymbolicLink() ? await realpath(path).catch(() => null) : path;
    if (!real || !isInside(folder, real) || !(await lstat(real)).isFile()) continue;
    names.push(entry.name);
  }
  return names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export const documentItem = (document: Document, renamed?: Document): CommandItem => ({
  kind: "document",
  id: document.id,
  name: displayName(document),
  ...(renamed && { renamed: displayName(renamed) }),
});

export const mindItem = (mind: Mind, renamed?: Mind): CommandItem => ({
  kind: "mind",
  id: mind.id,
  name: mindName(mind),
  ...(renamed && { renamed: mindName(renamed) }),
});

export type Checker = (input: CommandInput, host: CommandsHost) => Promise<CheckedCommand>;

/** What a command that reaches outside the Library changes in it: nothing its limit counts. */
const OUTSIDE_IT = { changes: false, deletes: false, final: false, yours: null } as const;

/** A change inside IncarnaMind that Undo takes back: it asks only past the Answer's limit. */
export const inApp = (
  command: CommandId,
  items: CommandItem[],
  into: string | null,
  run: () => Promise<Ran>,
): CheckedCommand => ({
  command,
  effects: IN_APP,
  items,
  into,
  outside: null,
  changes: true,
  deletes: false,
  final: false,
  yours: null,
  run,
});

/** Whether a Folder holds anything: Documents filed in it, Minds or conversations. */
export async function holdsAny(core: CommandsCore, folderId: string): Promise<boolean> {
  const [library, minds, conversations] = await Promise.all([
    core.getLibrary(),
    core.listMinds(),
    core.listConversations({ folderId }),
  ]);
  return (
    library.assignments.some((each) => each.groupId === folderId) ||
    minds.some((mind) => mind.folderId === folderId) ||
    conversations.length > 0
  );
}

/**
 * Removes for good a Folder or Tag a command made just now for a change that then failed: the
 * User never saw it, so it doesn't wait in Recently deleted.
 */
export async function unmake(
  core: CommandsCore,
  kind: "folder" | "tag",
  id: string,
): Promise<void> {
  if (kind === "folder") await core.deleteLibraryGroup(id);
  else await core.deleteTag(id);
  await core.deletePermanently([{ kind, id }]);
}

export async function folderNamed(
  core: CommandsCore,
  name: string,
  description = "",
): Promise<{ folder: LibraryGroup; made: boolean }> {
  const existing = (await core.getLibrary()).groups.find((group) => same(group.name, name));
  if (existing) return { folder: existing, made: false };
  return { folder: await core.createLibraryGroup({ name, description }), made: true };
}

async function moveBack(core: CommandsCore, move: FolderMove): Promise<void> {
  for (const document of move.documents) {
    if (document.from !== move.folderId) {
      await core.restoreAssignment(document.id, document.change.before, document.change.after);
    }
  }
  const back = new Map<string | null, string[]>();
  for (const { id, from } of move.minds) {
    if (from !== move.folderId) back.set(from, [...(back.get(from) ?? []), id]);
  }
  for (const [folderId, mindIds] of back) await core.moveToFolder({ mindIds, folderId });
}

function moveTo(command: "document.moveTo" | "mind.moveTo", kind: CommandTarget): Checker {
  return async (input, { core }) => {
    const name = needs(input.folder, "error.commands.noFolderName");
    const asked = kind === "document" ? await documentsOf(core, input.ids) : [];
    // The examples stay where they are: their Documents never join the User's Folders, and the
    // User's own in the same selection still go where they asked (#1942).
    const documents: Document[] = [];
    for (const document of asked) {
      if (!(await core.isExampleDocument(document.id))) documents.push(document);
    }
    if (kind === "document" && documents.length === 0 && asked.length > 0)
      throw new InvalidInputError({ key: "error.commands.exampleDocument" });
    const minds = kind === "mind" ? await mindsOf(core, input.ids) : [];
    const moving = {
      documentIds: documents.map((each) => each.id),
      mindIds: minds.map((each) => each.id),
    };
    const items = [
      ...documents.map((each) => documentItem(each)),
      ...minds.map((each) => mindItem(each)),
    ];
    return inApp(command, items, name, async () => {
      const { folder, made } = await folderNamed(core, name);
      let move: FolderMove;
      try {
        move = await core.moveToFolder({ ...moving, folderId: folder.id });
      } catch (error) {
        if (made) await unmake(core, "folder", folder.id);
        throw error;
      }
      const moved = new Set(
        [...move.documents, ...move.minds]
          .filter((each) => each.from !== folder.id)
          .map((each) => each.id),
      );
      const changed = [
        ...documents.filter((each) => moved.has(each.id)).map((each) => documentItem(each)),
        ...minds.filter((each) => moved.has(each.id)).map((each) => mindItem(each)),
      ];
      const already = documents.length + minds.length - changed.length;
      /** Whether its Undo removed the Folder it made; false: kept for what the User filed in it. */
      let removed: boolean | null = null;
      return {
        done: { items: changed, into: { kind: "folder", id: folder.id, name: folder.name, made } },
        step: {
          undo: async () => {
            await moveBack(core, move);
            if (!made || removed === false) return null;
            // What the User filed in it since keeps it.
            if (await holdsAny(core, folder.id)) {
              removed = false;
              return { kind: "folder", name: folder.name };
            }
            await core.deleteLibraryGroup(folder.id);
            removed = true;
            return null;
          },
          redo: async () => {
            if (removed) await core.restore([{ kind: "folder", id: folder.id }]);
            removed = null;
            move = await core.moveToFolder({ ...moving, folderId: folder.id });
          },
        },
        said: `Moved ${plural(changed.length, kind === "document" ? "Document" : "Mind")} to the Folder “${folder.name}”${made ? ", which this made" : ""}.${already > 0 ? ` ${plural(already, "was", "were")} in it already.` : ""}`,
      };
    });
  };
}

async function deleteAll(
  refs: readonly { kind: "document" | "mind"; id: string }[],
  remove: (id: string) => Promise<unknown>,
  restore: CommandsCore["restore"],
): Promise<void> {
  const done: { kind: "document" | "mind"; id: string }[] = [];
  try {
    for (const ref of refs) {
      await remove(ref.id);
      done.push(ref);
    }
  } catch (error) {
    if (done.length > 0) await restore(done, { reopen: true });
    throw error;
  }
}

/** The commands of #1110, which change the Library's Documents and Minds, export and add files. */
export const LIBRARY_CHECKERS = {
  "document.rename": async (input, { core }) => {
    const document = onlyOne(await documentsOf(core, input.ids));
    const name = needs(input.name, "error.commands.noName");
    return inApp("document.rename", [documentItem(document)], null, async () => {
      const renamed = await core.renameDocument(document.id, name);
      return {
        done: { items: [documentItem(document, renamed)] },
        step: {
          undo: async () => {
            await core.renameDocument(document.id, document.name);
            return null;
          },
          redo: async () => {
            await core.renameDocument(document.id, renamed.name);
          },
        },
        said: `Renamed the Document “${displayName(document)}” to “${displayName(renamed)}”.`,
      };
    });
  },

  "mind.rename": async (input, { core }) => {
    const mind = onlyOne(await mindsOf(core, input.ids));
    const name = needs(input.name, "error.commands.noName");
    return inApp("mind.rename", [mindItem(mind)], null, async () => {
      const renamed = await core.renameMind(mind.id, name);
      return {
        done: { items: [mindItem(mind, renamed)] },
        step: {
          undo: async () => {
            await core.renameMind(mind.id, mind.title);
            return null;
          },
          redo: async () => {
            await core.renameMind(mind.id, renamed.title);
          },
        },
        said: `Renamed the Mind “${mindName(mind)}” to “${mindName(renamed)}”.`,
      };
    });
  },

  "document.moveTo": moveTo("document.moveTo", "document"),
  "mind.moveTo": moveTo("mind.moveTo", "mind"),

  "document.tags": async (input, { core }) => {
    const name = needs(input.tag, "error.commands.noTag");
    const documents = await documentsOf(core, input.ids);
    const items = documents.map((each) => documentItem(each));
    return inApp("document.tags", items, name, async () => {
      const existing = (await core.listTags()).find((each) => same(each.name, name));
      const tag = existing ?? (await core.createTag({ name }));
      const made = existing === undefined;
      const changed = documents.filter((each) => !each.tags.some((one) => one.tagId === tag.id));
      const ids = changed.map((each) => each.id);
      const before = tagLinks(documents, ids, tag.id);
      try {
        if (ids.length > 0) await core.addTagToDocuments(ids, tag.id);
      } catch (error) {
        if (made) await unmake(core, "tag", tag.id);
        throw error;
      }
      /** Whether its Undo removed the Tag it made; false: kept for Documents the User tagged since. */
      let removed: boolean | null = null;
      const already = documents.length - changed.length;
      return {
        done: {
          items: changed.map((each) => documentItem(each)),
          into: { kind: "tag", id: tag.id, name: tag.name, made },
        },
        step: {
          undo: async () => {
            if (ids.length > 0) await core.revertDocumentTags(before);
            if (!made || removed === false) return null;
            const tagged = await core.listDocuments();
            if (tagged.some((each) => each.tags.some((one) => one.tagId === tag.id))) {
              removed = false;
              return { kind: "tag", name: tag.name };
            }
            await core.deleteTag(tag.id);
            removed = true;
            return null;
          },
          redo: async () => {
            if (removed) await core.restore([{ kind: "tag", id: tag.id }]);
            removed = null;
            if (ids.length > 0) await core.addTagToDocuments(ids, tag.id);
          },
        },
        said: `Tagged ${plural(changed.length, "Document")} “${tag.name}”${made ? ", a new Tag" : ""}.${already > 0 ? ` ${plural(already, "Document")} had it already.` : ""}`,
      };
    });
  },

  "document.delete": async (input, { core }) => {
    const documents = await documentsOf(core, input.ids);
    const refs = documents.map((each) => ({ kind: "document" as const, id: each.id }));
    const remove = () => core.deleteDocuments(refs.map((ref) => ref.id));
    const items = documents.map((each) => documentItem(each));
    return inApp("document.delete", items, null, async () => {
      await remove();
      return {
        done: { items },
        step: {
          undo: async () => {
            await core.restore(refs);
            return null;
          },
          redo: remove,
        },
        said: `Moved ${plural(documents.length, "Document")} to Recently deleted, where the User can restore them for ${RECENTLY_DELETED_DAYS} days.`,
      };
    });
  },

  "mind.delete": async (input, { core }) => {
    const minds = await mindsOf(core, input.ids);
    const refs = minds.map((each) => ({ kind: "mind" as const, id: each.id }));
    const remove = () => deleteAll(refs, (id) => core.deleteMind(id), core.restore);
    const items = minds.map((each) => mindItem(each));
    return inApp("mind.delete", items, null, async () => {
      await remove();
      return {
        done: { items },
        step: {
          undo: async () => {
            await core.restore(refs, { reopen: true });
            return null;
          },
          redo: remove,
        },
        said: `Moved ${plural(minds.length, "Mind")} to Recently deleted, where the User can restore them for ${RECENTLY_DELETED_DAYS} days.`,
      };
    });
  },

  "mind.export": async (input, host) => {
    const mind = onlyOne(await mindsOf(host.core, input.ids));
    const given = input.folder === null ? null : await folderOnDisk(input.folder);
    const output = given === null ? null : await host.outputFolder();
    // Only the Output location itself: a folder in it may be one a sync service shares.
    const elsewhere = given !== null && given !== output;
    const into = elsewhere ? given : null;
    const run = async (): Promise<Ran> => {
      const { file, marking } = await host.exportMind(mind.id, input.format, into, elsewhere, {
        named: input.format === "docx" ? input.marks : null,
      });
      return {
        done: {
          items: [mindItem(mind)],
          file: {
            path: file.path,
            name: file.name,
            folder: file.folder,
            inDefaultFolder: file.inDefaultFolder,
          },
          inOutputLocation: !elsewhere,
          ...(marking && { marking }),
        },
        step: null,
        said: `Saved “${mindName(mind)}” as “${file.name}” in ${elsewhere ? file.folder : `the Output location, ${file.folder}`}. A file can't be taken back with Undo.${markingSaid(marking)}`,
      };
    };
    const items = [mindItem(mind)];
    if (!elsewhere || given === null) {
      return {
        command: "mind.export",
        effects: [{ action: "write", scope: { kind: "output" } }],
        items,
        into: null,
        outside: null,
        ...OUTSIDE_IT,
        run,
      };
    }
    const { fileName } = await host.core.previewMindExport(mind.id, { format: input.format });
    return {
      command: "mind.export",
      effects: [{ action: "write", scope: { kind: "folder", path: given } }],
      items,
      into: null,
      outside: {
        kind: "export",
        mind: { id: mind.id, name: mindName(mind) },
        format: input.format,
        folder: given,
        fileName,
      },
      ...OUTSIDE_IT,
      run,
    };
  },

  "documents.addFromFolder": async (input, { core }) => {
    const folder = await folderOnDisk(needs(input.folder, "error.commands.noFolderPath"));
    const files = await filesIn(folder, input.kinds);
    if (files.length === 0) {
      throw new InvalidInputError({ key: "error.commands.noFiles", values: { folder } });
    }
    return {
      command: "documents.addFromFolder",
      effects: [{ action: "read", scope: { kind: "folder", path: folder } }, ...IN_APP],
      items: [],
      into: null,
      outside: { kind: "add", folder, files },
      ...OUTSIDE_IT,
      async run() {
        const known = new Set((await core.listDocuments()).map((each) => each.id));
        const result = await core.addDocuments(files.map((name) => join(folder, name)));
        const added = result.documents.filter((each) => !known.has(each.id));
        const refs = added.map((each) => ({ kind: "document" as const, id: each.id }));
        const already = result.documents.length - added.length;
        return {
          done: { items: added.map((each) => documentItem(each)) },
          step:
            added.length === 0
              ? null
              : {
                  undo: async () => {
                    await core.deleteDocuments(refs.map((ref) => ref.id));
                    return null;
                  },
                  redo: () => core.restore(refs),
                },
          said: `Added ${plural(added.length, "Document")} from ${folder}.${already > 0 ? ` ${plural(already, "was", "were")} in the Library already.` : ""}${result.skipped.length > 0 ? ` ${plural(result.skipped.length, "file")} couldn't be added.` : ""}`,
        };
      },
    };
  },
} satisfies Record<CommandId, Checker>;
