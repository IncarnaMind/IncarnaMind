/**
 * Organize by what the Documents say (#1421): the Library's own Organize, on the Documents named
 * or found, or those in no Folder, with the Folder the request names among those it may choose,
 * made for it if there is none, and Folders proposed when there are none at all. The User asked,
 * so it asks once in place and then files them, the way Accept all does (#2252): one Undo puts
 * every Document back and takes away the Folders it made.
 */
import type {
  AssignmentChange,
  AssignmentState,
  DocumentGroupAssignment,
  LibraryGroup,
} from "../../api";
import { classifyProviderError } from "../../providers/providerErrors";
import {
  type Checker,
  type CommandsCore,
  documentItem,
  documentsOf,
  folderNamed,
  holdsAny,
  inApp,
  plural,
  unmake,
} from "./run";

/** What the Library's Organize hasn't finished with: Undo puts such a Document back with none. */
const unfinished = (item: DocumentGroupAssignment) =>
  item.status === "pending" || item.status === "classifying" || item.status === "waiting";

const stateOf = (item: DocumentGroupAssignment | undefined): AssignmentState => {
  if (!item) return { assignment: null, tagging: null };
  const { documentId: _id, tagging, ...assignment } = item;
  return { assignment, tagging: tagging ?? null };
};

/** As it was before Organize ran, except one it hadn't finished with, which goes back with none (#1391). */
const wasBefore = (item: DocumentGroupAssignment | undefined): AssignmentState =>
  item && !unfinished(item) ? stateOf(item) : { assignment: null, tagging: stateOf(item).tagging };

async function assignmentsOf(core: CommandsCore, ids: readonly string[]) {
  const { assignments } = await core.getLibrary();
  const wanted = new Set(ids);
  return new Map(
    assignments
      .filter((each) => wanted.has(each.documentId))
      .map((each) => [each.documentId, each]),
  );
}

/** The User's Documents in no Folder, as the Library's Organize sorts them; the examples never. */
async function inNoFolder(core: CommandsCore) {
  const [documents, { assignments }] = await Promise.all([core.listDocuments(), core.getLibrary()]);
  const filed = new Set(
    assignments.filter((each) => each.groupId !== null).map((each) => each.documentId),
  );
  const own = [];
  for (const document of documents) {
    if (!filed.has(document.id) && !(await core.isExampleDocument(document.id))) own.push(document);
  }
  return own;
}

/** What couldn't be sorted, in one line: the failure's own words, or the first Document's. */
function unsortedReason(
  failed: unknown,
  waiting: readonly DocumentGroupAssignment[],
): string | null {
  if (failed) return classifyProviderError(failed).message;
  for (const item of waiting) if (item.error) return item.error.message;
  return null;
}

