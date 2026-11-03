import {
  viewerAreaHandle,
  viewerRangeHandle,
  viewerSelectionHandle,
  viewerSlideHandle,
} from "./handles";
import type { Command } from "./registry";

const selected = () => viewerSelectionHandle.current !== null;

const offersAsk = () => viewerSelectionHandle.current?.ask !== undefined;

const offersSlideAsk = () => viewerSlideHandle.current?.ask !== undefined;

const offersArea = () => viewerAreaHandle.current?.select !== undefined;

const rangeSelected = () => viewerRangeHandle.current !== null;

const rangeOffersAsk = () => viewerRangeHandle.current?.ask !== undefined;

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
    run: () => viewerSlideHandle.current?.ask?.(),
  },
  {
    id: "viewer.area.select",
    assistant: false,
    label: "command.viewer.area.select",
    group: "main",
    // Esc stops it, and nothing changes.
    reversible: true,
    when: offersArea,
    run: () => viewerAreaHandle.current?.select?.(),
  },
  {
    id: "viewer.range.ask",
    assistant: false,
    label: "command.viewer.range.ask",
    group: "main",
    // × on its chip takes it out of the composer.
    reversible: true,
    when: rangeOffersAsk,
    run: () => viewerRangeHandle.current?.ask?.(),
  },
  {
    id: "viewer.range.addToNote",
    label: "command.viewer.range.addToNote",
    group: "main",
    // Undo, on its line, or ⌘Z in the Mind.
    reversible: true,
    when: rangeSelected,
    run: () => viewerRangeHandle.current?.addToNote(),
  },
  {
    id: "viewer.range.copy",
    label: "command.viewer.range.copy",
    group: "edit",
    // Copying changes nothing.
    reversible: true,
    when: rangeSelected,
    run: () => viewerRangeHandle.current?.copy(),
  },
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
