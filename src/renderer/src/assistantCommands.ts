/**
 * The changes the assistant's commands made (#1110) are one step of Undo per Run, in the window
 * whose Question asked for them, as the User's own changes to the Library are. The step goes on
 * the stack as the Run's first change lands, and back on top as each later one does, and the
 * undo line says what changed ("Renamed 3 Documents · Undo"). ⌘Z, that line or the Answer's card
 * takes all of it back; what couldn't be is tried again from the line, while trying can help.
 */
import { create } from "zustand";
import type { CommandDone, CommandKept } from "../../core/api";
import { runText, undoable } from "./commandFacts";
import { core } from "./core";
import type { Words } from "./lineNames";
import { useAppStore } from "./store";
import { type Undoable, UndoRefused, useUndo } from "./undo";

interface CommandRunsState {
  /** The Runs whose changes this window can take back. */
  here: Readonly<Record<string, true>>;
  /** By Run: whether its changes were taken back. */
  undone: Readonly<Record<string, boolean>>;
  /** By Run: the Folders and Tags its Undo left in place, for what the User put in them since. */
  kept: Readonly<Record<string, readonly CommandKept[]>>;
}

export const useCommandRuns = create<CommandRunsState>()(() => ({
  here: {},
  undone: {},
  kept: {},
}));

const steps = new Map<string, { step: Undoable; done: CommandDone[] }>();
const askedHere = new Set<string>();
// A command can finish before the window hears that its Question was asked here.
const early = new Map<string, CommandDone[]>();
const EARLY_KEPT = 20;

export const keptWords =
  (kept: readonly CommandKept[]): Words =>
  (t) =>
    kept
      .map((each) =>
        t(each.kind === "folder" ? "commands.kept.folder" : "commands.kept.tag", {
          name: each.name,
        }),
      )
      .join(" ");

function stepOf(run: string, done: readonly CommandDone[]): Undoable {
  let kept: CommandKept[] = [];
  return {
    said: (t) => runText(t, done),
    undoneNote: () => (kept.length > 0 ? keptWords(kept) : null),
    undo: async () => {
      const undone = await core.undoCommands(run);
      kept = undone.kept;
      const { failed } = undone;
      // All of it taken back, or what is left never can be: the card offers Undo no more.
      if (!failed?.again) {
        useCommandRuns.setState((state) => ({
          undone: { ...state.undone, [run]: true },
          kept: { ...state.kept, [run]: kept },
        }));
      }
      if (!failed) return;
      const said: Words = (t) =>
        [
          t("error.commands.undoPartly", { reasons: failed.reasons.join(" ") }),
          ...(kept.length > 0 ? [keptWords(kept)(t)] : []),
        ].join(" ");
      // What could be taken back was: trying again takes back what is left.
      throw new UndoRefused(
        said,
        failed.again ? { label: (t) => t("checks.tryAgain"), run: async () => undefined } : null,
      );
    },
    redo: async () => {
      await core.redoCommands(run);
      useCommandRuns.setState((state) => ({
        undone: { ...state.undone, [run]: false },
        kept: { ...state.kept, [run]: [] },
      }));
    },
  };
}

/** An Answer this window asks for, or asks for again: the commands it runs can be undone here. */
export function watchCommands(answerId: string): void {
  askedHere.add(answerId);
  for (const done of early.get(answerId) ?? []) landed(done);
  early.delete(answerId);
}

/** The card's Undo: the same step ⌘Z takes, which then leaves the stack. */
export async function undoRun(run: string): Promise<void> {
  const step = steps.get(run)?.step;
  if (!step) return;
  const undo = useUndo.getState();
  if (undo.done.at(-1) === step) {
    await undo.undo();
    return;
  }
  try {
    await step.undo();
    undo.withdraw(step);
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}

function landed(command: CommandDone): void {
  const known = steps.get(command.run);
  if (known) {
    known.done.push(command);
    useUndo.getState().renew(known.step);
    return;
  }
  if (!undoable([command])) return;
  const done = [command];
  const step = stepOf(command.run, done);
  steps.set(command.run, { step, done });
  useCommandRuns.setState((state) => ({ here: { ...state.here, [command.run]: true } }));
  useUndo.getState().push(step);
}

core.on("answer.toolCallFinished", ({ answerId, call }) => {
  if (!call.command) return;
  if (askedHere.has(answerId)) {
    landed(call.command);
    return;
  }
  early.set(answerId, [...(early.get(answerId) ?? []), call.command]);
  // Those of Answers another window asked are never wanted here: keep only the latest few.
  for (const answer of [...early.keys()].slice(0, -EARLY_KEPT)) early.delete(answer);
});

core.on("conversation.message", (message) => {
  if (message.kind === "answer" && message.status !== "streaming") askedHere.delete(message.id);
});
