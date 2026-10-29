/**
 * The changes the assistant's commands made (#1110) are one step of Undo per Run, in the window
 * whose Question asked for them, as the User's own changes to the Library are. The step goes on
 * the stack as the Run's first change lands, and back on top as each later one does, and the
 * undo line says what changed ("Renamed 3 Documents · Undo"). ⌘Z, that line or the Answer's card
 * takes all of it back; what couldn't be is tried again from the line, while trying can help.
 * The commands of the window's list that the Run asked this window to run (#1421) run here, and
 * what they changed is part of the same step.
 */
import { create } from "zustand";
import type {
  AnswerToolCall,
  CommandDone,
  CommandKept,
  WindowCommandRequest,
} from "../../core/api";
import { startForAssistant } from "./assistantWindow";
import { clientId } from "./clientId";
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

/** A Run's changes, in the order they landed: the core's, taken back together, and the window's. */
type Part = { kind: "core" } | { kind: "window"; change: Undoable };

interface Step {
  step: Undoable;
  done: CommandDone[];
  parts: Part[];
}

const steps = new Map<string, Step>();
const askedHere = new Set<string>();
// A command can finish before the window hears that its Question was asked here.
const early = new Map<string, AnswerToolCall[]>();
const EARLY_KEPT = 20;
/** What the window's commands changed, by call, until the call's result lands. */
const windowChanges = new Map<string, Undoable>();
/** What the window's commands still going on when their calls returned said, by call. */
const goingOn = new Map<string, CommandDone>();

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

function stepOf(run: string, done: readonly CommandDone[], parts: readonly Part[]): Undoable {
  let kept: CommandKept[] = [];
  /** The parts taken back so far: a try again after a failure takes back only the rest. */
  const undone = new Set<Part>();
  const settle = (taken: boolean, keptNow: readonly CommandKept[]) =>
    useCommandRuns.setState((state) => ({
      undone: { ...state.undone, [run]: taken },
      kept: { ...state.kept, [run]: keptNow },
    }));
  return {
    said: (t) => runText(t, done),
    undoneNote: () => (kept.length > 0 ? keptWords(kept) : null),
    undo: async () => {
      for (const part of [...parts].reverse()) {
        if (undone.has(part)) continue;
        if (part.kind === "window") {
          await part.change.undo();
          undone.add(part);
          continue;
        }
        const taken = await core.undoCommands(run);
        kept = taken.kept;
        const { failed } = taken;
        if (failed) {
          // What is left never can be taken back: the card offers Undo no more.
          if (!failed.again) settle(true, kept);
          const said: Words = (t) =>
            [
              t("error.commands.undoPartly", { reasons: failed.reasons.join(" ") }),
              ...(kept.length > 0 ? [keptWords(kept)(t)] : []),
            ].join(" ");
          // What could be taken back was: trying again takes back what is left.
          throw new UndoRefused(
            said,
            failed.again
              ? { label: (t) => t("checks.tryAgain"), run: async () => undefined }
              : null,
          );
        }
        undone.add(part);
      }
      settle(true, kept);
    },
    redo: async () => {
      for (const part of parts) {
        if (part.kind === "core") await core.redoCommands(run);
        else await part.change.redo?.();
        undone.delete(part);
      }
      kept = [];
      settle(false, []);
    },
  };
}

/** An Answer this window asks for, or asks for again: the commands it runs can be undone here. */
export function watchCommands(answerId: string): void {
  askedHere.add(answerId);
  for (const call of early.get(answerId) ?? []) landed(call);
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

/** Puts what a call did into its Run's step, `before` being what it said earlier, if anything. */
function joinStep(run: string, done: CommandDone, before: CommandDone | null, part: Part | null) {
  const known = steps.get(run);
  if (known) {
    const at = before ? known.done.indexOf(before) : -1;
    if (at >= 0) known.done[at] = done;
    else known.done.push(done);
    if (part && (part.kind === "window" || !known.parts.some((each) => each.kind === "core"))) {
      known.parts.push(part);
    }
    if (known.parts.length > 0) useUndo.getState().renew(known.step);
    return;
  }
  if (!part) return;
  const dones = [done];
  const parts = [part];
  const step = stepOf(run, dones, parts);
  steps.set(run, { step, done: dones, parts });
  useCommandRuns.setState((state) => ({ here: { ...state.here, [run]: true } }));
  useUndo.getState().push(step);
}

function landed(call: AnswerToolCall): void {
  const command = call.command;
  if (!command) return;
  // A window's command that went on lands again when it ends.
  const before = goingOn.get(call.id) ?? null;
  if (command.window?.running) goingOn.set(call.id, command);
  else goingOn.delete(call.id);
  for (const id of [...goingOn.keys()].slice(0, -EARLY_KEPT)) goingOn.delete(id);
  const change = windowChanges.get(call.id);
  windowChanges.delete(call.id);
  const part: Part | null = change
    ? { kind: "window", change }
    : !before && !command.window && undoable([command])
      ? { kind: "core" }
      : null;
  joinStep(command.run, command, before, part);
}

async function runHere(request: WindowCommandRequest): Promise<void> {
  const { started, ended } = startForAssistant(request);
  try {
    if (started) await core.answerWindowCommand(request.requestId, { started: true });
    const { result, change } = await ended;
    const landedAs = goingOn.get(request.toolCallId);
    if (change && landedAs) joinStep(request.run, landedAs, landedAs, { kind: "window", change });
    else if (change) windowChanges.set(request.toolCallId, change);
    if (await core.answerWindowCommand(request.requestId, result)) return;
    // Too late: the Answer says it wasn't done, so it isn't.
    windowChanges.delete(request.toolCallId);
    await change?.undo();
  } catch (error) {
    windowChanges.delete(request.toolCallId);
    useAppStore.getState().reportError(error);
  }
}

core.on("command.windowRun", (request) => {
  if (request.clientId === clientId) void runHere(request);
});

core.on("answer.toolCallFinished", ({ answerId, call }) => {
  if (!call.command) return;
  if (askedHere.has(answerId)) {
    landed(call);
    return;
  }
  early.set(answerId, [...(early.get(answerId) ?? []), call]);
  // Those of Answers another window asked are never wanted here: keep only the latest few.
  for (const answer of [...early.keys()].slice(0, -EARLY_KEPT)) early.delete(answer);
});

core.on("conversation.message", (message) => {
  if (message.kind !== "answer" || message.status === "streaming") return;
  askedHere.delete(message.id);
});
