import { viewerSelectionHandle } from "./handles";
import type { Command } from "./registry";

const selected = () => viewerSelectionHandle.current !== null;

const offersAsk = () => viewerSelectionHandle.current?.ask !== undefined;

/** The viewer's selection menu in ⌘K (#101), while text is selected in a Document. */
export const viewerSelectionCommands: readonly Command[] = [
  {
    id: "viewer.selection.ask",
    label: "command.viewer.selection.ask",
    group: "main",
    // × on its chip takes it out of the composer.
    reversible: true,
    when: offersAsk,
    run: () => viewerSelectionHandle.current?.ask?.(),
  },
  {
    id: "viewer.selection.addToNote",
    label: "command.viewer.selection.addToNote",
    group: "main",
    // Undo, on its line, or ⌘Z in the Mind.
    reversible: true,
    when: selected,
    run: () => viewerSelectionHandle.current?.addToNote(),
  },
  {
    id: "viewer.selection.copy",
    label: "command.viewer.selection.copy",
    group: "edit",
    // Copying changes nothing.
    reversible: true,
    when: selected,
    run: () => viewerSelectionHandle.current?.copy(),
  },
];
