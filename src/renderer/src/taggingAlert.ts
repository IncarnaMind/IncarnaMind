import { create } from "zustand";

/**
 * Whether the sidebar's footer holds a Tagging problem the User can act on, for the dot on the
 * toggle of a hidden sidebar (#1130). The footer sets it; progress never does.
 */
export const useTaggingAlert = create<{ needsYou: boolean }>(() => ({ needsYou: false }));
