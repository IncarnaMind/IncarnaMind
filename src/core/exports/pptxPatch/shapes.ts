/**
 * Writing a shape's text and tags (#1264): only the shape's own paragraphs,
 * or its non-visual properties, are spliced; the rest of the slide keeps its
 * bytes, animations included.
 */

import { copiesOfShape } from "../../documents/formats/pptxShapeIds";
import { child, descendants, elements, local, type XmlElement } from "../../documents/formats/xml";
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
  PRESENTATION_CONTENT_TYPES,
  PRESENTATION_RELATIONSHIPS,
} from "./deck";

/** The shape with this id on a slide: a text shape, picture, frame (chart, table), group or connector. */
export function shapeById(root: XmlElement, id: string): XmlElement | undefined {
  return shapesById(root, id)[0];
}

/**
 * Every copy of the shape with this id: one, or two when it sits in
 * `mc:AlternateContent`, whose choice PowerPoint draws and whose fallback
 * other readers draw (ours among them). An edit writes both. Throws when
 * shapes that aren't copies of one another share the id: an edit can't tell
 * them apart, so it changes neither.
 */
export function shapesById(root: XmlElement, id: string): XmlElement[] {
  const copies = copiesOfShape(root, id);
  if (copies === null)
    throw new PackagePartError("slide", `has more than one shape with id ${id}.`);
  return copies;
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

/**
 * Finds the tags parts attached to a shape by following `p:custDataLst/p:tags` and matching the
 * tags relationship type — never by hardcoded part name or relationship id (#149).
 */
async function shapeTagParts(deck: Deck, slidePart: string, shape: XmlElement): Promise<string[]> {
  const nonVisual = elements(shape).find((each) => local(each.name).startsWith("nv"));
  const nvPr = nonVisual && child(nonVisual, "p:nvPr");
  const custDataLst = nvPr && child(nvPr, "p:custDataLst");
  if (!custDataLst) return [];
  const relationships = await deck.pkg.relationshipsOf(slidePart);
  const parts: string[] = [];
  for (const tagsEl of elements(custDataLst).filter((each) => local(each.name) === "tags")) {
    const rId = Object.entries(tagsEl.attrs).find(([key]) => key.endsWith(":id"))?.[1];
    if (!rId) continue;
    const rel = relationships.existing.find(
      (each) => each.id === rId && !each.external && each.type === PRESENTATION_RELATIONSHIPS.tags,
    );
    if (rel && !parts.includes(rel.target)) parts.push(rel.target);
  }
  return parts;
}

/**
 * Reads a shape's `<p:tag name="..." val="..."/>` map by tag name, locating its tags part
 * through the shape's `p:custDataLst/p:tags` relationship rather than by part name or rId (#149).
 */
export async function readShapeTags(
  deck: Deck,
  slidePart: string,
  shapeId: string,
): Promise<Record<string, string>> {
  const part = await deck.pkg.part(slidePart);
  if (!part) return {};
  const copies = shapesById(part.root, shapeId);
  const out: Record<string, string> = {};
  for (const shape of copies) {
    for (const tagsPart of await shapeTagParts(deck, slidePart, shape)) {
      const parsed = await deck.pkg.part(tagsPart);
      if (!parsed) continue;
      for (const tag of descendants(parsed.root, "p:tag")) {
        if (tag.attrs.name !== undefined) out[tag.attrs.name] = tag.attrs.val ?? "";
      }
    }
  }
  return out;
}

/**
 * Sets or updates named tags on a shape (and every copy in an `mc:AlternateContent` pair):
 * updates existing `<p:tag>` entries by tag name or creates a new tags part when none exists (#149).
 */
export async function setShapeTags(
  deck: Deck,
  slidePart: string,
  shapeId: string,
  tags: Readonly<Record<string, string>>,
): Promise<string[]> {
  const entries = Object.entries(tags);
  if (entries.length === 0) return [];
  const part = await deck.pkg.part(slidePart);
  if (!part) throw new PackagePartError(slidePart, "is missing.");
  const copies = shapesById(part.root, shapeId);
  if (copies.length === 0) throw new PackagePartError(slidePart, `has no shape ${shapeId} to tag.`);

  const updatedParts: string[] = [];
  const needsNew: XmlElement[] = [];
  for (const shape of copies) {
    const existing = await shapeTagParts(deck, slidePart, shape);
    if (existing.length === 0) {
      needsNew.push(shape);
      continue;
    }
    const targetPart = existing[0] as string;
    const tagPart = await deck.pkg.part(targetPart);
    if (!tagPart) throw new PackagePartError(targetPart, "is missing.");
    const existingTags = descendants(tagPart.root, "p:tag");
    const byName = new Map(
      existingTags
        .filter((each) => each.attrs.name !== undefined)
        .map((each) => [each.attrs.name as string, each]),
    );
    const splices: Splice[] = [];
    const appended: string[] = [];
    for (const [name, value] of entries) {
      const xml = `<p:tag name="${escapeXml(name)}" val="${escapeXml(value)}"/>`;
      const prev = byName.get(name);
      if (prev) splices.push({ from: startOf(prev), to: endOf(prev), text: xml });
      else appended.push(xml);
    }
    if (appended.length > 0) {
      splices.push(appendInside(tagPart.text, tagPart.root, appended.join("")));
    }
    if (splices.length > 0) deck.pkg.set(targetPart, applySplices(tagPart.text, splices));
    if (!updatedParts.includes(targetPart)) updatedParts.push(targetPart);
  }

  if (needsNew.length > 0) {
    const tagsPart = deck.pkg.freeName("ppt/tags/tag", "xml");
    deck.pkg.add(
      tagsPart,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:tagLst ${NAMESPACE_DECLARATIONS}>${entries
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
    const slideSplices: Splice[] = [];
    for (const shape of needsNew) {
      const nonVisual = elements(shape).find((each) => local(each.name).startsWith("nv"));
      const nvPr = nonVisual && child(nonVisual, "p:nvPr");
      if (!nvPr) throw new PackagePartError(slidePart, `has no shape ${shapeId} to tag.`);
      const custDataLst = child(nvPr, "p:custDataLst");
      if (custDataLst) {
        slideSplices.push(appendInside(part.text, custDataLst, `<p:tags r:id="${id}"/>`));
      } else {
        const extLst = child(nvPr, "p:extLst");
        slideSplices.push(
          extLst
            ? { from: startOf(extLst), to: startOf(extLst), text: custData }
            : selfClosing(nvPr)
              ? {
                  from: startOf(nvPr),
                  to: endOf(nvPr),
                  text: `${openTag(part.text, nvPr)}${custData}</${nvPr.name}>`,
                }
              : appendInside(part.text, nvPr, custData),
        );
      }
    }
    deck.pkg.set(slidePart, applySplices(part.text, slideSplices));
    updatedParts.push(tagsPart);
  }

  return updatedParts;
}
