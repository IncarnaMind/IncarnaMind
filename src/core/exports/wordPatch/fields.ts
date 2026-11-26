/**
 * The main document's TOC, REF and PAGEREF fields after an export changed it (#746). A field's
 * result is what Word last worked out. ECMA-376 (`w:dirty`) asks an application to work a field
 * marked dirty out again as it reads the file, and a viewer that doesn't shows the result as
 * saved. So each field whose result the change can have altered is marked dirty:
 *
 * - a REF, when its bookmark's paragraph number (`\r`, `\n`, `\w`) or its bookmark's text changed,
 *   or for `\r` the levels that number shares with where the REF stands in that numbering;
 * - a PAGEREF, when anything at or before its bookmark changed, which can move its page;
 * - a TOC, when the headings changed, or anything before the last of them.
 *
 * A REF's result is written again when it can be known, as a viewer that doesn't refresh fields
 * shows it (LibreOffice is one): the file's result was its bookmark's number (or text) as the file
 * had it, written in one of the ways Word writes it, and that way gives one number now whether a
 * paragraph deleted as a tracked change counts or not. A page can't be known without laying the
 * document out, so a PAGEREF's page and a table of contents' entries are left to Word. Fields in
 * headers, footers and notes are left as they are.
 */
import { headingLevelOf } from "../../documents/formats/docx";
import {
  levelText,
  type ParagraphNumber,
  paragraphNumbers,
  type WordNumbering,
} from "../../documents/formats/wordNumbering";
import type { WordStyleTable } from "../../documents/formats/wordStyleTable";
import { child, descendants, parseXml, walk, type XmlElement } from "../../documents/formats/xml";
import {
  applySplices,
  endOf,
  parentsOf,
  type Splice,
  selfClosing,
  startOf,
} from "../packagePatch/text";
import { escapeXml } from "../wordml";

/** The main part as one side of the change has it, with the styles and numbering it is read with. */
export interface FieldsPart {
  text: string;
  numbering: WordNumbering;
  styles: WordStyleTable;
}

interface Field {
  type: string;
  /** The bookmark it names, for a REF or PAGEREF. */
  bookmark: string | null;
  switches: Set<string>;
  /** Its `w:fldChar` begin, or its `w:fldSimple`: where it is marked dirty. */
  begin: XmlElement;
  /** The texts of its result, its own and not a field's inside it. */
  result: XmlElement[];
  /** Its result holds another field, so it is never written again, only marked. */
  nested: boolean;
}

const REFRESHED = new Set(["TOC", "REF", "PAGEREF"]);
/** Formatting switches that leave a result as written: any other `\*` changes it. */
const PLAIN_FORMATS = new Set(["MERGEFORMAT", "CHARFORMAT", "MERGEFORMATINET"]);
const NUMBER_SWITCHES = ["r", "n", "w"] as const;

const textIn = (element: XmlElement) =>
  element.children.filter((part): part is string => typeof part === "string").join("");

/** Any field as a part is read: its instruction, and the texts of its result that are its own. */
interface Read {
  begin: XmlElement;
  instruction: string;
  separated: boolean;
  ended: boolean;
  result: XmlElement[];
  nested: boolean;
}

function fieldOf(read: Read): Field | null {
  const words = read.instruction.trim().split(/\s+/);
  const type = (words[0] ?? "").toUpperCase();
  if (!REFRESHED.has(type)) return null;
  const switches = new Set<string>();
  for (const [at, word] of words.entries()) {
    if (!word.startsWith("\\")) continue;
    const name = word.slice(1).toLowerCase();
    switches.add(name === "*" ? `*${(words[at + 1] ?? "").toUpperCase()}` : name);
  }
  const bookmark = type === "TOC" ? null : words[1] && !words[1].startsWith("\\") ? words[1] : null;
  const { begin, result, nested } = read;
  return { type, bookmark, switches, begin, result, nested };
}

/**
 * The TOC, REF and PAGEREF fields of a part, in order. A text of a result is the innermost
 * field's: a simple field (`w:fldSimple`) holds what is inside it, a complex one what is between
 * its separate and its end.
 */
