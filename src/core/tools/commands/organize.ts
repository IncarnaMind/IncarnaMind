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
  Document,
  DocumentGroupAssignment,
  DocumentTag,
  LibraryGroup,
  TagLinkState,
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

type TagLink = Pick<DocumentTag, "source" | "confidence" | "needsReview">;

const tagLinksOf = (documents: readonly Document[]) =>
  new Map<string, Map<string, TagLink>>(
    documents.map((document) => [
      document.id,
      new Map(
        document.tags.map((tag) => [
          tag.tagId,
          { source: tag.source, confidence: tag.confidence, needsReview: tag.needsReview },
        ]),
      ),
    ]),
  );

const sameLink = (a: TagLink | null, b: TagLink | null) =>
  a === null || b === null
    ? a === b
    : a.source === b.source && a.confidence === b.confidence && a.needsReview === b.needsReview;

/** The Tag links to put back from `target` where the step left `left` and no later work moved them. */
const tagStates = (
  target: Map<string, Map<string, TagLink>>,
  left: Map<string, Map<string, TagLink>>,
  current: Map<string, Map<string, TagLink>>,
): TagLinkState[] => {
  const states: TagLinkState[] = [];
  for (const [documentId, leftLinks] of left) {
    const currentLinks = current.get(documentId) ?? new Map<string, TagLink>();
    const targetLinks = target.get(documentId) ?? new Map<string, TagLink>();
    for (const tagId of new Set([...leftLinks.keys(), ...targetLinks.keys()])) {
      if (!sameLink(currentLinks.get(tagId) ?? null, leftLinks.get(tagId) ?? null)) continue;
      const link = targetLinks.get(tagId) ?? null;
      if (sameLink(link, leftLinks.get(tagId) ?? null)) continue;
      states.push({ documentId, tagId, link });
    }
  }
  return states;
};

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
  const beforeTags = tagLinksOf(documents);
  return {
    ...inApp(
      "documents.organize",
      items,
      requested,
      async (_asking, signal) => {
        // Nothing to sort: no Folder is made or taken away for it.
        if (ids.length === 0) {
          return {
            done: { items: [] },
            step: null,
            said: "No Document is in no Folder, so Organize had nothing to sort.",
          };
        }
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
        let untouched = 0;
        try {
          ({ failed, untouched } = await host.organizeAtOnce(ids, signal));
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
        const afterTags = tagLinksOf(await core.listDocuments());
        const names = new Map(groups.map((group) => [group.id, group.name]));
        const counts = new Map<string, number>();
        for (const change of moved) {
          const folderId = change.after.assignment?.groupId ?? null;
          if (folderId !== null) counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
        }
        const parts = [...counts].map(
          ([folderId, count]) => `${count} in “${names.get(folderId) ?? ""}”`,
        );
        // What Organize reached and couldn't sort; the rest it never read, and they are as they
        // were when the run stopped.
        const unsorted = ids.length - untouched - moved.length;
        const reason =
          unsorted > 0
            ? unsortedReason(
                failed,
                ids.filter((id) => !movedIds.has(id)).flatMap((id) => after.get(id) ?? []),
              )
            : null;
        // A Folder Organize made but filed nothing in was never seen: it goes for good, not to
        // Recently deleted, and Redo must not bring it back.
        for (const folder of [...made]) {
          if (await holdsAny(core, folder.id)) continue;
          await unmake(core, "folder", folder.id);
          made.splice(made.indexOf(folder), 1);
        }
        /** The Folders Organize made that its Undo removed; Redo brings them back first. */
        const removed = new Set<string>();
        const removeMade = async () => {
          for (const folder of made) {
            if (removed.has(folder.id) || (await holdsAny(core, folder.id))) continue;
            await core.deleteLibraryGroup(folder.id);
            removed.add(folder.id);
          }
        };
        const madeSaid =
          made.length === 0
            ? ""
            : made.length === 1
              ? ` It made the Folder “${made[0]?.name ?? ""}”.`
              : ` It made ${made.length} Folders.`;
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
            ...(untouched > 0 && { untouched }),
            considered: ids.length,
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
                    const back = tagStates(
                      beforeTags,
                      afterTags,
                      tagLinksOf(await core.listDocuments()),
                    );
                    if (back.length > 0) await core.revertDocumentTags(back);
                    return null;
                  },
                  redo: async () => {
                    for (const folder of made) {
                      if (removed.has(folder.id)) {
                        await core.restore([{ kind: "folder", id: folder.id }]);
                        removed.delete(folder.id);
                      }
                    }
                    // File where the first run filed: Redo never asks the model again.
                    const targets = new Map<string | null, string[]>();
                    for (const [id, folderId] of Object.entries(checked)) {
                      targets.set(folderId, [...(targets.get(folderId) ?? []), id]);
                    }
                    for (const [folderId, moving] of targets) {
                      await core.moveToFolder({ documentIds: moving, folderId, wall: wallId });
                    }
                    const now = await assignmentsOf(core, ids);
                    for (const id of ids) left.set(id, stateOf(now.get(id)));
                    const again = tagStates(
                      afterTags,
                      beforeTags,
                      tagLinksOf(await core.listDocuments()),
                    );
                    if (again.length > 0) await core.revertDocumentTags(again);
                  },
                },
          said:
            moved.length === 0 && unsorted === 0 && untouched > 0
              ? `Organize stopped at “${reason ?? "a failure"}” before sorting any Document; the other ${plural(untouched, "Document")} stayed as they were.`
              : moved.length === 0
                ? `Organize sorted no Document: ${reason ?? "no Folder fitted"}${madeSaid}.`
                : `Organize filed ${plural(moved.length, "Document")}: ${parts.join(", ")}.${madeSaid}${unsorted > 0 ? ` ${plural(unsorted, "Document")} couldn't be sorted: ${reason ?? "no Folder fitted"}.` : ""}${untouched > 0 ? ` It stopped at “${reason ?? "a failure"}”; the other ${plural(untouched, "Document")} stayed as they were.` : ""} Name each Folder and its count in your reply, not a list under it.`,
        };
      },
      documents.length > 0 ? "organize" : null,
    ),
    changes: true,
  };
};
