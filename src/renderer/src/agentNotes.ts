/**
 * What the User's own AI agent did to a Note while IncarnaMind is open (#3371). A Note it wrote
 * opens in a tab behind the one in front, as a Note the assistant made does once the User has
 * gone elsewhere, so the keyboard stays where they type. A change to a Note it wrote applied at
 * once: a line says what changed where the Library's work shows, until its Open or ✕, and ⌘Z
 * takes the change back, last first, while its Note is shown.
 */
import { create } from "zustand";
import type { AgentChangeStep, AgentNoteChange } from "../../core/api";
import { core } from "./core";
import { groupsMerged, isShown } from "./layoutSlice";
import type { WordsInLine } from "./lineNames";
import { useAppStore } from "./store";
import { type Undoable, UndoRefused, useUndo } from "./undo";

/** The latest of each Note's, the newest last. */
export const useAgentNotes = create<{ lines: readonly AgentNoteChange[] }>()(() => ({
  lines: [],
}));

/** What a line says: who wrote or changed the Note, and what changed. */
export function agentNoteWords(change: AgentNoteChange, mind: string): WordsInLine {
  const name = change.agent;
  return (t) => {
    if (change.kind === "wrote") return t("agents.note.wrote", { name, mind });
    if (change.tables === 0 && change.changed > 0) {
      return change.changed === 1
        ? t("agents.note.changed.one", { name, mind })
        : t("agents.note.changed", { name, mind, count: change.changed });
    }
    if (change.tables === 0 && change.added > 0) {
      return change.added === 1
        ? t("agents.note.added.one", { name, mind })
        : t("agents.note.added", { name, mind, count: change.added });
    }
    return t("agents.note.edited", { name, mind });
  };
}

const forget = (mindId: string) =>
  useAgentNotes.setState(({ lines }) => ({
    lines: lines.filter((line) => line.mindId !== mindId),
  }));

export const dismissAgentNote = forget;

/** Open: the Note's tab, where it is open, in front. */
export function openAgentNote(mindId: string): void {
  forget(mindId);
  useAppStore.getState().openMind(mindId);
}

const nameOf = (mindId: string) => {
  const mind = useAppStore.getState().minds.find((each) => each.id === mindId);
  return mind ? mind.title || mind.autoTitle : "";
};

/** Each Note's changes on the app's Undo, by Note: the ones taken back go once the agent changes it again. */
const offered = new Map<string, Undoable[]>();

/**
 * Takes a change back, or does it again, exactly as the core did: a step with nothing of its change
 * left, or no longer the Note's last, leaves the stack, and its line says which change it was.
 */
async function stepOf(
  change: AgentNoteChange,
  step: "undo" | "redo",
  run: () => Promise<AgentChangeStep>,
): Promise<void> {
  const done = await run();
  if (done === "done") return;
  const mind = nameOf(change.mindId);
  throw new UndoRefused(
    (t) =>
      done === "nothing-left"
        ? t(step === "undo" ? "agents.note.nothingToUndo" : "agents.note.nothingToRedo", {
            name: change.agent,
            mind,
          })
        : t("agents.note.undoGone"),
    null,
  );
}

/** Puts the change on the app's Undo, which ⌘Z and ⇧⌘Z pass over while its Note isn't shown. */
function offerUndo(change: AgentNoteChange, step: string): void {
  // The core forgets the steps taken back once the agent changes the Note again: Redo can't reach them.
  const before = offered.get(change.mindId) ?? [];
  for (const each of before) {
    if (useUndo.getState().undone.includes(each)) useUndo.getState().withdraw(each);
  }
  const undoable: Undoable = {
    said: (t, cut) => agentNoteWords(change, nameOf(change.mindId))(t, cut),
    undo: () => stepOf(change, "undo", () => core.undoAgentChange(step)),
    redo: () => stepOf(change, "redo", () => core.redoAgentChange(step)),
  };
  offered.set(change.mindId, [
    ...before.filter((each) => {
      const { done, undone } = useUndo.getState();
      return done.includes(each) || undone.includes(each);
    }),
    undoable,
  ]);
  const recheck = () => {
    const { done, undone, running } = useUndo.getState();
    if (!done.includes(undoable) && !undone.includes(undoable)) {
      if (running?.change !== undoable) stop();
      return;
    }
    const item = { kind: "mind" as const, mindId: change.mindId };
    useUndo
      .getState()
      .setAside(undoable, !isShown(useAppStore.getState().layout, item, groupsMerged()));
  };
  const stopLayout = useAppStore.subscribe((state, before) => {
    if (state.layout !== before.layout) recheck();
  });
  const stopUndo = useUndo.subscribe(recheck);
  const stop = () => {
    stopLayout();
    stopUndo();
  };
  useUndo.getState().offer(undoable);
  recheck();
}

core.on("agents.noteChanged", (change) => {
  useAgentNotes.setState(({ lines }) => ({
    lines: [...lines.filter((line) => line.mindId !== change.mindId), change],
  }));
  if (change.kind === "wrote") useAppStore.getState().openMind(change.mindId, { behind: true });
  else if (change.step !== null) offerUndo(change, change.step);
});
