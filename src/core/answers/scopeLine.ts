/**
 * What the model is told of a Question's Search scope and of the Folder in front (#2529): given
 * only the Documents in scope, "this folder" had nothing to point at and the assistant asked
 * which one. The lines go just before the Question, with the Documents on screen, so the start of
 * the prompt stays the same from one Question to the next.
 */
import { folderScope, hasSearchScope, NO_SCOPE, type ScopeKind } from "../../shared/searchScope";
import type { SearchScope } from "../api";
import { listedName } from "./prompt";

interface Named {
  name: string;
  documents: number;
}

/** A Search scope as its chip shows it, with the Folder in front and, when none is named, the Folders to choose from. */
export interface ScopeNaming {
  folders: readonly Named[];
  tags: readonly Named[];
  /** Documents picked one by one. */
  picked: number;
  /** With no limit: the Documents searched, and the Folders the User keeps apart that are left out. */
  everything: { documents: number; leftOut: number } | null;
  /** The Folder of the Note in front, when the scope doesn't name it, and the names of its first Documents. */
  inFront: (Named & { documentNames: readonly string[] }) | null;
  /** The Folders there are, when the scope names nothing and the Note names no Folder: all Documents are searched. */
  choices: readonly Named[];
  /** How many Folders `choices` leaves out for want of room. */
  moreChoices: number;
}

/** The most Folders, and the most of a Folder's Documents, one line names. */
export const LISTED_FOLDERS = 10;
export const LISTED_FOLDER_DOCUMENTS = 10;

const documentsOf = (count: number) => `${count} Document${count === 1 ? "" : "s"}`;
const quoted = (name: string) => `"${listedName(name)}"`;
const counted = ({ name, documents }: Named) => `${quoted(name)} (${documentsOf(documents)})`;

/** The lines before the Question that name the scope and the Folder in front; "" when nothing is known. */
export function scopeLines(naming: ScopeNaming): string {
  const lines: string[] = [];
  const parts = [
    ...naming.folders.map((each) => `the Folder ${counted(each)}`),
    ...naming.tags.map((each) => `the Tag ${counted(each)}`),
    ...(naming.picked > 0 ? [`${documentsOf(naming.picked)} the User picked`] : []),
  ];
  if (parts.length > 0) {
    lines.push(`Search scope: ${parts.join(", ")}`);
  } else if (
    naming.everything &&
    (naming.everything.documents > 0 || naming.everything.leftOut > 0)
  ) {
    const { documents, leftOut } = naming.everything;
    const apart = leftOut > 0 ? ` · ${leftOut} Folder${leftOut === 1 ? "" : "s"} left out` : "";
    lines.push(`Search scope: All Documents${apart} (${documents})`);
  }
  if (naming.inFront) {
    const { documents, documentNames } = naming.inFront;
    const more = documents - documentNames.length;
    const listed =
      documentNames.length > 0
        ? `: ${documentNames.map(quoted).join(", ")}${more > 0 ? `, and ${more} more` : ""}`
        : "";
    lines.push(
      `The Note in front is in the Folder ${quoted(naming.inFront.name)} (${documentsOf(documents)}${listed})`,
    );
  } else if (naming.choices.length > 0) {
    const more = naming.moreChoices > 0 ? `, and ${naming.moreChoices} more` : "";
    lines.push(`The User's Folders: ${naming.choices.map(counted).join(", ")}${more}`);
  }
  return lines.join("\n");
}

/** Told once in the instructions: how the lines above read, and what a Folder the User points at without naming is. */
export const SEARCH_SCOPE_RULE = [
  'A line "Search scope: …" before the Question names what the User limited it to, as the scope chip in their composer shows it, with how many Documents each Folder or Tag holds in brackets. "All Documents · 2 Folders left out" is every Document except those in 2 Folders the User keeps apart: they are not searched, and you never name them. "The Note in front is in the Folder …" names the Folder of the Note the User is in, with its first Documents. "The User\'s Folders: …" lists their Folders when neither names one.',
  '- When the User points at a Folder without naming it ("this folder", "这个文件夹" and the like), it is the one Folder the Search scope names; else the Folder the Note in front is in; else the one Folder in "The User\'s Folders". Do what they asked with that Folder\'s Documents at once, and never ask which Folder it is. Say in your reply which Folder you took, by name.',
  "- Ask which Folder with ask_user, before doing anything, only when several Folders could be the one meant and nothing tells which: the scope names several, or the line lists several. Offer them by name. With no Folder at all, say they have no Folder yet.",
].join("\n");

