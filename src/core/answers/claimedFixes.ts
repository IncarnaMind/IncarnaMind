/**
 * What a reply says its edits fixed, held to what they did (#1559): the
 * claim check (./claimedChanges) finds a reply that says it changed a Mind
 * when no call did, but not one that says it fixed four typos when its edit
 * fixed three. Here a word the reply says it fixed ("Fixed “wich”", "“visted”
 * (visited)", "把“壮管”改成了“壮观”") that is in the Mind as often after the
 * Answer's edits as before, and a count of fixes or paragraphs larger than
 * the edits made, are what it claims and didn't do.
 */
import * as Y from "yjs";
import { resolveProposals } from "../../shared/proposals";
import { type AnswerToolCall, MIND_CONTENT_FIELD } from "../api";
import { plainText } from "../mindText";
import { MIND_TOOLS } from "../tools";
import { topLevelBlocks } from "./blocks";

/** A Mind's text before and after the Answer's own changes there. */
export interface EditedText {
  before: string;
  after: string;
}

/** What the Answer's edits made: the places they changed and the paragraphs. */
export interface EditCounts {
  places: number;
  paragraphs: number;
}

/** What a reply claims of its edits that they didn't do. */
export interface UnmadeFixes {
  /** Words it says it fixed, still there as often as before. */
  words: string[];
  /** A count it gives, larger than what was made: of places (typos, changes) or of paragraphs. */
  count: { claimed: number; made: number; of: "places" | "paragraphs" } | null;
}

/** A Mind's text with `requests`' changes accepted, or taken back. */
export function textWith(
  blocks: Y.XmlFragment,
  requests: ReadonlySet<string>,
  outcome: "accept" | "reject",
): string {
  const doc = blocks.doc;
  if (!doc) return "";
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const fragment = copy.getXmlFragment(MIND_CONTENT_FIELD);
  copy.transact(() => resolveProposals(fragment, (ref) => requests.has(ref.request), outcome));
  const text = topLevelBlocks(fragment)
    .map((block) => plainText(block))
    .join("\n");
  copy.destroy();
  return text;
}

const FIXED =
  /\b(?:fixed|corrected|changed|replaced|updated|amended|proposed (?:fixes|a fix|corrections?))\b|→|->/i;
const CHINESE_FIXED = /改正|修正|更正|纠正|改成|改为|修改了|已修改|改了|已将|替换/;
const NOT =
  /\b(?:not|never|no|couldn['’]t|didn['’]t|wasn['’]t|left)\b|没有|未能|未|无法|尚未|保留/i;
const QUOTED = /[“"「『]([^”"」』\n]{1,30})[”"」』]/g;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};
// After 第 a number is an ordinal ("第二段", "第 12 处"), and "最后一段" or "这一段" names one
// paragraph: neither is a count.
const NUMBER =
  "(?<!第\\s*)(?<![\\d一二两三四五六七八九十])(\\d+|\\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\\b|(?<![这那上下另每同后]\\s*)一|[二两三四五六七八九十])";
const PLACES = new RegExp(
  `${NUMBER}\\s*(?:typos?|spelling (?:mistakes?|errors?)|mistakes?|errors?|changes|places|edits|fixes|corrections)\\b|${NUMBER}\\s*(?:处|个错别字|个错误|个拼写错误)`,
  "gi",
);
const PARAGRAPHS = new RegExp(`${NUMBER}\\s*(?:paragraphs?\\b|个段落|段)`, "gi");

const numberOf = (word: string): number =>
  /^\d+$/.test(word) ? Number(word) : (NUMBER_WORDS[word.toLocaleLowerCase()] ?? 0);

const sentencesOf = (reply: string): string[] =>
  reply
    .split(/(?<=[.!?])\s+|(?<=[。！？])|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");

function occurrences(text: string, word: string): number {
  if (/[\p{Script=Han}]/u.test(word)) return text.split(word).length - 1;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    text.match(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"))?.length ?? 0
  );
}

function largest(sentences: readonly string[], pattern: RegExp): number {
  let found = 0;
  for (const sentence of sentences) {
    for (const match of sentence.matchAll(pattern)) {
      found = Math.max(found, numberOf(match[1] ?? match[2] ?? ""));
    }
  }
  return found;
}

/**
 * What a reply claims its edits fixed that they didn't, read from the
 * sentences that report a fix, against the edited Minds' text before and
 * after the Answer's changes and what the edits made; null for nothing.
 * `names`: the User's Minds', which a sentence quotes as where, not as what it fixed.
 */
export function unmadeFixes(
  reply: string,
  edited: readonly EditedText[],
  made: EditCounts,
  names: readonly string[] = [],
): UnmadeFixes | null {
  if (edited.length === 0) return null;
  const claiming = sentencesOf(reply).filter(
    (sentence) => (FIXED.test(sentence) || CHINESE_FIXED.test(sentence)) && !NOT.test(sentence),
  );
  if (claiming.length === 0) return null;
  const mindNames = new Set(names.map((name) => name.trim().toLocaleLowerCase()));
  const words = [
    ...new Set(
      claiming.flatMap((sentence) => [...sentence.matchAll(QUOTED)].map((match) => match[1] ?? "")),
    ),
  ].filter((word) => {
    const trimmed = word.trim();
    if (trimmed === "" || trimmed.split(/\s+/).length > 3) return false;
    if (mindNames.has(trimmed.toLocaleLowerCase())) return false;
    const before = edited.reduce((sum, each) => sum + occurrences(each.before, trimmed), 0);
    const after = edited.reduce((sum, each) => sum + occurrences(each.after, trimmed), 0);
    return before > 0 && after >= before;
  });
  const places = largest(claiming, PLACES);
  const paragraphs = largest(claiming, PARAGRAPHS);
  const count =
    places > made.places
      ? { claimed: places, made: made.places, of: "places" as const }
      : paragraphs > made.paragraphs
        ? { claimed: paragraphs, made: made.paragraphs, of: "paragraphs" as const }
        : null;
  return words.length > 0 || count ? { words, count } : null;
}

/**
 * `unmadeFixes` of a reply against what its Answer's `edit_mind` calls did,
 * reading each Mind they changed (`minds`) before and after their changes.
 */
export function unmadeFixesIn(
  reply: string,
  calls: readonly AnswerToolCall[],
  minds: { read<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T },
  names: readonly string[],
): UnmadeFixes | null {
  const edits = calls.flatMap((call) =>
    call.source === "minds" && call.tool === MIND_TOOLS.edit && call.mindChange
      ? [call.mindChange]
      : [],
  );
  if (edits.length === 0) return null;
  const requests = new Map<string, Set<string>>();
  for (const change of edits) {
    requests.set(change.mindId, (requests.get(change.mindId) ?? new Set()).add(change.request));
  }
  const edited = [...requests].map(([mindId, theirs]) =>
    minds.read(mindId, (blocks) => ({
      before: textWith(blocks, theirs, "reject"),
      after: textWith(blocks, theirs, "accept"),
    })),
  );
  const made = {
    places: edits.reduce((sum, change) => sum + change.proposals, 0),
    paragraphs: edits.reduce((sum, change) => sum + (change.changed ?? 0), 0),
  };
  return unmadeFixes(reply, edited, made, names);
}
