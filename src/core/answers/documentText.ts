/**
 * A short Document's whole text, given with the Question as Passages (#1036):
 * a résumé, a letter or a memo shares no word with "What is this about?", so
 * a keyword search for the Question finds nothing in it. Given up front, the
 * model needs no search and its Citations are checked as a search's are.
 * A summary of each Document gets a long one's skim the same way (#894).
 */
import type { WindowedPassage } from "../documents/search";
import type { ContextWindow } from "../providers/models";
import { estimateTokens } from "./context";
import type { SizedDocument } from "./coverage";

export const UP_FRONT_TOKEN_LIMIT = 6_000;
export const OPENING_TOKEN_LIMIT = 3_000;
/** Summing a large scope's sizes takes long (half a second at 300k Passages), and its text wouldn't fit. */
export const SMALL_SCOPE_DOCUMENTS = 12;

/** At most a quarter of the model's window, as a live transcript gets, when the window is known. */
export const upFrontTokens = (window: ContextWindow | undefined) =>
  window ? Math.min(UP_FRONT_TOKEN_LIMIT, Math.floor(window.tokens / 4)) : UP_FRONT_TOKEN_LIMIT;

// Long enough that a match is the overlap, not a phrase the next Passage happens to start with.
const OVERLAP_PROBE = 40;

/**
 * The Passages in reading order with what each repeats of the one before it
 * left out: consecutive Passages of a Document overlap (a sliding window).
 * A Passage left with nothing goes.
 */
export function withoutOverlap(passages: readonly WindowedPassage[]): WindowedPassage[] {
  const kept: WindowedPassage[] = [];
  let previous: WindowedPassage | undefined;
  for (const passage of passages) {
    let text = passage.text;
    if (previous && previous.documentId === passage.documentId) {
      const before = previous.text;
      const probe = text.slice(0, OVERLAP_PROBE);
      for (let at = before.indexOf(probe); at >= 0; at = before.indexOf(probe, at + 1)) {
        if (text.startsWith(before.slice(at))) {
          text = text.slice(before.length - at).trimStart();
          break;
        }
      }
    }
    previous = passage;
    if (text !== "") kept.push(text === passage.text ? passage : { ...passage, text });
  }
  return kept;
}

/** The opening Passages, without their overlap, that fit in `tokens`, in reading order. */
export function openingWithin(
  passages: readonly WindowedPassage[],
  tokens: number,
): WindowedPassage[] {
  const kept: WindowedPassage[] = [];
  let left = tokens;
  for (const passage of withoutOverlap(passages)) {
    const cost = estimateTokens(passage.text);
    if (cost > left) break;
    kept.push(passage);
    left -= cost;
  }
  return kept;
}

/**
 * The first of `candidates` (each a set of Documents) whose whole text, as
 * `block` sends it, fits in `tokens`: its Passages without their overlap,
 * and the block. Null when none fits.
 */
export function givenUpFront(
  candidates: readonly (readonly SizedDocument[])[],
  tokens: number,
  passagesOf: (documentId: string) => WindowedPassage[],
  block: (passages: readonly WindowedPassage[]) => string,
): { passages: WindowedPassage[]; block: string } | null {
  for (const documents of candidates) {
    // A token is at most 4 characters, and overlapping Passages hold less than twice the text.
    const size = documents.reduce((sum, each) => sum + each.size, 0);
    if (documents.length === 0 || size > tokens * 4 * 2) continue;
    const passages = withoutOverlap(documents.flatMap((each) => passagesOf(each.id)));
    if (passages.length === 0) continue;
    const text = block(passages);
    if (estimateTokens(text) <= tokens) return { passages, block: text };
  }
  return null;
}

/** The block that gives these Documents' whole text (`shown`: its Passages as the model reads them). */
export function documentTextBlock(names: readonly string[], shown: string): string {
  const which = names.map((name) => `"${name}"`).join(", ");
  return `<document-text>\nThe whole text of ${which}, as Passages. Answer from them and cite them as you cite any Passage; search only for what they don't hold.\n\n${shown}\n</document-text>`;
}

const SKIM_TOKEN_LIMIT = 12_000;

/** A summary's room to skim its Documents: more than a whole short one gets, as each needs several Passages. */
export const skimTokens = (window: ContextWindow | undefined) =>
  window ? Math.min(SKIM_TOKEN_LIMIT, Math.floor(window.tokens / 4)) : SKIM_TOKEN_LIMIT;

// A line that starts a part of a filing or a report: "Item 7.", "Part II", "第三节", "2.1 Revenue", "RISK FACTORS".
const PART_START =
  /^\s*(?:item\s+\d+[a-z]?\b|part\s+[ivx]+\b|第[一二三四五六七八九十百\d]+[章节条部分]|\d+(?:\.\d+)*\.?\s+\p{Lu}|\p{Lu}[\p{Lu}\s,&'’-]{6,}$)/imu;

/**
 * What a summary reads of a Document too long to give whole (#894): its opening, then Passages
 * spread evenly over the rest, each moved to a near one that starts a part ("Item 7.", "第三节")
 * when there is one, in reading order, within `tokens`. From what a search happened to return, a
 * 10-K was summarised from its exhibits; a reader skims every part.
 */
export function skimWithin(
  passages: readonly WindowedPassage[],
  tokens: number,
): WindowedPassage[] {
  const all = withoutOverlap(passages);
  const costs = all.map((passage) => estimateTokens(passage.text));
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  if (total <= tokens) return all;
  const count = Math.max(1, Math.floor((tokens * all.length) / total));
  const spacing = all.length / count;
  const reach = Math.floor(spacing / 2);
  const chosen = new Set<number>([0]);
  for (let step = 1; step < count; step++) {
    const even = Math.floor(step * spacing);
    let pick = even;
    for (let offset = 0; offset <= reach; offset++) {
      const part = [even + offset, even - offset].find(
        (at) =>
          at > 0 && at < all.length && !chosen.has(at) && PART_START.test(all[at]?.text ?? ""),
      );
      if (part !== undefined) {
        pick = part;
        break;
      }
    }
    chosen.add(pick);
  }
  const kept: WindowedPassage[] = [];
  let left = tokens;
  for (const at of [...chosen].sort((a, b) => a - b)) {
    const passage = all[at];
    const cost = costs[at] ?? 0;
    if (!passage || cost > left) continue;
    kept.push(passage);
    left -= cost;
  }
  return kept;
}

/** The block that gives a summary its Documents' skims (`shown`: their Passages as the model reads them). */
export function documentSkimBlock(names: readonly string[], shown: string): string {
  const which = names.map((name) => `"${name}"`).join(", ");
  return `<document-skims>\nOf ${which}: each one's opening and Passages from across the rest, as a reader skims it, or its whole text when short. Summarise each from every part shown, and cite them as you cite any Passage; search a Document by name for what they don't hold.\n\n${shown}\n</document-skims>`;
}
