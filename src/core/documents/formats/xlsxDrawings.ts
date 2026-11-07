/**
 * The pictures, charts and shapes over a sheet's cells, for the sheet preview
 * (ADR-0011): where each is anchored, a picture as a `data:` URL (the app's
 * Content-Security-Policy allows those, not `blob:` ones), a chart's type and
 * title for its placeholder, a shape's text and fill. Charts aren't drawn: a
 * chart shows a picture only when the file keeps one as its fallback. Pure.
 */
import { dataUrlOf, imageTypeOf } from "./images";
import type { OfficePackage, Relationships } from "./officePackage";
import type { SheetDrawing, SheetPoint } from "./sheetLayout";
import { child, descendants, elements, is, local, parseXml, textOf, type XmlElement } from "./xml";
import type { ZipArchive } from "./zip";

/** EMUs (DrawingML's unit) in a CSS pixel. */
const EMU_PER_PIXEL = 9525;

/** The largest picture shown, and the most picture bytes read from one workbook. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_WORKBOOK_IMAGE_BYTES = 64 * 1024 * 1024;

/** How many more picture bytes may be read from a workbook. */
export interface ImageBudget {
  left: number;
}

/** A part of the package as a `data:` URL; null for formats a browser can't show, or too large. */
async function dataUrl(zip: ZipArchive, part: string, budget: ImageBudget): Promise<string | null> {
  const type = imageTypeOf(part);
  if (!type || !zip.has(part)) return null;
  let data: Uint8Array | undefined;
  try {
    data = await zip.read(part, Math.min(MAX_IMAGE_BYTES, budget.left));
  } catch {
    return null;
  }
  if (!data) return null;
  budget.left -= data.length;
  return dataUrlOf(data, type);
}

const number = (element: XmlElement | undefined, name: string) =>
  Number((element && child(element, name) ? textOf(child(element, name) as XmlElement) : "0") || 0);

function pointOf(marker: XmlElement | undefined): SheetPoint | undefined {
  if (!marker) return undefined;
  return {
    row: number(marker, "row") + 1,
    column: number(marker, "col"),
    x: number(marker, "colOff") / EMU_PER_PIXEL,
    y: number(marker, "rowOff") / EMU_PER_PIXEL,
  };
}

/** The `r:embed` or `r:id` an element names. */
const relationOf = (element: XmlElement | undefined) =>
  element ? (element.attrs["r:embed"] ?? element.attrs["r:id"]) : undefined;

/** A chart's type and title, from its part. */
async function readChart(
  zip: ZipArchive,
  part: string | undefined,
): Promise<{ chart?: string; text?: string }> {
  if (!part || !zip.has(part)) return {};
  let chart: XmlElement;
  try {
    chart = parseXml((await zip.readText(part)) ?? "");
  } catch {
    return {};
  }
  const title = descendants(chart, "title")[0];
  const text = title
    ? descendants(title, "a:p")
        .map((paragraph) => descendants(paragraph, "a:t").map(textOf).join(""))
        .join(" ")
        .trim()
    : "";
  const plot = descendants(chart, "plotArea")[0];
  const kind = plot ? elements(plot).find((each) => /Chart$/.test(local(each.name))) : undefined;
  let type = kind
    ? local(kind.name)
        .replace(/3D/, "")
        .replace(/Chart$/, "")
    : undefined;
  if (type === "bar" && kind && child(kind, "barDir")?.attrs.val === "col") type = "column";
  if (type === "ofPie") type = "pie";
  return { ...(type ? { chart: type } : {}), ...(text ? { text } : {}) };
}

/** The text of a shape's text body, a line per paragraph. */
const shapeText = (shape: XmlElement) => {
  const body = child(shape, "txBody");
  if (!body) return "";
  return descendants(body, "a:p")
    .map((paragraph) => descendants(paragraph, "a:t").map(textOf).join(""))
    .join("\n")
    .trim();
};

