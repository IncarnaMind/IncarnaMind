import { useEffect } from "react";
import { create } from "zustand";
import type {
  OrganizeLibraryInput,
  OrganizeLibraryResult,
  OrganizeReview,
  OrganizeReviewChange,
  OrganizeReviewEdit,
  OrganizeReviewItem,
  RunEstimate,
} from "../../core/api";
import type { MessageKey } from "../../shared/i18n";
import { core } from "./core";
import { describeError } from "./errors";
import { isShown } from "./layoutSlice";
import { useNotices } from "./notices";
import { reviewLayout } from "./organizeReviewView";
import { useAppStore } from "./store";
import { makeInTurn, type Undoable, useUndo } from "./undo";

/** The Review's own changes: each is one ⌘Z, and none shows a line of its own. */
export const REVIEW_UNDO_PLACE = "organize-review";
/** The Library's top, where Confirm and Discard say what they did, with Undo. */
export const LIBRARY_UNDO_PLACE = "library";

export interface OrganizeRun {
  input: OrganizeLibraryInput;
  runId: string | null;
  /** Documents still being read: the plan waits for them. */
  waiting: number;
  done: number;
  total: number;
  /** Sorted one Document at a time into the Folders there are, by a model that can't plan: no Stop. */
  each?: true;
  /** Re-tag: "Tagging 4 of 12…", its Tags only (#2339). */
  tags?: true;
}

interface ReviewState {
  /** What waits in Suggestions, as last read; null until the first read. */
  review: OrganizeReview | null;
  /** How many Documents wait, from the core's last word; null until it has said. */
  count: number | null;
  /** The Review fills the Library's page. */
  open: boolean;
  /** The Organize this window started, while it runs: "Organizing 12 of 40…". */
  run: OrganizeRun | null;
  /** Stop ended the last run, after this many: "Stopped after reading 12. Nothing has moved." */
  stopped: number | null;
  /** The run Stop ended was a Re-tag: "Stopped after tagging 4. Nothing has changed." */
  stoppedTagging: boolean;
  /**
   * The last run proposed nothing, no Folder and no Tag, so no Review opened: its line says the
   * Documents are too different to group yet, or, for a Re-tag (`tags`), that no Tag fits them.
   */
  apart: { count: number; tags: boolean } | null;
  /**
   * The last run couldn't reach its model, so nothing was planned: its line names the service and
   * offers Try again, with the provider's own sentence under Details, until dismissed.
   */
  failed: { input: OrganizeLibraryInput; details: string } | null;
  /** A run over $1 that sent nothing yet: its cost shows first. */
  estimate: { estimate: RunEstimate; input: OrganizeLibraryInput; count: number } | null;
  /** The cards showing every row ("Show all"), by Folder id. */
  shownAll: ReadonlySet<string>;
}

export const useOrganizeReview = create<ReviewState>()(() => ({
  review: null,
  count: null,
  open: false,
  run: null,
  stopped: null,
  stoppedTagging: false,
  apart: null,
  failed: null,
  estimate: null,
  shownAll: new Set(),
}));

const report = (error: unknown) => useAppStore.getState().reportError(error);
const libraryShown = () => isShown(useAppStore.getState().layout, { kind: "library" });

/** Reads the Suggestions again; the Review closes once nothing is left in them. */
export async function refreshReview(): Promise<OrganizeReview> {
  const review = await core.getOrganizeReview();
  useOrganizeReview.setState((state) => ({
    review,
    count: review.count,
    open: state.open && review.items.length > 0,
  }));
  return review;
}

core.on("organizeReview.changed", ({ count }) => {
  useOrganizeReview.setState({ count });
  void refreshReview().catch(report);
});

let reading: Promise<unknown> | null = null;
let readAgain = false;
/** Reads the Suggestions again once a read under way has ended: changes come in bursts. */
function refreshSoon(): void {
  if (reading) {
    readAgain = true;
    return;
  }
  reading = refreshReview()
    .catch(report)
    .finally(() => {
      reading = null;
      if (readAgain) {
        readAgain = false;
        refreshSoon();
      }
    });
}

