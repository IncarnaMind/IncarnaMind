/**
 * What the assistant writes or changes applies at once (#880, #1559), in
 * the window whose Question asked for it, written or written again. The core
 * tags each of its requests (`ProposalRequest.requested`); their changes read as applied in the Mind
 * as they arrive, and a Mind not in view opens in a tab beside the one in
 * focus, never in its place. Once the Answer has ended, each Mind's are
 * applied in one step of its Undo, with the line over them saying what the
 * Answer's card says (`applyArrived`); the card then follows that step as
 * the User undoes and redoes in the Mind. The core applies a Mind that isn't
 * open in an editor before that Mind opens beside the one in view.
 */
import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { useCallback, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import type {
  AskedChangeApplication,
  AskedChangeTransition,
  ConversationAnswer,
} from "../../core/api";
import { askedFor } from "../../shared/askedChanges";
import {
  type AppliedAsked,
  applyArrived,
  canReviewApplied,
  coreApplicationStatus,
  onAskedApplied,
  releaseCoreChange,
  reviewApplied,
  shareCoreUndo,
  undoCoreChange,
} from "./appliedEdits";
import { type ChangedMind, changedMinds } from "./changedMinds";
import { changeFact } from "./changeFacts";
import { core } from "./core";
import type { FollowedSteps } from "./editor/editorUndo";
import { mindEditor, onMindEditorOpen, whenMindEditor } from "./editor/openEditors";
import { applyingIn, editorDoc, setApplying } from "./editor/proposalReview";
import { useAppStore } from "./store";
import { answerUndoPlace, type Undoable, UndoRefused, undoSettled, useUndo } from "./undo";

export type AskedOutcome = "applied" | "held" | "undone";

interface AskedChangesState {
  /** By Answer, then by Mind: whether the changes the User asked for there applied or wait. */
  outcomes: Readonly<Record<string, Readonly<Record<string, AskedOutcome>>>>;
  /** By Answer and Mind (`keyOf`): what the changes the User asked for there did, the rest left out. */
  facts: Readonly<Record<string, ChangedMind>>;
  /** By Answer and Mind (`keyOf`): written again over its earlier changes, which stayed. */
  onTop: Readonly<Record<string, true>>;
  /**
   * By Answer and Mind (`keyOf`): the changes its apply took. The card draws how many changes still
   * wait only once this Mind's copy no longer holds them, so a count never shows what was applied.
   */
  accepted: Readonly<Record<string, readonly string[]>>;
  /** The Answers this window is still answering, or applying the changes of. */
  arriving: ReadonlySet<string>;
}

export const useAskedChanges = create<AskedChangesState>()(() => ({
  outcomes: {},
  facts: {},
  onTop: {},
  accepted: {},
  arriving: new Set(),
}));

/** Keeps the Answers still on their way, as the cards count what waits around them (#1325). */
function syncArriving(): void {
  useAskedChanges.setState({ arriving: new Set([...askedHere, ...finishing.keys()]) });
}

type ApplicationRef = Pick<AskedChangeApplication, "undoId" | "held">;

interface Asked {
  answerId: string;
  mindId: string;
  requests: ReadonlySet<string>;
  requested: readonly string[];
  facts: ChangedMind;
  applied: AppliedAsked | null;
  application: ApplicationRef | null;
}

interface HeadlessChange {
  application: ApplicationRef;
  change: Undoable;
  stop: () => void;
  followerStop: (() => void) | null;
  undone: boolean;
  released: boolean;
}

const asked = new Map<string, Asked>();
const askedHere = new Set<string>();
const finishing = new Map<string, Promise<unknown>>();
const recovering = new Set<string>();
const catchingUp = new Map<string, () => void>();
const deferring = new Set<string>();
const headlessChanges = new Map<string, HeadlessChange>();

/** Whether this window has a Question in flight whose request, as the Mind's record has it, asks for these changes. */
export function askedInThisWindow(state: EditorState, request: string): boolean {
  const doc = ySyncPluginKey.getState(state)?.binding?.doc;
  return askedHere.size > 0 && doc !== undefined && askedFor(doc, request);
}

const keyOf = (answerId: string, mindId: string) => `${answerId} ${mindId}`;

function setOutcome(each: Asked, outcome: AskedOutcome, accepted?: readonly string[]): void {
  const { answerId, mindId } = each;
  useAskedChanges.setState((state) => ({
    outcomes: {
      ...state.outcomes,
      [answerId]: { ...state.outcomes[answerId], [mindId]: outcome },
    },
    facts: { ...state.facts, [keyOf(answerId, mindId)]: each.facts },
    ...(accepted && {
      accepted: { ...state.accepted, [keyOf(answerId, mindId)]: accepted },
    }),
  }));
}

export const useAskedFacts = (answerId: string, mindId: string): ChangedMind | undefined =>
  useAskedChanges((state) => state.facts[keyOf(answerId, mindId)]);

/** The changes this Answer's apply took in a Mind, until its copy shows them applied. */
export const useAcceptedChanges = (
  answerId: string,
  mindId: string,
): readonly string[] | undefined =>
  useAskedChanges((state) => state.accepted[keyOf(answerId, mindId)]);

async function releaseApplication(application: ApplicationRef): Promise<void> {
  await core.releaseAskedChanges(application.undoId).catch(useAppStore.getState().reportError);
}

function releaseHeadless(each: Asked, current: HeadlessChange): void {
  if (current.released) return;
  current.released = true;
  if (each.applied) releaseCoreChange(each.applied.followed);
  else void releaseApplication(current.application);
}

function forgetHeadless(each: Asked, release: boolean): void {
  const key = keyOf(each.answerId, each.mindId);
  const current = headlessChanges.get(key);
  if (!current) return;
  if (useUndo.getState().running?.change === current.change) {
    void undoSettled().then(() => forgetHeadless(each, release));
    return;
  }
  headlessChanges.delete(key);
  current.stop();
  current.followerStop?.();
  current.followerStop = null;
  useUndo.getState().withdraw(current.change);
  if (release) releaseHeadless(each, current);
}

function failHeadless(
  each: Asked,
  current: HeadlessChange,
  error: unknown,
  step: "undo" | "redo",
): never {
  releaseHeadless(each, current);
  each.application = null;
  setOutcome(each, step === "undo" ? "applied" : "undone");
  void undoSettled().then(() => forgetHeadless(each, false));
  throw error;
}

function headlessFor(each: Asked): HeadlessChange | null {
  const key = keyOf(each.answerId, each.mindId);
  const existing = headlessChanges.get(key);
  if (existing) return existing;
  const application = each.application;
  if (!application || application.held) return null;
  const change: Undoable = {
    said: (t) => changeFact(t, each.facts, null),
    shownAt: answerUndoPlace(each.answerId),
    undo: async () => {
      cancelCatchUp(key);
      const followed = each.applied?.followed;
      if (followed) {
        try {
          const undone = await followed.undo();
          if (undone === false) {
            return failHeadless(
              each,
              current,
              new UndoRefused((t) => t("edit.review.changedSince"), null),
              "undo",
            );
          }
        } catch (error) {
          return failHeadless(each, current, error, "undo");
        }
      } else {
        let transition: AskedChangeTransition | null;
        try {
          transition = await core.undoAskedChanges(application.undoId);
        } catch (error) {
          return failHeadless(each, current, error, "undo");
        }
        if (!transition) {
          return failHeadless(
            each,
            current,
            new UndoRefused((t) => t("edit.review.changedSince"), null),
            "undo",
          );
        }
      }
      current.undone = true;
      each.application = null;
      setOutcome(each, "undone");
    },
    redo: async () => {
      const followed = each.applied?.followed;
      if (followed) {
        try {
          const redone = await followed.redo?.();
          if (redone === false) {
            return failHeadless(
              each,
              current,
              new UndoRefused((t) => t("edit.review.changedSince"), null),
              "redo",
            );
          }
        } catch (error) {
          return failHeadless(each, current, error, "redo");
        }
        current.undone = false;
        setOutcome(each, "applied");
        return;
      }
      let transition: AskedChangeTransition | null;
      try {
        transition = await core.redoAskedChanges(application.undoId);
      } catch (error) {
        return failHeadless(each, current, error, "redo");
      }
      if (!transition) {
        return failHeadless(
          each,
          current,
          new UndoRefused((t) => t("edit.review.changedSince"), null),
          "redo",
        );
      }
      current.undone = false;
      each.application = application;
      setOutcome(each, "applied");
      const editor = mindEditor(each.mindId);
      if (editor) {
        void undoSettled()
          .then(async () => {
            if (asked.get(key) !== each || each.applied || !each.application) return;
            await recover(each, editor);
          })
          .catch(useAppStore.getState().reportError);
      }
    },
  };
  const current: HeadlessChange = {
    application,
    change,
    undone: false,
    released: false,
    followerStop: null,
    stop: () => undefined,
  };
  current.stop = useUndo.subscribe((state) => {
    if (
      !state.done.includes(change) &&
      !state.undone.includes(change) &&
      state.running?.change !== change
    ) {
      forgetHeadless(each, true);
    }
  });
  headlessChanges.set(key, current);
  useUndo.getState().offer(change);
  return current;
}

async function makeWayForAnswer(
  followed: FollowedSteps | null,
  application: ApplicationRef | null,
): Promise<"none" | "undone" | "stayed"> {
  if (!followed) {
    if (!application || application.held) return "none";
    try {
      const undone = await core.undoAskedChanges(application.undoId);
      return undone ? "undone" : "stayed";
    } catch (error) {
      useAppStore.getState().reportError(error);
      return "stayed";
    } finally {
      await releaseApplication(application);
    }
  }
  await followed.settled?.();
  if (followed.onTop()) await followed.undo();
  const outcome = followed.state() === "undone" ? "undone" : "stayed";
  releaseCoreChange(followed);
  return outcome;
}

/** An Answer this window has just asked for: what it was asked to write or change applies here. */
export function applyWhatIsAsked(answerId: string): void {
  askedHere.add(answerId);
  syncArriving();
}

/** An Answer this window asked for that nothing will be written for: nothing of it is on its way. */
export function applyNotAsked(answerId: string): void {
  if (!askedHere.delete(answerId)) return;
  syncArriving();
}

/**
 * An Answer this window asks for again: what it was asked to write or change applies here, and
 * what it applied before makes way for what it writes now, while nothing was done in the Mind
 * since. `keepWritten`: asked again from every Document, the text it wrote stays, which the core
 * writes over as one change, so Undo brings it back (#1149).
 */
export async function applyWhatWasAsked(
  answerId: string,
  { keepWritten = false } = {},
): Promise<void> {
  askedHere.add(answerId);
  syncArriving();
  await undoSettled();
  const pending = finishing.get(answerId);
  if (pending) await pending.catch(useAppStore.getState().reportError);
  const stayed: string[] = [];
  for (const [key, each] of asked) {
    if (each.answerId !== answerId) continue;
    const headless = headlessChanges.get(key);
    cancelCatchUp(key);
    asked.delete(key);
    const { created, wrote, tables, charts } = each.facts;
    if (keepWritten && (created || wrote + tables + charts > 0)) {
      forgetHeadless(each, true);
      continue;
    }
    const application = each.application ?? headless?.application ?? null;
    const wasUndone = headless?.undone === true;
    forgetHeadless(each, false);
    if (wasUndone) {
      if (application) await releaseApplication(application);
      continue;
    }
    const outcome = await makeWayForAnswer(each.applied?.followed ?? null, application);
    if (outcome === "stayed") stayed.push(key);
  }
  useAskedChanges.setState((state) => {
    const outcomes = { ...state.outcomes };
    delete outcomes[answerId];
    const others = <T>(byKey: Readonly<Record<string, T>>) =>
      Object.fromEntries(Object.entries(byKey).filter(([key]) => !key.startsWith(`${answerId} `)));
    const onTop = others(state.onTop);
    for (const key of stayed) onTop[key] = true;
    return { outcomes, facts: others(state.facts), onTop };
  });
}

export const useWrittenOnTop = (answerId: string, mindId: string): boolean =>
  useAskedChanges((state) => state.onTop[keyOf(answerId, mindId)] === true);

/** The Answers this window is still answering, or applying the changes of: what its cards leave out. */
export const useArrivingAnswers = (): ReadonlySet<string> =>
  useAskedChanges((state) => state.arriving);

const askedOf = (doc: Y.Doc, row: ChangedMind): Set<string> =>
  new Set(row.requests.filter((request) => askedFor(doc, request)));

const OPEN_WAIT_MS = 10_000;

const refOf = ({ undoId, held }: AskedChangeApplication): ApplicationRef => ({ undoId, held });

const openBeside = (mindId: string, behind: boolean) =>
  useAppStore.getState().changeLayout({
    type: "open",
    item: { kind: "mind", mindId },
    where: { in: "place" },
    behind,
  });

function cancelCatchUp(key: string): void {
  catchingUp.get(key)?.();
}

function applyCore(
  each: Asked,
  editor: Editor,
  application: AskedChangeApplication,
  afterSteps = false,
): void {
  const key = keyOf(each.answerId, each.mindId);
  const headless = headlessChanges.get(key);
  if (headless && !afterSteps) {
    if (deferring.has(key)) return;
    deferring.add(key);
    void undoSettled()
      .then(() => {
        deferring.delete(key);
        if (
          asked.get(key) === each &&
          !each.applied &&
          each.application?.undoId === application.undoId
        ) {
          applyCore(each, editor, application, true);
        }
      })
      .catch((error: unknown) => {
        deferring.delete(key);
        useAppStore.getState().reportError(error);
      });
    return;
  }
  if (!application.held && coreApplicationStatus(editor, application) === "behind") {
    if (catchingUp.has(key)) return;
    const doc = editorDoc(editor);
    if (!doc) return;
    const stop = () => {
      doc.off("afterTransaction", check);
      editor.off("destroy", stop);
      catchingUp.delete(key);
    };
    const check = () => {
      if (
        asked.get(key) !== each ||
        each.applied ||
        each.application?.undoId !== application.undoId ||
        editor.isDestroyed
      ) {
        stop();
        return;
      }
      if (coreApplicationStatus(editor, application) === "behind") return;
      stop();
      applyArrived(editor, each.mindId, each.requests, each.facts, {
        application,
        retainHeadless: headless !== undefined,
      });
      each.application = each.applied ? null : refOf(application);
    };
    catchingUp.set(key, stop);
    doc.on("afterTransaction", check);
    editor.on("destroy", stop);
    return;
  }
  cancelCatchUp(key);
  applyArrived(editor, each.mindId, each.requests, each.facts, {
    application,
    retainHeadless: headless !== undefined,
  });
  each.application = each.applied ? null : refOf(application);
}

function follow(row: ChangedMind): void {
  const editor = mindEditor(row.mindId);
  const doc = editor && editorDoc(editor);
  if (editor && doc) {
    const requests = askedOf(doc, row);
    const now = applyingIn(editor.state);
    if ([...requests].some((request) => !now.has(request))) {
      setApplying(editor, new Set([...now, ...requests]));
    }
    return;
  }
}

/** Each Mind's changes apply at once, in its open editor or in the core. */
const finish = (answer: ConversationAnswer): Promise<unknown> => {
  const rows = changedMinds(answer);
  const made = rows.some((row) => row.created);
  const task = Promise.allSettled(
    rows.map((row) => finishIn(answer, row, made && !row.created)),
  ).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") useAppStore.getState().reportError(result.reason);
    }
  });
  finishing.set(answer.id, task);
  syncArriving();
  return task.finally(() => {
    if (finishing.get(answer.id) === task) finishing.delete(answer.id);
    syncArriving();
  });
};

