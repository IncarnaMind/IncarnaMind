/**
 * PowerPoint (.pptx) → Units: one per slide, in presentation order, so a
 * slide's Unit number is its slide number. A Unit holds the slide's title,
 * its text boxes, tables (a row per line, cells separated by tabs), charts'
 * titles, series and categories, and images' alt text, then, after a blank
 * line, its speaker notes, which count as part of the slide (ADR-0011).
 * Anchors mark the title, each shape, table row, chart and image, and the
 * notes, so the viewer and the prompt can tell the notes apart.
 *
 * It also gives each slide's outline for the viewer: title, text, tables,
 * charts, images (as parts of the package) and notes. Ported from the
 * office-formats spike.
 */
import { type TextUnit, UnitBuilder } from "../../../shared/units";
import { cellTable, headingRowsOf, isFigure, shiftedDigits } from "../tableCells";
import { dataUrlOf, imageTypeOf } from "./images";
import {
  mainRootOf,
  OfficePackage,
  type Relationship,
  type Relationships,
  relationshipOfType,
} from "./officePackage";
import { child, descendants, elements, local, parseXml, textOf, type XmlElement } from "./xml";
import { openPackage, type ZipArchive } from "./zip";

const REL_SLIDE = "/slide";
const REL_NOTES = "/notesSlide";
const REL_IMAGE = "/image";
const REL_CHART = "/chart";

/** A merge flag as DrawingML writes it: "1", or "true" in files that spell booleans out. */
const mergedAttr = (value: string | undefined) => value === "1" || value === "true";

/** A run's text, digits set raised or lowered written as Unicode's superscript or subscript digits. */
function runText(run: XmlElement): string {
  const text = textOf(child(run, "a:t") ?? run);
  const baseline = Number(child(run, "a:rPr")?.attrs.baseline ?? 0);
  return baseline === 0 || !Number.isFinite(baseline) ? text : shiftedDigits(text, baseline > 0);
}

/** A DrawingML text body (a:txBody or p:txBody) as lines, one per paragraph. */
function paragraphs(txBody: XmlElement): string[] {
  return elements(txBody)
    .filter((each) => each.name === "a:p")
    .map((paragraph) =>
      elements(paragraph)
        .map((run) =>
          run.name === "a:br"
            ? "\n"
            : run.name === "a:r" || run.name === "a:fld"
              ? runText(run)
              : "",
        )
        .join("")
        .trim(),
    )
    .filter(Boolean);
}

const placeholderType = (shape: XmlElement): string | undefined => {
  const nv = elements(shape).find((each) => local(each.name).startsWith("nv"));
  const nvPr = nv && child(nv, "p:nvPr");
  const ph = nvPr && child(nvPr, "p:ph");
  return ph ? (ph.attrs.type ?? "body") : undefined;
};

/** A slide as the viewer's outline shows it. */
export interface SlideOutline {
  number: number;
  hidden: boolean;
  title: string | null;
  /** Text boxes, each as its paragraphs. */
  blocks: string[][];
  /** Tables, as rows of cells. */
  tables: string[][][];
  /** Each chart's text: title, series and categories. */
  charts: string[];
  /** Images, as parts of the package, with their alt text. */
  images: { part: string; alt: string }[];
  /** The speaker notes, as paragraphs. */
  notes: string[];
}

interface DeckRow {
  cells: string[];
  covered: boolean[];
  continued: boolean[];
}

interface Collected {
  title: string | null;
  blocks: string[][];
  tables: DeckRow[][];
  images: { part: string; alt: string }[];
  charts: string[];
}

