/**
 * A PowerPoint deck opened to be written into (#1264): the stored package,
 * every part of it copied as it is unless a patch changes it (../packagePatch),
 * and the addresses a patch needs: the slides in presentation order, their
 * layouts and notes, and the text shapes on a slide.
 */
import { deflateRawSync } from "node:zlib";
import { child, descendants, elements, local, type XmlElement } from "../../documents/formats/xml";
import { openPackage } from "../../documents/formats/zip";
import { checkWellFormed, PackagePartError, PackageWriter } from "../packagePatch/package";

const OFFICE_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export const PRESENTATION_RELATIONSHIPS = {
  officeDocument: `${OFFICE_RELATIONSHIPS}/officeDocument`,
  slide: `${OFFICE_RELATIONSHIPS}/slide`,
  slideLayout: `${OFFICE_RELATIONSHIPS}/slideLayout`,
  slideMaster: `${OFFICE_RELATIONSHIPS}/slideMaster`,
  notesSlide: `${OFFICE_RELATIONSHIPS}/notesSlide`,
  notesMaster: `${OFFICE_RELATIONSHIPS}/notesMaster`,
  theme: `${OFFICE_RELATIONSHIPS}/theme`,
  chart: `${OFFICE_RELATIONSHIPS}/chart`,
  package: `${OFFICE_RELATIONSHIPS}/package`,
  tags: `${OFFICE_RELATIONSHIPS}/tags`,
} as const;

const PRESENTATIONML = "application/vnd.openxmlformats-officedocument.presentationml";
export const PRESENTATION_CONTENT_TYPES = {
  slide: `${PRESENTATIONML}.slide+xml`,
  notesSlide: `${PRESENTATIONML}.notesSlide+xml`,
  notesMaster: `${PRESENTATIONML}.notesMaster+xml`,
  tags: `${PRESENTATIONML}.tags+xml`,
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
} as const;

export const NAMESPACES = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: OFFICE_RELATIONSHIPS,
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
} as const;

export const NAMESPACE_DECLARATIONS = `xmlns:a="${NAMESPACES.a}" xmlns:r="${NAMESPACES.r}" xmlns:p="${NAMESPACES.p}"`;

export interface DeckSlide {
  /** 1 for the first slide shown. */
  number: number;
  part: string;
  layout: string | null;
  notes: string | null;
}

export interface Placeholder {
  /** "body" when the placeholder names none, as PowerPoint reads it. */
  type: string;
  idx: string | null;
}

export interface TextShape {
  /** `p:cNvPr`'s id, unique on its slide. */
  id: string;
  name: string;
  placeholder: Placeholder | null;
  paragraphs: string[];
}

/** A shape's placeholder (`p:nvPr/p:ph`), if it is one. */
export function placeholderOf(shape: XmlElement): Placeholder | null {
  const nonVisual = elements(shape).find((each) => local(each.name).startsWith("nv"));
  const nvPr = nonVisual && child(nonVisual, "p:nvPr");
  const ph = nvPr && child(nvPr, "p:ph");
  return ph ? { type: ph.attrs.type ?? "body", idx: ph.attrs.idx ?? null } : null;
}

/** A shape's `p:cNvPr`. */
export function nonVisualOf(shape: XmlElement): XmlElement | undefined {
  const nonVisual = elements(shape).find((each) => local(each.name).startsWith("nv"));
  return nonVisual && child(nonVisual, "p:cNvPr");
}

/** A text body's paragraphs as plain text, a line break as "\n". */
export function paragraphsOf(txBody: XmlElement): string[] {
  return elements(txBody)
    .filter((each) => local(each.name) === "p")
    .map((paragraph) =>
      elements(paragraph)
        .map((run) => {
          const name = local(run.name);
          if (name === "br") return "\n";
          if (name !== "r" && name !== "fld") return "";
          const text = child(run, "a:t");
          return text ? text.children.filter((each) => typeof each === "string").join("") : "";
        })
        .join(""),
    );
}

export class Deck {
  private constructor(readonly pkg: PackageWriter) {}

  static open(bytes: Uint8Array): Deck {
    return new Deck(new PackageWriter(openPackage(bytes)));
  }

  /** The presentation part, "ppt/presentation.xml" in every deck PowerPoint writes. */
  async presentationPart(): Promise<string> {
    const root = await this.pkg.relationshipsOf("");
    const main = root.ofType(PRESENTATION_RELATIONSHIPS.officeDocument);
    if (!main) throw new PackagePartError("_rels/.rels", "names no presentation part.");
    return main.target;
  }

  /** The slides in the order they are shown, with each one's layout and notes. */
  async slides(): Promise<DeckSlide[]> {
    const name = await this.presentationPart();
    const presentation = await this.pkg.part(name);
    if (!presentation) throw new PackagePartError(name, "is missing.");
    const relationships = await this.pkg.relationshipsOf(name);
    const list = child(presentation.root, "p:sldIdLst");
    const slides: DeckSlide[] = [];
    for (const entry of list ? descendants(list, "p:sldId") : []) {
      const target = relationships.existing.find(
        (each) => each.id === entry.attrs["r:id"] && !each.external,
      )?.target;
      if (!target) continue;
      const own = await this.pkg.relationshipsOf(target);
      slides.push({
        number: slides.length + 1,
        part: target,
        layout: own.ofType(PRESENTATION_RELATIONSHIPS.slideLayout)?.target ?? null,
        notes: own.ofType(PRESENTATION_RELATIONSHIPS.notesSlide)?.target ?? null,
      });
    }
    return slides;
  }

  /** Every layout of every master, in the masters' order, with its name and type. */
  async layouts(): Promise<{ part: string; name: string; type: string | null }[]> {
    const name = await this.presentationPart();
    const relationships = await this.pkg.relationshipsOf(name);
    const layouts: { part: string; name: string; type: string | null }[] = [];
    for (const master of relationships.existing) {
      if (master.type !== PRESENTATION_RELATIONSHIPS.slideMaster || master.external) continue;
      const own = await this.pkg.relationshipsOf(master.target);
      for (const layout of own.existing) {
        if (layout.type !== PRESENTATION_RELATIONSHIPS.slideLayout || layout.external) continue;
        const part = await this.pkg.part(layout.target);
        if (!part) continue;
        const cSld = child(part.root, "p:cSld");
        layouts.push({
          part: layout.target,
          name: cSld?.attrs.name ?? "",
          type: part.root.attrs.type ?? null,
        });
      }
    }
    return layouts;
  }

  /** The shapes on a slide (or a notes slide) that hold text, groups included, in z-order. */
  async textShapes(slidePart: string): Promise<TextShape[]> {
    const part = await this.pkg.part(slidePart);
    if (!part) throw new PackagePartError(slidePart, "is missing.");
    return descendants(part.root, "p:sp").flatMap((shape) => {
      const txBody = child(shape, "p:txBody");
      const nonVisual = nonVisualOf(shape);
      if (!txBody || !nonVisual?.attrs.id) return [];
      return [
        {
          id: nonVisual.attrs.id,
          name: nonVisual.attrs.name ?? "",
          placeholder: placeholderOf(shape),
          paragraphs: paragraphsOf(txBody),
        },
      ];
    });
  }

  /** The deck with every patch made, every other part copied byte for byte. */
  save(): Promise<Uint8Array> {
    return this.pkg.write(deflateRawSync, checkWellFormed);
  }
}
