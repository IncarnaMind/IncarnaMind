import { saidInLine } from "../../src/renderer/src/lineNames";
import type { Translate } from "../../src/renderer/src/objects";
import type { Undoable } from "../../src/renderer/src/undo";

/** What a change's undo line and its Edit menu name say in the words of `t`. */
export function undoLines(t: Translate) {
  return {
    said: (change: Undoable | undefined) => change && saidInLine(t, change.said).message,
    named: (change: Undoable | undefined) => change?.name?.(t),
  };
}
