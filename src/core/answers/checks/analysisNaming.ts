/**
 * Whether a sentence's own words for an Analysis's figure can stand as naming it (#2378). It is a
 * filter on the claim judge's "same", never a judge: it only ever takes Supported away, leaving the
 * figure Not checked. No code reads a name well enough to call it right, so this one reads a closed
 * set of words: the figure's own clause holds every word of its label, and nothing else but the
 * Analysis's own words for its input and columns and words that only link a figure to its name.
 * Any other word, a qualifier, a period, a change, a negation or another group, leaves it unchecked.
 */
import { AGGREGATE_WORDS } from "../../../shared/analysis";
import type { CheckFigure } from "../../api";

/** Where the words between two figures part: a comma, colon, semicolon or bracket. */
const BREAK = /[,;:，；：、()（）[\]【】]/u;
const HAN = /\p{Script=Han}/u;
const HAN_RUN = /\p{Script=Han}+/gu;
const TOKEN = /[\p{L}\p{M}\p{N}]+/gu;

/** Short words a label leaves no trace of when a sentence words it otherwise ("Revenue by region"). */
const FUNCTION_WORDS = new Set(["a", "an", "as", "at", "by", "in", "of", "on", "or", "to"]);

/** Words that only link a figure to its name: they say nothing of what it is. */
const LINKING = new Set([
  ...FUNCTION_WORDS,
  "s",
  "is",
  "was",
  "were",
  "are",
  "be",
  "been",
  "the",
  "its",
  "their",
  "for",
  "from",
  "with",
  "and",
  "that",
  "this",
  "it",
  "there",
  "came",
  "comes",
  "come",
  "reached",
  "reaches",
  "reach",
  "stood",
  "stands",
  "stand",
  "recorded",
  "records",
  "has",
  "had",
  "have",
  "totalled",
  "totaled",
  "amounted",
  "out",
  "all",
  "works",
  "worked",
  "took",
  "brought",
  "logged",
  "placed",
  "closes",
  "closed",
  "equal",
  "equals",
]);
/** The same in Chinese, longest first, so 而言 goes before 而 could be read alone. */
const HAN_LINKING = [
  "而言",
  "达到",
  "共有",
  "一共",
  "总共",
  "约为",
  "录得",
  "停在",
  "所有",
  "全部",
  "为",
  "是",
  "的",
  "达",
  "共",
  "有",
  "在",
  "就",
  "约",
  "了",
  "其",
  "该",
];

/** A table's headings that say only that a cell holds a figure: "Metric | Value", "指标 | 结果". */
const HEADING_WORDS = ["value", "result", "figure", "数值", "结果"].map((term) => ({
  term,
  exact: false,
}));

interface Terms {
  /** Lowercased words of three letters or more, and words with a digit ("2026", "q3"). */
  words: string[];
  /** Words of one or two letters, matched whole and in their case ("UK", "B"). */
  exact: string[];
  /** A Han run in two-character words, with a last one alone ("东部", "金额", "合计"). */
  han: string[];
}

function termsOf(label: string): Terms {
  const words: string[] = [];
  const exact: string[] = [];
  for (const [token] of label.replace(HAN_RUN, " ").matchAll(TOKEN)) {
    if (/\p{N}/u.test(token) || [...token].length >= 3) words.push(token.toLowerCase());
    else if (!FUNCTION_WORDS.has(token)) exact.push(token);
  }
  const han = [...label.matchAll(HAN_RUN)].flatMap(([run]) => {
    const characters = [...run];
    const pairs: string[] = [];
    for (let at = 0; at < characters.length; at += 2)
      pairs.push(characters.slice(at, at + 2).join(""));
    return pairs;
  });
  return { words, exact, han };
}

/** A word and its plural name the same: "visit" and "visits", "category" and "categories". */
const plurals = (word: string) => [word, `${word}s`, `${word}es`, word.replace(/y$/u, "ies")];
const sameWord = (word: string, token: string) =>
  plurals(word).includes(token) || plurals(token).includes(word);

/** Whether `token` is `term`: a word with a digit exactly, a short word in its case, any other as a word or its plural. */
function isTerm(token: string, term: string, exact: boolean): boolean {
  if (exact) return token === term;
  const lower = term.toLowerCase();
  return /\p{N}/u.test(lower)
    ? token.toLowerCase() === lower
    : sameWord(lower, token.toLowerCase());
}

const tokensOf = (text: string) =>
  [...text.replace(HAN_RUN, " ").matchAll(TOKEN)].map(([token]) => token);

const allTerms = (terms: Terms) => [
  ...terms.words.map((term) => ({ term, exact: false })),
  ...terms.exact.map((term) => ({ term, exact: true })),
  ...terms.han.map((term) => ({ term, exact: false })),
];

function holds(clause: string, term: string, exact: boolean): boolean {
  if (HAN.test(term)) return clause.includes(term);
  return tokensOf(clause).some((token) => isTerm(token, term, exact));
}

