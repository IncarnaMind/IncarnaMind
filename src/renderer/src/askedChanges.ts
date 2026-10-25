/**
 * What the assistant writes or changes applies at once (#880, #1559), in
 * the window whose Question asked for it, written or written again. The core
 * tags each of its requests (`ProposalRequest.requested`); their changes read as applied in the Mind
 * as they arrive, and a Mind not in view opens in a tab beside the one in
 * focus, never in its place. Once the Answer has ended, each Mind's are
 * applied in one step of its Undo, with the line over them saying what the
 * Answer's card says (`applyArrived`); the card then follows that step as
 * the User undoes and redoes in the Mind. A Mind that isn't open in an
 * editor, such as a second one the turn changed, applies them once it opens.
 */
import type { EditorState } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { useCallback, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import type { ConversationAnswer } from "../../core/api";
import { askedFor } from "../../shared/askedChanges";
import {
  type AppliedAsked,
  applyArrived,
  canReviewApplied,
  onAskedApplied,
  reviewApplied,
} from "./appliedEdits";
import { type ChangedMind, changedMinds } from "./changedMinds";
import { readMindHandle } from "./commands/handles";
import { core } from "./core";
import type { FollowedSteps } from "./editor/editorUndo";
import { mindEditor, whenMindEditor } from "./editor/openEditors";
import { applyingIn, editorDoc, setApplying } from "./editor/proposalReview";
import { openMindCopy } from "./mindCopies";
import { useAppStore } from "./store";

/** "opening": its Mind isn't open in an editor yet, so its changes apply once it is (Open on its line). */
export type AskedOutcome = "applied" | "held" | "opening";

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

interface Asked {
  answerId: string;
  mindId: string;
  requests: ReadonlySet<string>;
  facts: ChangedMind;
  applied: AppliedAsked | null;
}

const asked = new Map<string, Asked>();
const askedHere = new Set<string>();
const seen = new Set<string>();

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

/**
 * An Answer this window asked for, or asks for again: what it was asked to write or change
 * applies here. Asked again, what it applied before makes way for what it writes now, while
 * nothing was done in the Mind since. `keepWritten`: asked again from every Document, the text it
 * wrote stays, which the core writes over as one change, so Undo brings it back (#1149).
 */
export function applyWhatWasAsked(answerId: string, { keepWritten = false } = {}): void {
  askedHere.add(answerId);
  const stayed: string[] = [];
  for (const [key, each] of asked) {
    if (each.answerId !== answerId) continue;
    asked.delete(key);
    const { created, wrote, tables, charts } = each.facts;
    if (keepWritten && (created || wrote + tables + charts > 0)) continue;
    const followed = each.applied?.followed;
    if (followed?.onTop()) followed.undo();
    else if (followed && followed.state() !== "undone") stayed.push(key);
  }
  for (const key of seen) if (key.startsWith(`${answerId} `)) seen.delete(key);
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

function askedInCopy(row: ChangedMind): Promise<boolean> {
  return new Promise((resolve) => {
    const close = openMindCopy(
      row.mindId,
      ({ doc }) => {
        resolve(doc !== null && askedOf(doc, row).size > 0);
        close();
      },
      () => resolve(false),
    );
  });
}

const openBeside = (mindId: string) =>
  useAppStore
    .getState()
    .changeLayout({ type: "open", item: { kind: "mind", mindId }, where: { in: "place" } })
    .catch(useAppStore.getState().reportError);

function follow(answer: ConversationAnswer, row: ChangedMind): void {
  const key = keyOf(answer.id, row.mindId);
  const editor = mindEditor(row.mindId);
  const doc = editor && editorDoc(editor);
  if (editor && doc) {
    const requests = askedOf(doc, row);
    const now = applyingIn(editor.state);
    if ([...requests].some((request) => !now.has(request))) {
      setApplying(editor, new Set([...now, ...requests]));
    }
    if (requests.size > 0 && !seen.has(key) && readMindHandle.current?.mindId !== row.mindId) {
      seen.add(key);
      void openBeside(row.mindId);
    }
    return;
  }
  if (seen.has(key)) return;
  seen.add(key);
  // A Mind the Answer made opens anyway (./assistantMinds).
  if (row.created) return;
  void askedInCopy(row).then((found) => {
    if (found) void openBeside(row.mindId);
  });
}

/** Each Mind's changes apply at once where it is open; one not open in front applies once it opens. */
const finish = (answer: ConversationAnswer): Promise<unknown> =>
  Promise.all(changedMinds(answer).map((row) => finishIn(answer, row)));

async function finishIn(answer: ConversationAnswer, row: ChangedMind): Promise<void> {
  let editor = mindEditor(row.mindId);
  if (!editor) {
    setOutcome(
      {
        answerId: answer.id,
        mindId: row.mindId,
        requests: new Set(row.requests),
        facts: row,
        applied: null,
      },
      "opening",
    );
    editor = await whenMindEditor(row.mindId, null);
  }
  const doc = editor && editorDoc(editor);
  if (!editor || !doc) return;
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
  const each: Asked = { answerId: answer.id, mindId: row.mindId, requests, facts, applied: null };
  asked.set(keyOf(answer.id, row.mindId), each);
  if (applyArrived(editor, row.mindId, requests, facts) === "held") setOutcome(each, "held");
}

onAskedApplied((mindId, requests, applied) => {
  for (const each of asked.values()) {
    if (each.mindId !== mindId || ![...requests].some((request) => each.requests.has(request)))
      continue;
    each.applied = applied;
    setOutcome(each, "applied");
  }
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
  const followed = followedOf(answerId, mindId);
  const subscribe = useCallback(
    (changed: () => void) => followed?.observe(changed) ?? (() => undefined),
    [followed],
  );
  return useSyncExternalStore(subscribe, () => stateOf(followed));
}

export function undoAsked(answerId: string, mindId: string): void {
  const followed = followedOf(answerId, mindId);
  if (followed?.onTop()) followed.undo();
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
  for (const row of changedMinds(answer)) follow(answer, row);
  if (answer.status === "streaming") return;
  askedHere.delete(answer.id);
  finish(answer).catch(useAppStore.getState().reportError);
});
