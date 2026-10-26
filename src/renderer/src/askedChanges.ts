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
import type { EditorState } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { useCallback, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import type { AskedChangeApplication, ConversationAnswer } from "../../core/api";
import { askedFor } from "../../shared/askedChanges";
import {
  type AppliedAsked,
  applyArrived,
  canReviewApplied,
  onAskedApplied,
  releaseCoreChange,
  reviewApplied,
  undoCoreChange,
} from "./appliedEdits";
import { type ChangedMind, changedMinds } from "./changedMinds";
import { core } from "./core";
import type { FollowedSteps } from "./editor/editorUndo";
import { mindEditor, onMindEditorOpen, whenMindEditor } from "./editor/openEditors";
import { applyingIn, editorDoc, setApplying } from "./editor/proposalReview";
import { useAppStore } from "./store";
import { undoSettled } from "./undo";

export type AskedOutcome = "applied" | "held" | "undone";

interface AskedChangesState {
  /** By Answer, then by Mind: whether the changes the User asked for there applied or wait. */
  outcomes: Readonly<Record<string, Readonly<Record<string, AskedOutcome>>>>;
  /** By Answer and Mind (`keyOf`): what the changes the User asked for there did, the rest left out. */
  facts: Readonly<Record<string, ChangedMind>>;
  /** By Answer and Mind (`keyOf`): written again over its earlier changes, which stayed. */
  onTop: Readonly<Record<string, true>>;
}

export const useAskedChanges = create<AskedChangesState>()(() => ({
  outcomes: {},
  facts: {},
  onTop: {},
}));

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

const asked = new Map<string, Asked>();
const askedHere = new Set<string>();
const finishing = new Map<string, Promise<unknown>>();
const recovering = new Set<string>();

/** Whether this window has a Question in flight whose request, as the Mind's record has it, asks for these changes. */
export function askedInThisWindow(state: EditorState, request: string): boolean {
  const doc = ySyncPluginKey.getState(state)?.binding?.doc;
  return askedHere.size > 0 && doc !== undefined && askedFor(doc, request);
}

const keyOf = (answerId: string, mindId: string) => `${answerId} ${mindId}`;

function setOutcome(each: Asked, outcome: AskedOutcome): void {
  const { answerId, mindId } = each;
  useAskedChanges.setState((state) => ({
    outcomes: {
      ...state.outcomes,
      [answerId]: { ...state.outcomes[answerId], [mindId]: outcome },
    },
    facts: { ...state.facts, [keyOf(answerId, mindId)]: each.facts },
  }));
}

export const useAskedFacts = (answerId: string, mindId: string): ChangedMind | undefined =>
  useAskedChanges((state) => state.facts[keyOf(answerId, mindId)]);

async function makeWayForAnswer(
  followed: FollowedSteps | null,
  application: ApplicationRef | null,
): Promise<"none" | "undone" | "stayed"> {
  if (!followed) {
    if (!application || application.held) return "none";
    const undone = await core.undoAskedChanges(application.undoId);
    await core.releaseAskedChanges(application.undoId).catch(useAppStore.getState().reportError);
    return undone ? "undone" : "stayed";
  }
  await followed.settled?.();
  if (followed.onTop()) await followed.undo();
  const outcome = followed.state() === "undone" ? "undone" : "stayed";
  releaseCoreChange(followed);
  return outcome;
}

/**
 * An Answer this window asked for, or asks for again: what it was asked to write or change
 * applies here. Asked again, what it applied before makes way for what it writes now, while
 * nothing was done in the Mind since. `keepWritten`: asked again from every Document, the text it
 * wrote stays, which the core writes over as one change, so Undo brings it back (#1149).
 */
export async function applyWhatWasAsked(
  answerId: string,
  { keepWritten = false } = {},
): Promise<void> {
  askedHere.add(answerId);
  await undoSettled();
  const pending = finishing.get(answerId);
  if (pending) await pending.catch(useAppStore.getState().reportError);
  const stayed: string[] = [];
  for (const [key, each] of asked) {
    if (each.answerId !== answerId) continue;
    asked.delete(key);
    const { created, wrote, tables, charts } = each.facts;
    if (keepWritten && (created || wrote + tables + charts > 0)) continue;
    const outcome = await makeWayForAnswer(each.applied?.followed ?? null, each.application);
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

const askedOf = (doc: Y.Doc, row: ChangedMind): Set<string> =>
  new Set(row.requests.filter((request) => askedFor(doc, request)));

const OPEN_WAIT_MS = 10_000;

const refOf = ({ undoId, held }: AskedChangeApplication): ApplicationRef => ({ undoId, held });

const openBeside = (mindId: string) =>
  useAppStore
    .getState()
    .changeLayout({ type: "open", item: { kind: "mind", mindId }, where: { in: "place" } });

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
  const task = Promise.allSettled(changedMinds(answer).map((row) => finishIn(answer, row))).then(
    (results) => {
      for (const result of results) {
        if (result.status === "rejected") useAppStore.getState().reportError(result.reason);
      }
    },
  );
  finishing.set(answer.id, task);
  return task.finally(() => {
    if (finishing.get(answer.id) === task) finishing.delete(answer.id);
  });
};

async function finishIn(answer: ConversationAnswer, row: ChangedMind): Promise<void> {
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
    setOutcome(each, application.held ? "held" : "applied");
    if (!(await openBeside(row.mindId))) {
      each.application = refOf(application);
      return;
    }
    const opened = await whenMindEditor(row.mindId, OPEN_WAIT_MS);
    if (opened && editorDoc(opened)) {
      applyArrived(opened, row.mindId, requests, facts, { application });
    }
    each.application = each.applied ? null : refOf(application);
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

onAskedApplied((mindId, requests, applied) => {
  for (const each of asked.values()) {
    if (each.mindId !== mindId || ![...requests].some((request) => each.requests.has(request)))
      continue;
    each.applied = applied;
    each.application = null;
    setOutcome(each, "applied");
  }
});

onMindEditorOpen((mindId, editor) => {
  void Promise.all(
    [...asked.values()].map(async (each) => {
      const key = keyOf(each.answerId, mindId);
      if (each.mindId !== mindId || each.applied || !each.application || recovering.has(key)) {
        return;
      }
      recovering.add(key);
      try {
        const pending = finishing.get(each.answerId);
        if (pending) await pending;
        if (asked.get(key) !== each || each.applied || !each.application) return;
        const application = await core.applyAskedChanges({
          answerId: each.answerId,
          mindId,
          requests: each.requested,
        });
        if (asked.get(key) !== each || each.applied || !each.application) return;
        if (!application) {
          each.application = null;
          return;
        }
        applyArrived(editor, mindId, each.requests, each.facts, { application });
        each.application = each.applied ? null : refOf(application);
      } finally {
        recovering.delete(key);
      }
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
  const followed = followedOf(answerId, mindId);
  if (followed?.onTop()) {
    void undoCoreChange(followed);
    return;
  }
  const each = asked.get(keyOf(answerId, mindId));
  if (!each?.application || each.application.held) return;
  void makeWayForAnswer(null, each.application)
    .then((outcome) => {
      each.application = null;
      setOutcome(each, outcome === "undone" ? "undone" : "applied");
    })
    .catch(useAppStore.getState().reportError);
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
  finish(answer).catch(useAppStore.getState().reportError);
});
