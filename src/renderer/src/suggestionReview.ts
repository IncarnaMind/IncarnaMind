import type { AssignmentChange, DocumentGroupAssignment } from "../../core/api";
import { displayName } from "../../shared/documentNames";
import { core } from "./core";
import { applyAssignments } from "./documentUpdates";
import { useAppStore } from "./store";
import { makeInTurn, type Undoable, useUndo } from "./undo";

type Decision = "accept" | "reject";

/** What a step leaves a Document as, so that Undo spares one the User has changed since. */
const placeOf = (item: DocumentGroupAssignment | undefined) =>
  item ? `${item.groupId ?? ""}|${item.source}|${item.suggested}` : "";

const assignmentsNow = () =>
  new Map(
    (useAppStore.getState().library?.assignments ?? []).map((item) => [item.documentId, item]),
  );

export const waitingIds = (): string[] =>
  (useAppStore.getState().library?.assignments ?? []).flatMap((item) =>
    item.suggested && item.groupId !== null ? [item.documentId] : [],
  );

/**
 * Organize couldn't sort the Document: it ran, placed it in no Folder, and failed. A restored
 * assignment may keep that state with no error saved; it still shows, with a reason of its own.
 */
export const isNotSorted = (
  item: Pick<DocumentGroupAssignment, "status" | "groupId"> | undefined,
): boolean => item?.status === "failed" && item.groupId === null;

/** Whether Organize left a Document it couldn't sort, which To review shows with the reason. */
export const hasNotSorted = (): boolean =>
  (useAppStore.getState().library?.assignments ?? []).some((item) => isNotSorted(item));

function showDecided(decision: Decision, ids: readonly string[]): void {
  const now = assignmentsNow();
  const changed = new Map(
    ids.flatMap((id) => {
      const item = now.get(id);
      if (!item?.suggested) return [];
      const decided: DocumentGroupAssignment =
        decision === "accept"
          ? { ...item, source: "user", suggested: false }
          : { ...item, groupId: null, suggested: false };
      return [[id, decided] as const];
    }),
  );
  useAppStore.setState((state) => ({
    ...(state.library && { library: applyAssignments(state.library, changed) }),
  }));
}

async function apply(decision: Decision, ids: readonly string[]): Promise<AssignmentChange[]> {
  showDecided(decision, ids);
  try {
    return decision === "accept"
      ? await core.acceptAssignments([...ids])
      : await core.rejectAssignments([...ids]);
  } catch (error) {
    await useAppStore.getState().refreshLibrary();
    throw error;
  }
}

function stepOf(
  decision: Decision,
  changes: readonly AssignmentChange[],
  said: Undoable["said"],
): Undoable {
  return {
    said,
    name: (t) => t(decision === "accept" ? "undo.name.accept" : "undo.name.reject"),
    async undo() {
      const now = assignmentsNow();
      // A Document the User has moved since is theirs now: it stays where they put it.
      const mine = changes.filter(
        (each) => placeOf(now.get(each.after.documentId)) === placeOf(each.after),
      );
      await Promise.all(
        mine.map(({ before: { documentId, ...previous } }) =>
          core.restoreAssignment(documentId, previous),
        ),
      );
      await useAppStore.getState().refreshLibrary();
    },
    async redo() {
      const now = assignmentsNow();
      const mine = changes.filter(
        (each) => placeOf(now.get(each.before.documentId)) === placeOf(each.before),
      );
      if (mine.length === 0) return;
      await apply(
        decision,
        mine.map((each) => each.before.documentId),
      );
    },
  };
}

// A ⌘Z pressed while it runs waits for it, then takes it back.
const decide = (decision: Decision, ids: readonly string[]): Promise<Undoable | null> =>
  makeInTurn(() => decideNow(decision, ids));

async function decideNow(decision: Decision, ids: readonly string[]): Promise<Undoable | null> {
  const waiting = new Set(waitingIds());
  const chosen = [...new Set(ids)].filter((id) => waiting.has(id));
  if (chosen.length === 0) return null;
  const { documents, library } = useAppStore.getState();
  // Kept as the words the line says, not the lists they came from: the undo stack lasts the session.
  const only = chosen.length === 1 ? documents.find((each) => each.id === chosen[0]) : undefined;
  const name = only ? displayName(only) : "";
  const folderId = only ? assignmentsNow().get(only.id)?.groupId : null;
  const folder = library?.groups.find((each) => each.id === folderId)?.name ?? "";
  const changes = await apply(decision, chosen);
  if (changes.length === 0) {
    await useAppStore.getState().refreshLibrary();
    return null;
  }
  const count = changes.length;
  const one = count === 1 && only !== undefined;
  const said: Undoable["said"] =
    decision === "accept"
      ? (t) =>
          one ? t("library.review.accepted.one", { name }) : t("library.review.accepted", { count })
      : (t) =>
          one
            ? t("library.review.rejected.one", { name, folder })
            : t("library.review.rejected", { count });
  const step = stepOf(decision, changes, said);
  useUndo.getState().push(step);
  return step;
}

export const acceptSuggestions = (ids: readonly string[]) => decide("accept", ids);

export const rejectSuggestions = (ids: readonly string[]) => decide("reject", ids);
