import { useTabPlace } from "../components/tabs/tabItems";

/** Where a Mind's check cards are kept: its tab, else the Mind, so a Mind beside itself has a card in each. */
export const useCardPlace = (mindId: string) => useTabPlace()?.tabId ?? mindId;