/** Walks a shape tree in document order (z-order), into groups. */
function collect(tree: XmlElement, rels: Relationships, into: Collected): void {
  for (const shape of elements(tree)) {
    switch (shape.name) {
      case "p:sp": {
        const txBody = child(shape, "p:txBody");
        if (!txBody) break;
        const lines = paragraphs(txBody);
        if (lines.length === 0) break;
        const type = placeholderType(shape);
        if (type === "sldNum" || type === "dt" || type === "ftr") break;
        if ((type === "title" || type === "ctrTitle") && into.title === null) {
          into.title = lines.join(" ");
        } else into.blocks.push(lines);
        break;
      }
      case "p:grpSp":
        collect(shape, rels, into);
        break;
      case "p:graphicFrame": {
        for (const table of descendants(shape, "a:tbl")) {
          into.tables.push(
            elements(table)
              .filter((each) => each.name === "a:tr")
              .map((row) => {
                const cells: string[] = [];
                const covered: boolean[] = [];
                const continued: boolean[] = [];
                for (const cell of elements(row).filter((each) => each.name === "a:tc")) {
                  // A row names each of its grid's columns with a cell of its own; the cells a
                  // merged one covers come after it marked hMerge, so the span adds none.
                  cells.push(paragraphs(child(cell, "a:txBody") ?? cell).join(" "));
                  covered.push(mergedAttr(cell.attrs.hMerge));
                  continued.push(mergedAttr(cell.attrs.vMerge));
                }
                return { cells, covered, continued };
              }),
          );
        }
        for (const chart of descendants(shape, "c:chart")) {
          const rel = rels.get(chart.attrs["r:id"] ?? "");
          if (rel?.type.endsWith(REL_CHART)) into.charts.push(rel.target);
        }
        break;
      }
      case "p:pic": {
        const blip = descendants(shape, "a:blip")[0];
        const rel = blip && rels.get(blip.attrs["r:embed"] ?? "");
        const alt = descendants(shape, "p:cNvPr")[0]?.attrs.descr ?? "";
        if (rel?.type.endsWith(REL_IMAGE)) into.images.push({ part: rel.target, alt });
        break;
      }
    }
  }
}

/** A chart's title, series names, and categories with their values, from the chart's caches. */
async function chartText(zip: ZipArchive, part: string): Promise<string> {
  const xml = await zip.readText(part);
  if (!xml) return "";
  const root = parseXml(xml);
  const pieces: string[] = [];
  for (const title of descendants(root, "c:title")) {
    pieces.push(descendants(title, "a:t").map(textOf).join(""));
  }
  for (const series of descendants(root, "c:ser")) {
    const name = descendants(child(series, "c:tx") ?? series, "c:v")[0];
    if (name) pieces.push(textOf(name));
    const categories = child(series, "c:cat");
    const values = child(series, "c:val");
    const labels = categories ? descendants(categories, "c:v").map(textOf) : [];
    const numbers = values ? descendants(values, "c:v").map(textOf) : [];
    pieces.push(labels.map((label, index) => `${label}: ${numbers[index] ?? ""}`).join(", "));
  }
  return pieces.filter(Boolean).join("\n");
}

/** Alt text that is only a file name ("image1.png"), which some writers put there. */
const FILE_NAME = /^[\w .-]+\.(png|jpe?g|gif|bmp|emf|wmf|svg|tiff?)$/i;

export interface PptxResult {
  units: TextUnit[];
  slides: SlideOutline[];
  /** Relationships parts that couldn't be read; the rest was read without what they name. */
  unreadable: string[];
}