function fieldsIn(root: XmlElement): Field[] {
  const parents = parentsOf(root);
  const read: Read[] = [];
  const simple = new Map<XmlElement, Read>();
  const open: Read[] = [];
  /** The field whose result an element is in: the innermost of the simple field around it and the open one. */
  const ownerOf = (element: XmlElement): Read | undefined => {
    let around: Read | undefined;
    for (let at = parents.get(element); at && !around; at = parents.get(at))
      around = simple.get(at);
    const top = open.at(-1);
    const inner = !around || (top && startOf(top.begin) > startOf(around.begin)) ? top : around;
    return inner?.separated ? inner : undefined;
  };
  for (const element of walk(root)) {
    const top = open.at(-1);
    const kind = element.name === "w:fldChar" ? element.attrs["w:fldCharType"] : undefined;
    if (element.name === "w:fldSimple" || kind === "begin") {
      const outer = ownerOf(element);
      if (outer) outer.nested = true;
      const field: Read = {
        begin: element,
        instruction: element.name === "w:fldSimple" ? (element.attrs["w:instr"] ?? "") : "",
        separated: element.name === "w:fldSimple",
        ended: element.name === "w:fldSimple",
        result: [],
        nested: false,
      };
      read.push(field);
      if (element.name === "w:fldSimple") simple.set(element, field);
      else open.push(field);
    } else if (kind === "separate" && top) top.separated = true;
    else if (kind === "end" && top) {
      top.ended = true;
      open.pop();
    } else if (element.name === "w:instrText" && top && !top.separated) {
      top.instruction += textIn(element);
    } else if (element.name === "w:t") {
      ownerOf(element)?.result.push(element);
    }
  }
  return read.flatMap((each) => {
    const field = each.ended ? fieldOf(each) : null;
    return field ? [field] : [];
  });
}

/** One side of the change, read for what its fields show. */
class Reading {
  readonly root: XmlElement;
  private readonly parents: Map<XmlElement, XmlElement>;
  private readonly paragraphs: XmlElement[];
  /** Each paragraph's number with every paragraph counted, and with those deleted as tracked changes left out. */
  private readonly numbers = new Map<XmlElement, ParagraphNumber>();
  private readonly accepted = new Map<XmlElement, ParagraphNumber>();
  private readonly starts = new Map<string, XmlElement>();
  private readonly ends = new Map<string, XmlElement>();
  private texts: XmlElement[] | null = null;

  constructor(
    readonly part: FieldsPart,
    root: XmlElement,
  ) {
    this.root = root;
    this.parents = parentsOf(this.root);
    this.paragraphs = descendants(this.root, "w:p");
    const counted = (paragraphs: XmlElement[], into: Map<XmlElement, ParagraphNumber>) =>
      paragraphNumbers(part.numbering, part.styles, paragraphs).forEach((number, index) => {
        const p = paragraphs[index];
        if (number && p) into.set(p, number);
      });
    counted(this.paragraphs, this.numbers);
    counted(
      this.paragraphs.filter((p) => !deletedMark(p)),
      this.accepted,
    );
    const ids = new Map<string, string>();
    for (const element of walk(this.root)) {
      const name = element.attrs["w:name"];
      if (element.name === "w:bookmarkStart" && name && !this.starts.has(name)) {
        this.starts.set(name, element);
        ids.set(element.attrs["w:id"] ?? "", name);
      } else if (element.name === "w:bookmarkEnd") {
        const named = ids.get(element.attrs["w:id"] ?? "");
        if (named && !this.ends.has(named)) this.ends.set(named, element);
      }
    }
  }

  /** Where a bookmark ends in the part's text; null for one it hasn't. */
  endOfBookmark(name: string): number | null {
    const end = this.ends.get(name) ?? this.starts.get(name);
    return end ? endOf(end) : null;
  }

