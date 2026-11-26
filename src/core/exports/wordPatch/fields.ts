/**
 * The main document's TOC, REF and PAGEREF fields after an export changed it (#746). A field's
 * result is what Word last worked out. ECMA-376 (`w:dirty`) asks an application to work a field
 * marked dirty out again as it reads the file, and a viewer that doesn't shows the result as
 * saved (LibreOffice and WPS are such).
 *
 * What the export can know it writes itself:
 *
 * - a REF, when its bookmark's paragraph number (`\r`, `\n`, `\w`) or its bookmark's text changed,
 *   or for `\r` the levels that number shares with where the REF stands in that numbering: the
 *   file's result was its bookmark's number (or text) as the file had it, written in one of the
 *   ways Word writes it, and that way gives one number now whether a paragraph deleted as a
 *   tracked change counts or not;
 * - a table of contents' entry whose heading was renamed: the heading's words, before its page.
 *
 * With the User's edits tracked, a REF's new result is their tracked change, the old one deleted
 * and the new inserted. A REF whose new result can't be known or can't carry a tracked change (a
 * simple field's, one of several runs) is marked dirty and keeps its result: only those make Word
 * ask whether to update the fields. Page numbers, a PAGEREF's or a table of contents', need Word's
 * layout, and Word works them out at opening before it has laid the pages out (Word for Mac gives
 * every entry page 1): they keep the page the file saved, for the User to update in Word. Fields
 * in headers, footers and notes, and a field locked against updating, are left as they are.
 */
import {
  levelText,
  type ParagraphNumber,
  paragraphNumbers,
  type WordNumbering,
} from "../../documents/formats/wordNumbering";
import type { WordStyleTable } from "../../documents/formats/wordStyleTable";
import {
  child,
  descendants,
  elements,
  parseXml,
  walk,
  type XmlElement,
} from "../../documents/formats/xml";
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
  /** Fields locked against updating (`w:fldLock`): Word keeps their results as they are, and so does this. */
  const locked = new Set<XmlElement>();
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
    if (kind === "begin" || element.name === "w:fldSimple") {
      const lock = element.attrs["w:fldLock"];
      if (lock !== undefined && !["false", "0", "off"].includes(lock)) locked.add(element);
    }
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
    const field = each.ended && !locked.has(each.begin) ? fieldOf(each) : null;
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

  parentOf(element: XmlElement): XmlElement | undefined {
    return this.parents.get(element);
  }

  /** The nearest element around this one with the name. */
  ancestor(element: XmlElement, name: string): XmlElement | undefined {
    for (let at = this.parents.get(element); at; at = this.parents.get(at)) {
      if (at.name === name) return at;
    }
    return undefined;
  }

  /** Where a bookmark starts in the part's text; null for one it hasn't. */
  startOfBookmark(name: string): number | null {
    const start = this.starts.get(name);
    return start ? startOf(start) : null;
  }

  /** What a bookmark holds in the part's text, from its start to its end; null for one without both. */
  rangeOf(name: string): [number, number] | null {
    const start = this.starts.get(name);
    const end = this.ends.get(name);
    return start && end ? [endOf(start), startOf(end)] : null;
  }

  private paragraphAround(element: XmlElement): XmlElement | null {
    return this.ancestor(element, "w:p") ?? null;
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
}

/** A paragraph's number in each way Word writes it in a cross-reference; null where one can't be written. */
type Ways = (string | null)[];

/** Which of `numberWays` a switch can show: its own level's text (with its period trimmed), or the full context. */
const WAYS = { own: [0, 1], full: [2, 3, 4], any: [0, 1, 2, 3, 4] } as const;

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

/**
 * A paragraph's number as its level's text, then that with its closing period trimmed, then in
 * full context: as the levels' texts, with all but the last's period trimmed, and with every
 * period trimmed, as Word writes "2" for a clause numbered "2.".
 */
function numberWays(number: ParagraphNumber | null, numbering: WordNumbering): Ways {
  if (!number) return [null, null, null, null, null];
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
    known ? levels.map((each) => trimmed(each ?? "")).join("") : null,
  ];
}