/** What `nameScope` reads of the Library, as the core gives it. */
export interface ScopeSource {
  /** A Folder's, Tag's or Document's name; null once it is gone. */
  itemName(kind: ScopeKind, id: string): string | null;
  /** The live Folders of the Library, with whether each keeps its work inside it. */
  folders(): readonly { id: string; name: string; keepInside: boolean }[];
  /** The wall a Folder is in or is; null outside every wall. */
  walledFolderId(folderId: string | null): string | null;
  /** The Documents a scope covers from `mindId`'s side of the walls; null: every Document. */
  resolveScope(scope: SearchScope, mindId: string | null): string[] | null;
  /** How many of those a search can read. */
  searchableCount(documentIds: readonly string[] | null): number;
  /** The names of up to `limit` of those, newest first. */
  searchableNames(documentIds: readonly string[] | null, limit: number): readonly string[];
  /** The Folder a Note is in; null for none. */
  mindFolder(mindId: string): string | null;
}

interface AskedScope {
  /** The Question's Search scope; null: none. */
  scope: SearchScope | null;
  /** The Note in focus. */
  mindId: string | null;
  /** The wall the Question is asked behind, whose Folder is then the whole scope; null outside every wall. */
  wallId: string | null;
  /** The Documents the scope covers, as the Answer searches them; null: every Document. */
  documentIds: readonly string[] | null;
}

/**
 * Names the scope of a Question as its chip shows it. A Folder behind a wall is named only to
 * work behind that same wall: outside it the scope's walled Folders are left out as the search
 * leaves them, and the Folders to choose from are those outside every wall.
 */
export function nameScope(
  { scope, mindId, wallId, documentIds }: AskedScope,
  source: ScopeSource,
): ScopeNaming {
  const effective = wallId ? folderScope(wallId) : (scope ?? NO_SCOPE);
  const countIn = (part: Partial<SearchScope>) =>
    source.searchableCount(source.resolveScope({ ...NO_SCOPE, ...part }, mindId));
  const named = (kind: "folder" | "tag", ids: readonly string[]) =>
    ids.flatMap((id) => {
      if (kind === "folder" && wallId === null && source.walledFolderId(id) !== null) return [];
      const name = source.itemName(kind, id);
      if (name === null) return [];
      return [
        {
          id,
          name,
          documents: countIn(kind === "folder" ? { folderIds: [id] } : { tagIds: [id] }),
        },
      ];
    });
  const folders = named("folder", effective.folderIds);
  const limited = hasSearchScope(effective);
  const own = mindId === null || wallId !== null ? null : source.mindFolder(mindId);
  const ownName = own === null ? null : source.itemName("folder", own);
  const front =
    own !== null && ownName !== null && !folders.some((each) => each.id === own)
      ? { id: own, name: ownName }
      : null;
  const frontIds = front ? source.resolveScope(folderScope(front.id), mindId) : null;
  const choices =
    limited || folders.length > 0 || front || wallId !== null
      ? []
      : source
          .folders()
          .filter((folder) => source.walledFolderId(folder.id) === null)
          .map((folder) => ({ name: folder.name, documents: countIn({ folderIds: [folder.id] }) }))
          .filter((folder) => folder.documents > 0);
  return {
    folders,
    tags: named("tag", effective.tagIds),
    picked:
      effective.documentIds.length > 0 ? countIn({ documentIds: [...effective.documentIds] }) : 0,
    everything: limited
      ? null
      : {
          documents: source.searchableCount(documentIds),
          leftOut:
            wallId === null ? source.folders().filter((folder) => folder.keepInside).length : 0,
        },
    inFront: front && {
      name: front.name,
      documents: source.searchableCount(frontIds),
      documentNames: source.searchableNames(frontIds ?? [], LISTED_FOLDER_DOCUMENTS),
    },
    choices: choices.slice(0, LISTED_FOLDERS),
    moreChoices: Math.max(0, choices.length - LISTED_FOLDERS),
  };
}