/** What one anchor holds, or null for what isn't shown (connectors, empty shapes, groups). */
async function readContent(
  content: XmlElement,
  zip: ZipArchive,
  rels: Relationships,
  budget: ImageBudget,
): Promise<Omit<SheetDrawing, "from" | "to" | "size"> | null> {
  if (is(content, "AlternateContent")) {
    // A newer kind of chart (chartex) keeps a fallback for older readers: a picture, or a shape.
    const choice = child(content, "Choice");
    const fallback = child(content, "Fallback");
    const chosen = choice ? elements(choice)[0] : undefined;
    const usual = chosen ? await readContent(chosen, zip, rels, budget) : null;
    if (usual && !(usual.kind === "shape" && !usual.text)) return usual;
    const other = fallback ? elements(fallback)[0] : undefined;
    const backup = other ? await readContent(other, zip, rels, budget) : null;
    if (backup?.kind === "picture" && backup.src) return backup;
    const name = chosen ? (descendants(chosen, "cNvPr")[0]?.attrs.name ?? "") : "";
    return { kind: "chart", ...(name ? { text: name } : {}) };
  }
  const properties = descendants(content, "cNvPr")[0];
  if (is(content, "pic")) {
    const blip = descendants(content, "a:blip")[0];
    const part = rels.get(relationOf(blip) ?? "")?.target;
    const description = properties?.attrs.descr || properties?.attrs.name || "";
    return {
      kind: "picture",
      src: part ? await dataUrl(zip, part, budget) : null,
      ...(description ? { text: description } : {}),
    };
  }
  if (is(content, "graphicFrame")) {
    const chart = descendants(content, "chart")[0];
    if (chart)
      return {
        kind: "chart",
        ...(await readChart(zip, rels.get(relationOf(chart) ?? "")?.target)),
      };
    const name = properties?.attrs.name ?? "";
    return { kind: "shape", ...(name ? { text: name } : {}) };
  }
  if (is(content, "sp")) {
    const text = shapeText(content);
    const properties = child(content, "spPr");
    const solid = properties ? child(properties, "solidFill") : undefined;
    const rgb = solid ? child(solid, "srgbClr")?.attrs.val : undefined;
    if (!text && !rgb) return null;
    return { kind: "shape", ...(text ? { text } : {}), ...(rgb ? { fill: `#${rgb}` } : {}) };
  }
  return null;
}

/** The drawings of a sheet's drawing part. */
export async function readDrawings(
  pkg: OfficePackage,
  part: string,
  budget: ImageBudget,
): Promise<SheetDrawing[]> {
  const { zip } = pkg;
  if (!zip.has(part)) return [];
  let root: XmlElement;
  try {
    root = parseXml((await zip.readText(part)) ?? "");
  } catch {
    return [];
  }
  const rels = await pkg.internalRelationships(part);
  const drawings: SheetDrawing[] = [];
  for (const anchor of elements(root)) {
    const kind = local(anchor.name);
    if (!["twoCellAnchor", "oneCellAnchor", "absoluteAnchor"].includes(kind)) continue;
    const content = elements(anchor).find((each) =>
      ["pic", "graphicFrame", "sp", "AlternateContent"].includes(local(each.name)),
    );
    if (!content) continue;
    const read = await readContent(content, zip, rels, budget);
    if (!read) continue;
    const extent = child(anchor, "ext");
    const size = extent
      ? {
          width: Number(extent.attrs.cx ?? 0) / EMU_PER_PIXEL,
          height: Number(extent.attrs.cy ?? 0) / EMU_PER_PIXEL,
        }
      : undefined;
    if (kind === "absoluteAnchor") {
      const position = child(anchor, "pos");
      const from = {
        row: 1,
        column: 0,
        x: Number(position?.attrs.x ?? 0) / EMU_PER_PIXEL,
        y: Number(position?.attrs.y ?? 0) / EMU_PER_PIXEL,
      };
      drawings.push({ ...read, from, ...(size ? { size } : {}) });
      continue;
    }
    const from = pointOf(child(anchor, "from"));
    if (!from) continue;
    const to = kind === "twoCellAnchor" ? pointOf(child(anchor, "to")) : undefined;
    drawings.push({ ...read, from, ...(to ? { to } : size ? { size } : {}) });
  }
  return drawings;
}

/** A sheet's notes (legacy comments): the text of each, by cell reference. */
export async function readNotes(zip: ZipArchive, part: string): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  if (!zip.has(part)) return notes;
  try {
    const root = parseXml((await zip.readText(part)) ?? "");
    const authors = descendants(root, "author").map(textOf);
    for (const comment of descendants(root, "comment")) {
      const ref = comment.attrs.ref;
      const text = child(comment, "text");
      if (!ref || !text) continue;
      const author = authors[Number(comment.attrs.authorId ?? -1)];
      const body = descendants(text, "t").map(textOf).join("").trim();
      notes.set(ref, author && !body.startsWith(author) ? `${author}:\n${body}` : body);
    }
  } catch {
    // A note that can't be read is left out.
  }
  return notes;
}
