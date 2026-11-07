import { create } from "zustand";
import type { MindCheckEarly } from "../../core/api";
import { core } from "./core";

/**
 * By Note: the sentences its Check this Note run checks before it marks them (#1624), drawn as
 * checking in the margin and counted in the run's line. They live in the window only; the Note's
 * own marks come once the run has named every claim.
 */
export const useEarlyChecks = create<{ byMind: Readonly<Record<string, MindCheckEarly>> }>()(
  () => ({ byMind: {} }),
);

core.on("mindCheck.early", (event) => {
  useEarlyChecks.setState(({ byMind }) => {
    const next = { ...byMind };
    if (event.sentences.length > 0) next[event.mindId] = event;
    else delete next[event.mindId];
    return { byMind: next };
  });
});
