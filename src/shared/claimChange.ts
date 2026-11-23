import type { ClaimChange } from "../core/api";
import { isRecord } from "./record";
import { INLINE_NODE } from "./sentences";

/**
 * The longest a change's words may be: a sentence longer than this reads as several, so a change
 * this long rewrites more than the sentence it is for.
 */
export const CHANGE_CHARS = 1_000;

/** Why a change the User's own AI gave can't be kept as it gave it (#3715). */
export type ChangeProblem =
  /** It writes the words it replaces. */
  | "same"
  /** It holds a `[cite:…]` token: a change is the sentence's words; its Citations stay put. */
  | "citation"
  /** It runs over a line break. */
  | "line-break"
  /** It holds the character that stands for a Citation or figure in a sentence's text. */
  | "object"
  | "too-long";

const CITE_TOKEN = /\[cite:[^\]]*\]/i;
const LINE_BREAK = /[\r\n\u2028\u2029]/;

/** What is wrong with a change as given, or null when it can be kept. */
export function changeProblem(change: ClaimChange): ChangeProblem | null {
  const both = [change.replace, change.with];
  if (both.some((words) => CITE_TOKEN.test(words))) return "citation";
  if (both.some((words) => LINE_BREAK.test(words))) return "line-break";
  if (both.some((words) => words.includes(INLINE_NODE))) return "object";
  if (both.some((words) => words.length > CHANGE_CHARS)) return "too-long";
  return change.with === change.replace ? "same" : null;
}

/** A change as given: its two strings, the words to change not blank; null for anything else. */
export function givenChange(value: unknown): ClaimChange | null {
  return isRecord(value) &&
    typeof value.replace === "string" &&
    value.replace.trim() !== "" &&
    typeof value.with === "string"
    ? { replace: value.replace, with: value.with }
    : null;
}

/** A change a mark keeps, or null where the mark keeps none or it isn't one that can be kept. */
export function readClaimChange(value: unknown): ClaimChange | null {
  const change = givenChange(value);
  return change && changeProblem(change) === null ? change : null;
}
