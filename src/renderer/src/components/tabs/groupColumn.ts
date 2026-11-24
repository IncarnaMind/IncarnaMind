import { createContext } from "react";

/**
 * Where a tab group draws the Note's conversation as a column the group's full height, beside its
 * tab strip and its body (#3677); null outside a tab group.
 */
export const GroupColumnContext = createContext<HTMLElement | null>(null);
