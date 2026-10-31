import type { MindLook } from "../../shared/wordLook";
import { heldByMind } from "./heldByMind";

export interface ShownWordLook {
  shown: MindLook;
  choose(look: MindLook): void;
  openOriginal: (() => void) | null;
  /** The fonts the look draws its text in (`wordFontsOf`). */
  fonts: readonly string[];
}

const looks = heldByMind<ShownWordLook>();

/** The Minds open in the window that have a Word file's look, for the Look menu and ⌘K. */
export const useWordLooks = looks.use;

export const holdWordLook = looks.hold;
