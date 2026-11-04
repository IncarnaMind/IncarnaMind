/**
 * Whether a sentence's own words for an Analysis's figure can stand as naming it (#2378). It is a
 * filter on the claim judge's "same", never a judge: it only ever takes Supported away, leaving the
 * figure Not checked. No code reads a name well enough to call it right; this one only refuses
 * clauses that leave a word of the label out, or that also name another of the run's figures, a
 * negation or a comparison.
 */
import type { CheckFigure } from "../../api";

/** Where a figure's own clause ends: a figure beside it, a comma, colon, semicolon or bracket. */
const BREAK = /[,;:，；：、()（）[\]【】]/u;
const HAN = /\p{Script=Han}/u;
const HAN_RUN = /\p{Script=Han}+/gu;
const TOKEN = /[\p{L}\p{M}\p{N}]+/gu;

/** Short words a label leaves no trace of when a sentence words it otherwise ("Revenue by region"). */
const FUNCTION_WORDS = new Set(["a", "an", "as", "at", "by", "in", "of", "on", "or", "to"]);

const NEGATIONS = [
  "not",
  "no",
  "never",
  "neither",
  "nor",
  "isn",
  "aren",
  "wasn",
  "weren",
  "doesn",
  "don",
  "didn",
  "below",
  "above",
  "under",
  "over",
  "less",
  "fewer",
  "more",
  "greater",
  "higher",
  "lower",
  "than",
  "exceed",
  "exceeds",
  "exceeded",
  "beyond",
  "unlike",
  "except",
  "excluding",
  "ahead",
  "behind",
  "trails",
  "trailed",
];
const HAN_NEGATIONS = [
  "不",
  "没",
  "未",
  "无",
  "非",
  "低于",
  "高于",
  "超过",
  "少于",
  "多于",
  "相比",
  "领先",
  "落后",
];

/**
 * Words that make a figure another quantity than its label's: a net or a gross one, one per day or
 * after tax, a forecast. "Per" and "each" only make an average, so a mean's clause may hold them.
 */
const QUALIFIERS = [
  "net",
  "gross",
  "median",
  "adjusted",
  "excluding",
  "minus",
  "plus",
  "after",
  "before",
  "daily",
  "weekly",
  "monthly",
  "annual",
  "yearly",
  "cumulative",
  "projected",
  "forecast",
  "estimated",
  "expected",
  "target",
  "budget",
  "budgeted",
];
const HAN_QUALIFIERS = [
  "净",
  "毛",
  "中位",
  "扣除",
  "除去",
  "不含",
  "税后",
  "税前",
  "预计",
  "预测",
  "估计",
  "目标",
  "预算",
  "累计",
  "日均",
  "月均",
  "年均",
];
const PER = ["per", "each", "every"];
const HAN_PER = ["每"];

/** The words that name each way a figure is worked out, so a sum called an average is told apart. */
const AGGREGATES: Record<string, readonly string[]> = {
  sum: ["total", "sum", "合计", "总计", "总额"],
  mean: ["average", "mean", "avg", "平均", "均值"],
  min: ["lowest", "minimum", "smallest", "最低", "最小"],
  max: ["highest", "maximum", "largest", "最高", "最大"],
  count: ["count", "number", "次数", "数量", "个数", "笔数"],
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

/** Characters that make a region's name another region's just before it: 东北部 is not 北部. */
const COMPASS = /[东南西北中华]/u;

function holdsTerm(
  clause: string,
  tokens: readonly string[],
  term: string,
  exact = false,
): boolean {
  if (HAN.test(term))
    return [...clause.matchAll(new RegExp(term, "gu"))].some(
      (found) => found.index === 0 || !COMPASS.test(clause[found.index - 1] ?? ""),
    );
  if (exact) return tokens.includes(term);
  const lower = term.toLowerCase();
  return tokens.some((token) =>
    /\p{N}/u.test(lower) ? token.toLowerCase() === lower : sameWord(lower, token.toLowerCase()),
  );
}

const tokensOf = (text: string) =>
  [...text.replace(HAN_RUN, " ").matchAll(TOKEN)].map(([token]) => token);

const allTerms = (terms: Terms) => [
  ...terms.words.map((term) => ({ term, exact: false })),
  ...terms.exact.map((term) => ({ term, exact: true })),
  ...terms.han.map((term) => ({ term, exact: false })),
];

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

/**
 * Whether `figure`'s own clause in `claim` can stand as naming it: it holds every word of its label
 * (in a table, its cell's row and column headings count), and none that only another of its run's
 * figures, or another figure of the sentence, is named by, no negation, no comparison, no word
 * that makes it another quantity (net, per day, a forecast), and no word for another way of working
 * it out than its own. False also when its clause can't be found.
 */
export function namingHolds(
  claim: string,
  figure: CheckFigure,
  figures: readonly CheckFigure[],
): boolean {
  const record = figure.analysisRecord;
  const label = record?.label ?? figure.calculated?.figure.label ?? "";
  const own = termsOf(label);
  const terms = allTerms(own);
  if (terms.length === 0) return false;
  const found = clausesOf(claim, figures).get(figure.id);
  if (found === undefined) return false;
  const clause = `${found} ${figure.label ?? ""}`;
  if (!terms.every(({ term, exact }) => holdsTerm(clause, tokensOf(clause), term, exact)))
    return false;
  const tokens = tokensOf(found);
  const lowered = tokens.map((token) => token.toLowerCase());
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
  if (sibling.some(({ term, exact }) => holdsTerm(found, tokens, term, exact))) return false;
  if (NEGATIONS.some((word) => lowered.includes(word))) return false;
  if (HAN_NEGATIONS.some((word) => found.includes(word))) return false;
  const how = record?.of?.how ?? null;
  const unlabelled = (word: string) => !mine.has(word) && !label.toLowerCase().includes(word);
  const qualifiers = [...QUALIFIERS, ...(how === "mean" ? [] : PER)].filter(unlabelled);
  if (qualifiers.some((word) => lowered.includes(word))) return false;
  const hanQualifiers = [...HAN_QUALIFIERS, ...(how === "mean" ? [] : HAN_PER)].filter(unlabelled);
  if (hanQualifiers.some((word) => found.includes(word))) return false;
  const elsewhere = Object.entries(AGGREGATES)
    .filter(([each]) => how !== null && each !== how)
    .flatMap(([, words]) => words)
    .filter((word) => !mine.has(word) && !label.includes(word));
  return !elsewhere.some((word) => holdsTerm(found, tokens, word));
}
