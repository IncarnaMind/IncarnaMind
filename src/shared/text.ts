/**
 * Text helpers shared by the core and the renderer: CJK character classes and
 * the one text normaliser (ADR-0009).
 *
 * Everything that compares or indexes text normalises it with `normaliseText`
 * first: keyword indexing and queries, the text the embedding model reads,
 * the viewer's quote highlighting and the Citation check. Rules, in order:
 *
 * 1. Unicode NFKC, applied to each character with its combining marks. It
 *    turns full-width forms into ASCII ("，" into ",") and the Kangxi radicals
 *    that browser-made PDFs use for common ideographs ("⼤" into "大").
 * 2. CJK radical look-alikes NFKC leaves alone are folded too ("⻓" into "长"),
 *    from Unicode's EquivalentUnifiedIdeograph data.
 * 3. Invisible characters (soft hyphens, zero-width spaces, BOMs) are dropped.
 * 4. Quote marks become ' and ", dashes become -, and "、" and "。" become ","
 *    and ".".
 * 5. Line-break hyphenation, at a hyphen that ends a line between two letters:
 *    - a word split across the line is joined: "inter-\nnational" reads
 *      "international";
 *    - a hyphenated compound keeps its hyphen: "English-\nto-German" reads
 *      "English-to-German". It is a compound when the part before or after the
 *      break has a hyphen of its own, or when the line ends in a lowercase
 *      letter and the next starts with a capital ("non-\nEnglish").
 *    A hyphen or dash that ends a line before a digit or letter stays, with
 *    the line break removed ("COVID-\n19", "1990–\n1995").
 * 6. Whitespace next to a CJK character or CJK punctuation is removed: Chinese
 *    and Japanese don't put spaces between words, and pdf.js puts spaces
 *    around Latin words and numbers inside them ("含 1750 亿参数"). Korean
 *    does use spaces, so Hangul isn't counted.
 * 7. Any other run of whitespace, line breaks included, becomes one space,
 *    and leading and trailing whitespace goes.
 *
 * Rule 5 has to guess, so `normaliseWithOffsets` also marks each line-end
 * hyphen as optional: quote matching accepts the text with or without it.
 */

/**
 * Scripts written without spaces between words (Chinese, Japanese, Korean),
 * as the body of a regular-expression character class. Needs the `u` flag.
 */
export const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";

const cjkCharacter = new RegExp(`[${CJK}]`, "u");

/** A name read for comparing: its letters and digits, in lower case ("Gradient Descent: The Ultimate Optimizer" is a file named without its colon). */
export const nameKey = (name: string): string =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

export const isCjk = (character: string): boolean => cjkCharacter.test(character);

/**
 * Characters whitespace is removed next to (rule 6): Han (radicals included),
 * kana, Bopomofo, CJK punctuation, CJK compatibility forms, and the full-width
 * punctuation (but not the full-width letters and digits). Judged before NFKC,
 * which turns "，" into ",".
 */
const SPACELESS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\u3000-\u303f\ufe30-\ufe4f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u;

/** Whether whitespace next to `character` is removed (rule 6). */
export const isSpaceless = (character: string): boolean => SPACELESS.test(character);

/**
 * CJK Radicals Supplement characters that NFKC leaves alone but PDF generators
 * emit in place of the unified ideograph: a subset of Unicode's
 * EquivalentUnifiedIdeograph.txt. NFKC already folds the Kangxi Radicals block.
 */
