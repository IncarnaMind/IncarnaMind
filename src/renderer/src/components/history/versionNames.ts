import type { Checkpoint } from "../../../../core/api";
import { core } from "../../core";
import { makeInTurn, useUndo } from "../../undo";

/** Where History shows the line of a name it gave, so ⌘Z there takes it back (`UndoLineAt`). */
export const HISTORY_UNDO_PLACE = "history";

/**
 * Names a version, with its line and Undo, in turn with Undo, Redo and other names: ⌘Z takes back
 * the names in the order they were given, to the name each one replaced when it was saved.
 */
export const renameVersion = (
  mindId: string,
  checkpoint: Checkpoint,
  name: string | null,
  onNamed: (checkpoint: Checkpoint) => void,
): Promise<void> =>
  makeInTurn(async () => {
    const { checkpoint: named, was } = await core.renameCheckpoint(mindId, checkpoint.id, name);
    onNamed(named);
    useUndo.getState().push({
      said: (say) => (name ? say("history.named", { name }) : say("history.unnamed")),
      shownAt: HISTORY_UNDO_PLACE,
      undo: async () => {
        await core.renameCheckpoint(mindId, checkpoint.id, was);
      },
      redo: async () => {
        await core.renameCheckpoint(mindId, checkpoint.id, name);
      },
    });
  });
