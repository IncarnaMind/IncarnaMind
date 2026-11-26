/**
 * A Word file's list numbering (`numbering.xml`) read as Word reads it (#746): the list and level
 * a paragraph is numbered at, through its own numbering, else its style chain's, its level from
 * its own, its style chain's or the level that names its style; and the number Word draws before
 * it, counted in document order, the lists of one definition counting on together and a list's
 * start override starting it again. The import's lists and the export's cross-references read it
 * the same way. Pure.
 */
import { wordNumberText } from "../../../shared/numbering";
import type { WordStyleTable } from "./wordStyleTable";
import { child, elements, onOff, type XmlElement } from "./xml";

export interface WordListLevel {
  format: string;
  start: number;
  /** Its number's text, with "%1"… where each level's number goes: "%1.", "(%2)", "第%1条". */
  text: string;
  /** The paragraph style numbered at this level (`w:pStyle`), if one is. */
  style: string | null;
  /** Every level's number in Arabic numerals, as legal numbering writes them (`w:isLgl`). */
  legal: boolean;
  /**
   * The level, from 1, whose items or those of any level above it start this one again
   * (`w:lvlRestart`); 0 for never; null for any level above it, as without one.
   */
  restart: number | null;
}

export interface WordNumbering {
  /** abstractNumId → its levels; a definition that only links to a list style has that style's. */
  abstracts: Map<string, Map<number, WordListLevel>>;
  /** numId → its definition, and what it overrides by level: a start, or the level itself. */
  nums: Map<string, { abstract: string; overrides: Map<number, Partial<WordListLevel>> }>;
}

/** The list and level a paragraph is numbered at. */
export interface ParagraphList {
  numId: string;
  abstract: string;
  /** Its Word level, from 0. */
  level: number;
  /** Its own numbering names the list, rather than its style. */
  own: boolean;
}

/** The deepest Word level, from 0. */
const DEEPEST = 8;

function readLevel(lvl: XmlElement): Partial<WordListLevel> {
  const value = (name: string) => child(lvl, name)?.attrs["w:val"];
  const start = value("w:start");
  const format = value("w:numFmt");
  const text = value("w:lvlText");
  const style = value("w:pStyle");
  const restart = value("w:lvlRestart");
  const legal = onOff(child(lvl, "w:isLgl"));
  return {
    ...(format !== undefined && { format }),
    ...(text !== undefined && { text }),
    ...(start !== undefined && Number.isFinite(Number(start)) && { start: Number(start) }),
    ...(style !== undefined && { style }),
    ...(legal !== undefined && { legal }),
    ...(restart !== undefined &&
      Number.isInteger(Number(restart)) &&
      Number(restart) >= 0 && { restart: Number(restart) }),
  };
}

/** The `w:numPr` a style's own paragraph properties hold. */
const numPrOf = (style: XmlElement) => child(child(style, "w:pPr") ?? style, "w:numPr");

export function readWordNumbering(
  root: XmlElement | undefined,
  styles: WordStyleTable,
): WordNumbering {
  const abstracts = new Map<string, Map<number, WordListLevel>>();
  const nums: WordNumbering["nums"] = new Map();
  const styleLinks = new Map<string, string>();
  for (const element of root ? elements(root) : []) {
    if (element.name === "w:abstractNum") {
      const id = element.attrs["w:abstractNumId"];
      if (id === undefined) continue;
      const levels = new Map<number, WordListLevel>();
      for (const lvl of elements(element).filter((each) => each.name === "w:lvl")) {
        const level = readLevel(lvl);
        levels.set(Number(lvl.attrs["w:ilvl"] ?? 0), {
          format: level.format ?? "decimal",
          start: level.start ?? 1,
          text: level.text ?? "",
          style: level.style ?? null,
          legal: level.legal ?? false,
          restart: level.restart ?? null,
        });
      }
      abstracts.set(id, levels);
      const link = child(element, "w:numStyleLink")?.attrs["w:val"];
      if (link) styleLinks.set(id, link);
    } else if (element.name === "w:num") {
      const id = element.attrs["w:numId"];
      const abstract = child(element, "w:abstractNumId")?.attrs["w:val"];
      if (id === undefined || abstract === undefined) continue;
      const overrides = new Map<number, Partial<WordListLevel>>();
      for (const override of elements(element).filter((each) => each.name === "w:lvlOverride")) {
        const lvl = child(override, "w:lvl");
        const start = child(override, "w:startOverride")?.attrs["w:val"];
        overrides.set(Number(override.attrs["w:ilvl"] ?? 0), {
          ...(lvl ? readLevel(lvl) : {}),
          ...(start !== undefined && Number.isFinite(Number(start)) && { start: Number(start) }),
        });
      }
      nums.set(id, { abstract, overrides });
    }
  }
  // A definition that only links to a list style takes its levels from the definition the
  // style's own numbering names. A list style is a style of type "numbering".
  for (const [abstract, styleId] of styleLinks) {
    const style = styles.chain("numbering", styleId).find((each) => numPrOf(each.element));
    const numId =
      style && child(numPrOf(style.element) ?? style.element, "w:numId")?.attrs["w:val"];
    const linked = numId ? nums.get(numId)?.abstract : undefined;
    const levels = linked ? abstracts.get(linked) : undefined;
    if (levels && (abstracts.get(abstract)?.size ?? 0) === 0) abstracts.set(abstract, levels);
  }
  return { abstracts, nums };
}

/**
 * The list and level a paragraph is numbered at, or null for one Word doesn't number: no list,
 * the list "0" that turns its style's off, or a list the file doesn't define.
 */