// A Document deleted or restored leaves or rejoins the Suggestions with no change of their own.
core.on("documents.removed", refreshSoon);
core.on("library.changed", () => {
  const { review, count } = useOrganizeReview.getState();
  if (review !== null || (count ?? 0) > 0) refreshSoon();
});

core.on("organize.progress", (progress) => {
  const { run } = useOrganizeReview.getState();
  if (!run || (run.runId !== null && run.runId !== progress.runId)) return;
  useOrganizeReview.setState({
    run: {
      ...run,
      runId: progress.runId,
      waiting: progress.waiting,
      done: progress.done,
      total: progress.total,
    },
  });
});

/**
 * How many Documents wait in the Review for a Folder: while any do, Organize offers their Review
 * instead of another run. Tags waiting alone don't hold it back (#2339): a new User's Documents
 * are tagged before they are organized. `fallback`: the count before the Review is first read.
 */
export function useFoldersWaiting(fallback: number): number {
  const review = useOrganizeReview((state) => state.review);
  const count = useOrganizeReview((state) => state.count) ?? fallback;
  useEffect(() => {
    if (review === null && count > 0) void refreshReview().catch(report);
  }, [review, count]);
  if (review === null) return count;
  return review.items.filter(
    (item) =>
      item.ticked && (item.placement.kind === "folder" || item.placement.kind === "newFolder"),
  ).length;
}

/** Opens the Review over the Library's page, as its count's Review does. */
export function openReview(): void {
  const app = useAppStore.getState();
  app.openLibrary();
  useOrganizeReview.setState({ open: true, stopped: null, apart: null });
  void refreshReview().catch(report);
  // The update's own words at the Library's top last until the Review is first opened (#1569).
  if ((app.library?.reviewMoved ?? 0) > 0) void core.reviewMovedSeen().catch(report);
}

/** Not Now: the Suggestions stay as they are, and the Library's top counts them. */
export function closeReview(): void {
  useOrganizeReview.setState({ open: false });
}

export function showAllRows(cardId: string): void {
  useOrganizeReview.setState((state) => ({ shownAll: new Set([...state.shownAll, cardId]) }));
}

/**
 * Organize, through the whole-Library plan (#1569): the Library's Documents in no Folder, these
 * Documents, or a Folder's own (Organize This Folder). The Library's top says how far it is, with
 * Stop; the Review opens when it ends, never halfway, and only if the Library is in view.
 */
export async function organize(input: OrganizeLibraryInput): Promise<OrganizeLibraryResult | null> {
  if (useOrganizeReview.getState().run) return null;
  return runInReview(input, () => core.organizeLibrary(input));
}

/**
 * Re-tag (#2339): these Documents, or every one, tagged as one run, "Tagging 4 of 12…" with Stop
 * at the Library's top; their Tags wait in the Review, which opens when it ends.
 */
export function tagDocuments(
  documentIds?: readonly string[],
): Promise<OrganizeLibraryResult | null> {
  const input = documentIds ? { documentIds: [...documentIds] } : {};
  return runInReview(input, () => core.tagDocuments(input), true);
}

