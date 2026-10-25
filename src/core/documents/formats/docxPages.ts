/**
 * A Word file's pages as Page view lays them out (#803): each section's size,
 * orientation and margins, its headers and footers with their PAGE, NUMPAGES
 * and SECTIONPAGES fields, whether the first page and the odd and even pages
 * differ, and where its page numbers start. Read from the package kept at
 * import, in the document's own units (twips). A header or footer a section
 * doesn't name is the one before's, as Word has it, so each section comes
 * with the ones it shows.
 */
import type {
  PageFurniture,
  PageFurnitureParagraph,
  PageFurnitureRun,
  PageFurnitureSet,
  PageNumberFormat,
  PageSection,
  PageSetup,
  PageTabStop,
} from "../../api";
import { HEADER_AND_FOOTER_DISTANCE, MARGIN, PAPER } from "../../pageDefaults";
import { type Relationship, relationshipsOf, type WordPackage } from "./docxPackage";
import { child, elements, onOff, ordinalsOf, parseXml, textOf, walk, type XmlElement } from "./xml";

const FORMATS: Readonly<Record<string, PageNumberFormat>> = {
  decimal: "decimal",
  lowerRoman: "lowerRoman",
  upperRoman: "upperRoman",
  lowerLetter: "lowerLetter",
  upperLetter: "upperLetter",
};

const SWITCHES: Readonly<Record<string, PageNumberFormat>> = {
  arabic: "decimal",
  roman: "lowerRoman",
  ROMAN: "upperRoman",
  alphabetic: "lowerLetter",
  ALPHABETIC: "upperLetter",
};

const START_TYPES: Readonly<Record<string, PageSection["start"]>> = {
  nextPage: "nextPage",
  continuous: "continuous",
  evenPage: "evenPage",
  oddPage: "oddPage",
};

const FIELDS = new Set(["PAGE", "NUMPAGES", "SECTIONPAGES"]);

const own = <T>(record: Readonly<Record<string, T>>, key: string | undefined): T | undefined =>
  key !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

const twips = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) ? Math.round(parsed) : fallback;
};

type Align = PageFurnitureParagraph["align"];

const ALIGNS: Readonly<Record<string, Align>> = {
  left: "left",
  start: "left",
  center: "center",
  right: "right",
  end: "right",
  both: "justify",
  distribute: "justify",
};

const TAB_ALIGNS: Readonly<Record<string, PageTabStop["align"]>> = {
  left: "left",
  start: "left",
  num: "left",
  center: "center",
  right: "right",
  end: "right",
  decimal: "decimal",
  bar: "bar",
};

const TAB_LEADERS: Readonly<Record<string, NonNullable<PageTabStop["leader"]>>> = {
  dot: "dot",
  hyphen: "hyphen",
  underscore: "underscore",
  heavy: "heavy",
  middleDot: "middleDot",
};

/** The paper a section has when the file gives none; the caller picks it for the region. */
export interface PageDefaults {
  width: number;
  height: number;
}

interface ParagraphStyle {
  basedOn: string | null;
  align: Align | undefined;
  tabs: XmlElement | undefined;
}

interface Styles {
  paragraph: ReadonlyMap<string, ParagraphStyle>;
  defaultId: string | null;
  /** From `w:docDefaults`, below every style. */
  align: Align | undefined;
}

const MAX_STYLE_DEPTH = 20;

async function stylesOf(
  pkg: WordPackage,
  relationships: ReadonlyMap<string, Relationship>,
): Promise<Styles> {
  const paragraph = new Map<string, ParagraphStyle>();
  const styles: Styles = { paragraph, defaultId: null, align: undefined };
  const part = [...relationships.values()].find(
    (rel) => !rel.external && rel.type.endsWith("/styles"),
  );
  const xml = part && pkg.zip.has(part.target) ? await pkg.zip.readText(part.target) : undefined;
  if (!xml) return styles;
  for (const element of elements(parseXml(xml))) {
    if (element.name === "w:docDefaults") {
      const pPr = child(child(element, "w:pPrDefault") ?? element, "w:pPr");
      styles.align = alignOf(pPr);
    }
    if (element.name !== "w:style" || element.attrs["w:type"] !== "paragraph") continue;
    const id = element.attrs["w:styleId"];
    if (!id) continue;
    if (element.attrs["w:default"] === "1" || element.attrs["w:default"] === "true") {
      styles.defaultId = id;
    }
    const pPr = child(element, "w:pPr");
    paragraph.set(id, {
      basedOn: child(element, "w:basedOn")?.attrs["w:val"] ?? null,
      align: alignOf(pPr),
      tabs: pPr && child(pPr, "w:tabs"),
    });
  }
  return styles;
}

