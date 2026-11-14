/**
 * A Document's own name where a sentence that cites the Document writes it (#3093). A sentence
 * whose words are only that name says where something comes from, not what it claims, and the
 * number in the name ("Lease 2", "附件3") is no figure. Only the text proves either: the name, and a
 * Citation of that Document in the same sentence. Pure.
 */
import type { CitationLocation } from "../core/api";
import { readFigures } from "./figures";
import { citationLocation, type RequestedLocation } from "./locations";
import { citesSource, namedSource } from "./namedSources";
import { INLINE_NODE } from "./sentences";

/** What a Citation says of its Document and its place, as a Note's or an Answer's carries it. */
export interface CitedSource {
  documentName?: unknown;
  pageFrom?: unknown;
  pageTo?: unknown;
  location?: unknown;
}

const END = /[\s.。!！?？;；:：,，、]+$/u;
const ENCLOSED = /^[([（【]([^()[\]（）【】]+)[)\]）】]$/u;
/** A file's extension starts with a letter: the ".1" of "Lease 2.1" is part of its name. */
const EXTENSION = /\.[a-z][a-z0-9]{0,4}$/i;
/**
 * The one list of words: the labels a reference writes before the name it gives ("Source: Lease 2",
 * "见附件2"). No rule of shape alone tells them from a claim: "Void: Lease 2" states something.
 */
const SOURCE_LABEL =
  /^(?:(?:see\s+also|sources?|see|from|reference|ref|per|cf)\.?(?:\s*[:：]\s*|\s+)|(?:资料来源|数据来源|来源|出处|参见|详见|见)[：:]?\s*)/iu;
const QUOTED = /^[“"《「『‘']\s*([^“”"《》「」『』‘’']+?)\s*[”"》」』’']$/u;
const PLACE_IN_BRACKETS =
  /^(.+?)\s*[(（]\s*(p\.\s*\d+(?:\s*[-–—]\s*\d+)?|第\s*\d+(?:\s*[-–—]\s*\d+)?\s*页)\s*[)）]$/u;

/** A number with no unit, currency, percent or scale of its own. */
const plainNumber = (figure: { unit: { kind: string }; currency: string | null; scale: number }) =>
  figure.unit.kind === "plain" && figure.currency === null && figure.scale === 1;

/** A written place names the Citation's only when the Citation has one of its kind: a page for a page. */
function sameKind(written: RequestedLocation, at: CitationLocation | null): boolean {
  if (at === null) return false;
  const paged = (kind: string) => kind === "page" || kind === "slide";
  return written.kind === at.kind || (paged(written.kind) && paged(at.kind));
}

function placeOf(citation: CitedSource): CitationLocation | null {
  return citationLocation({
    location: citation.location,
    pageFrom: typeof citation.pageFrom === "number" ? citation.pageFrom : null,
    pageTo: typeof citation.pageTo === "number" ? citation.pageTo : null,
  });
}

/** The name the words give, its quotation or title marks off and a place in brackets after it read as after a comma. */
function nameOf(words: string): string {
  const inner = (QUOTED.exec(words)?.[1] ?? words).trim();
  const placed = PLACE_IN_BRACKETS.exec(inner);
  return (placed ? `${placed[1]}, ${placed[2]}` : inner).replace(END, "");
}

/**
 * Whether the words of a sentence, apart from its Citations, brackets, quotation marks and end
 * punctuation, are only the name of a Document it cites, with or without the file's extension, and
 * with the place the Citation points at when they give one ("Lease 1, p. 2", "Lease 1 (p. 2)").
 * A source label may stand before the name. A bare name that states a figure with a unit, percent,
 * currency or scale is a headline, so a claim; one that is only a number may be an amount.
 */
export function onlyNamesItsSource(words: string, cited: readonly CitedSource[]): boolean {
  if (cited.length === 0) return false;
  const bare = words.replaceAll(INLINE_NODE, "").trim().replace(END, "");
  const whole = (ENCLOSED.exec(bare)?.[1] ?? bare).trim().replace(END, "");
  const label = SOURCE_LABEL.exec(whole);
  const written = [
    { name: nameOf(whole), labelled: false },
    ...(label ? [{ name: nameOf(whole.slice(label[0].length).trim()), labelled: true }] : []),
  ];
  return written.some(({ name, labelled }) => {
    const source = name ? namedSource(name) : null;
    if (!source || !/\p{L}/u.test(source.name.replace(EXTENSION, ""))) return false;
    if (!labelled && readFigures(source.name).some((figure) => !plainNumber(figure))) return false;
    return cited.some(
      (citation) =>
        citesSource(citation, source) &&
        (source.location === null || sameKind(source.location, placeOf(citation))),
    );
  });
}

const escaped = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/gu, "\\s+");

/** The name as a pattern: a Latin edge never runs into the word beside it, a number never into more digits. */
function namePattern(name: string): RegExp | null {
  const base = name.replace(EXTENSION, "").trim();
  if (!/\p{L}/u.test(base) || !/\p{N}/u.test(base)) return null;
  const first = base[0] ?? "";
  const last = base.at(-1) ?? "";
  const before = /[A-Za-z0-9]/.test(first) ? "(?<![\\p{L}\\p{N}])" : "";
  const after = /\p{N}/u.test(last)
    ? "(?![\\p{N}]|[.,]\\p{N})"
    : /[A-Za-z]/.test(last)
      ? "(?![\\p{L}\\p{N}])"
      : "";
  return new RegExp(`${before}${escaped(base)}(?:\\.[a-z][a-z0-9]{0,4})?${after}`, "giu");
}

/** Where `text` writes the whole name of one of `names`, the Documents its sentence cites. */
export function citedNameStretches(
  text: string,
  names: readonly unknown[],
): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  for (const name of new Set(names)) {
    const pattern = typeof name === "string" ? namePattern(name) : null;
    if (!pattern) continue;
    for (const match of text.matchAll(pattern))
      found.push({ from: match.index, to: match.index + match[0].length });
  }
  return found;
}

/**
 * Whether a figure read at `start`..`end` is the number of a cited Document's name: inside the
 * name, with no unit, currency, percent or scale of its own. "2 months" or "3万元" after the name
 * reads past it, so stays a figure.
 */
export function isNameNumber(
  figure: {
    start: number;
    end: number;
    unit: { kind: string };
    currency: string | null;
    scale: number;
  },
  stretches: readonly { from: number; to: number }[],
): boolean {
  return (
    plainNumber(figure) &&
    stretches.some((stretch) => figure.start >= stretch.from && figure.end <= stretch.to)
  );
}
