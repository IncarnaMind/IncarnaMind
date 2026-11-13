import { matchName, queryWords } from "../matcher";

/**
 * The prompts "/" in the panel's field finds for what follows it (#2925), best first: those whose
 * label starts with it, then those with a word starting with it, then those holding it anywhere,
 * then those found by a keyword or, for a Chinese label, its pinyin or the pinyin's initials, as
 * ⌘K's matcher finds names. Within a rank they keep their order; nothing typed lists them all.
 */
export function rankHelp<Kind>(
  kinds: readonly Kind[],
  typed: string,
  labelOf: (kind: Kind) => string,
  keywordsOf: (kind: Kind) => string,
): Kind[] {
  const words = queryWords(typed);
  if (words.length === 0) return [...kinds];
  const query = words.join(" ");
  const rankOf = (kind: Kind): number | null => {
    const label = queryWords(labelOf(kind)).join(" ");
    if (label.startsWith(query)) return 0;
    if (` ${label}`.includes(` ${query}`)) return 1;
    if (label.includes(query)) return 2;
    const found = matchName(words, `${labelOf(kind)} ${keywordsOf(kind)}`);
    return found?.atWordStart && !found.typo ? 3 : null;
  };
  return kinds
    .flatMap((kind, index) => {
      const rank = rankOf(kind);
      return rank === null ? [] : [{ kind, index, rank }];
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ kind }) => kind);
}