const alignOf = (pPr: XmlElement | undefined): Align | undefined => {
  const jc = pPr && child(pPr, "w:jc")?.attrs["w:val"];
  return jc === undefined ? undefined : (own(ALIGNS, jc) ?? "left");
};

function styleChain(styles: Styles, id: string | null): ParagraphStyle[] {
  const chain: ParagraphStyle[] = [];
  const seen = new Set<string>();
  for (let at = id; at && !seen.has(at) && chain.length < MAX_STYLE_DEPTH; ) {
    seen.add(at);
    const style = styles.paragraph.get(at);
    if (!style) break;
    chain.push(style);
    at = style.basedOn;
  }
  return chain;
}

function paragraphLayout(
  styles: Styles,
  pPr: XmlElement | undefined,
): { align: Align; tabStops: PageTabStop[] } {
  const named = pPr && child(pPr, "w:pStyle")?.attrs["w:val"];
  const chain = styleChain(styles, named ?? styles.defaultId);
  const align = alignOf(pPr) ?? chain.find((style) => style.align)?.align ?? styles.align ?? "left";
  const stops = new Map<number, PageTabStop>();
  const layers = [...chain.map((style) => style.tabs).reverse(), pPr && child(pPr, "w:tabs")];
  for (const tabs of layers) {
    for (const tab of tabs ? elements(tabs) : []) {
      if (tab.name !== "w:tab") continue;
      const position = Number(tab.attrs["w:pos"]);
      if (!Number.isFinite(position)) continue;
      const kind = tab.attrs["w:val"] ?? "left";
      if (kind === "clear") {
        stops.delete(position);
        continue;
      }
      const leader = own(TAB_LEADERS, tab.attrs["w:leader"]);
      stops.set(position, {
        position: Math.round(position),
        align: own(TAB_ALIGNS, kind) ?? "left",
        ...(leader && { leader }),
      });
    }
  }
  return { align, tabStops: [...stops.values()].sort((a, b) => a.position - b.position) };
}

interface Formatting {
  bold?: true;
  italic?: true;
}

class RunReader {
  readonly runs: PageFurnitureRun[] = [];
  private readonly fields: {
    instruction: string;
    inResult: boolean;
    format: Formatting;
    result: PageFurnitureRun[];
  }[] = [];

  private add(run: PageFurnitureRun): void {
    const open = this.fields.at(-1);
    const target = open?.inResult ? open.result : open ? null : this.runs;
    if (!target) return;
    const last = target.at(-1);
    if (
      run.kind === "text" &&
      last?.kind === "text" &&
      last.bold === run.bold &&
      last.italic === run.italic
    ) {
      target[target.length - 1] = { ...last, text: last.text + run.text };
    } else {
      target.push(run);
    }
  }

  read(node: XmlElement): void {
    for (const element of elements(node)) {
      switch (element.name) {
        case "w:r":
          this.run(element);
          break;
        case "w:fldSimple":
          this.simpleField(element);
          break;
        case "w:hyperlink":
        case "w:ins":
        case "w:smartTag":
        case "w:sdt":
        case "w:sdtContent":
        case "w:customXml":
          this.read(element);
          break;
        default:
      }
    }
  }

  private formatting(run: XmlElement | undefined): Formatting {
    const props = run && child(run, "w:rPr");
    return {
      ...(props && onOff(child(props, "w:b")) && { bold: true as const }),
      ...(props && onOff(child(props, "w:i")) && { italic: true as const }),
    };
  }

  private run(run: XmlElement): void {
    const format = this.formatting(run);
    for (const part of elements(run)) {
      if (part.name === "w:fldChar") this.fieldChar(part, format);
      else if (part.name === "w:instrText") {
        const open = this.fields.at(-1);
        if (open && !open.inResult) open.instruction += textOf(part);
      } else if (part.name === "w:t") this.add({ kind: "text", text: textOf(part), ...format });
      else if (part.name === "w:tab") this.add({ kind: "text", text: "\t", ...format });
      else if (part.name === "w:ptab") {
        this.add({
          kind: "alignedTab",
          align:
            part.attrs["w:alignment"] === "center"
              ? "center"
              : part.attrs["w:alignment"] === "right"
                ? "right"
                : "left",
          relativeTo: part.attrs["w:relativeTo"] === "indent" ? "indent" : "margin",
        });
      } else if (part.name === "w:br" || part.name === "w:cr") {
        this.add({ kind: "text", text: "\n", ...format });
      }
    }
  }

