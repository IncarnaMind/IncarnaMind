/**
 * Which Document names are machine-made (#213): a UUID, a long run of hex
 * digits or of numbers, a camera or scanner's counter, "Untitled" or
 * "document". The app then shows the Document's own title instead of its
 * name. Pure: the core and the renderer both use it.
 */
import { webHostOf } from "./webAddresses";

/** A UUID, with or without its dashes, as exported files carry it. */
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** A long run of hex digits, perhaps cut by dashes, underscores or dots, with a digit in it. */
const LONG_CODE = /^(?=.*\d)[0-9a-f]{10,}(?:[-_.][0-9a-f]+)*$/i;

/** A long number, perhaps with separators. */
const NUMBERS = /^\d[\d\s._-]{7,}$/;

/** What software calls a file when it has no title: "Untitled", "document (2)", "IMG_0042", "Scan 12". */
const PLACEHOLDER =
  /^(?:untitled|document|doc|new document|new file|file|download|scan|scanned document|image|img|dsc|dscn|screenshot)(?:[\s._-]*\(?\d+\)?)?$/i;

/** One long word of letters and digits mixed, which nobody typed. */
const MIXED_TOKEN = /^(?=.*\d)(?=.*[a-z])[a-z0-9_-]{24,}$/i;

/** Digits make up a quarter of a token nobody typed: "37-38UpperGrosvenorStreet" has far fewer. */
const mixedToken = (text: string) =>
  MIXED_TOKEN.test(text) && (text.match(/\d/g)?.length ?? 0) / text.length >= 0.25;

/** Whether a Document's name looks machine-made, so that its own title serves the reader better. */
export function looksMachineMade(name: string): boolean {
  const text = name.trim();
  if (text === "") return true;
  return (
    UUID.test(text) ||
    LONG_CODE.test(text) ||
    NUMBERS.test(text) ||
    PLACEHOLDER.test(text) ||
    mixedToken(text)
  );
}

/** The part of a path after its last slash or backslash: the file's name, with its extension. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * The name to show for a Document: its own name, unless that looks
 * machine-made and the Document has a title of its own, which then stands
 * in. A name the User set by renaming is not machine-made, so it stays.
 */
export function displayName(document: { name: string; title?: string | null }): string {
  const title = document.title?.trim();
  return title && looksMachineMade(document.name) ? title : document.name;
}

/** What sites put between a page's title and their own name: "Tea - The Open Encyclopedia". */
const SITE_SEPARATORS = [" - ", " | ", " – ", " · "];

/**
 * A web page's title without its site's name at the end, as a citation names the site on its
 * own: "Tea - The Open Encyclopedia" from The Open Encyclopedia is "Tea". Any other title, or
 * one that would be left empty, stays as it is.
 */
export function titleWithoutSite(title: string, site: string): string {
  const name = site.trim();
  if (name === "") return title;
  for (const separator of SITE_SEPARATORS) {
    const suffix = `${separator}${name}`;
    if (title.toLowerCase().endsWith(suffix.toLowerCase())) {
      const rest = title.slice(0, -suffix.length).trim();
      if (rest !== "") return rest;
    }
  }
  return title;
}

/**
 * Where a Document comes from, as its tooltip names it: its file's name, or a web page's address.
 * A file IncarnaMind keeps under a machine-made name (a Transcript's until it is saved, #1347)
 * reads as the Document's name, the name its saved file has.
 */
export function sourceOf(document: {
  name: string;
  path: string;
  web?: { address: string } | null;
}): string {
  if (document.web) return document.web.address;
  const file = fileNameOf(document.path);
  const base = file.replace(/\.[^.]+$/, "");
  if (!looksMachineMade(base)) return file;
  const extension = file.slice(base.length);
  return document.name.toLowerCase().endsWith(extension.toLowerCase())
    ? document.name
    : `${document.name}${extension}`;
}

/** What `whereShown` reads of a Document. */
export interface NamedDocument {
  id: string;
  name: string;
  title?: string | null;
  /** Where its file is: absolute, on this computer. */
  path: string;
  web?: { address: string } | null;
}

const foldersOf = (path: string) => path.split(/[\\/]/).filter(Boolean).slice(0, -1);
const sameName = (name: string) => name.normalize("NFC").toLocaleLowerCase();

/**
 * Where each Document stands among those it shares its shown name with (#1507), by id: the
 * fewest of its parent folders, nearest first, that tell it from the others ("2025", or
 * "Q1 / 2025"), or, where even its whole path doesn't, its place in their order ("(2)"). A
 * Document whose name nobody else's shown name matches has none. A web page goes by its site.
 */
export function whereShown(documents: readonly NamedDocument[]): Map<string, string> {
  const byName = new Map<string, NamedDocument[]>();
  for (const document of documents) {
    const key = sameName(displayName(document));
    const group = byName.get(key);
    if (group) group.push(document);
    else byName.set(key, [document]);
  }
  const where = new Map<string, string>();
  for (const named of byName.values()) {
    if (named.length < 2) continue;
    // By id, so twins at one path take their "(2)" in an order that doesn't change.
    const group = [...named].sort((a, b) => a.id.localeCompare(b.id));
    const places = group.map((document) => {
      const host = document.web ? webHostOf(document.web.address) : null;
      return host ? [host] : foldersOf(document.path);
    });
    let deepest = 0;
    for (const place of places) deepest = Math.max(deepest, place.length);
    const label = (place: string[], upTo: number) => place.slice(-upTo).join(" / ");
    const distinct = (upTo: number) => new Set(places.map((place) => label(place, upTo))).size;
    // As few folders as tell apart all that their whole paths can.
    const most = distinct(deepest);
    let depth = 1;
    while (depth < deepest && distinct(depth) < most) depth++;
    const twins = new Map<string, number>();
    for (const place of places) {
      const key = label(place, depth);
      twins.set(key, (twins.get(key) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    group.forEach((document, index) => {
      const place = label(places[index] ?? [], depth);
      const count = (seen.get(place) ?? 0) + 1;
      seen.set(place, count);
      where.set(
        document.id,
        (twins.get(place) ?? 0) > 1 ? (count > 1 ? `${place} (${count})` : place) : place,
      );
    });
  }
  return where;
}
