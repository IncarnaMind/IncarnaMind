import { create } from "zustand";

/**
 * The assistant's height the question waiting in its tray needs to be read whole (#1400), which
 * the bottom dock grows to while it waits; null when no question waits. `resized`: the User has
 * resized the dock meanwhile, so their own height holds, now and after.
 */
export const useQuestionRoom = create<{ fits: number | null; resized: boolean }>()(() => ({
  fits: null,
  resized: false,
}));
