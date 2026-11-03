import type { EditAction } from "../api";

export const MOST_OF_IT = 0.5;

/** New text maps onto the selection when at least half of it is found there. */
export function mapsOnto(found: number, total: number): boolean {
  return total === 0 || found / total >= MOST_OF_IT;
}

/** What was meant can't be told when new text maps onto none of the selection and removes most of it: it waits. */
export function waitsForUser(edit: {
  action: EditAction;
  mapped: boolean;
  removed: number;
  added: number;
  selected: number;
}): boolean {
  if (edit.mapped || edit.action === "translate" || edit.selected === 0) {
    return false;
  }
  return (edit.removed - edit.added) / edit.selected > MOST_OF_IT;
}