  private fieldChar(mark: XmlElement, format: Formatting): void {
    const type = mark.attrs["w:fldCharType"];
    if (type === "begin") {
      this.fields.push({ instruction: "", inResult: false, format, result: [] });
    } else if (type === "separate") {
      const open = this.fields.at(-1);
      if (open) open.inResult = true;
    } else if (type === "end") {
      const closed = this.fields.pop();
      if (closed) this.finish(closed.instruction, closed.result, closed.format);
    }
  }

  private simpleField(field: XmlElement): void {
    const inside = new RunReader();
    inside.read(field);
    const first = elements(field).find((each) => each.name === "w:r");
    this.finish(field.attrs["w:instr"] ?? "", inside.runs, this.formatting(first));
  }

  /** A field IncarnaMind draws becomes a field run; any other is its last result as text. */
  private finish(
    instruction: string,
    result: readonly PageFurnitureRun[],
    format: Formatting,
  ): void {
    const words = instruction.trim().split(/\s+/);
    const name = (words[0] ?? "").toUpperCase();
    if (FIELDS.has(name)) {
      const shown = result.find((run) => run.kind === "text");
      const bold = format.bold ?? (shown?.kind === "text" ? shown.bold : undefined);
      const italic = format.italic ?? (shown?.kind === "text" ? shown.italic : undefined);
      const given = words
        .map((word, at) => (words[at - 1] === "\\*" ? own(SWITCHES, word) : undefined))
        .find((each) => each !== undefined);
      this.add({
        kind: "field",
        field: name as "PAGE" | "NUMPAGES" | "SECTIONPAGES",
        format: given ?? null,
        ...(bold && { bold }),
        ...(italic && { italic }),
      });
      return;
    }
    for (const run of result) this.add(run);
  }
}

/** A text box's other half, the VML a file keeps for older readers, says the same again. */
const notFallback = (element: XmlElement) => element.name !== "mc:Fallback";

function furnitureOf(root: XmlElement, styles: Styles): PageFurniture {
  // A page number is often a text box in the footer: its paragraphs follow the one it is anchored in.
  const boxed = new Set<XmlElement>();
  let pictures = 0;
  for (const box of walk(root, notFallback)) {
    if (box.name === "w:txbxContent") {
      for (const inside of walk(box)) if (inside.name === "w:p") boxed.add(inside);
    } else if (box.name === "w:drawing" || box.name === "w:pict") {
      const holdsText = [...walk(box)].some((each) => each.name === "w:txbxContent");
      if (!holdsText) pictures++;
    }
  }
  const paragraphs: PageFurnitureParagraph[] = [];
  for (const element of walk(root, notFallback)) {
    if (element.name !== "w:p") continue;
    const reader = new RunReader();
    reader.read(element);
    const pPr = child(element, "w:pPr");
    const { align, tabStops } = paragraphLayout(styles, pPr);
    paragraphs.push({
      align,
      runs: reader.runs,
      ...(tabStops.length > 0 && { tabStops }),
      ...(boxed.has(element) && { inTextBox: true as const }),
      ...(pPr && child(pPr, "w:framePr") && { framed: true as const }),
    });
  }
  return { paragraphs, ...(pictures > 0 && { pictures }) };
}

const furnitureKinds = ["default", "first", "even"] as const;

class Furniture {
  private readonly parts = new Map<string, Promise<PageFurniture | null>>();

  constructor(
    private readonly pkg: WordPackage,
    private readonly relationships: ReadonlyMap<string, Relationship>,
    private readonly styles: Styles,
  ) {}

  async named(
    sectPr: XmlElement | undefined,
    reference: "w:headerReference" | "w:footerReference",
  ): Promise<Partial<Record<(typeof furnitureKinds)[number], PageFurniture | null>>> {
    const found: Partial<Record<(typeof furnitureKinds)[number], PageFurniture | null>> = {};
    for (const each of sectPr ? elements(sectPr) : []) {
      if (each.name !== reference) continue;
      const type = each.attrs["w:type"] ?? "default";
      if (!furnitureKinds.some((kind) => kind === type)) continue;
      const rel = this.relationships.get(each.attrs["r:id"] ?? "");
      found[type as (typeof furnitureKinds)[number]] =
        rel && !rel.external ? await this.part(rel.target) : null;
    }
    return found;
  }

  private part(name: string): Promise<PageFurniture | null> {
    let read = this.parts.get(name);
    if (!read) {
      read = (async () => {
        if (!this.pkg.zip.has(name)) return null;
        const xml = await this.pkg.zip.readText(name);
        return xml ? furnitureOf(parseXml(xml), this.styles) : null;
      })();
      this.parts.set(name, read);
    }
    return read;
  }
}

