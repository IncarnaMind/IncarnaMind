import { OfficePackage } from "../../../core/documents/formats/officePackage";
import {
  child,
  elements,
  parseXml,
  walk,
  type XmlElement,
} from "../../../core/documents/formats/xml";
import { openPackage } from "../../../core/documents/formats/zip";

/**
 * What docx-preview leaves undrawn: the newer branch of `mc:AlternateContent`
 * (it draws the older one, a VML text box's paragraphs included) and a drawing's
 * text box, which it doesn't draw.
 */
const UNDRAWN = new Set(["mc:Choice", "w:drawing"]);

/** A paragraph or table of a Word file, as the viewer draws it (#736). */
export interface DrawnTarget {
  /** Its place among the drawn paragraphs (or tables), counting those a page break splits in two. */
  index: number;
  /** A paragraph's text as the file has it, with spaces collapsed, to confirm the drawn one by; "" for a table. */
  text: string;
}

const isPageBreak = (element: XmlElement) =>
  element.name === "w:lastRenderedPageBreak" ||
  (element.name === "w:br" && element.attrs["w:type"] === "page");

/**
 * Whether docx-preview, breaking pages, draws a top-level paragraph as two: it splits one at
 * its first run holding a page break (Word's `lastRenderedPageBreak`, or a page break in the
 * text) unless that break is the paragraph's very end.
 */
function splitByPage(paragraph: XmlElement): boolean {
  const parts = elements(paragraph).filter((each) => each.name !== "w:pPr");
  const at = parts.findIndex(
    (each) => each.name === "w:r" && elements(each).some((inner) => isPageBreak(inner)),
  );
  if (at < 0) return false;
  const run = elements(parts[at] as XmlElement).filter((each) => each.name !== "w:rPr");
  const last = run.findIndex(isPageBreak) === run.length - 1;
  return at < parts.length - 1 || !last;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** A paragraph's text as drawn: its runs' text, deleted text and nested paragraphs left out. */
function paragraphText(paragraph: XmlElement): string {
  let text = "";
  for (const element of walk(paragraph, (each) => each.name !== "w:p" && each.name !== "w:del")) {
    if (element.name === "w:t") {
      text += element.children.filter((each): each is string => typeof each === "string").join("");
    } else if (element.name === "w:tab") text += " ";
  }
  return collapse(text);
}

/**
 * Where a paragraph or table at a place in a Word file's main document part
 * ("w:p#12", counted from 0 in document order, as a Word import counts them)
 * is among those the viewer draws, of the same kind: the import counts every
 * one, the viewer draws only one branch of each alternative, and splits a
 * paragraph a page break crosses. One the viewer doesn't draw gives the last
 * drawn before it, the one that holds it. Null for a place the file hasn't.
 */
export async function drawnTargetOf(bytes: Uint8Array, place: string): Promise<DrawnTarget | null> {
  const match = /^(w:p|w:tbl)#(\d+)$/.exec(place);
  if (!match) return null;
  const [, name, ordinal] = match;
  const pkg = new OfficePackage(openPackage(bytes));
  const xml = await pkg.zip.readText(await pkg.mainPart("word/document.xml"));
  if (xml === undefined) return null;
  const root = parseXml(xml);
  const body = child(root, "w:body");
  const undrawn = new Set<XmlElement>();
  for (const element of walk(root)) {
    if (UNDRAWN.has(element.name)) for (const inner of walk(element)) undrawn.add(inner);
  }
  const split = new Set(
    name === "w:p" && body
      ? elements(body).filter((each) => each.name === "w:p" && splitByPage(each))
      : [],
  );
  let seen = -1;
  let drawn = -1;
  for (const element of walk(root)) {
    if (element.name !== name) continue;
    seen++;
    if (!undrawn.has(element)) drawn++;
    if (seen === Number(ordinal)) {
      return { index: Math.max(drawn, 0), text: name === "w:p" ? paragraphText(element) : "" };
    }
    if (split.has(element)) drawn++;
  }
  return null;
}

/**
 * The drawn paragraph to go to, of those drawn (their text, in order): the one at the
 * target's place if its text begins as the paragraph's does, else the nearest one that does,
 * as a count can drift where the viewer draws a paragraph otherwise than the file holds it.
 * A paragraph with no text, or one found nowhere, is taken at its place.
 */
export function confirmDrawn(drawn: readonly string[], target: DrawnTarget): number | null {
  const want = target.text.slice(0, 60);
  const begins = (text: string) => {
    const shown = collapse(text);
    return (
      shown !== "" && (shown.startsWith(want) || (shown.length >= 8 && want.startsWith(shown)))
    );
  };
  if (want === "" || begins(drawn[target.index] ?? "")) {
    return target.index < drawn.length ? target.index : null;
  }
  let best: number | null = null;
  drawn.forEach((text, index) => {
    if (!begins(text)) return;
    if (best === null || Math.abs(index - target.index) < Math.abs(best - target.index))
      best = index;
  });
  return best ?? (target.index < drawn.length ? target.index : null);
}
