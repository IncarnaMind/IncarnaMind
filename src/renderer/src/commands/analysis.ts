import { NO_MIND, useComposer } from "../composer";
import { ownAiOnlyNow } from "../ownAiPanel";
import { useResearch } from "../research";
import { focusComposer } from "./assistant";
import type { Command } from "./registry";

export const analysisCommands: readonly Command[] = [
  {
    id: "analysis.start",
    label: "analysis.command",
    keywords: ["analysis.command.keywords"],
    group: "main",
    reversible: true,
    // The panel's, which a User with only their own AI never sees (#3612).
    when: () => !ownAiOnlyNow(),
    enabled: () => {
      const { seat } = useComposer.getState();
      return seat && useResearch.getState().plans[seat.mindId]
        ? { reason: "analysis.planOpen" }
        : true;
    },
    run: () => {
      const { seat, update } = useComposer.getState();
      update(seat?.mindId ?? NO_MIND, { analyse: true, research: false });
      focusComposer();
    },
  },
];
