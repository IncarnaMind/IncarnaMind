/**
 * The citation styles IncarnaMind ships (#289, ADR-0016): every style of the CSL project's
 * repository, unmodified, in resources/citation-styles/styles.pack, each known by its file's name
 * ("nature", "the-lancet"), and the common list the picker offers first, with names of its own in
 * either language. "Numbered" is IncarnaMind's own: Citations numbered in the text, each a
 * footnote naming its Document and Location, as before styles existed.
 * Pure: the core and the renderer import it.
 */
import type { Language } from "../core/language";
import type { MessageKey } from "./i18n";

/** How a style's citations read, as its CSL category says. */
export const CITATION_FORMATS = ["author-date", "author", "numeric", "label", "note"] as const;
export type CitationFormat = (typeof CITATION_FORMATS)[number];

/** The common list's ids, which Minds have kept since before the pack. */
export const COMMON_CITATION_STYLE_IDS = [
  "numbered",
  "apa",
  "mla",
  "harvard",
  "chicago-notes",
  "chicago-author-date",
  "ieee",
  "gb-t-7714-2015-numeric",
  "gb-t-7714-2015-author-date",
  "gb-t-7714-2025-numeric",
  "gb-t-7714-2025-author-date",
  "vancouver",
] as const;

export type CommonCitationStyleId = (typeof COMMON_CITATION_STYLE_IDS)[number];

/** A common style's id, or a style's file name in the pack ("nature"). */
export type CitationStyleId = string;

/**
 * How a style's Citations read in the text:
 * - "numbered": IncarnaMind's numbered markers, each a footnote naming the Document and Location;
 * - "in-text": the style's own form in the text, "(Bowler et al., 2010, p. 4)" or "[1]";
 * - "note": a note (a footnote in Word) in the style's form, its number in the text.
 */
export type CitationForm = "numbered" | "in-text" | "note";

export interface CitationStyle {
  id: CommonCitationStyleId;
  /** Its name in the picker and on its button: "APA 7". */
  label: MessageKey;
  /** Its file's name in the pack; null for Numbered. */
  packId: string | null;
  /** How the picker describes its citations. */
  format: CitationFormat;
  form: CitationForm;
  /**
   * The language its own words are in, and its Location words ("slide 4", "第 4 张幻灯片"):
   * Chinese for GB/T 7714, English for the rest.
   */
  language: Language;
  /**
   * Its other names, which the picker's search ranks as it ranks its label: "American
   * Psychological Association", "国标".
   */
  aliases: readonly string[];
  /**
   * What else the picker's search finds it by, after a style of that name: how it cites
   * ("author-date", "footnote"), a field it is for ("medicine").
   */
  keywords: readonly string[];
  /**
   * The Bibliography's heading in an export, as the style's guide names it, in its language;
   * null for Numbered, whose exports have none.
   */
  heading: string | null;
  /**
   * Where a Citation's Location goes: "in-citation", as the style's file writes it ("(Oke, 1982,
   * p. 4)"), or "raised-after": the file leaves it out, and the standard puts it after the number
   * or the author and year, raised ("[3]⁵⁻⁶", "（钱学森，1990）³⁰"), as GB/T 7714—2015 10.1.3 and
   * 10.2.5 do.
   */
  locators: "in-citation" | "raised-after";
}

const GB_T = ["GB/T 7714", "GBT 7714", "国标", "国家标准", "guobiao"];

