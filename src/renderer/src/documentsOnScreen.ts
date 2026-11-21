import { documentsOnScreenOf, groupsMerged } from "./layoutSlice";
import { useAppStore } from "./store";

/** The Documents shown on screen now, by id, the focused group's first: what "this document" means (#1334). */
export const documentsOnScreen = (): string[] =>
  documentsOnScreenOf(useAppStore.getState().layout, groupsMerged());