async function finishIn(
  answer: ConversationAnswer,
  row: ChangedMind,
  behind: boolean,
): Promise<void> {
  const editor = mindEditor(row.mindId);
  if (!editor) {
    const application = await core.applyAskedChanges({
      answerId: answer.id,
      mindId: row.mindId,
      requests: row.requests,
    });
    if (!application) {
      useAskedChanges.setState((state) => {
        const { [row.mindId]: _gone, ...rest } = state.outcomes[answer.id] ?? {};
        return { outcomes: { ...state.outcomes, [answer.id]: rest } };
      });
      return;
    }
    const requests = new Set(application.requests);
    const calls = answer.toolCalls.filter(
      (call) => call.mindChange && requests.has(call.mindChange.request),
    );
    const [facts = row] = changedMinds({ toolCalls: calls });
    const each: Asked = {
      answerId: answer.id,
      mindId: row.mindId,
      requests,
      requested: row.requests,
      facts,
      applied: null,
      application: refOf(application),
    };
    asked.set(keyOf(answer.id, row.mindId), each);
    setOutcome(each, application.held ? "held" : "applied", application.accepted);
    if (!(await openBeside(row.mindId, behind))) return;
    const opened = behind ? mindEditor(row.mindId) : await whenMindEditor(row.mindId, OPEN_WAIT_MS);
    // Undone on the card while the Note opened, and that Undo's entry gone since with a newer
    // change: nothing is left to hold this apply back (#2302).
    if (each.application?.undoId !== application.undoId) return;
    if (opened && editorDoc(opened)) applyCore(each, opened, application);
    return;
  }
  const doc = editorDoc(editor);
  if (!doc) return;
  const requests = askedOf(doc, row);
  if (requests.size === 0) {
    // Only changes that wait, which the card lists as waiting.
    useAskedChanges.setState((state) => {
      const { [row.mindId]: _gone, ...rest } = state.outcomes[answer.id] ?? {};
      return { outcomes: { ...state.outcomes, [answer.id]: rest } };
    });
    return;
  }
  const calls = answer.toolCalls.filter(
    (call) => call.mindChange && requests.has(call.mindChange.request),
  );
  const [facts = row] = changedMinds({ toolCalls: calls });
  const each: Asked = {
    answerId: answer.id,
    mindId: row.mindId,
    requests,
    requested: row.requests,
    facts,
    applied: null,
    application: null,
  };
  asked.set(keyOf(answer.id, row.mindId), each);
  if (applyArrived(editor, row.mindId, requests, facts) === "held") setOutcome(each, "held");
}

