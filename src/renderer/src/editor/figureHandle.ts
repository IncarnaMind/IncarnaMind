import type { CommandContext } from "../commands/registry";

export interface FigureHandle {
  id: string;
  editable(): boolean;
  open(): void;
  copyFormula(): void;
  convertToText(): void;
  remove(): void;
  /** What its card offers only there, for ⌘K, which takes them as it opens (#1933). */
  here(): CommandContext["here"];
}

export const figureHandle: { current: FigureHandle | null } = { current: null };