export const organizeChecker: Checker = async (input, host, { wallId }) => {
  const { core } = host;
  const requested = input.folder;
  const documents =
    input.ids.length > 0 ? await documentsOf(core, input.ids) : await inNoFolder(core);
  const items = documents.map((each) => documentItem(each));
  const ids = documents.map((each) => each.id);
  return {
    ...inApp(
      "documents.organize",
      items,
      requested,
      async (_asking, signal) => {
        const before = await assignmentsOf(core, ids);
        const made: LibraryGroup[] = [];
        let named: LibraryGroup | null = null;
        if (requested !== null) {
          const { folder, made: created } = await folderNamed(core, requested, input.about ?? "");
          named = folder;
          if (created) made.push(folder);
        } else if ((await core.getLibrary()).groups.length === 0) {
          made.push(...(await core.proposeFolders(ids)));
        }
        let failed: unknown | null = null;
        try {
          ({ failed } = await host.organizeAtOnce(ids, signal));
        } catch (error) {
          for (const folder of made) {
            if (!(await holdsAny(core, folder.id))) await unmake(core, "folder", folder.id);
          }
          throw error;
        }
        const after = await assignmentsOf(core, ids);
        const waiting = [...after.values()].filter((item) => item.suggested);
        const suggested = waiting.map((item) => item.documentId);
        // The Folder each was checked against goes with the accept, so the wall is judged at the
        // filing as the window's Accept all does (#2250).
        const checked = Object.fromEntries(
          waiting.map((item) => [item.documentId, item.groupId ?? null]),
        );
        let moved: AssignmentChange[] = [];
        try {
          if (suggested.length > 0)
            moved = await core.acceptAssignments(suggested, checked, wallId);
        } catch (error) {
          for (const folder of made) {
            if (!(await holdsAny(core, folder.id))) await unmake(core, "folder", folder.id);
          }
          throw error;
        }
        const movedIds = new Set(moved.map((change) => change.documentId));
        const left = new Map<string, AssignmentState>();
        for (const id of ids) left.set(id, stateOf(after.get(id)));
        for (const change of moved) left.set(change.documentId, change.after);
        const { groups } = await core.getLibrary();
        const names = new Map(groups.map((group) => [group.id, group.name]));
        const counts = new Map<string, number>();
        for (const change of moved) {
          const folderId = change.after.assignment?.groupId ?? null;
          if (folderId !== null) counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
        }
        const parts = [...counts].map(
          ([folderId, count]) => `${count} in “${names.get(folderId) ?? ""}”`,
        );
        const unsorted = ids.length - moved.length;
        const reason =
          unsorted > 0
            ? unsortedReason(
                failed,
                ids.filter((id) => !movedIds.has(id)).flatMap((id) => after.get(id) ?? []),
              )
            : null;
        /** The Folders Organize made that its Undo removed; Redo brings them back first. */
        const removed = new Set<string>();
        const removeMade = async () => {
          for (const folder of made) {
            if (removed.has(folder.id) || (await holdsAny(core, folder.id))) continue;
            await core.deleteLibraryGroup(folder.id);
            removed.add(folder.id);
          }
        };
        await removeMade();
        const kept = made.filter((folder) => !removed.has(folder.id));
        const madeSaid =
          kept.length === 0
            ? ""
            : kept.length === 1
              ? ` It made the Folder “${kept[0]?.name ?? ""}”.`
              : ` It made ${kept.length} Folders.`;
        const never = new AbortController().signal;
        return {
          done: {
            items: moved.map((change) => {
              const document = documents.find((each) => each.id === change.documentId);
              return document
                ? documentItem(document)
                : { kind: "document" as const, id: change.documentId, name: change.documentId };
            }),
            ...(named !== null &&
              counts.has(named.id) && {
                into: {
                  kind: "folder" as const,
                  id: named.id,
                  name: named.name,
                  made: made.some((folder) => folder.id === named?.id),
                },
              }),
            folders: [...counts].map(([folderId, count]) => ({
              name: names.get(folderId) ?? "",
              count,
            })),
            ...(unsorted > 0 && { unsorted }),
          },
          step:
            moved.length === 0
              ? null
              : {
                  undo: async () => {
                    const now = await assignmentsOf(core, ids);
                    for (const id of ids) {
                      await core.restoreAssignment(
                        id,
                        wasBefore(before.get(id)),
                        left.get(id) ?? stateOf(now.get(id)),
                      );
                    }
                    await removeMade();
                    return null;
                  },
                  redo: async () => {
                    for (const folder of made) {
                      if (removed.has(folder.id)) {
                        await core.restore([{ kind: "folder", id: folder.id }]);
                        removed.delete(folder.id);
                      }
                    }
                    await host.organizeAtOnce(ids, never);
                    const again = await assignmentsOf(core, ids);
                    const waiting = [...again.values()].filter((item) => item.suggested);
                    if (waiting.length > 0) {
                      await core.acceptAssignments(
                        waiting.map((item) => item.documentId),
                        Object.fromEntries(waiting.map((item) => [item.documentId, item.groupId])),
                        wallId,
                      );
                    }
                  },
                },
          said:
            ids.length === 0
              ? "No Document is in no Folder, so Organize had nothing to sort."
              : moved.length === 0
                ? `Organize sorted no Document: ${reason ?? "no Folder fitted"}${madeSaid}.`
                : `Organize filed ${plural(moved.length, "Document")}: ${parts.join(", ")}.${madeSaid}${unsorted > 0 ? ` ${plural(unsorted, "Document")} couldn't be sorted: ${reason ?? "no Folder fitted"}.` : ""} Name each Folder and its count in your reply, not a list under it.`,
        };
      },
      documents.length > 0 ? "organize" : null,
    ),
    changes: true,
  };
};
