import { viewerSelectionHandle } from "./handles";
import type { Command } from "./registry";

const selected = () => viewerSelectionHandle.current !== null;

const offersAsk = () => viewerSelectionHandle.current?.ask !== undefined;

/** The viewer's selection menu in ⌘K (#101), while text is selected in a Document. */
export const viewerSelectionCommands: readonly Command[] = [
  {
    id: "viewer.selection.ask",
    assistant: false,
    label: "command.viewer.selection.ask",
    group: "main",
    // × on its chip takes it out of the composer.
    reversible: true,
    when: offersAsk,
    run: () => viewerSelectionHandle.current?.ask?.(),
  },
  {
    id: "viewer.selection.highlight",
    label: "command.annotations.highlight",
    group: "main",
    // Delete takes it back, with Undo.
    reversible: true,
    when: selected,
    run: () => viewerSelectionHandle.current?.highlight(),
  },
  {
    id: "viewer.selection.note",
    label: "command.annotations.note",
    group: "main",
    // Delete the highlight, with Undo, while its note is open.
    reversible: true,
    when: selected,
    run: () => viewerSelectionHandle.current?.note(),
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