export const CITATION_STYLES: readonly CitationStyle[] = [
  {
    id: "numbered",
    label: "citationStyle.numbered",
    packId: null,
    format: "numeric",
    form: "numbered",
    language: "en",
    aliases: [],
    keywords: ["footnote", "document", "page", "脚注", "编号"],
    heading: null,
    locators: "in-citation",
  },
  {
    id: "apa",
    label: "citationStyle.apa",
    packId: "apa",
    format: "author-date",
    form: "in-text",
    language: "en",
    aliases: ["American Psychological Association"],
    keywords: ["author-date"],
    heading: "References",
    locators: "in-citation",
  },
  {
    id: "mla",
    label: "citationStyle.mla",
    packId: "modern-language-association",
    format: "author",
    form: "in-text",
    language: "en",
    aliases: ["Modern Language Association"],
    keywords: ["works cited"],
    heading: "Works Cited",
    locators: "in-citation",
  },
  {
    id: "harvard",
    label: "citationStyle.harvard",
    packId: "harvard-cite-them-right",
    format: "author-date",
    form: "in-text",
    language: "en",
    aliases: ["Cite Them Right"],
    keywords: ["author-date"],
    heading: "Reference list",
    locators: "in-citation",
  },
  {
    id: "chicago-notes",
    label: "citationStyle.chicago-notes",
    packId: "chicago-notes-bibliography",
    format: "note",
    form: "note",
    language: "en",
    aliases: ["Chicago Manual of Style"],
    keywords: ["footnote", "notes and bibliography", "脚注"],
    heading: "Bibliography",
    locators: "in-citation",
  },
  {
    id: "chicago-author-date",
    label: "citationStyle.chicago-author-date",
    packId: "chicago-author-date",
    format: "author-date",
    form: "in-text",
    language: "en",
    aliases: ["Chicago Manual of Style"],
    keywords: ["author-date"],
    heading: "References",
    locators: "in-citation",
  },
  {
    id: "ieee",
    label: "citationStyle.ieee",
    packId: "ieee",
    format: "numeric",
    form: "in-text",
    language: "en",
    aliases: ["Institute of Electrical and Electronics Engineers"],
    keywords: ["numeric"],
    heading: "References",
    locators: "in-citation",
  },
  {
    id: "gb-t-7714-2015-numeric",
    label: "citationStyle.gb-t-7714-2015-numeric",
    packId: "china-national-standard-gb-t-7714-2015-numeric",
    format: "numeric",
    form: "in-text",
    language: "zh-CN",
    aliases: GB_T,
    keywords: ["numeric", "顺序编码"],
    heading: "参考文献",
    locators: "raised-after",
  },
  {
    id: "gb-t-7714-2015-author-date",
    label: "citationStyle.gb-t-7714-2015-author-date",
    packId: "china-national-standard-gb-t-7714-2015-author-date",
    format: "author-date",
    form: "in-text",
    language: "zh-CN",
    aliases: GB_T,
    keywords: ["author-date", "著者-出版年"],
    heading: "参考文献",
    locators: "raised-after",
  },
  {
    id: "gb-t-7714-2025-numeric",
    label: "citationStyle.gb-t-7714-2025-numeric",
    packId: "china-national-standard-gb-t-7714-2025-numeric",
    format: "numeric",
    form: "in-text",
    language: "zh-CN",
    aliases: GB_T,
    keywords: ["numeric", "顺序编码"],
    heading: "参考文献",
    locators: "raised-after",
  },
  {
    id: "gb-t-7714-2025-author-date",
    label: "citationStyle.gb-t-7714-2025-author-date",
    packId: "china-national-standard-gb-t-7714-2025-author-date",
    format: "author-date",
    form: "in-text",
    language: "zh-CN",
    aliases: GB_T,
    keywords: ["author-date", "著者-出版年"],
    heading: "参考文献",
    locators: "raised-after",
  },
  {
    id: "vancouver",
    label: "citationStyle.vancouver",
    packId: "nlm-citation-sequence",
    format: "numeric",
    form: "in-text",
    language: "en",
    aliases: ["NLM", "Citing Medicine"],
    keywords: ["numeric", "medicine"],
    heading: "References",
    locators: "in-citation",
  },
];

/**
 * The style of a Mind that hasn't chosen one. Numbered, as many Minds cite contracts and reports
 * that no citation style could cite better, so none turns into "(n.d.)" by itself; but GB/T
 * 7714—2015 when the interface and the Mind's text are both Chinese and it cites a paper or a
 * book (`isPaperOrBook`), as a Chinese thesis is cited.
 */