  private paragraphAround(element: XmlElement): XmlElement | null {
    for (let at = this.parents.get(element); at; at = this.parents.get(at)) {
      if (at.name === "w:p") return at;
    }
    return null;
  }

  /** The paragraph a bookmark starts in, or the one after it when it starts between paragraphs. */
  private paragraphOf(name: string): XmlElement | null {
    const start = this.starts.get(name);
    if (!start) return null;
    return (
      this.paragraphAround(start) ?? this.paragraphs.find((p) => startOf(p) >= endOf(start)) ?? null
    );
  }

  /** A paragraph's number, every paragraph counted, then with tracked deletions accepted. */
  private numbersOf(p: XmlElement | null): Counted {
    return p ? [this.numbers.get(p) ?? null, this.accepted.get(p) ?? null] : [null, null];
  }

  /** A bookmark's paragraph number, both ways. */
  numberOf(name: string): Counted {
    return this.numbersOf(this.paragraphOf(name));
  }

  /**
   * Where an element stands in a list's numbering, both ways: its paragraph's number in that
   * list, else the number of the nearest paragraph before it in that list; null when the element
   * isn't in a paragraph.
   */
  placeIn(element: XmlElement, abstract: string | undefined): Counted | null {
    const p = this.paragraphAround(element);
    if (!p) return null;
    const from = this.paragraphs.indexOf(p);
    const nearest = (numbers: Map<XmlElement, ParagraphNumber>) => {
      for (let at = from; at >= 0; at--) {
        const paragraph = this.paragraphs[at];
        const number = paragraph && numbers.get(paragraph);
        if (number && number.list.abstract === abstract) return number;
      }
      return null;
    };
    return [nearest(this.numbers), nearest(this.accepted)];
  }

  /** A bookmark's text, when it is all in one paragraph; null for one that isn't. */
  textOf(name: string): string | null {
    const start = this.starts.get(name);
    const end = this.ends.get(name);
    if (!start || !end) return null;
    const from = endOf(start);
    const to = startOf(end);
    if (this.paragraphs.some((p) => startOf(p) > from && startOf(p) < to)) return null;
    this.texts ??= descendants(this.root, "w:t");
    return this.texts
      .filter((t) => startOf(t) >= from && endOf(t) <= to)
      .map(textIn)
      .join("");
  }

  /** The headings, by level and text, and where the last of them ends. */
  headings(): { list: string[]; end: number } {
    const list: string[] = [];
    let end = 0;
    for (const p of this.paragraphs) {
      const pPr = child(p, "w:pPr");
      const outline = pPr && child(pPr, "w:outlineLvl")?.attrs["w:val"];
      const styleId =
        (pPr && child(pPr, "w:pStyle")?.attrs["w:val"]) ?? this.part.styles.defaultOf("paragraph");
      const level =
        outline !== undefined
          ? Number(outline) < 9
            ? Number(outline) + 1
            : null
          : (this.part.styles
              .chain("paragraph", styleId)
              .map((style) => headingLevelOf(style.element))
              .find((each) => each !== null) ?? null);
      if (level === null) continue;
      list.push(`${level} ${descendants(p, "w:t").map(textIn).join("")}`);
      end = endOf(p);
    }
    return { list, end };
  }
}

/** A paragraph's number in each way Word writes it in a cross-reference; null where one can't be written. */
type Ways = (string | null)[];

/** A paragraph's number with every paragraph counted, and with tracked deletions accepted. */
type Counted = [ParagraphNumber | null, ParagraphNumber | null];

const sameNumber = (a: ParagraphNumber | null, b: ParagraphNumber | null) =>
  a === null || b === null
    ? a === b
    : a.list.abstract === b.list.abstract &&
      a.list.level === b.list.level &&
      a.numbers.join(".") === b.numbers.join(".");

/** How many of its first levels a paragraph's number shares with where the REF to it stands. */
function sharedLevels(target: ParagraphNumber | null, from: ParagraphNumber | null): number {
  if (!target || !from || target.list.abstract !== from.list.abstract) return 0;
  let at = 0;
  while (at < target.numbers.length && target.numbers[at] === from.numbers[at]) at++;
  return at;
}

