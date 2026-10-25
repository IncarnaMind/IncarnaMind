import { setImmediate as nextTurn } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

/** A WeakRef keeps its target until the turn that made it ends, so this waits a turn before it collects. */
export async function isFreed(ref: WeakRef<object>): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await nextTurn();
    collect();
    if (ref.deref() === undefined) return true;
  }
  return false;
}
