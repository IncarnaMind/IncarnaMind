import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import type { Words, WordsInLine } from "../lineNames";
import { type Undoable, useUndo } from "../undo";
import { historyEditor, keptHistory, onHistoryEnd, onHistoryShown } from "./keptHistories";

type StackEvent = "stack-item-added" | "stack-item-popped";
type StackListener = (event: { stackItem: UndoStep; type: "undo" | "redo" }) => void;
type DeleteSet = ReturnType<typeof Y.createDeleteSet>;

/** One step of Undo: what it inserted and deleted, by Yjs item. */
export interface UndoStep {
  insertions: DeleteSet;
  deletions: DeleteSet;
}

export interface UndoStack {
  undoStack: UndoStep[];
  redoStack: UndoStep[];
  /** True while an Undo is being done: the step it adds is the one that does it again. */
  undoing: boolean;
  /** True while a Redo is being done: the step it adds is the one it brings back, not an edit. */
  redoing: boolean;
  /** A change soon after the last one joins its step. */
  lastChange: number;
  stopCapturing(): void;
  /** Takes back the last step, or does the last one taken back again, with no editor to show it. */
  undo(): unknown;
  redo(): unknown;
  addTrackedOrigin(origin: unknown): void;
  removeTrackedOrigin(origin: unknown): void;
  addToScope: Y.UndoManager["addToScope"];
  /** Whether Undo or Redo deletes this item it inserted: a paragraph that isn't empty it keeps. */
  deleteFilter(item: Y.Item): boolean;
  on(event: StackEvent, listener: StackListener): void;
  on(event: "stack-cleared", listener: () => void): void;
  off(event: StackEvent, listener: StackListener): void;
  off(event: "stack-cleared", listener: () => void): void;
}

export const undoStackOf = (editor: Editor): UndoStack | undefined =>
  yUndoPluginKey.getState(editor.state)?.undoManager;

/**
 * What a Note's steps are kept by: the history its tab keeps (../tabCopies), which outlives the
 * tab's editors, or else the editor itself (#3115).
 */
export function historyOwnerOf(editor: Editor): object {
  const stack = undoStackOf(editor);
  return stack && keptHistory(stack) ? stack : editor;
}

/** How a step's follower reaches the Note, and hears it end. */
interface Reach {
  shown(): Editor | null;
  kept: boolean;
  /** The tab still keeps the history, or the editor still lives. */
  lasts(): boolean;
  onEnd(listener: () => void): () => void;
}

// Apart, so that what follows a tab's history holds none of the editors that once showed it.
const keptReach = (manager: UndoStack): Reach => ({
  shown: () => historyEditor(manager),
  kept: true,
  lasts: () => keptHistory(manager) !== undefined,
  onEnd: (listener) => onHistoryEnd(manager, listener),
});

const editorReach = (editor: Editor): Reach => ({
  shown: () => (editor.isDestroyed ? null : editor),
  kept: false,
  lasts: () => !editor.isDestroyed,
  onEnd: (listener) => {
    editor.on("destroy", listener);
    return () => void editor.off("destroy", listener);
  },
});

/**
 * In a tab that keeps the Note's history (../tabCopies), through whichever editor shows it now,
 * ending with the tab; elsewhere through `editor`, ending with it.
 */
const reachOf = (editor: Editor, manager: UndoStack): Reach =>
  keptHistory(manager) ? keptReach(manager) : editorReach(editor);

const takenOutListeners = new WeakMap<object, Set<(steps: ReadonlySet<UndoStep>) => void>>();

/**
 * Takes steps out of a Note's history, from both of its stacks: ⌘Z and ⇧⌘Z no longer reach them,
 * and what follows them hears it (`onTakenOut`). What is done next is a step of its own.
 */
export function takeOutOfHistory(manager: UndoStack, steps: ReadonlySet<UndoStep>): void {
  if (steps.size === 0) return;
  const without = (stack: UndoStep[]) =>
    stack.splice(0, stack.length, ...stack.filter((step) => !steps.has(step)));
  without(manager.undoStack);
  without(manager.redoStack);
  manager.stopCapturing();
  for (const listener of [...(takenOutListeners.get(manager) ?? [])]) listener(steps);
}