/** A paragraph whose mark is deleted as a tracked change: with it accepted, the paragraph is gone. */
function deletedMark(p: XmlElement): boolean {
  const pPr = child(p, "w:pPr");
  const rPr = pPr && child(pPr, "w:rPr");
  return (
    rPr !== undefined &&
    (child(rPr, "w:del") !== undefined || child(rPr, "w:moveFrom") !== undefined)
  );
}

function numberWays(number: ParagraphNumber | null, numbering: WordNumbering): Ways {
  if (!number) return [null, null, null, null];
  const own = number.text;
  const levels = number.numbers.map((_, at) =>
    levelText(numbering, number.list.numId, at, number.numbers.slice(0, at + 1)),
  );
  const known = levels.every((each) => each !== null);
  const trimmed = (text: string) => text.replace(/[.．]$/u, "");
  return [
    own,
    own === null ? null : trimmed(own),
    known ? levels.join("") : null,
    known
      ? levels
          .map((each, at) => (at < levels.length - 1 ? trimmed(each ?? "") : (each ?? "")))
          .join("")
      : null,
  ];
}

/**
 * The main part after the change, its fields marked dirty where the change can have altered
 * their results, and REF results written again where the new one can be known.
 */
export function refreshFields(
  before: FieldsPart & { root: XmlElement },
  after: FieldsPart,
): string {
  if (before.text === after.text) return after.text;
  let changedAt = 0;
  const limit = Math.min(before.text.length, after.text.length);
  while (
    changedAt < limit &&
    before.text.charCodeAt(changedAt) === after.text.charCodeAt(changedAt)
  )
    changedAt++;
  const root = parseXml(after.text);
  const fields = fieldsIn(root);
  if (fields.length === 0) return after.text;
  const was = new Reading(before, before.root);
  const now = new Reading(after, root);
  let earlierMap: Map<Field, Field> | null = null;
  const earlier = () => {
    earlierMap ??= earlierFields(fieldsIn(before.root), fields);
    return earlierMap;
  };

  let headings: boolean | null = null;
  const headingsChanged = () => {
    if (headings === null) {
      const then = was.headings();
      const list = now.headings().list;
      headings =
        changedAt < then.end ||
        list.length !== then.list.length ||
        list.some((each, at) => each !== then.list[at]);
    }
    return headings;
  };

  const splices: Splice[] = [];
  for (const field of fields) {
    const shown = field.result.map(textIn).join("");
    let dirty = false;
    let written: string | null = null;
    if (field.type === "TOC") dirty = headingsChanged();
    else if (field.bookmark === null) continue;
    else if (field.type === "PAGEREF") {
      const end = was.endOfBookmark(field.bookmark);
      dirty = end === null || now.endOfBookmark(field.bookmark) === null || changedAt < end;
    } else if (NUMBER_SWITCHES.some((each) => field.switches.has(each))) {
      const from = field.switches.has("r") ? (earlier().get(field)?.begin ?? null) : undefined;
      ({ dirty, written } = numberResult(field, was, now, from));
    } else {
      const then = was.textOf(field.bookmark);
      const next = now.textOf(field.bookmark);
      dirty = then === null || next === null || then !== next;
      if (dirty && then !== null && next !== null && shown === then) written = next;
    }
    if (!dirty) continue;
    splices.push(...markDirty(after.text, field.begin));
    const formatted = [...field.switches].some(
      (each) => each.startsWith("*") && !PLAIN_FORMATS.has(each.slice(1)),
    );
    if (written !== null && !formatted && !field.nested)
      splices.push(...rewritten(field.result, written));
  }
  return splices.length > 0 ? applySplices(after.text, splices) : after.text;
}

/**
 * Each field of the part after the change, with the same field before it: the one with its
 * instruction at its place among those, when the change left as many of them.
 */
