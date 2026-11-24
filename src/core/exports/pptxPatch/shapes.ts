/**
 * Writing a shape's text and tags (#1264): only the shape's own paragraphs,
 * or its non-visual properties, are spliced; the rest of the slide keeps its
 * bytes, animations included.
 */
import {
  child,
  descendants,
  elements,
  local,
  walk,
  type XmlElement,
} from "../../documents/formats/xml";
import { PackagePartError } from "../packagePatch/package";
import {
  appendInside,
  applySplices,
  endOf,
  openTag,
  type Splice,
  selfClosing,
  sliceOf,
  startOf,
} from "../packagePatch/text";
import { escapeXml } from "../wordml";
import {
  type Deck,
  NAMESPACE_DECLARATIONS,
  nonVisualOf,
  PRESENTATION_CONTENT_TYPES,
  PRESENTATION_RELATIONSHIPS,
} from "./deck";

const SHAPE_KINDS = new Set(["p:sp", "p:pic", "p:graphicFrame", "p:grpSp", "p:cxnSp"]);

/** The shape with this id on a slide: a text shape, picture, frame (chart, table), group or connector. */
export function shapeById(root: XmlElement, id: string): XmlElement | undefined {
  for (const element of walk(root)) {
    if (SHAPE_KINDS.has(element.name) && nonVisualOf(element)?.attrs.id === id) return element;
  }
  return undefined;
}

const prefixOf = (element: XmlElement) =>
  element.name.includes(":") ? element.name.slice(0, element.name.indexOf(":") + 1) : "";

/** A run property element written as another of its kind: `a:endParaRPr` → `a:rPr`. */
function renamed(text: string, element: XmlElement, name: string): string {
  const prefix = prefixOf(element);
  const slice = sliceOf(text, element);
  const own = element.name;
  const opened = slice.replace(new RegExp(`^<${own}`), `<${prefix}${name}`);
  return selfClosing(element)
    ? opened
    : opened.replace(new RegExp(`</${own}>$`), `</${prefix}${name}>`);
}

/** The animations that build this shape paragraph by paragraph: they name paragraph indexes. */
export function animatesParagraphs(root: XmlElement, id: string): boolean {
  const timing = child(root, "p:timing");
  if (!timing) return false;
  return descendants(timing, "p:spTgt").some(
    (target) => target.attrs.spid === id && child(target, "p:txEl") !== undefined,
  );
}

/**
 * A text body's paragraphs replaced with `paragraphs`, each written in the
 * formatting of the paragraph it replaces (or of the last one): its
 * paragraph properties, its first run's properties and its end mark. A line
 * break inside one is written as `a:br`.
 */
export function paragraphSplice(
  text: string,
  txBody: XmlElement,
  paragraphs: readonly string[],
): Splice {
  const existing = elements(txBody).filter((each) => local(each.name) === "p");
  const bodyPr = elements(txBody).find((each) => local(each.name) === "bodyPr");
  const prefix = prefixOf(existing[0] ?? bodyPr ?? txBody);
  const written = paragraphs.map((paragraph, index) => {
    const like = existing[index] ?? existing.at(-1);
    const pPr = like && child(like, `${prefix}pPr`);
    const firstRun = like && elements(like).find((each) => ["r", "fld"].includes(local(each.name)));
    const runPr = firstRun && child(firstRun, `${prefix}rPr`);
    const end = like && child(like, `${prefix}endParaRPr`);
    const rPr = runPr
      ? sliceOf(text, runPr)
      : end
        ? renamed(text, end, "rPr")
        : `<${prefix}rPr lang="en-US" dirty="0"/>`;
    const runs = paragraph
      .split("\n")
      .map((line) =>
        line === ""
          ? ""
          : `<${prefix}r>${rPr}<${prefix}t>${escapeXml(line)}</${prefix}t></${prefix}r>`,
      )
      .join(`<${prefix}br>${rPr}</${prefix}br>`);
    return `<${prefix}p>${pPr ? sliceOf(text, pPr) : ""}${runs}${end ? sliceOf(text, end) : ""}</${prefix}p>`;
  });
  const first = existing[0];
  const last = existing.at(-1);
  if (first && last) return { from: startOf(first), to: endOf(last), text: written.join("") };
  return appendInside(text, txBody, written.join(""));
}

