/**
 * Organize by what the Documents say (#1421): the Library's own Organize, on the Documents named
 * or found, or those in no Folder. With no Folder named, outside every wall, it plans them as the
 * Library's Organize does, at any size; with one named, proposed by name if there is none, or
 * inside a wall, it sorts each into the Folders it may choose. Nothing moves from the chat
 * (#1569): what it proposes waits in Suggestions, and the reply's Review button opens them. It
 * asks only before a cloud service first reads the Documents for it, and its Undo takes its
 * proposals back out. With no model chosen for Organize it takes the one the Library offers,
 * asks where the Library's card would (#1569), and keeps it as Organize's model; under a
 * standing no it only lends it for the run (#2252).
 */

import { translate } from "../../../shared/i18n";
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
import type { Language } from "../../language";
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

/**
 * What the model reads once Organize proposed (#1569): the app writes the proposals as the reply,
 * since models that narrated them wrote "filed" and "moved" of Documents that only wait. With
 * nothing else asked the turn ends there; whenever it goes on (more asked, or another call in the
 * same step), the model is told the same: leave organizing out.
 */
const LEAVE_ORGANIZING_OUT =
  "IncarnaMind has already shown the User what Organize proposed, in its own words. Your reply leaves organizing out entirely, as if it had not been asked: no word about Organize, Folders or where the Documents are.";
const proposalsShown = (alsoAsked: string | null) =>
  alsoAsked === null
    ? `${LEAVE_ORGANIZING_OUT} If the User asked for nothing else, write nothing.`
    : `${LEAVE_ORGANIZING_OUT} Answer the rest of the request, as its call put it: “${alsoAsked}”`;

/** What Organize proposed, as the reply says it in `language`: the app writes it, not the model. */
export function proposedText(
  language: Language,
  folders: readonly { name: string; count: number }[],
): string {
  const count = folders.reduce((sum, folder) => sum + folder.count, 0);
  const proposed = translate(language, "answer.commands.proposed", {
    folders: translate(
      language,
      folders.length === 1
        ? "answer.commands.proposed.folders.one"
        : "answer.commands.proposed.folders",
      { count: folders.length },
    ),
    documents: translate(
      language,
      count === 1 ? "organizeReview.documents.one" : "organizeReview.documents",
      { count },
    ),
    parts: folders
      .map((folder) =>
        translate(language, "answer.commands.proposed.part", {
          folder: folder.name,
          count: folder.count,
        }),
      )
      .join(translate(language, "answer.commands.proposed.separator")),
  });
  const wait = translate(
    language,
    count === 1 ? "answer.commands.proposed.wait.one" : "answer.commands.proposed.wait",
  );
  return language === "zh-CN" ? `${proposed}${wait}` : `${proposed} ${wait}`;
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
  // In Local mode nothing asks: the run itself says nothing went (#1569).
  const asks = route.where === "cloud" && !host.localOnly();
  const cloud = asks && flow?.consent !== "accepted" ? route.service : null;
  const cloudDeclined = asks && flow?.consent === "declined";
  /**
   * Runs with the pick as Organize's model: kept, as the Library's "Allow and organize" keeps it,
   * except under a standing no, where this Allow is for this run only and the model is lent.
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
        // A subfolder goes by its path, as the Review heads its card: "Contracts › Leases".
        const pathOf = (id: string | null): string[] => {
          const group = groupsNow.find((each) => each.id === id);
          return group ? [...pathOf(group.parentId), group.name] : [];
        };
        const proposedPathOf = (id: string): string[] => {
          const folder = review.folders.find((each) => each.id === id);
          if (!folder) return [];
          const parent =
            folder.parentNewFolderId === null
              ? pathOf(folder.parentId)
              : proposedPathOf(folder.parentNewFolderId);
          return [...parent, folder.name];
        };
        const counts = new Map<string, { name: string; count: number }>();
        for (const { placement } of placed) {
          const at =
            placement.kind === "folder"
              ? { id: placement.folderId, path: pathOf(placement.folderId) }
              : placement.kind === "newFolder"
                ? { id: placement.newFolderId, path: proposedPathOf(placement.newFolderId) }
                : null;
          if (!at) continue;
          const was = counts.get(at.id);
          counts.set(at.id, { name: at.path.join(" › "), count: (was?.count ?? 0) + 1 });
        }
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
              counts.has(named.id) && {
                into: { kind: "folder" as const, id: named.id, name: named.name, made: false },
              }),
            folders: [...counts.values()],
            ...(unsorted > 0 && { unsorted }),
            ...(untouched > 0 && { untouched }),
            considered: ids.length,
            review: { count: review.count },
            ...(input.alsoAsked !== null && { alsoAsked: input.alsoAsked }),
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
          ...(placed.length > 0 && input.alsoAsked === null && { ends: true as const }),
          said:
            placed.length === 0 && unsorted === 0 && untouched > 0
              ? `Organize stopped at “${reason ?? "a failure"}” before reading any Document; the other ${plural(untouched, "Document")} stayed as they were.`
              : placed.length === 0
                ? `Organize proposed no Folder for any Document: ${reason ?? "no Folder fitted"}. Nothing moved.`
                : proposalsShown(input.alsoAsked),
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
