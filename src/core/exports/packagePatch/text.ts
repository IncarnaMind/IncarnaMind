/**
 * Writing into a part's text as stored (#105): changes are splices by the
 * offsets the parser records (`XmlElement.start`, `openEnd`, `end`), so every
 * byte outside them stays as it was.
 */
import { elements, walk, type XmlElement } from "../../documents/formats/xml";

/** Replaces `from` to `to` of the text with `text`; an insertion has `from === to`. */
export interface Splice {
  from: number;
  to: number;
  text: string;
}

/**
 * The text with the splices made. Insertions at one place go in the order
 * given, before what replaces or removes the text that starts there. Throws
 * if two splices overlap: what is written would be broken.
 */
export function applySplices(text: string, splices: readonly Splice[]): string {
  const ordered = splices
    .map((splice, index) => ({ ...splice, index }))
    .sort(
      (a, b) =>
        a.from - b.from || Number(a.from !== a.to) - Number(b.from !== b.to) || a.index - b.index,
    );
  let out = "";
  let at = 0;
  for (const splice of ordered) {
    if (splice.from < at) throw new Error("Two changes to one part overlap.");
    out += text.slice(at, splice.from) + splice.text;
    at = splice.to;
  }
  return out + text.slice(at);
}

export const startOf = (element: XmlElement): number => element.start ?? 0;
export const endOf = (element: XmlElement): number => element.end ?? 0;

/** An element as written. */
export const sliceOf = (text: string, element: XmlElement): string =>
  text.slice(startOf(element), endOf(element));

/** Whether an element closes itself (`<w:p/>`). */
export const selfClosing = (element: XmlElement): boolean => element.openEnd === element.end;

/** An element's start tag as written, as an opening tag even if it closed itself. */
export function openTag(text: string, element: XmlElement): string {
  const tag = text.slice(startOf(element), element.openEnd ?? startOf(element));
  return selfClosing(element) ? `${tag.slice(0, -2).trimEnd()}>` : tag;
}

export const closeTag = (element: XmlElement): string => `</${element.name}>`;

/** A splice that adds XML at the end of an element's content, opening one that closes itself. */
export function appendInside(text: string, element: XmlElement, xml: string): Splice {
  if (selfClosing(element)) {
    return {
      from: startOf(element),
      to: endOf(element),
      text: `${openTag(text, element)}${xml}${closeTag(element)}`,
    };
  }
  const at = endOf(element) - closeTag(element).length;
  return { from: at, to: at, text: xml };
}

/** Each element's parent, below `root`. */
export function parentsOf(root: XmlElement): Map<XmlElement, XmlElement> {
  const parents = new Map<XmlElement, XmlElement>();
  for (const child of elements(root)) parents.set(child, root);
  for (const element of walk(root)) {
    for (const child of elements(element)) parents.set(child, element);
  }
  return parents;
}

// ---------------------------------------------------------------------------
// Namespaces

/** Prefix → namespace URI, as declared ("" for the default namespace). */
export type Namespaces = ReadonlyMap<string, string>;

/** The namespaces an element declares itself. */
function declaredBy(element: XmlElement): Map<string, string> {
  const declared = new Map<string, string>();
  for (const [name, value] of Object.entries(element.attrs)) {
    if (name === "xmlns") declared.set("", value);
    else if (name.startsWith("xmlns:")) declared.set(name.slice(6), value);
  }
  return declared;
}

/** The namespaces in scope inside an element: those its ancestors and it declare, nearest first. */
export function scopeOf(
  element: XmlElement,
  parents: ReadonlyMap<XmlElement, XmlElement>,
): Map<string, string> {
  const chain: XmlElement[] = [];
  for (let at: XmlElement | undefined = element; at; at = parents.get(at)) chain.push(at);
  const scope = new Map<string, string>();
  for (const each of chain.reverse()) {
    for (const [prefix, uri] of declaredBy(each)) scope.set(prefix, uri);
  }
  return scope;
}

const PREFIXED = /<\/?([A-Za-z_][\w.-]*):|\s([A-Za-z_][\w.-]*):[\w.-]+\s*=/g;

/** The prefixes XML uses on its elements and attributes, but not `xml:` or `xmlns:`. */
function prefixesIn(xml: string): Set<string> {
  const found = new Set<string>();
  for (const match of xml.matchAll(PREFIXED)) {
    const prefix = match[1] ?? match[2];
    if (prefix && prefix !== "xml" && prefix !== "xmlns") found.add(prefix);
  }
  return found;
}

/**
 * XML written where `there` is in scope, as it was where `here` was: each top
 * element of it declares the namespaces it uses that `there` binds otherwise
 * or not at all. What was in scope stays bound, so moving an element, or
 * writing new XML into a document that declares its namespaces elsewhere,
 * never leaves a prefix unbound.
 */
export function rescoped(xml: string, here: Namespaces, there: Namespaces): string {
  const missing = [...prefixesIn(xml)].filter(
    (prefix) => here.has(prefix) && here.get(prefix) !== there.get(prefix),
  );
  if (missing.length === 0) return xml;
  let out = "";
  let at = 0;
  let depth = 0;
  for (const match of xml.matchAll(
    /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g,
  )) {
    const [whole, closing, name, rest, closes] = match;
    const index = match.index;
    if (closing) {
      depth--;
      continue;
    }
    if (depth === 0) {
      const own = `${rest}`;
      const declarations = missing
        .filter((prefix) => !new RegExp(`\\sxmlns:${prefix}\\s*=`).test(own))
        .map((prefix) => ` xmlns:${prefix}="${here.get(prefix)}"`)
        .join("");
      out += `${xml.slice(at, index)}<${name}${declarations}${rest}${closes}>`;
      at = index + whole.length;
    }
    if (!closes) depth++;
  }
  return out + xml.slice(at);
}