const RADICALS: Readonly<Record<string, string>> = {
  "⺋": "㔾",
  "⺌": "小",
  "⺎": "兀",
  "⺏": "尣",
  "⺐": "尢",
  "⺒": "巳",
  "⺓": "幺",
  "⺔": "彑",
  "⺕": "彐",
  "⺖": "忄",
  "⺗": "心",
  "⺘": "扌",
  "⺙": "攵",
  "⺛": "旡",
  "⺞": "歺",
  "⺠": "民",
  "⺡": "氵",
  "⺣": "灬",
  "⺤": "爫",
  "⺦": "丬",
  "⺧": "牛",
  "⺨": "犭",
  "⺪": "疋",
  "⺫": "罒",
  "⺬": "示",
  "⺭": "礻",
  "⺮": "竹",
  "⺲": "罒",
  "⺳": "罓",
  "⺶": "羊",
  "⺷": "羊",
  "⺹": "耂",
  "⺼": "肀",
  "⺾": "艹",
  "⻁": "虎",
  "⻂": "衤",
  "⻃": "覀",
  "⻄": "西",
  "⻅": "见",
  "⻆": "角",
  "⻈": "讠",
  "⻉": "贝",
  "⻋": "车",
  "⻌": "辶",
  "⻍": "辶",
  "⻎": "辶",
  "⻏": "阝",
  "⻐": "钅",
  "⻑": "長",
  "⻒": "镸",
  "⻓": "长",
  "⻔": "门",
  "⻕": "阝",
  "⻖": "阝",
  "⻗": "雨",
  "⻘": "青",
  "⻙": "韦",
  "⻚": "页",
  "⻛": "风",
  "⻜": "飞",
  "⻝": "食",
  "⻞": "飠",
  "⻟": "飠",
  "⻠": "饣",
  "⻡": "首",
  "⻢": "马",
  "⻣": "骨",
  "⻤": "鬼",
  "⻥": "鱼",
  "⻦": "鸟",
  "⻧": "卤",
  "⻨": "麦",
  "⻩": "黄",
  "⻪": "黾",
  "⻫": "斉",
  "⻬": "齐",
  "⻭": "歯",
  "⻮": "齿",
  "⻯": "竜",
  "⻰": "龙",
  "⻱": "龜",
  "⻲": "亀",
  "⻳": "龟",
};

/** Rule 4, applied after NFKC. Hyphens are listed separately: rule 5 treats them apart from dashes. */
const UNIFIED: Readonly<Record<string, string>> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "′": "'",
  "`": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "″": '"',
  "«": '"',
  "»": '"',
  "「": '"',
  "」": '"',
  "『": '"',
  "』": '"',
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "−": "-",
  "、": ",",
  "。": ".",
};

/** Hyphens, after NFKC: the hyphen-minus and U+2010 (NFKC turns the non-breaking hyphen into it). */
const HYPHENS: ReadonlySet<string> = new Set(["-", "‐"]);

/** Dropped entirely: NUL, soft hyphen, zero-width space and joiners, word joiner, byte-order mark. */
export const INVISIBLE: ReadonlySet<string> = new Set([
  "\u0000",
  "\u00ad",
  "\u200b",
  "\u200c",
  "\u200d",
  "\u2060",
  "\ufeff",
]);

// A base character with its combining marks, so NFKC sees them together (e.g. "e" + U+0301).
const SEGMENT = /\P{M}\p{M}*|\p{M}+/gsu;
const WHITESPACE = /\s/u;
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;
const UPPERCASE = /\p{Lu}/u;
const LOWERCASE = /\p{Ll}/u;

/** One UTF-16 code unit of normalised text, and the span of the original it came from. */
export interface NormalisedUnit {
  char: string;
  /** UTF-16 offsets into the original text; `end` is exclusive. */
  start: number;
  end: number;
  /**
   * A hyphen that ended a line between two letters (rule 5). Quote matching
   * may skip it, or match a "-" in the quote to it when it was removed.
   */
  optional?: true;
  /** Left out of the normalised text: a hyphen rule 5 removed to join a word. */
  removed?: true;
}

interface Unit extends NormalisedUnit {
  /** Whitespace next to it is removed (rule 6). */
  spaceless: boolean;
  /** A hyphen, not a dash (rule 5). */
  hyphen: boolean;
}

/** Rules 1 to 4: one unit per code unit of normalised text, whitespace kept as it is. */
function characterUnits(text: string): Unit[] {
  const units: Unit[] = [];
  for (const match of text.matchAll(SEGMENT)) {
    const start = match.index;
    const end = start + match[0].length;
    const spaceless = SPACELESS.test(match[0]);
    const normalised = match[0].normalize("NFKC");
    for (let index = 0; index < normalised.length; index++) {
      const raw = normalised[index] as string;
      if (INVISIBLE.has(raw)) continue;
      const hyphen = HYPHENS.has(raw);
      const char = hyphen ? "-" : (RADICALS[raw] ?? UNIFIED[raw] ?? raw);
      units.push({ char, start, end, spaceless, hyphen });
    }
  }
  return units;
}