/**
 * The main part after the change: each field whose result the change can have altered written
 * again where the new result can be known (as the User's tracked change when `track` is given,
 * since their edits are tracked), else, for a REF, marked dirty.
 */
export function refreshFields(
  before: FieldsPart & { root: XmlElement },
  after: FieldsPart,
  track?: Track,
): string {
  if (before.text === after.text) return after.text;
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

  const decided: { field: Field; dirty: boolean; written: string | null }[] = [];
  for (const field of fields) {
    const shown = field.result.map(textIn).join("");
    let dirty = false;
    let written: string | null = null;
    if (field.type !== "REF" || field.bookmark === null) continue;
    if (NUMBER_SWITCHES.some((each) => field.switches.has(each))) {
      const from = field.switches.has("r") ? (earlier().get(field)?.begin ?? null) : undefined;
      ({ dirty, written } = numberResult(field, was, now, from));
    } else {
      const then = was.textOf(field.bookmark);
      const next = now.textOf(field.bookmark);
      dirty = then === null || next === null || then !== next;
      if (dirty && then !== null && next !== null && shown === then) written = next;
    }
    if (field.switches.has("p")) {
      // A REF's `\p` says "above" or "below": it changes when the field and its bookmark change places.
      const earlierField = earlier().get(field);
      const thenAt = was.startOfBookmark(field.bookmark);
      const nowAt = now.startOfBookmark(field.bookmark);
      dirty ||=
        !earlierField ||
        thenAt === null ||
        nowAt === null ||
        startOf(earlierField.begin) > thenAt !== startOf(field.begin) > nowAt;
      written = null;
    }
    const formatted = [...field.switches].some(
      (each) => each.startsWith("*") && !PLAIN_FORMATS.has(each.slice(1)),
    );
    if (formatted || field.nested) written = null;
    decided.push({ field, dirty, written });
  }
  // A REF to words that hold another field written again here reads that field's old result: it
  // is marked for Word, and keeps its own.
  const writtenAt = decided.flatMap((each) =>
    each.written === null ? [] : [startOf(each.field.begin)],
  );
  for (const each of decided) {
    const { type, bookmark, switches } = each.field;
    const words = type === "REF" && !NUMBER_SWITCHES.some((one) => switches.has(one));
    const range = words && bookmark ? now.rangeOf(bookmark) : null;
    if (range && writtenAt.some((at) => at > range[0] && at < range[1])) {
      each.dirty = true;
      each.written = null;
    }
  }

  const splices: Splice[] = [];
  for (const { field, dirty, written } of decided) {
    if (!dirty) continue;
    const rewrite =
      written === null
        ? []
        : track
          ? trackedRewrite(after.text, now, field, written, track)
          : rewritten(after.text, field.result, written);
    // Only a field left as it was is marked: Word asks whether to update the fields of a file
    // that has one, and a result written here is already right.
    splices.push(...(rewrite.length > 0 ? rewrite : markDirty(after.text, field.begin)));
  }
  for (const field of fields) {
    if (field.type === "TOC") splices.push(...renamedEntries(after.text, field, fields, was, now));
  }
  return splices.length > 0 ? applySplices(after.text, splices) : after.text;
}

/**
 * A table of contents' entries whose headings were renamed, given the headings' words: Word shows
 * an entry as the file saved it until the User updates the table, and WPS never updates it. An
 * entry is the heading's words after anything before them (its number), then its page; one whose
 * words don't end with its heading's as the file had them is left as it was. The words are written
 * plain even with the User's edits tracked: the tracked change is the heading's, and WPS doesn't
 * draw an insertion inside an entry.
 */