function earlierFields(then: readonly Field[], now: readonly Field[]): Map<Field, Field> {
  const grouped = (fields: readonly Field[]) => {
    const groups = new Map<string, Field[]>();
    for (const field of fields) {
      const key = `${field.type} ${field.bookmark ?? ""} ${[...field.switches].sort().join(" ")}`;
      groups.set(key, [...(groups.get(key) ?? []), field]);
    }
    return groups;
  };
  const thenGroups = grouped(then);
  const earlier = new Map<Field, Field>();
  for (const [key, fields] of grouped(now)) {
    const was = thenGroups.get(key);
    if (was?.length !== fields.length) continue;
    fields.forEach((field, at) => {
      const same = was[at];
      if (same) earlier.set(field, same);
    });
  }
  return earlier;
}

/**
 * A REF to a paragraph's number: whether the change can have altered what it shows, and what
 * it shows now when that can be known. A `\r` number leaves out the levels the paragraph shares
 * with where the field stands in its numbering (ECMA-376's REF field), so `from` is the field
 * before the change, null when it can't be found; undefined for a number that doesn't depend on
 * where it is.
 */
function numberResult(
  field: Field,
  was: Reading,
  now: Reading,
  from: XmlElement | null | undefined,
): { dirty: boolean; written: string | null } {
  const bookmark = field.bookmark ?? "";
  const result = field.result.map(textIn).join("").trim();
  const then = was.numberOf(bookmark);
  const next = now.numberOf(bookmark);
  const counts = [0, 1] as const;
  const thenWays: [Ways, Ways] = [
    numberWays(then[0], was.part.numbering),
    numberWays(then[1], was.part.numbering),
  ];
  const nowWays: [Ways, Ways] = [
    numberWays(next[0], now.part.numbering),
    numberWays(next[1], now.part.numbering),
  ];
  let placed = from === undefined;
  if (from) {
    const thenFrom = was.placeIn(from, (then[0] ?? then[1])?.list.abstract);
    const nowFrom = now.placeIn(field.begin, (next[0] ?? next[1])?.list.abstract);
    placed =
      thenFrom !== null &&
      nowFrom !== null &&
      counts.every(
        (at) => sharedLevels(then[at], thenFrom[at]) === sharedLevels(next[at], nowFrom[at]),
      );
  }
  const way = thenWays[0].findIndex(
    (_, at) => result !== "" && thenWays.some((ways) => ways[at] === result),
  );
  if (way < 0) {
    const changed = counts.some(
      (at) =>
        !sameNumber(then[at], next[at]) || nowWays[at].some((each, w) => each !== thenWays[at][w]),
    );
    return { dirty: changed || !placed, written: null };
  }
  const all = nowWays[0][way] ?? null;
  const accepted = nowWays[1][way] ?? null;
  const dirty = !placed || all !== thenWays[0][way] || accepted !== thenWays[1][way];
  const known = dirty && placed && all !== null && all === accepted && all !== result;
  return { dirty, written: known ? all : null };
}

const DIRTY = /\sw:dirty\s*=\s*(["'])(.*?)\1/;

/** Marks a field dirty, as Word marks one whose result is out of date: on its begin, or its simple field. */
function markDirty(text: string, begin: XmlElement): Splice[] {
  const tag = text.slice(startOf(begin), begin.openEnd ?? endOf(begin));
  const found = DIRTY.exec(tag);
  if (found && ["true", "1", "on"].includes(found[2] ?? "")) return [];
  const marked = found
    ? tag.replace(DIRTY, ' w:dirty="true"')
    : tag.replace(/\s*(\/?>)$/, ' w:dirty="true"$1');
  return [{ from: startOf(begin), to: startOf(begin) + tag.length, text: marked }];
}

/** A result's text written again: all of it in its first text, in that run's formatting; the others emptied. */
function rewritten(result: readonly XmlElement[], text: string): Splice[] {
  if (result.length === 0 || result.some(selfClosing)) return [];
  return result.map((element, at) => ({
    from: element.openEnd ?? startOf(element),
    to: endOf(element) - `</${element.name}>`.length,
    text: at === 0 ? escapeXml(text) : "",
  }));
}