async function recover(each: Asked, editor: Editor): Promise<void> {
  const key = keyOf(each.answerId, each.mindId);
  if (each.applied || !each.application || recovering.has(key)) return;
  recovering.add(key);
  try {
    const pending = finishing.get(each.answerId);
    if (pending) await pending;
    // The card's Undo of these changes, still running, decides whether there is anything to apply.
    const headless = headlessChanges.get(key);
    if (headless && useUndo.getState().running?.change === headless.change) await undoSettled();
    if (asked.get(key) !== each || each.applied || !each.application) return;
    const application = await core.applyAskedChanges({
      answerId: each.answerId,
      mindId: each.mindId,
      requests: each.requested,
    });
    if (asked.get(key) !== each || each.applied || !each.application) return;
    if (!application) {
      each.application = null;
      return;
    }
    applyCore(each, editor, application);
  } finally {
    recovering.delete(key);
  }
}

onAskedApplied((mindId, requests, applied) => {
  for (const each of asked.values()) {
    if (each.mindId !== mindId || ![...requests].some((request) => each.requests.has(request)))
      continue;
    const key = keyOf(each.answerId, mindId);
    cancelCatchUp(key);
    each.applied = applied;
    each.application = null;
    const current = headlessChanges.get(key);
    if (current) {
      shareCoreUndo(applied.followed, current.change);
      current.followerStop?.();
      const check = () => {
        const state = applied.followed.state();
        if (
          state === "gone" ||
          (state === "done" && !applied.followed.onTop()) ||
          (state === "undone" && applied.followed.canRedo && !applied.followed.canRedo())
        ) {
          forgetHeadless(each, true);
        }
      };
      current.followerStop = applied.followed.observe(check);
      check();
    }
    setOutcome(each, "applied", applied.accepted);
  }
});