export async function extractPptx(bytes: Uint8Array): Promise<PptxResult> {
  const zip = openPackage(bytes);
  const pkg = new OfficePackage(zip);
  const presentation = await pkg.mainPart("ppt/presentation.xml");
  const root = mainRootOf(
    await zip.readText(presentation),
    presentation,
    "presentation",
    "Not a PowerPoint file",
  );
  const presentationRels = await pkg.internalRelationships(presentation);
  const list = child(root, "p:sldIdLst");
  const slideParts = (list ? elements(list) : [])
    .map((id) => presentationRels.get(id.attrs["r:id"] ?? ""))
    .filter((rel): rel is Relationship => rel?.type.endsWith(REL_SLIDE) ?? false)
    .map((rel) => rel.target);

  const units: TextUnit[] = [];
  const slides: SlideOutline[] = [];
  for (const [index, part] of slideParts.entries()) {
    const number = index + 1;
    const xml = await zip.readText(part);
    const root = xml ? parseXml(xml) : null;
    const rels = await pkg.internalRelationships(part);
    const tree = root ? descendants(root, "p:spTree")[0] : undefined;
    const collected: Collected = { title: null, blocks: [], tables: [], images: [], charts: [] };
    if (tree) collect(tree, rels, collected);
    for (const rows of collected.tables) {
      // A merge repeats the text it continues down the body's rows, not into another heading row,
      // and never a figure, which would count twice.
      const starts: string[] = [];
      const startedAt: number[] = [];
      const headingRows = headingRowsOf(
        rows.map((row) => row.cells),
        { covered: rows.map((row) => row.covered) },
      );
      for (const [at, row] of rows.entries()) {
        for (let column = 0; column < row.cells.length; column++) {
          const start = starts[column];
          if (
            row.continued[column] &&
            start &&
            !isFigure(start) &&
            (startedAt[column] ?? -1) >= headingRows
          )
            row.cells[column] = start;
        }
        for (let column = 0; column < row.cells.length; column++) {
          if (!row.continued[column]) {
            starts[column] = row.cells[column] ?? "";
            startedAt[column] = at;
          }
        }
      }
    }

    const notesRel = relationshipOfType(rels, REL_NOTES);
    const notes: string[] = [];
    if (notesRel) {
      const notesXml = await zip.readText(notesRel.target);
      const notesTree = notesXml && descendants(parseXml(notesXml), "p:spTree")[0];
      for (const shape of notesTree ? descendants(notesTree, "p:sp") : []) {
        if (placeholderType(shape) !== "body") continue;
        const txBody = child(shape, "p:txBody");
        if (txBody) notes.push(...paragraphs(txBody));
      }
    }

    const builder = new UnitBuilder();
    if (collected.title) builder.add(collected.title, "title");
    for (const [at, lines] of collected.blocks.entries()) {
      builder.add(lines.join("\n"), `shape${at + 1}`);
    }
    for (const [table, rows] of collected.tables.entries()) {
      for (const [row, cells] of rows.entries()) {
        builder.add(cells.cells.join("\t"), `table${table + 1}.row${row + 1}`);
      }
    }
    const charts: string[] = [];
    for (const chart of collected.charts) charts.push(await chartText(zip, chart));
    for (const [at, text] of charts.entries()) builder.add(text, `chart${at + 1}`);
    collected.images.forEach((image, at) => {
      if (image.alt && !FILE_NAME.test(image.alt)) builder.add(image.alt, `image${at + 1}`);
    });
    if (notes.length) builder.add(notes.join("\n"), "notes", "\n\n");

    const hidden = root?.attrs.show === "0";
    const tables = collected.tables.flatMap(
      (rows) =>
        cellTable(
          rows.map((row) => row.cells),
          { covered: rows.map((row) => row.covered) },
        ) ?? [],
    );
    units.push({
      page: number,
      kind: "slide",
      label: {
        ...(collected.title ? { title: collected.title } : {}),
        ...(hidden ? { hidden } : {}),
        ...(tables.length > 0 ? { tables } : {}),
      },
      text: builder.text,
      anchors: builder.anchors,
    });
    slides.push({
      number,
      hidden,
      title: collected.title,
      blocks: collected.blocks,
      tables: collected.tables.map((rows) => rows.map((row) => row.cells)),
      charts: charts.filter(Boolean),
      images: collected.images,
      notes,
    });
  }
  return { units, slides, unreadable: pkg.unreadable };
}

/** The largest image the outline shows, in bytes. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * An image part of a deck as a `data:` URL, for the outline (the viewer's
 * Content-Security-Policy allows `data:` images, not `blob:` ones). Null for
 * formats a browser can't show (EMF, WMF), SVG (left out: it can carry
 * scripts and links), and parts that are missing or too large.
 */
export async function imageDataUrl(bytes: Uint8Array, part: string): Promise<string | null> {
  const type = imageTypeOf(part);
  if (!type) return null;
  let data: Uint8Array | undefined;
  try {
    data = await openPackage(bytes).read(part, MAX_IMAGE_BYTES);
  } catch {
    return null;
  }
  if (!data) return null;
  return dataUrlOf(data, type);
}
