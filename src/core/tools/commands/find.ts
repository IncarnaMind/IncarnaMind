/**
 * What `list_commands` finds (#1110): the User's Documents or Minds whose names hold the words
 * given, or that carry the Tag or are in the Folder named, and their Folders and Tags by name
 * (#1421), matched exactly (ignoring case and spacing), never by meaning, so a command touches
 * only what plainly matches.
 */
import { displayName } from "../../../shared/documentNames";
import { mindName } from "../../../shared/naming";
import type {
  CommandsFound,
  CommandTarget,
  DeletedItem,
  DeletedKind,
  Document,
  LibrarySnapshot,
  Mind,
  Tag,
} from "../../api";

/** What is found, as the model reads it and a command acts on it. */
export interface Found {
  kind: CommandTarget;
  id: string;
  name: string;
  /** For a Document: when it was added, created and last modified, as dates (YYYY-MM-DD). */
  dates: { added: string; created: string | null; modified: string | null } | null;
  folder: string | null;
  tags: string[];
  /** A saved web page: its name is its title, which someone else wrote. */
  webPage: boolean;
  /** In Recently deleted: what it was, and its `dates.added` is when it was deleted. */
  deletedKind?: DeletedKind;
}

/** What a deleted thing with no name is called, as Recently deleted shows it. */
const UNTITLED: Readonly<Record<DeletedKind, string>> = {
  mind: "Untitled",
  conversation: "Untitled conversation",
  document: "Untitled",
  folder: "Untitled Folder",
  tag: "Untitled Tag",
};

export interface FindInput {
  kind: CommandTarget;
  name?: string;
  tag?: string;
  folder?: string;
}

export interface Findable {
  documents: readonly Document[];
  minds: readonly Mind[];
  library: Pick<LibrarySnapshot, "groups" | "assignments">;
  tags: readonly Tag[];
  /** What waits in Recently deleted, newest first. */
  deleted: readonly DeletedItem[];
}

const normal = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

export function all(
  kind: CommandTarget,
  { documents, minds, library, tags, deleted }: Findable,
): Found[] {
  const folders = new Map(library.groups.map((group) => [group.id, group.name]));
  const filedIn = new Map(library.assignments.map((each) => [each.documentId, each.groupId]));
  const tagNames = new Map(tags.map((tag) => [tag.id, tag.name]));
  const folderOf = (id: string | null | undefined) => (id ? (folders.get(id) ?? null) : null);
  const named = (id: string, name: string): Found => ({
    kind,
    id,
    name,
    dates: null,
    folder: null,
    tags: [],
    webPage: false,
  });
  if (kind === "folder") return library.groups.map((group) => named(group.id, group.name));
  if (kind === "tag") return tags.map((tag) => named(tag.id, tag.name));
  if (kind === "deleted") {
    return deleted.map((item) => ({
      ...named(item.id, item.name || UNTITLED[item.kind]),
      dates: { added: day(item.deletedAt) ?? "", created: null, modified: null },
      deletedKind: item.kind,
    }));
  }
  if (kind === "mind") {
    return minds.map((mind) => ({
      kind,
      id: mind.id,
      name: mindName(mind),
      dates: null,
      folder: folderOf(mind.folderId),
      tags: [],
      webPage: false,
    }));
  }
  return documents.map((document) => ({
    kind,
    id: document.id,
    name: displayName(document),
    dates: {
      added: day(document.createdAt) ?? "",
      created: day(document.creationDate),
      modified: day(document.modifiedAt),
    },
    folder: folderOf(filedIn.get(document.id)),
    tags: document.tags.flatMap((each) => tagNames.get(each.tagId) ?? []),
    webPage: document.web !== null,
  }));
}

/** What matches every one given of a name, a Tag and a Folder: all of the kind with none given. */
export function find(input: FindInput, findable: Findable): Found[] {
  const name = input.name ? normal(input.name) : null;
  const filed = input.kind === "document" || input.kind === "mind";
  const tag = filed && input.tag ? normal(input.tag) : null;
  const folder = filed && input.folder ? normal(input.folder) : null;
  return all(input.kind, findable).filter(
    (each) =>
      (name === null || normal(each.name).includes(name)) &&
      (tag === null || each.tags.some((one) => normal(one) === tag)) &&
      (folder === null || (each.folder !== null && normal(each.folder) === folder)),
  );
}

/** What the card keeps of a search: how many, and what they were matched by, as given. */
export const foundOf = (input: FindInput, count: number): CommandsFound => ({
  kind: input.kind,
  count,
  by: {
    ...(input.name && { name: input.name.trim() }),
    ...(input.tag && { tag: input.tag.trim() }),
    ...(input.folder && { folder: input.folder.trim() }),
  },
});

/** One found thing as the model reads it: its id, then its name and what it is filed under. */
export function foundLine(found: Found, inFocus: string | null): string {
  if (found.kind === "folder" || found.kind === "tag") return `- ${found.id}: “${found.name}”`;
  if (found.kind === "deleted") {
    return `- ${found.id}: “${found.name}” (${found.deletedKind ?? "item"}, deleted ${found.dates?.added ?? ""})`;
  }
  const facts = [
    ...(found.dates
      ? [
          `added ${found.dates.added}`,
          ...(found.dates.created ? [`created ${found.dates.created}`] : []),
          ...(found.dates.modified ? [`modified ${found.dates.modified}`] : []),
        ]
      : []),
    found.folder === null ? "in no Folder" : `in the Folder “${found.folder}”`,
    ...(found.tags.length > 0 ? [`Tags: ${found.tags.join(", ")}`] : []),
    ...(found.id === inFocus ? ["the Note in focus"] : []),
  ];
  return `- ${found.id}: “${found.name}” (${facts.join("; ")})`;
}