const isSpace = (unit: Unit | undefined) => unit !== undefined && WHITESPACE.test(unit.char);
/** A letter of a script written with spaces: rule 5 applies between these. */
const isSpacedLetter = (unit: Unit | undefined) =>
  unit !== undefined && !unit.spaceless && LETTER.test(unit.char);

/** Whether the word ending just before `index` in `out` (the hyphen excluded) has a hyphen. */
function hasHyphenBefore(out: readonly Unit[], index: number): boolean {
  for (let at = index - 1; at >= 0; at--) {
    const unit = out[at] as Unit;
    if (unit.char === " " || unit.spaceless) return false;
    if (unit.char === "-") return true;
  }
  return false;
}

/** Whether the word starting at `index` in `units` has a hyphen or dash. */
function hasHyphenAfter(units: readonly Unit[], index: number): boolean {
  for (let at = index; at < units.length; at++) {
    const unit = units[at] as Unit;
    if (isSpace(unit) || unit.spaceless) return false;
    if (unit.char === "-") return true;
  }
  return false;
}

/** Rules 5 to 7. */
function joinWhitespace(units: readonly Unit[]): Unit[] {
  const out: Unit[] = [];
  let index = 0;
  while (index < units.length) {
    const unit = units[index] as Unit;
    if (!isSpace(unit)) {
      out.push(unit);
      index++;
      continue;
    }
    let next = index;
    let lineBreak = false;
    while (next < units.length && isSpace(units[next])) {
      if (LINE_BREAK.test((units[next] as Unit).char)) lineBreak = true;
      next++;
    }
    const before = out.at(-1);
    const after = units[next];
    index = next;
    // Leading and trailing whitespace is dropped.
    if (!before || !after) continue;

    if (lineBreak && before.char === "-" && out.length > 1 && !isSpace(out.at(-2))) {
      const letterBefore = out.at(-2) as Unit;
      if (before.hyphen && isSpacedLetter(letterBefore) && isSpacedLetter(after)) {
        before.optional = true;
        const compound =
          hasHyphenBefore(out, out.length - 1) ||
          hasHyphenAfter(units, next) ||
          (LOWERCASE.test(letterBefore.char) && UPPERCASE.test(after.char));
        if (!compound) before.removed = true;
        continue;
      }
      // A hyphen or dash attached to what comes before keeps the next line attached to it.
      if (!after.spaceless && (LETTER.test(after.char) || DIGIT.test(after.char))) continue;
    }
    if (before.spaceless || after.spaceless) continue;
    out.push({
      char: " ",
      start: unit.start,
      end: (units[next - 1] as Unit).end,
      spaceless: false,
      hyphen: false,
    });
  }
  return out;
}

/**
 * Normalises text and keeps track of where each part came from: one unit per
 * UTF-16 code unit of the normalised text, plus the hyphens rule 5 removed
 * (marked `removed`). `text` is the normalised text itself.
 */
export function normaliseWithOffsets(text: string): { text: string; units: NormalisedUnit[] } {
  const units: NormalisedUnit[] = joinWhitespace(characterUnits(text)).map(
    ({ char, start, end, optional, removed }) => ({
      char,
      start,
      end,
      ...(optional && { optional }),
      ...(removed && { removed }),
    }),
  );
  return {
    text: units
      .filter((unit) => !unit.removed)
      .map((unit) => unit.char)
      .join(""),
    units,
  };
}

/** The Kangxi Radicals and CJK Radicals Supplement blocks: the look-alikes rules 1 and 2 fold. */
const RADICAL_LOOK_ALIKE = /[\u2e80-\u2eff\u2f00-\u2fdf]/gu;

/**
 * Text with its CJK radical look-alikes folded into the ideographs they stand
 * for, as rules 1 and 2 fold them ("⼤" reads "大"), and nothing else changed:
 * line breaks, punctuation and other compatibility forms stay as they are.
 * For text a model reads, such as the Passages it is given.
 */
export function foldRadicals(text: string): string {
  return text.replace(RADICAL_LOOK_ALIKE, (char) => RADICALS[char] ?? char.normalize("NFKC"));
}

/** Normalises text for comparing and indexing (see the module comment for the rules). */
export function normaliseText(text: string): string {
  let out = "";
  for (const unit of joinWhitespace(characterUnits(text))) {
    if (!unit.removed) out += unit.char;
  }
  return out;
}
