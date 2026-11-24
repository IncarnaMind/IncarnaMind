/**
 * A new slide from one of the deck's own layouts (#1264): one placeholder
 * shape per layout placeholder, with no position or format of its own, so
 * it follows the layout, master and theme; then the slide is added at the
 * end of the presentation's slide list.
 */
import { child, descendants, type XmlElement } from "../../documents/formats/xml";
import { PackagePartError } from "../packagePatch/package";
import { appendInside, applySplices, endOf, type Splice } from "../packagePatch/text";
import { escapeXml } from "../wordml";
import {
  type Deck,
  NAMESPACE_DECLARATIONS,
  nonVisualOf,
  PRESENTATION_CONTENT_TYPES,
  PRESENTATION_RELATIONSHIPS,
  placeholderOf,
} from "./deck";

/** What goes into a new slide's placeholders: its title and the first body's paragraphs. */
export interface SlideFill {
  title?: string;
  body?: readonly string[];
  /** BCP 47, e.g. "zh-CN": the language the text is spell-checked in. */
  language?: string;
}

const LEFT_EMPTY = new Set(["dt", "ftr", "sldNum"]);
const TITLES = new Set(["title", "ctrTitle"]);

const paragraphXml = (text: string, language: string) =>
  `<a:p><a:r><a:rPr lang="${escapeXml(language)}" dirty="0"/><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;

const emptyParagraph = (language: string) =>
  `<a:p><a:endParaRPr lang="${escapeXml(language)}" dirty="0"/></a:p>`;

const relativeFrom = (owner: string, part: string) => {
  const ownerFolders = owner.split("/").slice(0, -1);
  const target = part.split("/");
  let shared = 0;
  while (shared < ownerFolders.length && ownerFolders[shared] === target[shared]) shared++;
  return [...ownerFolders.slice(shared).map(() => ".."), ...target.slice(shared)].join("/");
};

/** The placeholder shape on a new slide for one on its layout. */
function placeholderShape(
  shape: XmlElement,
  id: number,
  paragraphs: readonly string[],
  language: string,
): string {
  const nonVisual = nonVisualOf(shape);
  const ph = descendants(shape, "p:ph")[0];
  const name = nonVisual?.attrs.name ?? `Placeholder ${id - 1}`;
  const body =
    paragraphs.length > 0
      ? paragraphs.map((each) => paragraphXml(each, language)).join("")
      : emptyParagraph(language);
  // Only the attributes that tie it to the layout's placeholder: an extension inside may use
  // prefixes the layout declares and the new slide doesn't.
  const attributes = ["type", "orient", "sz", "idx"]
    .flatMap((key) =>
      ph?.attrs[key] === undefined ? [] : [` ${key}="${escapeXml(ph.attrs[key])}"`],
    )
    .join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${attributes}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

/** The next slide id: above every id the deck has, and at least 256 as the schema asks. */
function nextSlideId(list: XmlElement | undefined): number {
  const ids = (list ? descendants(list, "p:sldId") : []).map((each) => Number(each.attrs.id));
  return Math.max(255, ...ids.filter(Number.isFinite)) + 1;
}

/** Adds a slide at the end of the deck from a layout; returns its part. */
export async function addSlide(deck: Deck, layoutPart: string, fill: SlideFill): Promise<string> {
  const layout = await deck.pkg.part(layoutPart);
  if (!layout) throw new PackagePartError(layoutPart, "is missing.");
  const language = fill.language ?? "en-US";
  const placeholders = descendants(layout.root, "p:sp").filter((shape) => {
    const placeholder = placeholderOf(shape);
    return placeholder !== null && !LEFT_EMPTY.has(placeholder.type);
  });
  let bodyGiven = false;
  const shapes = placeholders.map((shape, index) => {
    const placeholder = placeholderOf(shape);
    let paragraphs: readonly string[] = [];
    if (placeholder && TITLES.has(placeholder.type) && fill.title !== undefined) {
      paragraphs = [fill.title];
    } else if (placeholder && !TITLES.has(placeholder.type) && !bodyGiven && fill.body) {
      paragraphs = fill.body;
      bodyGiven = true;
    }
    return placeholderShape(shape, index + 2, paragraphs, language);
  });
  const slide = deck.pkg.freeName("ppt/slides/slide", "xml");
  deck.pkg.add(
    slide,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NAMESPACE_DECLARATIONS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
  );
  await deck.pkg.addContentType(slide, PRESENTATION_CONTENT_TYPES.slide);
  (await deck.pkg.relationshipsOf(slide)).add(
    PRESENTATION_RELATIONSHIPS.slideLayout,
    relativeFrom(slide, layoutPart),
  );

  const presentationPart = await deck.presentationPart();
  const id = (await deck.pkg.relationshipsOf(presentationPart)).add(
    PRESENTATION_RELATIONSHIPS.slide,
    relativeFrom(presentationPart, slide),
  );
  const presentation = await deck.pkg.part(presentationPart);
  if (!presentation) throw new PackagePartError(presentationPart, "is missing.");
  const list = child(presentation.root, "p:sldIdLst");
  const entry = `<p:sldId id="${nextSlideId(list)}" r:id="${id}"/>`;
  let splice: Splice;
  if (list) splice = appendInside(presentation.text, list, entry);
  else {
    // The schema's order: sldMasterIdLst, notesMasterIdLst, handoutMasterIdLst, then sldIdLst.
    const before = ["p:handoutMasterIdLst", "p:notesMasterIdLst", "p:sldMasterIdLst"]
      .map((name) => child(presentation.root, name))
      .find((each) => each !== undefined);
    if (!before) throw new PackagePartError(presentationPart, "has no slide masters.");
    splice = { from: endOf(before), to: endOf(before), text: `<p:sldIdLst>${entry}</p:sldIdLst>` };
  }
  deck.pkg.set(presentationPart, applySplices(presentation.text, [splice]));
  return slide;
}