export function onTakenOut(
  manager: UndoStack,
  listener: (steps: ReadonlySet<UndoStep>) => void,
): () => void {
  const listeners = takenOutListeners.get(manager) ?? new Set();
  takenOutListeners.set(manager, listeners);
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Keeps an entry of the app's Undo that belongs to a tab's kept history (#3115) in that tab's
 * sight: while no editor of the tab shows the Note, ⌘Z and ⇧⌘Z pass over it and its line goes, and
 * once one shows it, it is back; it leaves the stack with the tab. `hidden` says when it is out of
 * sight besides, as on a view that hides the Note's words; for an entry of any other history it is
 * all that counts. `recheck` reads it again, once the entry is on the stack and whenever `hidden`
 * may have changed; `stop` is for when the entry leaves the stack.
 */
export function keepInSight(
  history: object | null,
  change: Undoable,
  hidden?: () => boolean,
): { recheck(): void; stop(): void } {
  const kept = history && keptHistory(history) ? history : null;
  const recheck = () => {
    const { done, undone, running } = useUndo.getState();
    if (!done.includes(change) && !undone.includes(change)) {
      if (running?.change !== change) stop();
      return;
    }
    const away = kept !== null && historyEditor(kept) === null;
    useUndo.getState().setAside(change, away || hidden?.() === true);
    if (away && useUndo.getState().line?.change === change) useUndo.getState().dismiss();
  };
  const stopShown = kept ? onHistoryShown(kept, recheck) : () => undefined;
  const stopEnd = kept
    ? onHistoryEnd(kept, () => {
        stop();
        useUndo.getState().withdraw(change);
      })
    : () => undefined;
  const stop = () => {
    stopShown();
    stopEnd();
  };
  return { recheck, stop };
}

/**
 * Makes what `change` does to the note one step of its Undo, apart from the
 * typing before and after it, so ⌘Z in the note takes back that and nothing else.
 */
export function asOneStep<T>(editor: Editor, change: () => T): T {
  const stack = undoStackOf(editor);
  stack?.stopCapturing();
  try {
    return change();
  } finally {
    stack?.stopCapturing();
  }
}

/**
 * Puts the note's last step on the app's undo stack, with its line ("Accepted
 * 2 changes · Undo", or under an Answer with `shownAt`). It follows the step
 * through the note's own history: taken back there or here, ⇧⌘Z here does it
 * again, as ⌘⇧Z in the note would. Once the User edits again, takes back an
 * earlier step in the note, or closes the note, it leaves the stack.
 * `onUndone` puts back what the step left behind outside the note's history,
 * such as a check's result the core wrote over (#1247), and `onRedone` makes
 * that again once the step is done again: without it, only the note's own
 * ⇧⌘Z does the step again. Returns what takes it off the stack, which holds the change it put
 * there.
 *
 * In a tab that keeps the Note's history (#3115), a tab switch leaves the step where it is, in the
 * tab's sight (`keepInSight`, with `also.hidden`), and the editor drawn there next takes it back.
 * A step taken out of the history (`takeOutOfHistory`) takes it off the stack.
 */
export function offerEditorUndo(
  editor: Editor,
  said: WordsInLine,
  shownAt?: string,
  onUndone?: () => void,
  onRedone?: () => void,
  also: { name?: Words; hidden?: () => boolean } = {},
): EditorUndoOffer {
  const manager = undoStackOf(editor);
  const last = manager?.undoStack.at(-1);
  if (!manager || last === undefined) return Object.assign(() => undefined, { recheck() {} });
  const reach = reachOf(editor, manager);
  let step = last;
  /** What brings the step back, on the note's redo stack, while it is taken back. */
  let reversal: UndoStep | undefined;
  /** Undo and Redo add the step that reverses the one they pop, just before they pop it. */
  let added: UndoStep | undefined;
  const change: Undoable = {
    said,
    ...(also.name && { name: also.name }),
    undo: async () => {
      if (manager.undoStack.at(-1) !== step) return;
      const shown = reach.shown();
      if (shown) shown.commands.undo();
      else if (reach.kept) manager.undo();
    },
    ...((!onUndone || onRedone) && {
      redo: async () => {
        if (!reversal || manager.redoStack.at(-1) !== reversal) return;
        const shown = reach.shown();
        if (shown) shown.commands.redo();
        else if (reach.kept) manager.redo();
      },
    }),
    ...(shownAt && { shownAt }),
  };
  const sight = keepInSight(manager, change, also.hidden);
  /** Moves it to the other stack when the note itself took the step, not ⌘Z or ⇧⌘Z here. */
  const followHere = (taken: "undo" | "redo") => {
    if (useUndo.getState().running?.change !== change) useUndo.getState().follow(change, taken);
  };
  const forget = () => {
    manager.off("stack-item-added", onAdded);
    manager.off("stack-item-popped", onPopped);
    manager.off("stack-cleared", onCleared);
    stopTaken();
    stopEnd();
    sight.stop();
    useUndo.getState().withdraw(change);
  };
  const onAdded = (event: { stackItem: UndoStep; type: "undo" | "redo" }) => {
    if (event.type === "redo" || manager.redoing) added = event.stackItem;
    else forget();
  };
  const onPopped = (event: { stackItem: UndoStep; type: "undo" | "redo" }) => {
    if (event.type === "undo" && event.stackItem === step) {
      if (change.redo) {
        reversal = added;
        followHere("undo");
      } else forget();
      onUndone?.();
    } else if (event.type === "redo" && reversal && event.stackItem === reversal) {
      if (added) step = added;
      reversal = undefined;
      onRedone?.();
      followHere("redo");
    } else forget();
  };
  const onCleared = () => {
    const held = reversal ? manager.redoStack.includes(reversal) : manager.undoStack.includes(step);
    if (!held) forget();
  };
  manager.on("stack-item-added", onAdded);
  manager.on("stack-item-popped", onPopped);
  manager.on("stack-cleared", onCleared);
  const stopTaken = onTakenOut(manager, onCleared);
  const stopEnd = reach.onEnd(forget);
  useUndo.getState().push(change);
  sight.recheck();
  return Object.assign(forget, { change, recheck: sight.recheck });
}

/**
 * Takes an editor's step off the app's undo stack; `change` is what it put there, if anything, and
 * `recheck` reads again whether its words show.
 */
export type EditorUndoOffer = (() => void) & {
  readonly change?: Undoable;
  readonly recheck: () => void;
};

/**
 * Steps of a note's Undo, followed as ⌘Z takes them back and ⌘⇧Z does them
 * again, each time as a new step: whether they are in the note ("done"),
 * taken back ("undone"), or no longer in its history ("gone", as when it closed).
 */
export interface FollowedSteps {
  state(): "done" | "undone" | "gone";
  /** Done, and nothing done in the note since: Undo takes back these steps alone. */
  onTop(): boolean;
  add(step: UndoStep): void;
  undo(): undefined | boolean | Promise<boolean | undefined>;
  redo?(): undefined | boolean | Promise<boolean | undefined>;
  canRedo?(): boolean;
  settled?(): Promise<void>;
  release?(): void | Promise<void>;
  observe(listener: () => void): () => void;
}

/** Steps followed in one note's history, which can also be taken out of it. */
export interface NoteSteps extends FollowedSteps {
  /** The steps whose changes are in the note now: none while they are taken back. */
  inNote(): readonly UndoStep[];
  /** Takes the steps out of the note's history: ⌘Z and ⇧⌘Z no longer reach them. */
  drop(): void;
  /** Taken back, and what puts them back is the next ⇧⌘Z. */
  redoesNext(): boolean;
}

/** What hears one history's steps move for one `followSteps`. */
interface Follower {
  added(step: UndoStep): void;
  popped(step: UndoStep, type: "undo" | "redo"): void;
  cleared(): void;
  ended(): void;
}

interface Following {
  followers: Set<Follower>;
  stop(): void;
}

/** Each history's followers, heard through one set of its listeners, however many there are. */
const followings = new WeakMap<UndoStack, Following>();

function follow(manager: UndoStack, reach: Reach, follower: Follower): () => void {
  const following = followings.get(manager) ?? listenTo(manager, reach);
  following.followers.add(follower);
  return () => {
    following.followers.delete(follower);
    if (following.followers.size === 0) following.stop();
  };
}

function listenTo(manager: UndoStack, reach: Reach): Following {
  const followers = new Set<Follower>();
  const each = (call: (one: Follower) => void) => {
    for (const one of [...followers]) call(one);
  };
  const added: StackListener = ({ stackItem }) => each((one) => one.added(stackItem));
  const popped: StackListener = ({ stackItem, type }) => each((one) => one.popped(stackItem, type));
  const cleared = () => each((one) => one.cleared());
  manager.on("stack-item-added", added);
  manager.on("stack-item-popped", popped);
  manager.on("stack-cleared", cleared);
  const stopTaken = onTakenOut(manager, cleared);
  const stopEnd = reach.onEnd(() => {
    const all = [...followers];
    followers.clear();
    following.stop();
    for (const one of all) one.ended();
  });
  const following: Following = {
    followers,
    stop: () => {
      manager.off("stack-item-added", added);
      manager.off("stack-item-popped", popped);
      manager.off("stack-cleared", cleared);
      stopTaken();
      stopEnd();
      if (followings.get(manager) === following) followings.delete(manager);
    },
  };
  followings.set(manager, following);
  return following;
}

export function followSteps(editor: Editor, first: readonly UndoStep[]): NoteSteps | null {
  const manager = undoStackOf(editor);
  if (!manager) return null;
  const reach = reachOf(editor, manager);
  let gone = false;
  const ended = () => gone || !reach.lasts();
  const done = new Set(first);
  const undone = new Set<UndoStep>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  // Undo and Redo add the step that reverses the one they pop, just before they pop it.
  let added: UndoStep | null = null;
  let unfollow: (() => void) | null = null;
  const held = () =>
    manager.undoStack.some((step) => done.has(step)) ||
    manager.redoStack.some((step) => undone.has(step));
  // Off both stacks, nothing brings the steps back: their state holds, and nothing more is heard.
  const settle = () => {
    if (unfollow && !manager.undoing && !manager.redoing && !held()) {
      unfollow();
      unfollow = null;
    }
  };
  const follower: Follower = {
    added(step) {
      added = step;
      // Undo and Redo pop their step next, which says where the steps are now.
      if (manager.undoing || manager.redoing) return;
      settle();
      changed();
    },
    popped(step, type) {
      const from = type === "undo" ? done : undone;
      const to = type === "undo" ? undone : done;
      if (from.delete(step) && added) to.add(added);
      settle();
      changed();
    },
    cleared() {
      settle();
      changed();
    },
    ended() {
      gone = true;
      unfollow = null;
      changed();
    },
  };
  const listen = () => {
    if (!ended() && !unfollow) unfollow = follow(manager, reach, follower);
  };
  listen();
  const inStack = () => manager.undoStack.filter((step) => done.has(step));
  const followed: NoteSteps = {
    state() {
      if (ended()) return "gone";
      if (inStack().length > 0) return "done";
      return undone.size > 0 ? "undone" : "gone";
    },
    onTop() {
      const ours = inStack().length;
      return !ended() && ours > 0 && manager.undoStack.slice(-ours).every((step) => done.has(step));
    },
    add(step) {
      done.add(step);
      listen();
      changed();
    },
    undo() {
      let top = manager.undoStack.at(-1);
      while (!ended() && top !== undefined && done.has(top)) {
        const shown = reach.shown();
        if (shown) shown.commands.undo();
        else if (reach.kept) manager.undo();
        else break;
        if (manager.undoStack.at(-1) === top) break;
        top = manager.undoStack.at(-1);
      }
    },
    observe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    inNote: inStack,
    redoesNext() {
      const next = manager.redoStack.at(-1);
      return next !== undefined && undone.has(next);
    },
    drop() {
      const steps = new Set([...done, ...undone]);
      done.clear();
      undone.clear();
      takeOutOfHistory(manager, steps);
      settle();
      changed();
    },
  };
  return followed;
}
