import { KEYS_FROM_CANVASES } from "../../../shared/commands";
import { usePalette } from "../palette";
import type { Command } from "./registry";

export const paletteCommands: readonly Command[] = [
  {
    id: "palette.open",
    label: "command.palette.open",
    shortcut: { keys: KEYS_FROM_CANVASES["palette.open"] },
    palette: false,
    group: "open",
    reversible: true,
    run: () => usePalette.getState().show(),
  },
];
