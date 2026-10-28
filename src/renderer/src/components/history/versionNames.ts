import type { Checkpoint } from "../../../../core/api";
import { core } from "../../core";
import { makeInTurn, useUndo } from "../../undo";

/** Where History shows the line of a name it gave, so ⌘Z there takes it back (`UndoLineAt`). */
export const HISTORY_UNDO_PLACE = "history";

/**
 * Names a version, with its line and Undo, in turn with Undo and Redo: a ⌘Z pressed while the
 * name is saved takes back this name, not an earlier one.
 */
export const renameVersion = (
  mindId: string,
  checkpoint: Checkpoint,
  name: string | null,
  onNamed: (checkpoint: Checkpoint) => void,
): Promise<void> =>
  makeInTurn(async () => {
    const before = checkpoint.name;
    onNamed(await core.renameCheckpoint(mindId, checkpoint.id, name));
    useUndo.getState().push({
      said: (say) => (name ? say("history.named", { name }) : say("history.unnamed")),
      shownAt: HISTORY_UNDO_PLACE,
      undo: async () => {
        await core.renameCheckpoint(mindId, checkpoint.id, before);
      },
      redo: async () => {
        await core.renameCheckpoint(mindId, checkpoint.id, name);
      },
    });
  });