async function runInReview(
  input: OrganizeLibraryInput,
  start: () => Promise<OrganizeLibraryResult>,
  tags?: true,
): Promise<OrganizeLibraryResult | null> {
  if (useOrganizeReview.getState().run) return null;
  useOrganizeReview.setState({
    run: { input, runId: null, waiting: 0, done: 0, total: 0, ...(tags && { tags }) },
    stopped: null,
    stoppedTagging: false,
    apart: null,
    failed: null,
    estimate: null,
    open: false,
  });
  try {
    let result: OrganizeLibraryResult;
    try {
      result = await start();
    } catch (error) {
      // The app's own sentence (no model, no consent) is a notice; a provider's is this line's.
      const { wording, message } = describeError(error);
      if (wording) throw error;
      useOrganizeReview.setState({ failed: { input, details: message } });
      return null;
    }
    const { run } = useOrganizeReview.getState();
    if (result.status === "estimate") {
      useOrganizeReview.setState({
        estimate: { estimate: result.estimate, input, count: run?.total ?? 0 },
      });
      return result;
    }
    if (result.status === "stopped") {
      useOrganizeReview.setState({ stopped: run?.done ?? 0, stoppedTagging: tags === true });
      return result;
    }
    const [review] = await Promise.all([refreshReview(), useAppStore.getState().refreshLibrary()]);
    if (result.proposed === 0 || review.items.length === 0) {
      useOrganizeReview.setState({ apart: { count: result.documents, tags: tags === true } });
    } else if (libraryShown()) {
      useOrganizeReview.setState({ open: true, shownAll: new Set() });
    }
    return result;
  } finally {
    useOrganizeReview.setState({ run: null });
  }
}

const working = (ids: ReadonlySet<string>) =>
  (useAppStore.getState().library?.assignments ?? []).filter(
    (item) =>
      ids.has(item.documentId) && (item.status === "pending" || item.status === "classifying"),
  ).length;

/**
 * Organize with a model that can only choose among the Folders there are (a decision model): each
 * Document is sorted on its own into the Review, which opens once none is left working.
 */
export async function organizeEach(
  ids: readonly string[],
  folderId: string | null,
  { forService, once }: { forService?: string; once?: boolean } = {},
): Promise<void> {
  if (useOrganizeReview.getState().run || ids.length === 0) return;
  const mine = new Set(ids);
  useOrganizeReview.setState({
    run: {
      input: folderId ? { folderId } : { documentIds: [...ids] },
      runId: null,
      waiting: 0,
      done: 0,
      total: ids.length,
      each: true,
    },
    stopped: null,
    failed: null,
    estimate: null,
    open: false,
  });
  try {
    await core.classifyDocuments([...ids], {
      ...(forService !== undefined && { forService }),
      ...(once === true && { once }),
      ...(folderId !== null && { folderId }),
    });
    await useAppStore.getState().refreshLibrary();
    await new Promise<void>((resolve) => {
      let unsubscribe = () => {};
      const check = () => {
        const left = working(mine);
        const { run } = useOrganizeReview.getState();
        if (run) useOrganizeReview.setState({ run: { ...run, done: ids.length - left } });
        if (left > 0) return;
        unsubscribe();
        resolve();
      };
      unsubscribe = useAppStore.subscribe(check);
      check();
    });
    const review = await refreshReview();
    if (review.items.some((item) => mine.has(item.documentId))) {
      if (libraryShown()) useOrganizeReview.setState({ open: true, shownAll: new Set() });
    } else {
      useNotices.getState().confirm("library.organize.noneFit");
    }
  } finally {
    useOrganizeReview.setState({ run: null });
  }
}

/** Try again, from the line that says the last run couldn't reach its model. */
export function retryFailed(): void {
  const { failed } = useOrganizeReview.getState();
  if (failed) void organize(failed.input).catch(report);
}

export function dismissFailed(): void {
  useOrganizeReview.setState({ failed: null });
}

/** Stop: the plan under way goes, and nothing it planned is kept. */
export function stopOrganizing(): void {
  void core.stopOrganizeLibrary().catch(report);
}

/** Organize as the estimate offered it, now that the User has seen its cost. */
export function acceptEstimate(): void {
  const { estimate } = useOrganizeReview.getState();
  if (!estimate) return;
  void organize({ ...estimate.input, costAccepted: true }).catch(report);
}

export function dismissEstimate(): void {
  useOrganizeReview.setState({ estimate: null });
}

