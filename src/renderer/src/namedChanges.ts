import { create } from "zustand";
import type { NamedChange } from "./changeFacts";

/** The paragraph each request at a Note's foot changed, by turn, once it is placed: for the line that says it. */
export const useNamedChanges = create<{ byTurn: Readonly<Record<string, NamedChange>> }>(() => ({
  byTurn: {},
}));

export const rememberNamed = (turn: string, named: NamedChange): void =>
  useNamedChanges.setState((state) => ({ byTurn: { ...state.byTurn, [turn]: named } }));
