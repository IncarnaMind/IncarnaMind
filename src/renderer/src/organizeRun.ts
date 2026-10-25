import { create } from "zustand";
import type { DocumentGroupAssignment } from "../../core/api";
import { core } from "./core";
import { isShown } from "./layoutSlice";
import { useAppStore } from "./store";
import { type Undoable, useUndo } from "./undo";

const working = (item: DocumentGroupAssignment) =>
  item.status === "pending" || item.status === "classifying";

/** The Folder an assignment puts a Document in, and whether it only waits to be accepted. */
const placeOf = (item: DocumentGroupAssignment | undefined) =>
  item ? `${item.groupId ?? ""}|${item.suggested}` : "";

let lastOrganize: Undoable | null = null;

/** The step Organize last put on the undo stack, which To review offers to undo while it is next. */
export const lastOrganizeStep = (): Undoable | null => lastOrganize;

/**
 * Says what Organize did once it has gone through `ids` (#763): how many
 * Documents got a Suggested Folder, with Undo, which puts each back as it was
 * (Tags it suggested stay, to accept or reject). Said nothing when it
 * suggested none.
 */
export function sayWhenOrganized(
  ids: readonly string[],
  before: ReadonlyMap<string, DocumentGroupAssignment>,
): void {
  const mine = new Set(ids);
  const itemsNow = () =>
    (useAppStore.getState().library?.assignments ?? []).filter((item) => mine.has(item.documentId));
  let unsubscribe = () => {};
  const finish = () => {
    unsubscribe();
    const changed = itemsNow().filter(
      (item) => item.suggested && placeOf(item) !== placeOf(before.get(item.documentId)),
    );
    if (changed.length === 0) return;
    const stays = (now: ReadonlyMap<string, DocumentGroupAssignment>, wanted: "undone" | "done") =>
      changed.filter((item) => {
        const then = wanted === "undone" ? before.get(item.documentId) : item;
        return placeOf(now.get(item.documentId)) === placeOf(then);
      });
    const assignmentsNow = () =>
      new Map(
        (useAppStore.getState().library?.assignments ?? []).map((item) => [item.documentId, item]),
      );
    const put = (item: DocumentGroupAssignment) => {
      const previous = before.get(item.documentId);
      if (!previous) return core.restoreAssignment(item.documentId, null);
      const { documentId: _id, ...rest } = previous;
      return core.restoreAssignment(item.documentId, rest);
    };
    const step: Undoable = {
      said: (t) =>
        t(changed.length === 1 ? "library.organize.done.one" : "library.organize.done", {
          count: changed.length,
        }),
      name: (t) => t("undo.name.organize"),
      // From another tab, where To review isn't in sight.
      ...(!isShown(useAppStore.getState().layout, { kind: "library" }) && {
        also: {
          label: (t) => t("library.review.review"),
          testId: "undo-review",
          run: () => useAppStore.getState().openLibrary("review"),
        },
      }),
      undo: async () => {
        // A Document the User has moved since is theirs now: it stays where they put it.
        await Promise.all(stays(assignmentsNow(), "done").map(put));
        await useAppStore.getState().refreshLibrary();
      },
      redo: async () => {
        // The same again, in one step: the Documents still as Undo left them get their Suggested Folder back.
        await Promise.all(
          stays(assignmentsNow(), "undone").map(({ documentId, ...suggestion }) =>
            core.restoreAssignment(documentId, suggestion),
          ),
        );
        await useAppStore.getState().refreshLibrary();
      },
    };
    lastOrganize = step;
    useUndo.getState().push(step);
  };
  // Organize has queued its Documents by now: with nothing working, there is nothing to wait for.
  let sawWorking = itemsNow().some(working);
  if (!sawWorking) return;
  unsubscribe = useAppStore.subscribe(() => {
    if (itemsNow().some(working)) sawWorking = true;
    else if (sawWorking) finish();
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
