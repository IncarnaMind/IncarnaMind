import { NO_MIND, useComposer } from "../composer";
import { focusComposer } from "./assistant";
import type { Command } from "./registry";

export const analysisCommands: readonly Command[] = [
  {
    id: "analysis.start",
    label: "analysis.command",
    keywords: ["analysis.command.keywords"],
    group: "main",
    // It only marks the composer; the chip's × or Esc takes it back.
    reversible: true,
    run: () => {
      const { seat, update } = useComposer.getState();
      update(seat?.mindId ?? NO_MIND, { analyse: true, research: false });
      focusComposer();
    },
  },
];