/**
 * Sets a text shape's paragraphs. Refused when an animation builds the shape
 * paragraph by paragraph and the count would change: the animation would
 * name paragraphs that are gone, and PowerPoint repairs such a file.
 */
export async function setShapeText(
  deck: Deck,
  slidePart: string,
  shapeId: string,
  paragraphs: readonly string[],
): Promise<void> {
  const part = await deck.pkg.part(slidePart);
  if (!part) throw new PackagePartError(slidePart, "is missing.");
  const shape = shapeById(part.root, shapeId);
  const txBody = shape && child(shape, "p:txBody");
  if (!shape || !txBody) throw new PackagePartError(slidePart, `has no text shape ${shapeId}.`);
  const count = elements(txBody).filter((each) => local(each.name) === "p").length;
  if (count !== paragraphs.length && animatesParagraphs(part.root, shapeId)) {
    throw new PackagePartError(
      slidePart,
      `shape ${shapeId} is animated by paragraph, so its ${count} paragraphs can't become ${paragraphs.length}.`,
    );
  }
  deck.pkg.set(
    slidePart,
    applySplices(part.text, [paragraphSplice(part.text, txBody, paragraphs)]),
  );
}

/**
 * Tags a shape (`p:custDataLst/p:tags`, a tags part of its own), as a
 * Citation could be kept on a figure's shape. PowerPoint keeps the tags of
 * shapes it doesn't know.
 */
export async function tagShape(
  deck: Deck,
  slidePart: string,
  shapeId: string,
  tags: Readonly<Record<string, string>>,
): Promise<string> {
  const part = await deck.pkg.part(slidePart);
  if (!part) throw new PackagePartError(slidePart, "is missing.");
  const shape = shapeById(part.root, shapeId);
  const nonVisual = shape && elements(shape).find((each) => local(each.name).startsWith("nv"));
  const nvPr = nonVisual && child(nonVisual, "p:nvPr");
  if (!nvPr) throw new PackagePartError(slidePart, `has no shape ${shapeId} to tag.`);
  if (child(nvPr, "p:custDataLst")) {
    throw new PackagePartError(slidePart, `shape ${shapeId} already has tags.`);
  }
  const tagsPart = deck.pkg.freeName("ppt/tags/tag", "xml");
  deck.pkg.add(
    tagsPart,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:tagLst ${NAMESPACE_DECLARATIONS}>${Object.entries(
      tags,
    )
      .map(([name, value]) => `<p:tag name="${escapeXml(name)}" val="${escapeXml(value)}"/>`)
      .join("")}</p:tagLst>`,
  );
  await deck.pkg.addContentType(tagsPart, PRESENTATION_CONTENT_TYPES.tags);
  const relationships = await deck.pkg.relationshipsOf(slidePart);
  const id = relationships.add(
    PRESENTATION_RELATIONSHIPS.tags,
    `../tags/${tagsPart.slice("ppt/tags/".length)}`,
  );
  const custData = `<p:custDataLst><p:tags r:id="${id}"/></p:custDataLst>`;
  // p:custDataLst comes after the placeholder and media elements, and before p:extLst.
  const extLst = child(nvPr, "p:extLst");
  const splice: Splice = extLst
    ? { from: startOf(extLst), to: startOf(extLst), text: custData }
    : selfClosing(nvPr)
      ? {
          from: startOf(nvPr),
          to: endOf(nvPr),
          text: `${openTag(part.text, nvPr)}${custData}</${nvPr.name}>`,
        }
      : appendInside(part.text, nvPr, custData);
  deck.pkg.set(slidePart, applySplices(part.text, [splice]));
  return tagsPart;
}
