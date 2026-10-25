/**
 * What the citation style picker lists and finds (#910): the common styles, by their names in
 * either language and what else they're called ("国标", "Cite Them Right"), and every style of
 * the pack by its title, short title and fields. Pure, so the ranking is tested on the whole pack.
 */
import type { Language } from "../../core/language";
import {
  CITATION_STYLES,
  type CitationFormat,
  type CitationStyleId,
  type StyleCatalogue,
} from "../../shared/citationStyles";
import { translate } from "../../shared/i18n";

export interface StyleEntry {
  id: CitationStyleId;
  /** Its name in the interface language. */
  title: string;
  format: CitationFormat;
  /** A journal's style: the title of the style it follows. */
  follows?: string;
  common: boolean;
  /**
   * Its names, normalised (`normalise`): a common style's in either language and its aliases, or
   * a pack style's title and short title.
   */
  names: readonly string[];
  /** What else it is found by, normalised: a common style's keywords, a pack style's fields. */
  keywords: readonly string[];
}

export const normalise = (text: string) =>
  text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

/** Every style the picker can offer, the common ones first, in the common list's order. */
export function styleEntries(language: Language, catalogue: StyleCatalogue | null): StyleEntry[] {
  const common: StyleEntry[] = CITATION_STYLES.map((style) => ({
    id: style.id,
    title: translate(language, style.label),
    format: style.format,
    common: true,
    names: [translate("en", style.label), translate("zh-CN", style.label), ...style.aliases].map(
      normalise,
    ),
    keywords: style.keywords.map(normalise),
  }));
  const rest: StyleEntry[] = (catalogue?.styles ?? []).map((style) => ({
    id: style.id,
    title: style.title,
    format: style.format,
    ...(style.follows ? { follows: style.follows } : {}),
    common: false,
    names: [style.title, ...(style.short ? [style.short] : [])].map(normalise),
    keywords: style.fields.map(normalise),
  }));
  return [...common, ...rest];
}

/** The common list as the picker shows it: GB/T 7714 first when the interface is Chinese. */
export function commonEntries(entries: readonly StyleEntry[], language: Language): StyleEntry[] {
  const common = entries.filter((entry) => entry.common);
  if (language !== "zh-CN") return common;
  const gbt = common.filter((entry) => entry.id.startsWith("gb-t-7714"));
  return [...gbt, ...common.filter((entry) => !gbt.includes(entry))];
}

const LETTER = /[\p{L}\p{N}]/u;

/** How well a name matches: 0 the whole name, 2 its start, 3 a word's start, 4 inside it. */
function nameScore(name: string, query: string): number {
  if (name === query) return 0;
  if (name.startsWith(query)) return 2;
  let at = name.indexOf(query);
  if (at < 0) return Number.POSITIVE_INFINITY;
  for (; at > 0; at = name.indexOf(query, at + 1)) {
    if (!LETTER.test(name[at - 1] ?? "")) return 3;
  }
  return 4;
}

/**
 * Its best name's `nameScore`, a whole keyword just after a whole name: the journal "Medicine"
 * before Vancouver, which "medicine" also finds; 5 for every word of the query somewhere.
 */
function score(entry: StyleEntry, query: string, words: readonly string[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const name of entry.names) best = Math.min(best, nameScore(name, query));
  for (const keyword of entry.keywords) {
    best = Math.min(best, Math.max(1, nameScore(keyword, query)));
  }
  if (best === Number.POSITIVE_INFINITY && words.length > 1) {
    const all = [...entry.names, ...entry.keywords].join(" ");
    if (words.every((word) => all.includes(word))) best = 5;
  }
  return best;
}

export interface StyleMatches {
  /** The common styles and the pack's own, best first. */
  styles: StyleEntry[];
  /** The journals' styles, best first. */
  journals: StyleEntry[];
  /** The journals hold the best match, so they come first. */
  journalsFirst: boolean;
}

/**
 * The styles a query finds, best first: a whole name of its own, a whole keyword, then a name's
 * start, a word's, anywhere.
 */
export function searchStyles(entries: readonly StyleEntry[], query: string): StyleMatches {
  const wanted = normalise(query);
  const words = wanted.split(" ").filter(Boolean);
  const scored = entries.flatMap((entry, order) => {
    const value = score(entry, wanted, words);
    return value === Number.POSITIVE_INFINITY ? [] : [{ entry, value, order }];
  });
  scored.sort(
    (a, b) =>
      a.value - b.value ||
      Number(b.entry.common) - Number(a.entry.common) ||
      (a.entry.common ? a.order - b.order : 0) ||
      a.entry.title.length - b.entry.title.length ||
      a.entry.title.localeCompare(b.entry.title),
  );
  const styles = scored.filter(({ entry }) => entry.follows === undefined);
  const journals = scored.filter(({ entry }) => entry.follows !== undefined);
  return {
    styles: styles.map(({ entry }) => entry),
    journals: journals.map(({ entry }) => entry),
    journalsFirst:
      (journals[0]?.value ?? Number.POSITIVE_INFINITY) <
      (styles[0]?.value ?? Number.POSITIVE_INFINITY),
  };
}

/**
 * `found` for a query whose matches `shown` were on screen before more styles arrived: those keep
 * their order and section first, and the ones that arrived follow, so the style at the top, which
 * Enter takes, doesn't move under the User (#1497). A whole name that arrives follows too until
 * the query changes: mostly a journal's abbreviation, the "CHI" of a "Chicago" being typed.
 */
export function keepShown(shown: StyleMatches, found: StyleMatches): StyleMatches {
  if (shown.styles.length + shown.journals.length === 0) return found;
  const after = (before: readonly StyleEntry[], now: readonly StyleEntry[]) => {
    const place = new Map(before.map((entry, index) => [entry.id, index]));
    const at = (entry: StyleEntry) => place.get(entry.id) ?? before.length;
    return now.toSorted((a, b) => at(a) - at(b));
  };
  return {
    styles: after(shown.styles, found.styles),
    journals: after(shown.journals, found.journals),
    journalsFirst: shown.journalsFirst,
  };
}
