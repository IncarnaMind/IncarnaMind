/**
 * Whether a sentence's own words for an Analysis's figure can stand as naming it (#2378). It is a
 * filter on the claim judge's "same", never a judge: it only ever takes Supported away, leaving the
 * figure Not checked. No code reads a name well enough to call it right, so this one reads a closed
 * set of words: the figure's own clause holds every word of its label, and nothing else but the
 * Analysis's own words for its input and columns and words that only link a figure to its name.
 * Any other word, a qualifier, a period, a change, a negation or another group, leaves it unchecked.
 */
import type { CheckFigure } from "../../api";

/** Where a figure's own clause ends: a figure beside it, a comma, colon, semicolon or bracket. */
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

/** The words for each way a figure is worked out: a sum's own clause may call it a total. */
const AGGREGATES: Record<string, readonly string[]> = {
  sum: ["total", "sum", "合计", "总计", "总额"],
  mean: ["average", "mean", "平均", "均值"],
  min: ["lowest", "minimum", "smallest", "最低", "最小"],
  max: ["highest", "maximum", "largest", "最高", "最大"],
  count: ["number", "count", "数量", "个数"],
};

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

/**
 * Each figure's own clause of `claim`, by id: from the figure before it, or a break, to the next,
 * with the figure's own number taken out, so its digits never name it.
 */
function clausesOf(claim: string, figures: readonly CheckFigure[]): Map<string, string> {
  const placed: { id: string; from: number; to: number }[] = [];
  let after = 0;
  const ordered = [...figures].sort(
    (a, b) =>
      (a.locator.kind === "text" ? a.locator.from.offset : 0) -
      (b.locator.kind === "text" ? b.locator.from.offset : 0),
  );
  for (const figure of ordered) {
    const at = claim.indexOf(figure.reading.chars, after);
    if (at < 0) continue;
    placed.push({ id: figure.id, from: at, to: at + figure.reading.chars.length });
    after = at + figure.reading.chars.length;
  }
  const clauses = new Map<string, string>();
  placed.forEach((figure, index) => {
    let from = placed[index - 1]?.to ?? 0;
    for (let at = figure.from - 1; at >= from; at--)
      if (BREAK.test(claim[at] ?? "")) {
        from = at + 1;
        break;
      }
    let to = placed[index + 1]?.from ?? claim.length;
    for (let at = figure.to; at < to; at++)
      if (BREAK.test(claim[at] ?? "")) {
        to = at;
        break;
      }
    clauses.set(figure.id, `${claim.slice(from, figure.from)} ${claim.slice(figure.to, to)}`);
  });
  return clauses;
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
 * (in a table, its cell's row and column headings count), none that only another of its run's
 * figures, or another figure of the sentence, is named by, and no word but those, the Analysis's
 * own words for its input and columns, and linking words. False also when its clause can't be found.
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
  const found = clausesOf(claim, figures).get(figure.id);
  if (found === undefined) return false;
  const clause = `${found} ${figure.label ?? ""}`;
  if (!terms.every(({ term, exact }) => holds(clause, term, exact))) return false;
  const mine = new Set(terms.map(({ term }) => term.toLowerCase()));
  const others = [
    ...(record?.siblings ?? []),
    ...figures
      .filter((each) => each.id !== figure.id)
      .map((each) => each.analysisRecord?.label ?? each.calculated?.figure.label ?? ""),
  ];
  const sibling = others
    .flatMap((each) => allTerms(termsOf(each)))
    .filter(({ term }) => !mine.has(term.toLowerCase()));
  if (sibling.some(({ term, exact }) => holds(found, term, exact))) return false;
  const how = record?.of?.how;
  const vocabulary = [
    ...(record?.vocabulary ?? []).flatMap((each) => allTerms(termsOf(each))),
    ...(how ? (AGGREGATES[how] ?? []) : []).map((term) => ({ term, exact: false })),
    // A cell's own words beside its number, a unit such as 次, are its headings' to say.
    ...[...(figure.label ?? "").matchAll(/\p{Script=Han}/gu)].map(([term]) => ({
      term,
      exact: false,
    })),
  ];
  return unaccounted(found, [...terms, ...vocabulary]).length === 0;
}
