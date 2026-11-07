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
  /** How many more Folders, and Tags, the scope names past the ones listed. */
  moreFolders: number;
  moreTags: number;
  /** Documents picked one by one. */
  picked: number;
  /** With no limit: the Documents searched, and the Folders the User keeps apart that are left out. */
  everything: { documents: number; leftOut: number } | null;
  /** The Folder in front, when the scope doesn't name it: the Note's, or the Library's with no Note. */
  inFront: (Named & { documentNames: readonly string[]; kind: "note" | "library" }) | null;
  /** The Folders there are, when the scope names nothing and nothing is in front: all Documents are searched. */
  choices: readonly Named[];
  /** How many Folders `choices` leaves out for want of room. */
  moreChoices: number;
}

/** The most Folders, and the most of a Folder's Documents, one line names. */
export const LISTED_FOLDERS = 10;
export const LISTED_FOLDER_DOCUMENTS = 10;

const documentsOf = (count: number) => `${count} Document${count === 1 ? "" : "s"}`;
const quoted = (name: string) => `"${listedName(name).replace(/"/g, "'")}"`;
const counted = ({ name, documents }: Named) => `${quoted(name)} (${documentsOf(documents)})`;

/**
 * Whether a scope is exactly one wall's Folders, picked alone: the search then
 * reads inside that wall, and the line names those Folders rather than leaving them out.
 */
export function explicitWalledFolderScope(
  scope: SearchScope,
  mindId: string | null,
  walledFolderId: (folderId: string | null) => string | null,
): boolean {
  if (mindId !== null || scope.tagIds.length > 0 || scope.documentIds.length > 0) return false;
  if (scope.folderIds.length === 0) return false;
  const walls = new Set(scope.folderIds.map((id) => walledFolderId(id)));
  return walls.size === 1 && !walls.has(null);
}

/** The lines before the Question that name the scope and the Folder in front; "" when nothing is known. */
export function scopeLines(naming: ScopeNaming): string {
  const lines: string[] = [];
  const parts = [
    ...naming.folders.map((each) => `the Folder ${counted(each)}`),
    ...(naming.moreFolders > 0 ? [`and ${naming.moreFolders} more Folders`] : []),
    ...naming.tags.map((each) => `the Tag ${counted(each)}`),
    ...(naming.moreTags > 0 ? [`and ${naming.moreTags} more Tags`] : []),
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
    const { documents, documentNames, kind } = naming.inFront;
    const more = documents - documentNames.length;
    const listed =
      documentNames.length > 0
        ? `: ${documentNames.map(quoted).join(", ")}${more > 0 ? `, and ${more} more` : ""}`
        : "";
    const front =
      kind === "note"
        ? `The Note in front is in the Folder ${quoted(naming.inFront.name)}`
        : `The Library is open in the Folder ${quoted(naming.inFront.name)}`;
    lines.push(`${front} (${documentsOf(documents)}${listed})`);
  } else if (naming.choices.length > 0) {
    const more = naming.moreChoices > 0 ? `, and ${naming.moreChoices} more` : "";
    lines.push(`The User's Folders: ${naming.choices.map(counted).join(", ")}${more}`);
  }
  return lines.join("\n");
}

/** Told once in the instructions: how the lines above read, and what a Folder the User points at without naming is. */
export const SEARCH_SCOPE_RULE = [
  'A line "Search scope: …" before the Question names what the User limited it to, as the scope chip in their composer shows it, with how many Documents each Folder or Tag holds in brackets. "All Documents · 2 Folders left out" is every Document except those in 2 Folders the User keeps apart: they are not searched, and you never name them. "The Note in front is in the Folder …" names the Folder of the Note the User is in, with its first Documents; "The Library is open in the Folder …" names the Folder the Library shows when no Note is, with its first Documents. "The User\'s Folders: …" lists their Folders when neither names one.',
  '- When the User points at a Folder without naming it ("this folder", "这个文件夹" and the like), or asks what is in the place in front, it is the one Folder the Search scope names; else the Folder the Note in front is in, or the Folder the Library is open in; else the one Folder in "The User\'s Folders". Do what they asked with that Folder\'s Documents at once, and never ask which Folder it is. Say in your reply which Folder you took, by name.',
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
  /** The Folder the Library is open on when there is no Note (#2529); null: none. */
  folderInFront: string | null;
}

/**
 * Names the scope of a Question as its chip shows it. A Folder behind a wall is named only to
 * work behind that same wall: outside it the scope's walled Folders are left out as the search
 * leaves them, unless the Question has no Note and the scope is those Folders alone, which the
 * search reads inside the wall. The Folder in front is the Note's, or the Library's with no Note,
 * and is named only when the scope is not limited, which is when its Documents can be searched.
 */
export function nameScope(
  { scope, mindId, wallId, documentIds, folderInFront }: AskedScope,
  source: ScopeSource,
): ScopeNaming {
  const fromLibrary = folderInFront !== null && mindId === null;
  const effective = wallId !== null && !fromLibrary ? folderScope(wallId) : (scope ?? NO_SCOPE);
  const countIn = (part: Partial<SearchScope>) =>
    source.searchableCount(source.resolveScope({ ...NO_SCOPE, ...part }, mindId));
  const explicitFolderScope = explicitWalledFolderScope(scope ?? NO_SCOPE, mindId, (id) =>
    source.walledFolderId(id),
  );
  const named = (kind: "folder" | "tag", ids: readonly string[]) =>
    ids.flatMap((id) => {
      if (
        kind === "folder" &&
        wallId === null &&
        !explicitFolderScope &&
        source.walledFolderId(id) !== null
      )
        return [];
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
  const allFolders = named("folder", effective.folderIds);
  const allTags = named("tag", effective.tagIds);
  const folders = allFolders.slice(0, LISTED_FOLDERS);
  const tags = allTags.slice(0, LISTED_FOLDERS);
  const limited = hasSearchScope(effective);
  const own = wallId !== null ? null : mindId !== null ? source.mindFolder(mindId) : folderInFront;
  const ownName =
    own === null || source.walledFolderId(own) !== null ? null : source.itemName("folder", own);
  const front =
    !limited && own !== null && ownName !== null && !allFolders.some((each) => each.id === own)
      ? { id: own, name: ownName, kind: mindId !== null ? ("note" as const) : ("library" as const) }
      : null;
  const frontIds = front ? source.resolveScope(folderScope(front.id), mindId) : null;
  const frontWalled = own !== null && source.walledFolderId(own) !== null;
  const choices =
    limited || allFolders.length > 0 || front || wallId !== null || frontWalled
      ? []
      : source
          .folders()
          .filter((folder) => source.walledFolderId(folder.id) === null)
          .map((folder) => ({ name: folder.name, documents: countIn({ folderIds: [folder.id] }) }))
          .filter((folder) => folder.documents > 0);
  return {
    folders,
    tags,
    moreFolders: Math.max(0, allFolders.length - LISTED_FOLDERS),
    moreTags: Math.max(0, allTags.length - LISTED_FOLDERS),
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
      kind: front.kind,
      documents: source.searchableCount(frontIds),
      documentNames: source.searchableNames(frontIds ?? [], LISTED_FOLDER_DOCUMENTS),
    },
    choices: choices.slice(0, LISTED_FOLDERS),
    moreChoices: Math.max(0, choices.length - LISTED_FOLDERS),
  };
}