function renamedEntries(
  text: string,
  toc: Field,
  fields: readonly Field[],
  was: Reading,
  now: Reading,
): Splice[] {
  const entries = new Map<XmlElement, XmlElement[]>();
  for (const t of toc.result) {
    const entry = now.ancestor(t, "w:p");
    if (entry) entries.set(entry, [...(entries.get(entry) ?? []), t]);
  }
  const splices: Splice[] = [];
  for (const [entry, texts] of entries) {
    const link = texts.map((t) => now.ancestor(t, "w:hyperlink")).find((each) => each);
    const page = fields.find(
      (each) => each.type === "PAGEREF" && now.ancestor(each.begin, "w:p") === entry,
    );
    const bookmark = link?.attrs["w:anchor"] ?? page?.bookmark ?? null;
    if (!bookmark) continue;
    const then = was.textOf(bookmark);
    const next = now.textOf(bookmark);
    if (!then || next === null || then === next) continue;
    const shown = texts.map(textIn);
    const words = shown.join("");
    if (!words.endsWith(then)) continue;
    splices.push(...replacedEnd(text, texts, shown, words.length - then.length, next));
  }
  return splices;
}

/** Texts' words from `from` on replaced by `words`: written into the first text there, the rest emptied. */
function replacedEnd(
  text: string,
  texts: readonly XmlElement[],
  shown: readonly string[],
  from: number,
  words: string,
): Splice[] {
  let at = 0;
  let first = true;
  return texts.flatMap((t, index) => {
    const own = shown[index] ?? "";
    const start = at;
    at += own.length;
    if (at <= from) return [];
    const kept = own.slice(0, Math.max(0, from - start));
    const written = first ? kept + words : kept;
    first = false;
    return rewritten(text, [t], written);
  });
}

/** How an export with the User's edits tracked writes their change: `xml` as a tracked insertion or deletion. */
export type Track = (xml: string, kind: "insert" | "delete") => string;

/**
 * A result written again as the User's tracked change, as Word writes a field it updates with
 * changes tracked: the old result deleted, the new one inserted in its run's formatting. Only a
 * complex field's result that is one run of text right in its paragraph can carry it; any other
 * is left as it was, marked for Word to refresh.
 */
function trackedRewrite(
  text: string,
  reading: Reading,
  field: Field,
  written: string,
  track: Track,
): Splice[] {
  const [t] = field.result;
  const run = t && reading.parentOf(t);
  if (field.begin.name !== "w:fldChar" || field.result.length !== 1 || !t || !run) return [];
  if (run.name !== "w:r" || reading.parentOf(run)?.name !== "w:p") return [];
  if (!elements(run).every((each) => each === t || each.name === "w:rPr")) return [];
  const rPr = child(run, "w:rPr");
  const open = text.slice(startOf(run), run.openEnd ?? startOf(run));
  const inserted = `${open}${rPr ? text.slice(startOf(rPr), endOf(rPr)) : ""}<w:t xml:space="preserve">${escapeXml(written)}</w:t></w:r>`;
  const deleted = text.slice(startOf(run), endOf(run));
  return [
    {
      from: startOf(run),
      to: endOf(run),
      text: `${track(deleted, "delete")}${track(inserted, "insert")}`,
    },
  ];
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
  // `\w` writes the number in full context, `\n` without; ways that tie can part when the level changes.
  const kinds = field.switches.has("w") ? WAYS.full : field.switches.has("n") ? WAYS.own : WAYS.any;
  const way =
    kinds.find((at) => result !== "" && thenWays.some((ways) => ways[at] === result)) ?? -1;
  const sameLevel = counts.every(
    (at) =>
      then[at]?.list.abstract === next[at]?.list.abstract &&
      then[at]?.list.level === next[at]?.list.level,
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
  const known = dirty && placed && sameLevel && all !== null && all === accepted && all !== result;
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

/**
 * A result's text written again: all of it in its first text, in that run's formatting, its
 * spaces kept; the others emptied.
 */
function rewritten(text: string, result: readonly XmlElement[], written: string): Splice[] {
  if (result.length === 0 || result.some(selfClosing)) return [];
  return result.flatMap((element, at) => {
    const open = element.openEnd ?? startOf(element);
    const close = text.lastIndexOf("<", endOf(element) - 1);
    const splices: Splice[] = [{ from: open, to: close, text: at === 0 ? escapeXml(written) : "" }];
    const tag = text.slice(startOf(element), open);
    if (at === 0 && /^\s|\s$/.test(written) && !/\sxml:space\s*=/.test(tag))
      splices.push({
        from: startOf(element),
        to: open,
        text: tag.replace(/\s*>$/, ' xml:space="preserve">'),
      });
    return splices;
  });
}