export function paragraphList(
  numbering: WordNumbering,
  styles: WordStyleTable,
  pPr: XmlElement | undefined,
  styleId: string | null,
): ParagraphList | null {
  const own = pPr && child(pPr, "w:numPr");
  const chain = styles.chain("paragraph", styleId).map((style) => ({
    id: style.id,
    numPr: numPrOf(style.element),
  }));
  const ownNumId = own && child(own, "w:numId")?.attrs["w:val"];
  const numId =
    ownNumId ??
    chain.flatMap((style) => {
      const value = style.numPr && child(style.numPr, "w:numId")?.attrs["w:val"];
      return value === undefined ? [] : [value];
    })[0] ??
    null;
  if (numId === null || numId === "0") return null;
  const num = numbering.nums.get(numId);
  if (!num) return null;
  const levelOf = (numPr: XmlElement | undefined) => {
    const value = numPr && child(numPr, "w:ilvl")?.attrs["w:val"];
    return value === undefined || value === null || !Number.isFinite(Number(value))
      ? null
      : Number(value);
  };
  const linked = [...(numbering.abstracts.get(num.abstract) ?? [])].find(([, level]) =>
    chain.some((style) => style.id === level.style),
  )?.[0];
  const level =
    levelOf(own) ??
    chain.map((style) => levelOf(style.numPr)).find((each) => each !== null) ??
    linked ??
    0;
  return {
    numId,
    abstract: num.abstract,
    level: Math.min(DEEPEST, Math.max(0, level)),
    own: ownNumId !== undefined,
  };
}

/** As `paragraphList`, for a paragraph element: its style, or the default paragraph style. */
export function listOfParagraph(
  numbering: WordNumbering,
  styles: WordStyleTable,
  p: XmlElement,
): ParagraphList | null {
  const pPr = child(p, "w:pPr");
  const styleId = (pPr && child(pPr, "w:pStyle")?.attrs["w:val"]) ?? styles.defaultOf("paragraph");
  return paragraphList(numbering, styles, pPr, styleId);
}

/** A list's level as its numbering defines it, with what the list overrides there. */
export function levelOf(numbering: WordNumbering, numId: string, at: number): WordListLevel {
  const num = numbering.nums.get(numId);
  const base = num ? numbering.abstracts.get(num.abstract)?.get(at) : undefined;
  return {
    format: "decimal",
    start: 1,
    text: "",
    style: null,
    legal: false,
    restart: null,
    ...base,
    ...num?.overrides.get(at),
  };
}

/**
 * Counts a document's numbered paragraphs in order, as Word does: each definition's levels count
 * on across the lists that share it; a list's start override starts it again where it is first
 * used; an item starts every deeper level again, but one whose restart level is above it.
 */
export class WordListCounter {
  private readonly counters = new Map<string, number[]>();
  private readonly seen = new Set<string>();

  constructor(private readonly numbering: WordNumbering) {}

  /** The numbers at each level, from the first down to the item's own, once it is counted. */
  count(list: ParagraphList): number[] {
    const num = this.numbering.nums.get(list.numId);
    const start = (at: number) =>
      num?.overrides.get(at)?.start ??
      this.numbering.abstracts.get(list.abstract)?.get(at)?.start ??
      1;
    let counters = this.counters.get(list.abstract);
    if (!counters) {
      counters = Array.from({ length: DEEPEST + 1 }, (_, at) => start(at) - 1);
      this.counters.set(list.abstract, counters);
    }
    if (!this.seen.has(list.numId)) {
      this.seen.add(list.numId);
      for (const [at, value] of num?.overrides ?? []) {
        if (value.start !== undefined) counters[at] = value.start - 1;
      }
    }
    counters[list.level] = (counters[list.level] ?? 0) + 1;
    for (let deeper = list.level + 1; deeper <= DEEPEST; deeper++) {
      const restart = levelOf(this.numbering, list.numId, deeper).restart;
      // ECMA-376 17.9.10: a restart level that is the level itself or a deeper one is ignored.
      const restarts =
        restart === null || restart > deeper ? true : restart > 0 && list.level < restart;
      if (restarts) counters[deeper] = start(deeper) - 1;
    }
    return counters.slice(0, list.level + 1);
  }
}

/**
 * A level's number as Word draws it, its text with each level's number written in that level's
 * format: "2.3", "第三条", "(b)", a bullet's character; null when a format can't be written.
 */
export function levelText(
  numbering: WordNumbering,
  numId: string,
  at: number,
  numbers: readonly number[],
): string | null {
  const level = levelOf(numbering, numId, at);
  if (level.format === "bullet" || level.format === "none") return level.text;
  let known = true;
  const text = level.text.replace(/%([1-9])/g, (_, digit: string) => {
    const of = Number(digit) - 1;
    const format = level.legal ? "decimal" : levelOf(numbering, numId, of).format;
    const written = wordNumberText(format, numbers[of] ?? 0);
    if (written === null) known = false;
    return written ?? "";
  });
  return known ? text : null;
}

/** A paragraph's number in a document: its list, the numbers counted at each level, and how Word draws it. */
export interface ParagraphNumber {
  list: ParagraphList;
  numbers: number[];
  /** As Word draws it before the paragraph; null when a format can't be written. */
  text: string | null;
}

/** The number before each paragraph, in document order; null for one Word doesn't number. */
export function paragraphNumbers(
  numbering: WordNumbering,
  styles: WordStyleTable,
  paragraphs: readonly XmlElement[],
): (ParagraphNumber | null)[] {
  const counter = new WordListCounter(numbering);
  return paragraphs.map((p) => {
    const list = listOfParagraph(numbering, styles, p);
    if (!list || levelOf(numbering, list.numId, list.level).format === "none") return null;
    const numbers = counter.count(list);
    return { list, numbers, text: levelText(numbering, list.numId, list.level, numbers) };
  });
}
