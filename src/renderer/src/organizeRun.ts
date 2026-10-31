import { create } from "zustand";
import type {
  AssignmentChange,
  AssignmentState,
  DocumentGroupAssignment,
  DocumentTagging,
  LibraryGroup,
} from "../../core/api";
import { core } from "./core";
import { isShown } from "./layoutSlice";
import { useNotices } from "./notices";
import { useAppStore } from "./store";
import { type Undoable, useUndo } from "./undo";

const working = (item: DocumentGroupAssignment) =>
  item.status === "pending" || item.status === "classifying";

/** The Folder an assignment puts a Document in, and whether it only waits to be accepted. */
const placeOf = (
  item: Pick<DocumentGroupAssignment, "groupId" | "suggested"> | null | undefined,
) => (item ? `${item.groupId ?? ""}|${item.suggested}` : "");

/** A Document's place and tagging as a change found or left it. */
const stateOf = (
  item: DocumentGroupAssignment | undefined,
  tagging: DocumentTagging | null,
): AssignmentState => {
  if (!item) return { assignment: null, tagging };
  const { documentId: _id, tagging: _tagging, ...assignment } = item;
  return { assignment, tagging };
};

const taggingOf = (item: DocumentGroupAssignment | undefined) => item?.tagging ?? null;

let lastOrganize: Undoable | null = null;

/** The step Organize last put on the undo stack, which To review offers to undo while it is next. */
export const lastOrganizeStep = (): Undoable | null => lastOrganize;

/**
 * What Undo puts a Document back to: as it was before Organize, except that one Organize hadn't
 * finished with (waiting for a model, or queued) goes back with no assignment at all. Put back as
 * waiting it would show "Needs attention" with a model chosen, and be organized again at the next
 * start (#1391).
 */
const wasBefore = (
  before: ReadonlyMap<string, DocumentGroupAssignment>,
  id: string,
): DocumentGroupAssignment | undefined => {
  const item = before.get(id);
  return item && (working(item) || item.status === "waiting") ? undefined : item;
};

/** Whether anything is filed in a Folder: a Document, suggested or not, or a Note. */
const holdsAny = (folderId: string) => {
  const { library, minds } = useAppStore.getState();
  return (
    (library?.assignments ?? []).some((item) => item.groupId === folderId) ||
    minds.some((mind) => mind.folderId === folderId)
  );
};

/**
 * The Folders Organize made that nothing went into, moved to Recently deleted: their ids. Those
 * the User has put something in since are theirs, and stay.
 */
export async function removeEmpty(made: readonly LibraryGroup[]): Promise<string[]> {
  await useAppStore.getState().refreshLibrary();
  const live = new Set((useAppStore.getState().library?.groups ?? []).map((group) => group.id));
  const empty = made.filter((group) => live.has(group.id) && !holdsAny(group.id));
  for (const group of empty) await core.deleteLibraryGroup(group.id);
  if (empty.length > 0) await useAppStore.getState().refreshLibrary();
  return empty.map((group) => group.id);
}

/**
 * Says what Organize did once it has gone through `ids` (#763): how many
 * Documents got a Suggested Folder, with Undo, which puts each back as it was
 * (Tags it suggested stay, to accept or reject) and takes away the Folders it
 * `made` for them (#2308) that hold nothing else; Redo brings them back first.
 * Said nothing when it suggested none, and the Folders it made then go.
 */
