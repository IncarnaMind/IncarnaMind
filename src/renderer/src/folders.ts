import type { Folder } from "../../core/api";

/** The parts of a Folder the tree reads: one of a Linked folder's Folders, or an in-app Folder. */
export interface TreeFolder {
  id: string;
  name: string;
  parentId: string | null;
}

/** A Folder in the tree, with its sub-Folders. */
export interface FolderNode<T extends TreeFolder = Folder> {
  folder: T;
  /** 0 at the top level. */
  depth: number;
  children: FolderNode<T>[];
}

/**
 * Builds the tree from the core's flat list, keeping its order among siblings.
 * A Folder whose parent isn't in the list shows at the top level.
 */
export function buildFolderTree<T extends TreeFolder>(folders: readonly T[]): FolderNode<T>[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const children = new Map<string | null, T[]>();
  for (const folder of folders) {
    const parentId = folder.parentId !== null && byId.has(folder.parentId) ? folder.parentId : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(folder);
    children.set(parentId, siblings);
  }
  const build = (parentId: string | null, depth: number): FolderNode<T>[] =>
    (children.get(parentId) ?? []).map((folder) => ({
      folder,
      depth,
      children: build(folder.id, depth + 1),
    }));
  return build(null, 0);
}

/** Every Folder in the tree, depth first: the order an indented list shows them in. */
export function flattenFolderTree<T extends TreeFolder>(
  nodes: readonly FolderNode<T>[],
): FolderNode<T>[] {
  return nodes.flatMap((node) => [node, ...flattenFolderTree(node.children)]);
}

/** The Folder and the Folders it is inside, outermost first. */
export function folderChain<T extends TreeFolder>(folders: readonly T[], id: string | null): T[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const chain: T[] = [];
  const seen = new Set<string>();
  let at = id === null ? undefined : byId.get(id);
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    chain.unshift(at);
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }
  return chain;
}

/** A Folder's names, outermost first and its own last: "Thesis › Chapter 2". */
export function folderPath(folders: readonly TreeFolder[], id: string | null): string[] {
  return folderChain(folders, id).map((folder) => folder.name);
}

/** "Thesis › Chapter 2", as a Folder named outside its tree shows its place. */
export function folderPathLabel(folders: readonly TreeFolder[], id: string | null): string {
  return folderPath(folders, id).join(" › ");
}

/** Whether this Folder is that Folder, or one inside it. */
export function isInsideFolder(
  folders: readonly TreeFolder[],
  id: string,
  ancestorId: string,
): boolean {
  return folderChain(folders, id).some((folder) => folder.id === ancestorId);
}

/** The Folder keeping its work inside it that this Folder is inside, or is; null outside every wall. */
export function folderWallOf<T extends TreeFolder & { keepInside?: boolean }>(
  folders: readonly T[],
  id: string,
): string | null {
  return folderChain(folders, id).find((folder) => folder.keepInside === true)?.id ?? null;
}