/** One step back and forth over the rows a change touched: each restore hands back the next one. */
function changeStep(change: OrganizeReviewChange, said: Undoable["said"]): Undoable {
  let held = change;
  const step = async () => {
    const back = await core.restoreOrganizeReview(held.before, held.after);
    if (back) held = back;
    await refreshReview();
  };
  return {
    said,
    name: (t) => t("undo.name.suggestions"),
    shownAt: REVIEW_UNDO_PLACE,
    undo: step,
    redo: step,
  };
}

/** The rows as an edit leaves them, before the core has said so, where that is safe. */
function edited(
  items: readonly OrganizeReviewItem[],
  edit: OrganizeReviewEdit,
): OrganizeReviewItem[] {
  if (edit.kind === "tick") {
    const ids = new Set(edit.itemIds);
    return items.map((item) => (ids.has(item.id) ? { ...item, ticked: edit.ticked } : item));
  }
  if (edit.kind === "move") {
    const ids = new Set(edit.itemIds);
    const { to } = edit;
    return items.map((item) =>
      ids.has(item.id)
        ? {
            ...item,
            ticked: to.kind === "leftOut" ? item.ticked : true,
            placement:
              to.kind === "leftOut" ? { kind: "leftOut" as const, leftOut: null } : { ...to },
          }
        : item,
    );
  }
  return [...items];
}

/** One change to the Suggestions, shown at once; ⌘Z takes it back. */
export function editReview(edit: OrganizeReviewEdit): Promise<void> {
  const { review } = useOrganizeReview.getState();
  if (review)
    useOrganizeReview.setState({ review: { ...review, items: edited(review.items, edit) } });
  return makeInTurn(async () => {
    try {
      const change = await core.editOrganizeReview(edit);
      if (change.after.length > 0)
        useUndo.getState().push(changeStep(change, (t) => t("undo.name.suggestions")));
    } finally {
      await refreshReview();
    }
  });
}

/**
 * Confirm: makes the new Folders, files the ticked Documents and adds their Tags in one step, and
 * says so at the Library's top with one Undo, which brings the Review back as it was.
 */
export function confirmReview(): Promise<void> {
  return makeInTurn(async () => {
    const { review } = useOrganizeReview.getState();
    if (!review) return;
    const library = useAppStore.getState().library;
    const { onlyTags } = reviewLayout(review, library?.groups ?? [], library?.assignments ?? []);
    const confirmation = await core.confirmOrganizeReview(review.items.map((item) => item.id));
    useOrganizeReview.setState({ open: false });
    await Promise.all([refreshReview(), useAppStore.getState().refreshLibrary()]);
    if (!confirmation) return;
    const { id } = confirmation;
    const count = confirmation.documentIds.length;
    useUndo.getState().push({
      // Only Tags were confirmed: "Tagged 12 Documents"; any filing makes it Organize's (#2339).
      said: (t) =>
        onlyTags
          ? t(count === 1 ? "organizeReview.tagged.one" : "organizeReview.tagged", { count })
          : t(count === 1 ? "organizeReview.organized.one" : "organizeReview.organized", {
              count,
            }),
      name: (t) => t("undo.name.organize"),
      shownAt: LIBRARY_UNDO_PLACE,
      undo: async () => {
        await core.undoOrganizeReviewConfirmation(id);
        await Promise.all([refreshReview(), useAppStore.getState().refreshLibrary()]);
        if (libraryShown()) useOrganizeReview.setState({ open: true });
      },
      redo: async () => {
        await core.redoOrganizeReviewConfirmation(id);
        useOrganizeReview.setState({ open: false });
        await Promise.all([refreshReview(), useAppStore.getState().refreshLibrary()]);
      },
    });
  });
}

/** Sets these rows aside, and gives the id that brings them back. */
const setAside = async (items: readonly OrganizeReviewItem[]) =>
  items.length === 0 ? null : core.discardOrganizeReview(items.map((item) => item.id));

