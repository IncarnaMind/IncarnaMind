export interface Run {
  insert: string;
  attributes: Record<string, unknown>;
}
export interface Retain {
  retain: number;
  attributes?: Record<string, unknown>;
}
export function formatChanges(ytext: { toDelta(): unknown[] }, content: readonly Run[]): Retain[];
export function changedMarks(
  wanted: Record<string, unknown>,
  held: Record<string, unknown>,
): Record<string, unknown> | null;
export function sameValue(a: unknown, b: unknown): boolean;
