import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The sentence a check's request is for, and the part of it when the request
 * checks one part: carried through every await, as `currentTask` names a Task,
 * so every request a check makes is told apart by its sentence without passing
 * either through the Answer engine.
 */
export interface CheckedText {
  sentence: string;
  part: string | null;
}

const current = new AsyncLocalStorage<CheckedText>();

export const inCheck = <T>(text: CheckedText, work: () => T): T => current.run(text, work);

export const checkNow = (): CheckedText | null => current.getStore() ?? null;
