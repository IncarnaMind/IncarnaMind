/**
 * A Document's own name where a sentence that cites the Document writes it (#3093). A sentence
 * whose words are only that name says where something comes from, not what it claims, and the
 * number in the name ("Lease 2", "附件3") is no figure. Only the text proves either: the name, and a
 * Citation of that Document in the same sentence. Pure.
 */
import type { CitationLocation } from "../core/api";
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
const EXTENSION = /\.[a-z0-9]{1,5}$/i;

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

/**
 * Whether the words of a sentence, apart from its Citations, brackets and end punctuation, are only
 * the name of a Document it cites, with or without the file's extension, and with the place the
 * Citation points at when they give one ("Lease 1, p. 2"). A name that is only a number names
 * nothing here: "1043" may be an amount.
 */
export function onlyNamesItsSource(words: string, cited: readonly CitedSource[]): boolean {
  if (cited.length === 0) return false;
  const bare = words.replaceAll(INLINE_NODE, "").trim().replace(END, "");
  const named = (ENCLOSED.exec(bare)?.[1] ?? bare).trim().replace(END, "");
  const source = named ? namedSource(named) : null;
  if (!source || !/\p{L}/u.test(source.name.replace(EXTENSION, ""))) return false;
  return cited.some(
    (citation) =>
      citesSource(citation, source) &&
      (source.location === null || sameKind(source.location, placeOf(citation))),
  );
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
    figure.unit.kind === "plain" &&
    figure.currency === null &&
    figure.scale === 1 &&
    stretches.some((stretch) => figure.start >= stretch.from && figure.end <= stretch.to)
  );
}