/** Discard: every row is set aside, with Undo, which brings them back and the Review with them. */
export function discardReview(): Promise<void> {
  return makeInTurn(async () => {
    const { review } = useOrganizeReview.getState();
    if (!review) return;
    let aside = await setAside(review.items);
    useOrganizeReview.setState({ open: false });
    await refreshReview();
    if (aside === null) return;
    useUndo.getState().push({
      said: (t) => t("organizeReview.discarded"),
      name: (t) => t("undo.name.discard"),
      shownAt: LIBRARY_UNDO_PLACE,
      undo: async () => {
        if (aside !== null) await core.restoreDiscardedOrganizeReview(aside);
        const back = await refreshReview();
        if (libraryShown() && back.items.length > 0) useOrganizeReview.setState({ open: true });
      },
      redo: async () => {
        const now = useOrganizeReview.getState().review;
        aside = await setAside(now?.items ?? []);
        useOrganizeReview.setState({ open: false });
        await refreshReview();
      },
    });
  });
}

/** Proposed Folders at the top of the place the Review is about: what Fewer and More count. */
export function proposedHere(review: OrganizeReview): number {
  const library = useAppStore.getState().library;
  const layout = reviewLayout(review, library?.groups ?? [], library?.assignments ?? []);
  const top = layout.scope?.id ?? null;
  return layout.proposed.filter((card) => card.parentId === top).length;
}

export type Replan = "fewer" | "more" | "again";

const REPLAN_NAMES = {
  fewer: "organizeReview.fewer",
  more: "organizeReview.more",
  again: "organizeReview.again",
} as const satisfies Record<Replan, MessageKey>;

/**
 * Fewer Folders, More Folders and Try Again: the rows the User hasn't changed are set aside and
 * the same place is planned again, aiming at fewer or more new Folders than now. One ⌘Z puts the
 * earlier rows back; a run that sends nothing (stopped, or its cost asked first) puts them back
 * at once.
 */
export async function replan(kind: Replan): Promise<void> {
  const { review } = useOrganizeReview.getState();
  if (!review) return;
  const library = useAppStore.getState().library;
  const layout = reviewLayout(review, library?.groups ?? [], library?.assignments ?? []);
  const count = proposedHere(review);
  const input: OrganizeLibraryInput = {
    ...(layout.scope && { folderId: layout.scope.id }),
    ...(kind === "fewer" && { folders: { fewerThan: count } }),
    ...(kind === "more" && { folders: { moreThan: count } }),
  };
  let earlier = await setAside(review.items.filter((item) => !item.edited));
  const putBack = async () => {
    if (earlier !== null) await core.restoreDiscardedOrganizeReview(earlier);
    earlier = null;
  };
  let result: OrganizeLibraryResult | null = null;
  // A plan that proposes nothing keeps the earlier one, as a stopped or failed one does.
  const planned = () => result?.status === "done" && result.proposed > 0;
  try {
    // Only Tags waiting: Try Again tags the same Documents again (#2339).
    result = layout.onlyTags
      ? await tagDocuments(review.items.map((item) => item.documentId))
      : await organize(input);
  } finally {
    if (!planned()) {
      await putBack();
      const back = await refreshReview();
      if (libraryShown() && back.items.length > 0 && result?.status !== "estimate")
        useOrganizeReview.setState({ open: true });
    }
  }
  if (!planned()) return;
  let later: string | null = null;
  const swap = async (from: "later" | "earlier") => {
    const now = await refreshReview();
    const aside = await setAside(now.items.filter((item) => !item.edited));
    const back = from === "earlier" ? earlier : later;
    if (back !== null) await core.restoreDiscardedOrganizeReview(back);
    if (from === "earlier") {
      later = aside;
      earlier = null;
    } else {
      earlier = aside;
      later = null;
    }
    await refreshReview();
  };
  useUndo.getState().push({
    said: (t) => t("undo.name.suggestions"),
    name: (t) => t(REPLAN_NAMES[kind]),
    shownAt: REVIEW_UNDO_PLACE,
    undo: () => swap("earlier"),
    redo: () => swap("later"),
  });
}