onMindEditorOpen((mindId, editor) => {
  void Promise.all(
    [...asked.values()].map(async (each) => {
      if (each.mindId === mindId) await recover(each, editor);
    }),
  ).catch(useAppStore.getState().reportError);
});

export type AskedState = "can-undo" | "changed-since" | "undone" | "closed";

const followedOf = (answerId: string, mindId: string) =>
  asked.get(keyOf(answerId, mindId))?.applied?.followed ?? null;

function stateOf(followed: FollowedSteps | null): AskedState {
  const state = followed?.state() ?? "gone";
  if (state === "gone") return "closed";
  if (state === "undone") return "undone";
  return followed?.onTop() ? "can-undo" : "changed-since";
}

export function useAskedState(answerId: string, mindId: string): AskedState {
  const each = asked.get(keyOf(answerId, mindId));
  const followed = followedOf(answerId, mindId);
  const outcome = useAskedChanges((state) => state.outcomes[answerId]?.[mindId]);
  const subscribe = useCallback(
    (changed: () => void) => followed?.observe(changed) ?? (() => undefined),
    [followed],
  );
  return useSyncExternalStore(subscribe, () => {
    if (outcome === "undone") return "undone";
    if (!followed && each?.application && !each.application.held) return "can-undo";
    return stateOf(followed);
  });
}