export function sayWhenOrganized(
  ids: readonly string[],
  before: ReadonlyMap<string, DocumentGroupAssignment>,
  made: readonly LibraryGroup[] = [],
): void {
  const mine = new Set(ids);
  const itemsNow = () =>
    (useAppStore.getState().library?.assignments ?? []).filter((item) => mine.has(item.documentId));
  let unsubscribe = () => {};
  const finish = () => {
    unsubscribe();
    const changed = itemsNow().filter(
      (item) => item.suggested && placeOf(item) !== placeOf(wasBefore(before, item.documentId)),
    );
    if (changed.length === 0) {
      if (made.length > 0) {
        removeEmpty(made).then(
          () => useNotices.getState().confirm("library.organize.noneFit"),
          useAppStore.getState().reportError,
        );
      }
      return;
    }
    // Undo puts back these rows, and Redo does Organize's again: each hands the change back and
    // keeps the fresh one, so what it compares against is always what it left (#1928).
    const held = new Map<string, AssignmentChange>(
      changed.map((item) => {
        const taggingBefore = taggingOf(before.get(item.documentId));
        const taggingAfter = taggingOf(item);
        const taggingMoved = JSON.stringify(taggingBefore) !== JSON.stringify(taggingAfter);
        return [
          item.documentId,
          {
            documentId: item.documentId,
            before: stateOf(
              wasBefore(before, item.documentId),
              taggingMoved ? taggingBefore : null,
            ),
            after: stateOf(item, taggingMoved ? taggingAfter : null),
          },
        ];
      }),
    );
    const assignmentsNow = () =>
      new Map(
        (useAppStore.getState().library?.assignments ?? []).map((item) => [item.documentId, item]),
      );
    const flip = async () => {
      // A Document the User has moved since is theirs now: it stays where they put it.
      const now = assignmentsNow();
      const going = changed.flatMap((item) => {
        const change = held.get(item.documentId);
        return change && placeOf(now.get(item.documentId)) === placeOf(change.after.assignment)
          ? [{ documentId: item.documentId, change }]
          : [];
      });
      const fresh = await Promise.all(
        going.map(({ documentId, change }) =>
          core.restoreAssignment(documentId, change.before, change.after),
        ),
      );
      going.forEach(({ documentId }, at) => {
        const made = fresh[at];
        if (made) held.set(documentId, made);
        else held.delete(documentId);
      });
      await useAppStore.getState().refreshLibrary();
    };
    let removed: string[] = [];
    const step: Undoable = {
      said: (t) =>
        t(
          changed.length === 1
            ? "library.organize.done.one"
            : made.length > 1
              ? "library.organize.doneFolders"
              : "library.organize.done",
          { count: changed.length },
        ),
      name: (t) => t("undo.name.organize"),
      // From another tab, where To review isn't in sight.
      ...(!isShown(useAppStore.getState().layout, { kind: "library" }) && {
        also: {
          label: (t) => t("library.review.review"),
          testId: "undo-review",
          // The line has done its job once To review is open.
          run: () => {
            useUndo.getState().dismiss();
            useAppStore.getState().openLibrary("review");
          },
        },
      }),
      undo: async () => {
        await flip();
        if (made.length > 0) removed = await removeEmpty(made);
      },
      redo: async () => {
        if (removed.length > 0) {
          await core.restore(removed.map((id) => ({ kind: "folder" as const, id })));
          removed = [];
          await useAppStore.getState().refreshLibrary();
        }
        await flip();
      },
    };
    lastOrganize = step;
    useUndo.getState().push(step);
  };
  // A model that answers at once can organize them before this is called, so "nothing working"
  // alone doesn't mean there is nothing to say: the run is over once every Document is in the
  // Library, or gone from it, and none is working (#1391).
  const ended = () => {
    const items = itemsNow();
    if (items.some(working)) return false;
    const here = new Set(items.map((item) => item.documentId));
    const live = new Set(useAppStore.getState().documents.map((doc) => doc.id));
    return [...mine].every((id) => here.has(id) || !live.has(id));
  };
  if (ended()) {
    finish();
    return;
  }
  unsubscribe = useAppStore.subscribe(() => {
    if (ended()) finish();
  });
}

/** The Documents Organize was asked for with no model chosen: what the row under the head says it needs. */
export const useOrganizeAsk = create<{
  ids: readonly string[] | null;
  ask(ids: readonly string[]): void;
  close(): void;
}>()((set) => ({
  ids: null,
  ask: (ids) => set({ ids }),
  close: () => set({ ids: null }),
}));
