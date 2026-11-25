import { create } from "zustand";

/** The two places a Note's own controls stand in the strip that shows its tab (#3765). */
export interface NoteControlsPlace {
  /** After the strip's spacer: the check, the comments and Show conversation. */
  controls?: HTMLElement;
  /** At the strip's end, where the strip's own ⋯ stands for any other tab: the Note's ⋯. */
  more?: HTMLElement;
}

/**
 * Where each Note tab's own controls stand while it is the tab its strip shows: the page has no
 * row of its own, so its controls are in one row with the tabs (#3765).
 */
export const useNoteControls = create<{ byTab: Readonly<Record<string, NoteControlsPlace>> }>(
  () => ({ byTab: {} }),
);

/** Sets or takes away one of the places for `tabId`'s controls. */
export function placeNoteControls(
  tabId: string,
  which: keyof NoteControlsPlace,
  element: HTMLElement | null,
): void {
  useNoteControls.setState((state) => {
    const was = state.byTab[tabId] ?? {};
    if ((was[which] ?? null) === element) return state;
    const { [which]: _gone, ...kept } = was;
    const next = element ? { ...kept, [which]: element } : kept;
    const { [tabId]: _tab, ...others } = state.byTab;
    return {
      byTab: Object.keys(next).length > 0 ? { ...others, [tabId]: next } : others,
    };
  });
}