export function undoAsked(answerId: string, mindId: string): void {
  const key = keyOf(answerId, mindId);
  const current = headlessChanges.get(key);
  if (current) {
    void useUndo.getState().undo(current.change).catch(useAppStore.getState().reportError);
    return;
  }
  const followed = followedOf(answerId, mindId);
  if (followed?.onTop()) {
    void undoCoreChange(followed);
    return;
  }
  const each = asked.get(key);
  if (!each?.application || each.application.held) return;
  cancelCatchUp(key);
  const created = headlessFor(each);
  if (created)
    void useUndo.getState().undo(created.change).catch(useAppStore.getState().reportError);
}

function reviewableIn(mindId: string, followed: FollowedSteps | null): boolean {
  const editor = mindEditor(mindId);
  return followed !== null && editor !== null && canReviewApplied(editor, followed);
}

/** Whether the Mind's ⌘K and ⋯ offer Review changes for this Answer's changes there: the card offers it too. */
export function useAskedReview(answerId: string, mindId: string): boolean {
  const followed = followedOf(answerId, mindId);
  const subscribe = useCallback(
    (changed: () => void) => {
      const editor = mindEditor(mindId);
      editor?.on("transaction", changed);
      const stop = followed?.observe(changed);
      return () => {
        editor?.off("transaction", changed);
        stop?.();
      };
    },
    [followed, mindId],
  );
  return useSyncExternalStore(subscribe, () => reviewableIn(mindId, followed));
}

export function reviewAsked(answerId: string, mindId: string): void {
  const editor = mindEditor(mindId);
  if (!editor || !reviewableIn(mindId, followedOf(answerId, mindId))) return;
  useAppStore.getState().openMind(mindId);
  reviewApplied(editor, { focus: true });
}

core.on("conversation.message", (message) => {
  if (message.kind !== "answer" || !askedHere.has(message.id)) return;
  const answer = message;
  for (const row of changedMinds(answer)) follow(row);
  if (answer.status === "streaming") return;
  askedHere.delete(answer.id);
  syncArriving();
  finish(answer).catch(useAppStore.getState().reportError);
});
