/**
 * The main document's TOC, REF and PAGEREF fields after an export changed it (#746). A field's
 * result is what Word last worked out; Word works it out again as the file opens only for a
 * field marked dirty, as Word marks one itself, and a viewer that never does shows the result as
 * saved. So each field whose result the change can have altered is marked dirty:
 *
 * - a REF, when its bookmark's paragraph number (`\r`, `\n`, `\w`) or its bookmark's text changed;
 * - a PAGEREF, when anything at or before its bookmark changed, which can move its page;
 * - a TOC, when the headings changed, or anything before the last of them.
 *
 * A REF's result is written again when it can be known: the file's result was its bookmark's
 * number (or text) as the file had it, written in one of the ways Word writes it, and that way
 * gives the number now. A page can't be known without laying the document out, so a PAGEREF's
 * page and a table of contents' entries are left to Word. Fields in headers, footers and notes
 * are left as they are.
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
}

const REFRESHED = new Set(["TOC", "REF", "PAGEREF"]);
/** Formatting switches that leave a result as written: any other `\*` changes it. */
const PLAIN_FORMATS = new Set(["MERGEFORMAT", "CHARFORMAT", "MERGEFORMATINET"]);
const NUMBER_SWITCHES = ["r", "n", "w"] as const;

const textIn = (element: XmlElement) =>
  element.children.filter((part): part is string => typeof part === "string").join("");

function fieldOf(instruction: string, begin: XmlElement, result: XmlElement[]): Field | null {
  const words = instruction.trim().split(/\s+/);
  const type = (words[0] ?? "").toUpperCase();
  if (!REFRESHED.has(type)) return null;
  const switches = new Set<string>();
  for (const [at, word] of words.entries()) {
    if (!word.startsWith("\\")) continue;
    const name = word.slice(1).toLowerCase();
    switches.add(name === "*" ? `*${(words[at + 1] ?? "").toUpperCase()}` : name);
  }
  const bookmark = type === "TOC" ? null : words[1] && !words[1].startsWith("\\") ? words[1] : null;
  return { type, bookmark, switches, begin, result };
}

/** The TOC, REF and PAGEREF fields of a part, in order. */
function fieldsIn(root: XmlElement): Field[] {
  const fields: Field[] = [];
  const open: {
    begin: XmlElement;
    instruction: string;
    separated: boolean;
    result: XmlElement[];
  }[] = [];
  for (const element of walk(root)) {
    const top = open.at(-1);
    if (element.name === "w:fldSimple") {
      const field = fieldOf(element.attrs["w:instr"] ?? "", element, descendants(element, "w:t"));
      if (field) fields.push(field);
    } else if (element.name === "w:fldChar") {
      const kind = element.attrs["w:fldCharType"];
      if (kind === "begin")
        open.push({ begin: element, instruction: "", separated: false, result: [] });
      else if (kind === "separate" && top) top.separated = true;
      else if (kind === "end" && top) {
        open.pop();
        const field = fieldOf(top.instruction, top.begin, top.result);
        if (field) fields.push(field);
      }
    } else if (element.name === "w:instrText" && top && !top.separated) {
      top.instruction += textIn(element);
    } else if (element.name === "w:t" && top?.separated) {
      top.result.push(element);
    }
  }
  return fields;
}

/** One side of the change, read for what its fields show. */
class Reading {
  readonly root: XmlElement;
  private readonly parents: Map<XmlElement, XmlElement>;
  private readonly paragraphs: XmlElement[];
  private readonly numbers = new Map<XmlElement, ParagraphNumber>();
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
    paragraphNumbers(part.numbering, part.styles, this.paragraphs).forEach((number, index) => {
      const p = this.paragraphs[index];
      if (number && p) this.numbers.set(p, number);
    });
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

  /** The paragraph a bookmark starts in, or the one after it when it starts between paragraphs. */
  private paragraphOf(name: string): XmlElement | null {
    const start = this.starts.get(name);
    if (!start) return null;
    for (let at = this.parents.get(start); at; at = this.parents.get(at)) {
      if (at.name === "w:p") return at;
    }
    return this.paragraphs.find((p) => startOf(p) >= endOf(start)) ?? null;
  }

  numberOf(name: string): ParagraphNumber | null {
    const p = this.paragraphOf(name);
    return p ? (this.numbers.get(p) ?? null) : null;
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

/** The ways Word writes a paragraph's number in a cross-reference to it; null where one can't be written. */
function numberWays(number: ParagraphNumber | null, numbering: WordNumbering): (string | null)[] {
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
 * their results, and REF results written again where the new one can be known. `rewrite` off
 * leaves every result as it was: in a review export, Word numbers the User's tracked deletions
 * as gone, which this doesn't.
 */
export function refreshFields(
  before: FieldsPart & { root: XmlElement },
  after: FieldsPart,
  rewrite: boolean,
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
      const then = numberWays(was.numberOf(field.bookmark), before.numbering);
      const nowWays = numberWays(now.numberOf(field.bookmark), after.numbering);
      const way = then.findIndex((each) => each !== null && each === shown.trim());
      if (way >= 0) {
        const next = nowWays[way] ?? null;
        dirty = next !== then[way];
        if (dirty && next !== null) written = next;
      } else dirty = then.some((each, at) => each !== nowWays[at]);
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
    if (written !== null && rewrite && !formatted)
      splices.push(...rewritten(field.result, written));
  }
  return splices.length > 0 ? applySplices(after.text, splices) : after.text;
}

/** Marks a field dirty, as Word marks one whose result is out of date: on its begin, or its simple field. */
function markDirty(text: string, begin: XmlElement): Splice[] {
  const tag = text.slice(startOf(begin), begin.openEnd ?? endOf(begin));
  if (/\sw:dirty="(?:true|1|on)"/.test(tag)) return [];
  const marked = /\sw:dirty="[^"]*"/.test(tag)
    ? tag.replace(/\sw:dirty="[^"]*"/, ' w:dirty="true"')
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