export function defaultCitationStyle(
  language: Language,
  mind: { chineseText: boolean; citesWorks: boolean },
): CommonCitationStyleId {
  return language === "zh-CN" && mind.chineseText && mind.citesWorks
    ? "gb-t-7714-2015-numeric"
    : "numbered";
}

/**
 * The styles the prompt in a Mind that cites papers or books offers (`CitationStylePrompt`),
 * the interface language's own first.
 */
export const PROMPTED_CITATION_STYLES: Readonly<
  Record<Language, readonly CommonCitationStyleId[]>
> = {
  en: ["apa", "gb-t-7714-2015-numeric"],
  "zh-CN": ["gb-t-7714-2015-numeric", "apa"],
};

/** Whether a value can be a style's id: a common one, or a CSL file's name, as the pack keeps them. */
export const isCitationStyleId = (value: unknown): value is CitationStyleId =>
  typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,199}$/.test(value);

/** How many styles the picker's Recently used lists. */
export const RECENT_CITATION_STYLES = 5;

/** Recently used, newest first, once `id` is chosen. */
export const withRecentStyle = (
  recent: readonly CitationStyleId[],
  id: CitationStyleId,
): CitationStyleId[] =>
  [id, ...recent.filter((each) => each !== id)].slice(0, RECENT_CITATION_STYLES);

export const isRecentStyles = (value: unknown): value is CitationStyleId[] =>
  Array.isArray(value) &&
  value.length <= RECENT_CITATION_STYLES &&
  value.every(isCitationStyleId) &&
  new Set(value).size === value.length;

export const commonCitationStyle = (id: CitationStyleId): CitationStyle | undefined =>
  CITATION_STYLES.find((each) => each.id === id);

/**
 * The prefix of a pack style whose file's name is a common style's id meaning another style: the
 * CSL repository's "chicago-notes" (notes alone) beside the common "chicago-notes" (notes and
 * bibliography), which Minds chose before the pack.
 */
const RENAMED = "csl-";

/** The id the app knows a pack style by: its file's name, unless a common style has it. */
export function styleIdOf(packId: string): CitationStyleId {
  const common = commonCitationStyle(packId);
  return common && common.packId !== packId ? `${RENAMED}${packId}` : packId;
}

/** The pack file a style formats with, by the id the app knows it by. */
export function packIdOf(id: CitationStyleId): string | null {
  const common = commonCitationStyle(id);
  if (common) return common.packId;
  const renamed = id.startsWith(RENAMED) ? id.slice(RENAMED.length) : null;
  return renamed && commonCitationStyle(renamed) ? renamed : id;
}

/** A style of the pack as the picker lists it, without the common list's own. */
export interface StyleSummary {
  id: CitationStyleId;
  title: string;
  short?: string;
  format: CitationFormat;
  /** Its citations are notes. */
  note: boolean;
  fields: readonly string[];
  /** A journal's style: the title of the style it follows. */
  follows?: string;
}

/** Every style of the pack, and how many there are with the common ones: "Search 10,865 styles…". */
export interface StyleCatalogue {
  count: number;
  styles: StyleSummary[];
}

/**
 * A style as a Mind is formatted in it: its form and words, and what the engine formats with.
 * Numbered formats with nothing; so does a style this version doesn't ship (`unavailable`).
 */
export interface ResolvedCitationStyle {
  id: CitationStyleId;
  form: CitationForm;
  language: Language;
  heading: string | null;
  locators: CitationStyle["locators"];
  engine: { packId: string; locale?: string } | null;
  unavailable?: true;
}

/** Numbered, as a style resolves when it is Numbered or this version doesn't have it. */
export const NUMBERED_STYLE: Omit<ResolvedCitationStyle, "id"> = {
  form: "numbered",
  language: "en",
  heading: null,
  locators: "in-citation",
  engine: null,
};
