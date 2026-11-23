/**
 * Where the change the User's own AI gave with a sentence's check can be written in the Note as it
 * is (#3715): a test of the document alone, which the card, ⌘K and Accept ask through `ownChange`.
 */
import type { EditorState } from "@tiptap/pm/state";
import {
  type ClaimChange,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../../../core/api";
import { diffSteps, hunksOf, splitWords } from "../../../core/proposals/diff";
import { readClaimChange } from "../../../shared/claimChange";
import { readProposalAttribute } from "../../../shared/proposals";
import { INLINE_NODE } from "../../../shared/sentences";
import { placeInSentence, type ShownClaim } from "./claimChecks";

/**
 * Whether a change waiting for review covers these words: someone's tracked change from Word, or
 * one asked for. Writing over it would drop it unreviewed.
 */
export function underReview(state: EditorState, from: number, to: number): boolean {
  const $from = state.doc.resolve(from);
  for (let depth = $from.depth; depth > 0; depth--) {
    if (readProposalAttribute($from.node(depth).attrs[PROPOSAL_ATTRIBUTE])) return true;
  }
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    found ||=
      readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE]) !== null ||
      node.marks.some(
        (mark) =>
          mark.type.name === PROPOSAL_INSERT_MARK || mark.type.name === PROPOSAL_DELETE_MARK,
      );
    return !found;
  });
  return found;
}

/** One run of the change: the words from `from` to `to` in the Note, written as `text`. */
export interface ChangeEdit {
  from: number;
  to: number;
  text: string;
}

/** Why a change can't be made now. */
export type ChangeRefused =
  /** The check gives none, or none this sentence's card makes. */
  | "none"
  /** The sentence's words aren't the ones checked, or the words to change aren't there once. */
  | "changed"
  /** A Citation or a worked-out figure stands inside words the change takes out. */
  | "inside"
  /** A change waiting for the User covers the words. */
  | "review"
  /** An edit runs in the Note. */
  | "editing"
  /** A check runs in the Note. */
  | "checking";

export type PlacedChange =
  | { ok: true; change: ClaimChange; edits: ChangeEdit[] }
  | { ok: false; why: ChangeRefused };

export const refused = (why: ChangeRefused): PlacedChange => ({ ok: false, why });

/** Where each token of `tokens` starts in their text, and where the last ends. */
function offsetsOf(tokens: readonly string[]): number[] {
  const offsets = [0];
  for (const token of tokens) offsets.push((offsets.at(-1) ?? 0) + token.length);
  return offsets;
}

/**
 * Where the change of `claim`'s check is written in the document as it is: one edit per run of
 * words it changes, word by word as a change waiting in the Note is drawn, so every Citation and
 * worked-out figure between them stays exactly where it is. Words added between two kept ones go
 * right after the one before, ahead of a Citation that follows it. Refused where a run it takes
 * out holds a Citation or figure, as writing over it would delete it.
 */
export function placeChange(state: EditorState, claim: ShownClaim): PlacedChange {
  const change = readClaimChange(claim.check.change);
  const shown = claim.shown.state;
  if (
    !change ||
    claim.kind === "chart" ||
    (shown !== "contradicted" && shown !== "unsupported") ||
    claim.check.unsupported?.word === "own-view"
  )
    return refused("none");
  const { text } = claim.sentence;
  const at = text.indexOf(change.replace);
  if (claim.check.text !== text || at < 0 || at !== text.lastIndexOf(change.replace))
    return refused("changed");
  if (!placeInSentence(state, claim, { from: at, to: at + change.replace.length }))
    return refused("changed");
  const old = splitWords(change.replace);
  const now = splitWords(change.with);
  const oldAt = offsetsOf(old);
  const nowAt = offsetsOf(now);
  const edits: ChangeEdit[] = [];
  for (const hunk of hunksOf(diffSteps(old, now), () => false)) {
    const from = at + (oldAt[hunk.oldFrom] ?? 0);
    const to = at + (oldAt[hunk.oldTo] ?? 0);
    const written = change.with.slice(nowAt[hunk.newFrom] ?? 0, nowAt[hunk.newTo] ?? 0);
    if (from < to) {
      const place = placeInSentence(state, claim, { from, to });
      if (
        !place ||
        state.doc.textBetween(place.from, place.to, "\n", INLINE_NODE) !== text.slice(from, to)
      )
        return refused("inside");
      if (underReview(state, place.from, place.to)) return refused("review");
      edits.push({ ...place, text: written });
      continue;
    }
    const near =
      from > 0
        ? placeInSentence(state, claim, { from: from - 1, to: from })
        : placeInSentence(state, claim, { from, to: from + 1 });
    if (!near) return refused("inside");
    const point = from > 0 ? near.to : near.from;
    if (underReview(state, point, point)) return refused("review");
    edits.push({ from: point, to: point, text: written });
  }
  return edits.length > 0 ? { ok: true, change, edits } : refused("none");
}
