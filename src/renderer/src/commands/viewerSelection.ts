import { useAppStore } from "../store";
import { viewerHandleInUse } from "./handles";
import type { Command } from "./registry";

const selection = () => viewerHandleInUse("selection", useAppStore.getState().layout);

const range = () => viewerHandleInUse("range", useAppStore.getState().layout);

const slide = () => viewerHandleInUse("slide", useAppStore.getState().layout);

const area = () => viewerHandleInUse("area", useAppStore.getState().layout);

const selected = () => selection() !== null;

const offersAsk = () => selection()?.ask !== undefined;

const offersSlideAsk = () => slide()?.ask !== undefined;

const offersArea = () => area()?.select !== undefined;

const offersAreaHighlight = () => area()?.highlight !== undefined;

const rangeSelected = () => range() !== null;

const rangeOffersAsk = () => range()?.ask !== undefined;

/** The viewer's selection menu in ⌘K (#101), while text is selected in a Document, and its
 *  slide and area actions (#118). */
export const viewerSelectionCommands: readonly Command[] = [
  {
    id: "viewer.slide.ask",
    assistant: false,
    label: "command.viewer.slide.ask",
    group: "main",
    // × on its chip takes it out of the composer.
    reversible: true,
    when: offersSlideAsk,
    run: () => slide()?.ask?.(),
  },
  {
    id: "viewer.area.select",
    assistant: false,
    label: "command.viewer.area.select",
    group: "main",
    // Esc stops it, and nothing changes.
    reversible: true,
    when: offersArea,
    run: () => area()?.select?.(),
  },
  {
    id: "viewer.area.highlight",
    assistant: false,
    label: "command.annotations.highlightArea",
    group: "main",
    // Delete takes the highlight back, with Undo.
    reversible: true,
    when: offersAreaHighlight,
    run: () => area()?.highlight?.(),
  },
  {
    id: "viewer.range.ask",
    assistant: false,
    label: "command.viewer.range.ask",
    group: "main",
    // × on its chip takes it out of the composer.
    reversible: true,
    when: rangeOffersAsk,
    run: () => range()?.ask?.(),
  },
  {
    id: "viewer.range.addToNote",
    label: "command.viewer.range.addToNote",
    group: "main",
    // Undo, on its line, or ⌘Z in the Mind.
    reversible: true,
    when: rangeSelected,
    run: () => range()?.addToNote(),
  },
  {
    id: "viewer.range.copy",
    label: "command.viewer.range.copy",
    group: "edit",
    // Copying changes nothing.
    reversible: true,
    when: rangeSelected,
    run: () => range()?.copy(),
  },
  {
    id: "viewer.selection.ask",
    assistant: false,
    label: "command.viewer.selection.ask",
    group: "main",
    // × on its chip takes it out of the composer.
    reversible: true,
    when: offersAsk,
    run: () => selection()?.ask?.(),
  },
  {
    id: "viewer.selection.highlight",
    label: "command.annotations.highlight",
    group: "main",
    // Delete takes it back, with Undo.
    reversible: true,
    when: selected,
    run: () => selection()?.highlight?.(),
  },
  {
    id: "viewer.selection.addToNote",
    label: "command.viewer.selection.addToNote",
    group: "main",
    // Undo, on its line, or ⌘Z in the Mind.
    reversible: true,
    when: selected,
    run: () => selection()?.addToNote(),
  },
  {
    id: "viewer.selection.copy",
    label: "command.viewer.selection.copy",
    group: "edit",
    // Copying changes nothing.
    reversible: true,
    when: selected,
    run: () => selection()?.copy(),
  },
];
