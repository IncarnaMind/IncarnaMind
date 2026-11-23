/**
 * How the change a check gives reads on its card (#3715), as a change waiting in the Note reads
 * (DESIGN.md › AI edits): the words it takes out struck and the words it writes underlined, or,
 * where it writes the sentence anew, the old sentence on one "Was:" line over the new one.
 */
import type { ClaimChange } from "../core/api";
import {
  diffSteps,
  hunksOf,
  JOINED_CHARS,
  REWRITTEN_SHARE,
  splitWords,
} from "../core/proposals/diff";
import { INLINE_NODE } from "./sentences";

export interface ChangeRun {
  text: string;
  kind: "kept" | "struck" | "written";
}

export type ChangeView =
  /** `cut`: the sentence's start, before the clause the change is in, is left out. */
  { kind: "words"; runs: ChangeRun[]; cut: boolean } | { kind: "anew"; was: string; now: string };

/** The sentence with `change` made, or null where its words aren't in it exactly once. */
export function changedSentence(text: string, change: ClaimChange): string | null {
  const at = text.indexOf(change.replace);
  if (at < 0 || at !== text.lastIndexOf(change.replace)) return null;
  return text.slice(0, at) + change.with + text.slice(at + change.replace.length);
}

/** The sentence's words alone: a Citation, and the space before it, are no words of it. */
const shown = (text: string) => text.replace(new RegExp(`\\s*${INLINE_NODE}`, "gu"), "").trim();

/** Where a clause starts, after the comma or semicolon that ends the one before. */
const CLAUSE_BREAK = /[,;，；]\s*/g;

/** A start this long before the changed clause is left out, as "…". */
const CUT_FROM_CHARS = 10;

export function changeView(text: string, change: ClaimChange): ChangeView | null {
  const changed = changedSentence(text, change);
  if (changed === null) return null;
  const old = splitWords(shown(text));
  const now = splitWords(shown(changed));
  const steps = diffSteps(old, now);
  const isWord = (token: string | undefined) => token !== undefined && !/^\s+$/.test(token);
  const words = old.filter(isWord).length;
  let kept = 0;
  let at = 0;
  for (const step of steps) {
    if (step === "insert") continue;
    if (step === "equal" && isWord(old[at])) kept++;
    at++;
  }
  if (words > 0 && words - kept >= words * REWRITTEN_SHARE) {
    return { kind: "anew", was: shown(text), now: shown(changed) };
  }
  const hunks = hunksOf(
    steps,
    (from, to) => old.slice(from, to).join("").replace(/\s+/g, "").length <= JOINED_CHARS,
  );
  const runs: ChangeRun[] = [];
  const add = (piece: string, kind: ChangeRun["kind"]) => {
    if (piece === "") return;
    const last = runs.at(-1);
    if (last?.kind === kind) last.text += piece;
    else runs.push({ text: piece, kind });
  };
  let oldAt = 0;
  for (const hunk of hunks) {
    add(old.slice(oldAt, hunk.oldFrom).join(""), "kept");
    add(old.slice(hunk.oldFrom, hunk.oldTo).join(""), "struck");
    add(now.slice(hunk.newFrom, hunk.newTo).join(""), "written");
    oldAt = hunk.oldTo;
  }
  add(old.slice(oldAt).join(""), "kept");
  const first = runs[0];
  if (first?.kind !== "kept") return { kind: "words", runs, cut: false };
  const breaks = [...first.text.matchAll(CLAUSE_BREAK)];
  const last = breaks.at(-1);
  if (!last || last.index < CUT_FROM_CHARS) return { kind: "words", runs, cut: false };
  first.text = first.text.slice(last.index + last[0].length);
  return { kind: "words", runs: first.text === "" ? runs.slice(1) : runs, cut: true };
}
