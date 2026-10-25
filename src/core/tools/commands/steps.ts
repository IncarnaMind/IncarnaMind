/**
 * What the commands of one Run changed, kept so one Undo takes all of it back and one Redo
 * does it again (#1110), as the User's own changes are: in this session only. Each change
 * remembers whether it is taken back, so one that fails is tried again, alone, the next time.
 */
import type { CommandKept, CommandsUndone } from "../../api";
import { InvalidInputError, NotFoundError } from "../../errors";

/**
 * One command's change: how to take it back, and how to make it again once taken back. Taking
 * it back gives the Folder or Tag it made and left, when the User filed things in it since.
 */
export interface CommandStep {
  undo(): Promise<CommandKept | null>;
  redo(): Promise<void>;
}

export type CommandSteps = ReturnType<typeof createCommandSteps>;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Change {
  step: CommandStep;
  undone: boolean;
  kept: CommandKept | null;
}

export function createCommandSteps() {
  const runs = new Map<string, { changes: Change[]; tries: number }>();

  const runOf = (runId: string) => {
    const run = runs.get(runId);
    if (!run) throw new NotFoundError({ key: "error.commands.undoGone" });
    return run;
  };

  return {
    add(runId: string, step: CommandStep): void {
      const run = runs.get(runId) ?? { changes: [], tries: 0 };
      run.changes.push({ step, undone: false, kept: null });
      runs.set(runId, run);
    },

    /** Takes back every change of the Run not yet taken back, the last first. */
    async undo(runId: string): Promise<CommandsUndone> {
      const run = runOf(runId);
      const latest = [...run.changes].reverse();
      const reasons: string[] = [];
      let tookBack = false;
      for (const change of latest) {
        if (change.undone) continue;
        try {
          change.kept = await change.step.undo();
          change.undone = true;
          tookBack = true;
        } catch (error) {
          reasons.push(reasonOf(error));
        }
      }
      const retried = run.tries > 0;
      run.tries++;
      const kept = latest.flatMap((change) => (change.undone && change.kept ? [change.kept] : []));
      if (reasons.length === 0) return { kept, failed: null };
      // A Document restored meanwhile can be renamed back, so the first failure offers a try
      // again; one that took back nothing more won't do better the next time.
      return { kept, failed: { reasons, again: !retried || tookBack } };
    },

    /** Makes again every change of the Run taken back, in the order they were made. */
    async redo(runId: string): Promise<void> {
      const run = runOf(runId);
      run.tries = 0;
      const failed: string[] = [];
      for (const change of run.changes) {
        if (!change.undone) continue;
        try {
          await change.step.redo();
          change.undone = false;
          change.kept = null;
        } catch (error) {
          failed.push(reasonOf(error));
        }
      }
      if (failed.length > 0) {
        throw new InvalidInputError({
          key: "error.commands.redoPartly",
          values: { reasons: failed.join(" ") },
        });
      }
    },
  };
}
