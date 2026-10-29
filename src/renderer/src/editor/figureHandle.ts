export interface FigureHandle {
  id: string;
  editable(): boolean;
  open(): void;
  copyFormula(): void;
  convertToText(): void;
  remove(): void;
}

export const figureHandle: { current: FigureHandle | null } = { current: null };