/** Where a figure is in `claim`: from the start of its words to their end. */
interface Place {
  id: string;
  from: number;
  to: number;
}

const blockOf = (figure: CheckFigure) =>
  figure.locator.kind === "text" ? figure.locator.from.blockId : figure.locator.blockId;
const offsetOf = (figure: CheckFigure) =>
  figure.locator.kind === "text" ? figure.locator.from.offset : 0;

/**
 * Where each of the sentence's figures in `target`'s Block is in `claim`, each one's words in turn.
 * A number Check doesn't read that has the same digits can take a figure's place, but then the
 * figure's own digits are left in its clause, which no word accounts for.
 */
function placesOf(claim: string, target: CheckFigure, figures: readonly CheckFigure[]): Place[] {
  const ordered = [...figures, ...(figures.includes(target) ? [] : [target])]
    .filter((each) => blockOf(each) === blockOf(target))
    .sort((a, b) => offsetOf(a) - offsetOf(b));
  const places: Place[] = [];
  let after = 0;
  for (const figure of ordered) {
    const shown = figure.calculated?.figure.shown;
    const words =
      shown !== undefined && claim.indexOf(shown, after) >= 0 ? shown : figure.reading.chars;
    const from = claim.indexOf(words, after);
    if (from < 0) continue;
    places.push({ id: figure.id, from, to: from + words.length });
    after = from + words.length;
  }
  return places;
}

/**
 * `target`'s own clause of `claim`: the sentence before its first figure and after its last, and
 * between two figures up to the first break after the one before, with the figure's own number
 * taken out, so its digits never name it. A qualifier set off by a comma is still the figure's.
 */
function clauseOf(
  claim: string,
  target: CheckFigure,
  figures: readonly CheckFigure[],
): string | undefined {
  const places = placesOf(claim, target, figures);
  const index = places.findIndex((place) => place.id === target.id);
  const place = places[index];
  if (!place) return undefined;
  const breakAfter = (from: number, to: number) => {
    for (let at = from; at < to; at++) if (BREAK.test(claim[at] ?? "")) return at;
    return to;
  };
  const before = places[index - 1];
  const next = places[index + 1];
  const cut = before ? breakAfter(before.to, place.from) : 0;
  const from = before ? (cut < place.from ? cut + 1 : before.to) : 0;
  const to = next ? breakAfter(place.to, next.from) : claim.length;
  return `${claim.slice(from, place.from)} ${claim.slice(place.to, to)}`;
}

/** What of `clause` no label word, word of the Analysis's or linking word accounts for. */
function unaccounted(clause: string, known: readonly { term: string; exact: boolean }[]): string[] {
  const words = tokensOf(clause).filter(
    (token) =>
      !LINKING.has(token.toLowerCase()) &&
      !known.some(({ term, exact }) => !HAN.test(term) && isTerm(token, term, exact)),
  );
  let han = clause.replace(/[^\p{Script=Han}]+/gu, " ");
  const hanKnown = [
    ...known.map(({ term }) => term).filter((term) => HAN.test(term)),
    ...HAN_LINKING,
  ].sort((a, b) => b.length - a.length);
  for (const term of hanKnown) han = han.replaceAll(term, " ");
  return [...words, ...(han.match(HAN_RUN) ?? [])];
}

/**
 * Whether `figure`'s own clause in `claim` can stand as naming it: it holds every word of its label
 * (in a table, its cell's row and column headings count), and no word but those, the Analysis's
 * own words for its input, columns and unit, the words for its way of being worked out, and linking
 * words; a cell's headings are read the same way, so another group's name is never one of them. `figures` are all of the sentence's, so each is placed among them. False also when its
 * clause can't be found.
 */
export function namingHolds(
  claim: string,
  figure: CheckFigure,
  figures: readonly CheckFigure[],
): boolean {
  const record = figure.analysisRecord;
  const label = record?.label ?? figure.calculated?.figure.label ?? "";
  const terms = allTerms(termsOf(label));
  if (terms.length === 0) return false;
  const found = clauseOf(claim, figure, figures);
  if (found === undefined) return false;
  const headings = figure.label ?? "";
  const clause = `${found} ${headings}`;
  if (!terms.every(({ term, exact }) => holds(clause, term, exact))) return false;
  const how = record?.of?.how;
  const known = [
    ...terms,
    ...(record?.vocabulary ?? []).flatMap((each) => allTerms(termsOf(each))),
    ...(how ? (AGGREGATE_WORDS[how] ?? []) : []).map((term) => ({ term, exact: false })),
  ];
  // A cell's own words beside its number, a unit such as 次, are its headings' to say.
  const besideItsNumber = [...headings.matchAll(/\p{Script=Han}/gu)].map(([term]) => ({
    term,
    exact: false,
  }));
  return (
    unaccounted(found, [...known, ...besideItsNumber]).length === 0 &&
    unaccounted(headings, [...known, ...HEADING_WORDS]).length === 0
  );
}
