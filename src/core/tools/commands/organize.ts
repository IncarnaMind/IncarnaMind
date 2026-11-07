/**
 * Organize by what the Documents say (#1421): the Library's own Organize, on the Documents named
 * or found, or those in no Folder. With no Folder named, outside every wall, it plans them as the
 * Library's Organize does, at any size; with one named, proposed by name if there is none, or
 * inside a wall, it sorts each into the Folders it may choose. Nothing moves from the chat
 * (#1569): what it proposes waits in Suggestions, and the reply's Review button opens them. It
 * asks only before a cloud service first reads the Documents for it, and its Undo takes its
 * proposals back out. With no model chosen for Organize it takes the one the
 * Library offers as "Use {company}", asks where that Library question would, and keeps it as
 * Organize's model; under a standing no it only lends it for the run (#2252).
 */
import type {
  Document,
  DocumentGroupAssignment,
  DocumentTag,
  LibraryGroup,
  OrganizeLibraryResult,
  OrganizeReviewChange,
  OrganizeReviewItem,
  RunEstimate,
  TagLinkChange,
  TagLinkState,
} from "../../api";
import { classifyProviderError } from "../../providers/providerErrors";
import {
  type CheckedCommand,
  type Checker,
  type CommandsCore,
  documentItem,
  documentsOf,
  inApp,
  plural,
  same,
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

const decisionsOf = (rows: readonly { documentId: string; tagIds: string[] }[]) =>
  new Map(rows.map((row) => [row.documentId, new Set(row.tagIds)]));

const sameLink = (a: TagLink | null, b: TagLink | null) =>
  a === null || b === null
    ? a === b
    : a.source === b.source && a.confidence === b.confidence && a.needsReview === b.needsReview;

/** Puts each Tag link Organize changed back to `to`, where it is still as `from` and the User hasn't decided on it. */
async function revertTags(
  core: CommandsCore,
  ids: readonly string[],
  changes: readonly TagLinkChange[],
  direction: "back" | "again",
): Promise<void> {
  const documents = await core.listDocuments();
  const live = new Set(documents.map((each) => each.id));
  const liveTags = new Set((await core.listTags()).map((each) => each.id));
  const decided = decisionsOf(await core.listDocumentTagDecisions([...ids]));
  const linksNow = tagLinksOf(documents.filter((each) => ids.includes(each.id)));
  const links: TagLinkState[] = [];
  for (const change of changes) {
    if (!live.has(change.documentId) || !liveTags.has(change.tagId)) continue;
    if (decided.get(change.documentId)?.has(change.tagId)) continue;
    const from = direction === "back" ? change.after : change.before;
    const to = direction === "back" ? change.before : change.after;
    const nowLink = linksNow.get(change.documentId)?.get(change.tagId) ?? null;
    if (!sameLink(nowLink, from)) continue;
    links.push({ documentId: change.documentId, tagId: change.tagId, link: to });
  }
  if (links.length > 0) await core.revertDocumentTags(links);
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

/** What couldn't be placed, in one line: the failure's own words, or the first Document's. */
function unsortedReason(
  failed: unknown,
  waiting: readonly DocumentGroupAssignment[],
): string | null {
  if (failed) return classifyProviderError(failed).message;
  for (const item of waiting) if (item.error) return item.error.message;
  return null;
}

/** Why the plan left Documents out, when it is more than that no Folder fitted them. */
function leftOutReason(items: readonly OrganizeReviewItem[]): string | null {
  for (const { placement } of items) {
    if (placement.kind !== "leftOut") continue;
    if (placement.leftOut?.reason === "unreachable")
      return `${placement.leftOut.service} couldn't be reached`;
    if (placement.leftOut?.reason === "noText") return "no text to read";
  }
  return null;
}

/** What the model is told of a plan that would cost more than IncarnaMind spends unshown. */
function costSaid(count: number, estimate: RunEstimate): string {
  const cost = estimate.billing === "per-token" ? estimate.cost : null;
  const amount = cost
    ? `about ${cost.amount.toFixed(2)} ${cost.currency}`
    : "more than 1 US dollar";
  return `Organizing ${plural(count, "Document")} would cost ${amount} on the Organize model, so nothing was sent and nothing was proposed. Tell the User they can start Organize from the Library, which shows the cost before it runs.`;
}

export const organizeChecker: Checker = async (input, host, { wallId }) => {
  const { core } = host;
  const requested = input.folder;
  const documents =
    input.ids.length > 0 ? await documentsOf(core, input.ids) : await inNoFolder(core);
  const items = documents.map((each) => documentItem(each));
  const ids = documents.map((each) => each.id);
  const picked = ids.length > 0 ? await host.offeredOrganizeModel() : null;
  const route =
    ids.length === 0
      ? { where: "none" as const }
      : (picked?.route ?? (await core.getTaggingRoute("classification")));
  const flow =
    route.where === "cloud"
      ? (await core.listDataFlows()).find(
          (each) => each.flow.id === "classification" && each.flow.service.id === route.service.id,
        )
      : null;
  const cloud = route.where === "cloud" && flow?.consent !== "accepted" ? route.service : null;
  const cloudDeclined = route.where === "cloud" && flow?.consent === "declined";
  /**
   * Runs with the pick as Organize's model: kept, as the Library keeps "Use {company}", except
   * under a standing no, where this Allow is for this run only and the model is lent, not kept.
   */
  const withPick =
    (run: CheckedCommand["run"]): CheckedCommand["run"] =>
    async (asking, signal, permit) => {
      if (!picked) return run(asking, signal, permit);
      if (!cloudDeclined) {
        await host.keepOrganizeModel(picked.classifier);
        return run(asking, signal, permit);
      }
      const giveBack = host.lendOrganizeModel(picked.classifier);
      try {
        return await run(asking, signal, permit);
      } finally {
        giveBack();
      }
    };
  return {
    ...inApp(
      "documents.organize",
      items,
      requested,
      withPick(async (_asking, signal, permit) => {
        if (ids.length === 0) {
          return {
            done: { items: [] },
            step: null,
            said: "No Document is in no Folder, so Organize had nothing to sort.",
          };
        }
        const runId = crypto.randomUUID();
        const proposed: string[] = [];
        let named: LibraryGroup | null = null;
        if (requested !== null) {
          const { groups } = await core.getLibrary();
          named = groups.find((group) => same(group.name, requested)) ?? null;
          const folder = named ? null : host.proposeFolder(requested, input.about ?? "");
          if (folder) proposed.push(folder.id);
        }
        const waitingBefore = new Set(
          (await core.getOrganizeReview()).items.map((item) => item.id),
        );
        let planned: OrganizeLibraryResult | null = null;
        let failed: unknown | null = null;
        let untouched = 0;
        let tagChanges: TagLinkChange[] = [];
        try {
          if (requested === null && wallId === null)
            planned = await host.organizeByPlan(ids, signal, permit, runId);
          if (planned === null)
            ({ failed, untouched, tagChanges } = await host.organizeAtOnce(
              ids,
              signal,
              wallId,
              permit,
              runId,
            ));
        } catch (error) {
          host.withdrawOrganizeRun(runId, proposed);
          throw error;
        }
        if (planned?.status === "estimate")
          return { done: { items: [] }, step: null, said: costSaid(ids.length, planned.estimate) };
        if (planned?.status === "stopped")
          return {
            done: { items: [] },
            step: null,
            said: "Organize stopped before it proposed anything. Nothing moved.",
          };
        const review = await core.getOrganizeReview();
        const wanted = new Set(ids);
        const fresh = review.items.filter(
          (item) => wanted.has(item.documentId) && !waitingBefore.has(item.id),
        );
        const placed = fresh.filter(
          (item) => item.placement.kind === "folder" || item.placement.kind === "newFolder",
        );
        // A Folder it proposed that nothing went into was never seen: it goes at once.
        const used = new Set(
          placed.flatMap((item) =>
            item.placement.kind === "newFolder" ? [item.placement.newFolderId] : [],
          ),
        );
        host.withdrawOrganizeRun(
          null,
          proposed.filter((id) => !used.has(id)),
        );
        // The Folders the plan proposed, and their proposed parents, go with its Undo.
        if (planned) {
          const parents = new Map(
            review.folders.map((folder) => [folder.id, folder.parentNewFolderId]),
          );
          for (const id of used)
            for (let at: string | null | undefined = id; at; at = parents.get(at))
              proposed.push(at);
        }
        const { groups: groupsNow } = await core.getLibrary();
        const nameOf = (item: OrganizeReviewItem) => {
          const { placement } = item;
          if (placement.kind === "folder")
            return {
              name: groupsNow.find((group) => group.id === placement.folderId)?.name ?? "",
              made: false,
            };
          if (placement.kind === "newFolder")
            return {
              name:
                review.folders.find((folder) => folder.id === placement.newFolderId)?.name ?? "",
              made: true,
            };
          return null;
        };
        const counts = new Map<string, { count: number; made: boolean }>();
        for (const item of placed) {
          const folder = nameOf(item);
          if (!folder) continue;
          const was = counts.get(folder.name);
          counts.set(folder.name, { count: (was?.count ?? 0) + 1, made: folder.made });
        }
        const parts = [...counts].map(([name, { count, made }]) =>
          made ? `${count} for the new Folder “${name}”` : `${count} for “${name}”`,
        );
        // What Organize reached and couldn't place; the rest it never read.
        const unsorted = ids.length - untouched - placed.length;
        const placedIds = new Set(placed.map((item) => item.documentId));
        const { assignments } = await core.getLibrary();
        const reason =
          unsorted === 0
            ? null
            : planned
              ? leftOutReason(fresh)
              : unsortedReason(
                  failed,
                  assignments.filter(
                    (each) => wanted.has(each.documentId) && !placedIds.has(each.documentId),
                  ),
                );
        let withdrawn: OrganizeReviewChange | null = null;
        return {
          done: {
            items: placed.map((item) => {
              const document = documents.find((each) => each.id === item.documentId);
              return document
                ? documentItem(document)
                : { kind: "document" as const, id: item.documentId, name: item.documentId };
            }),
            ...(named !== null &&
              counts.has(named.name) && {
                into: { kind: "folder" as const, id: named.id, name: named.name, made: false },
              }),
            folders: [...counts].map(([name, { count }]) => ({ name, count })),
            ...(unsorted > 0 && { unsorted }),
            ...(untouched > 0 && { untouched }),
            considered: ids.length,
            review: { count: review.count },
          },
          step:
            placed.length === 0 && tagChanges.length === 0
              ? null
              : {
                  undo: async () => {
                    withdrawn = host.withdrawOrganizeRun(runId, proposed);
                    await revertTags(core, ids, tagChanges, "back");
                    return null;
                  },
                  redo: async () => {
                    // Its proposals come back as they were: Redo never asks the model again.
                    if (withdrawn)
                      await core.restoreOrganizeReview(withdrawn.before, withdrawn.after);
                    withdrawn = null;
                    await revertTags(core, ids, tagChanges, "again");
                  },
                },
          said:
            placed.length === 0 && unsorted === 0 && untouched > 0
              ? `Organize stopped at “${reason ?? "a failure"}” before reading any Document; the other ${plural(untouched, "Document")} stayed as they were.`
              : placed.length === 0
                ? `Organize proposed no Folder for any Document: ${reason ?? "no Folder fitted"}. Nothing moved.`
                : `Organize proposed Folders for ${plural(placed.length, "Document")}: ${parts.join(", ")}. These are only proposals: no Document has moved or been filed, and no Folder has been made. They wait in Suggested Folders, ${plural(review.count, "Document")} in all, until the User confirms them with Review.${unsorted > 0 ? ` ${plural(unsorted, "Document")} got no Folder: ${reason ?? "no Folder fitted"}.` : ""}${untouched > 0 ? ` It stopped at “${reason ?? "a failure"}”; the other ${plural(untouched, "Document")} stayed as they were.` : ""} In your reply, name each proposed Folder with its count in a sentence, not a list under it, and say that nothing moves until the User reviews and confirms them. Never say a Document was moved, filed or put into a Folder.`,
        };
      }),
      documents.length > 0 ? "organize" : null,
    ),
    // Proposals move nothing, so they count towards no limit on the Answer's changes.
    changes: false,
    ...(cloud && { cloud }),
    ...(cloudDeclined && { cloudDeclined: true }),
  };
};