/**
 * Each section's `w:sectPr` in order, with the place of the atom that ends it in the Mind. Word
 * finds a break in any paragraph of the body's flow, inside a content control or custom XML too.
 * The Mind keeps a control as one atom and no atom for a break inside it, so such a break is
 * named by the outermost control that holds it.
 */
function sectionsOf(
  document: XmlElement,
): { sectPr: XmlElement | undefined; breakPlace: string | null }[] {
  const body = child(document, "w:body");
  if (!body) return [];
  const ordinals = ordinalsOf(document);
  const placeOf = (element: XmlElement) => `${element.name}#${ordinals.get(element) ?? 0}`;
  const found: { sectPr: XmlElement | undefined; breakPlace: string | null }[] = [];
  const visit = (container: XmlElement, control: XmlElement | null) => {
    for (const block of elements(container)) {
      if (block.name === "w:p") {
        const pPr = child(block, "w:pPr");
        const sectPr = pPr && child(pPr, "w:sectPr");
        if (sectPr) found.push({ sectPr, breakPlace: placeOf(control ?? sectPr) });
      } else if (block.name === "w:customXml") visit(block, control);
      else if (block.name === "w:sdt")
        visit(child(block, "w:sdtContent") ?? block, control ?? block);
    }
  };
  visit(body, null);
  // The last section's properties are the body's own; a file with none has the defaults.
  found.push({ sectPr: child(body, "w:sectPr"), breakPlace: null });
  return found;
}

export async function readPageSetup(
  pkg: WordPackage,
  defaults: PageDefaults = PAPER.letter,
): Promise<PageSetup> {
  const xml = await pkg.zip.readText(pkg.part);
  if (!xml) return { source: "word", oddAndEven: false, sections: [] };
  const document = parseXml(xml);
  const relationships = await relationshipsOf(pkg.zip, pkg.part);
  const furniture = new Furniture(pkg, relationships, await stylesOf(pkg, relationships));

  const settings = [...relationships.values()].find((rel) => rel.type.endsWith("/settings"));
  const settingsXml =
    settings && pkg.zip.has(settings.target) ? await pkg.zip.readText(settings.target) : undefined;
  const oddAndEven = settingsXml
    ? onOff(child(parseXml(settingsXml), "w:evenAndOddHeaders")) === true
    : false;

  const empty: PageFurnitureSet = { default: null, first: null, even: null };
  let headers = empty;
  let footers = empty;
  const sections: PageSection[] = [];
  for (const { sectPr, breakPlace } of sectionsOf(document)) {
    const size = sectPr && child(sectPr, "w:pgSz");
    const margins = sectPr && child(sectPr, "w:pgMar");
    const numbering = sectPr && child(sectPr, "w:pgNumType");
    const width = twips(size?.attrs["w:w"], defaults.width);
    const height = twips(size?.attrs["w:h"], defaults.height);
    headers = { ...headers, ...(await furniture.named(sectPr, "w:headerReference")) };
    footers = { ...footers, ...(await furniture.named(sectPr, "w:footerReference")) };
    const type = (sectPr && child(sectPr, "w:type")?.attrs["w:val"]) ?? "nextPage";
    const start = numbering?.attrs["w:start"];
    sections.push({
      breakPlace,
      start: own(START_TYPES, type) ?? "nextPage",
      width,
      height,
      // Word draws the box by `w:w` and `w:h`; a `w:orient` that disagrees with them is not what is drawn.
      orientation: width > height ? "landscape" : "portrait",
      margins: {
        top: twips(margins?.attrs["w:top"], MARGIN),
        right: twips(margins?.attrs["w:right"], MARGIN),
        bottom: twips(margins?.attrs["w:bottom"], MARGIN),
        left: twips(margins?.attrs["w:left"], MARGIN),
        gutter: twips(margins?.attrs["w:gutter"], 0),
        header: twips(margins?.attrs["w:header"], HEADER_AND_FOOTER_DISTANCE),
        footer: twips(margins?.attrs["w:footer"], HEADER_AND_FOOTER_DISTANCE),
      },
      differentFirstPage: sectPr ? onOff(child(sectPr, "w:titlePg")) === true : false,
      pageNumbers: {
        start: start !== undefined && Number.isFinite(Number(start)) ? Number(start) : null,
        format: own(FORMATS, numbering?.attrs["w:fmt"]) ?? "decimal",
      },
      headers,
      footers,
    });
  }
  return { source: "word", oddAndEven, sections };
}
