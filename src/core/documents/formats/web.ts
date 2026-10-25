/**
 * A web page's snapshot (../web/snapshot, #261) → Units: one per heading
 * section, as for Markdown, its paragraphs anchored "p1", "p2"… from the
 * heading so a Location can name them ("§ History, ¶ 3"). Pure: the worker
 * indexes with it and the viewer draws with it, so both see the same blocks.
 *
 * A picture saved with the page is a block of its own, numbered in
 * the page from 1 and anchored "figure2": its description, and the text
 * read from it, each line anchored "figure2.line3" with its box on
 * the picture. A picture's text never moves where a section is cut, so the
 * viewer, which has only the descriptions, cuts the page where the index did.
 */
import type { Anchor, TextUnit, UnitFigure } from "../../../shared/units";
import { MAX_SECTION_CHARS } from "./docx";
import { ExtractionError } from "./errors";
import { elements, parseXml, textOf, type XmlElement, type XmlNode } from "./xml";

export interface WebPageMeta {
  title: string | null;
  address: string | null;
  siteName: string | null;
  author: string | null;
  /** When the page says it was published, as it gives it (ISO 8601 when it can be read). */
  published: string | null;
  language: string | null;
}

export interface WebBlock {
  element: XmlElement;
  /** Null for a paragraph. */
  level: number | null;
  /** As indexed: a table's rows on lines, their cells separated by tabs. */
  text: string;
  /** A saved picture's number in the page, from 1. */
  figure?: number;
  /** A saved picture's lines read: spans of `text`, with their boxes. */
  lines?: { start: number; end: number; quad: number[] }[];
  reading?: Omit<UnitFigure, "number">;
}

export const SAVED_PICTURE = /^pictures\/[0-9a-f]{64}\.(?:png|jpg|gif|webp|avif)$/;

export interface FigureReading {
  reader: string;
  /** Its lines, in reading order. */
  text: string;
  /** Spans of `text`, with their boxes on the picture as fractions (see `Anchor.quad`). */
  lines: { start: number; end: number; quad: number[] }[];
  unsure?: [number, number][];
  /** It couldn't be read now: only its description is text. */
  unread?: boolean;
}

interface Figures {
  count: number;
  readings: ReadonlyMap<number, FigureReading> | null;
}

function savedPictures(nodes: readonly XmlNode[]): XmlElement[] {
  const found: XmlElement[] = [];
  for (const node of nodes) {
    if (typeof node === "string") continue;
    if (nameOf(node) === "img" && SAVED_PICTURE.test(node.attrs.src ?? "")) found.push(node);
    else found.push(...savedPictures(node.children));
  }
  return found;
}

function pushFigures(nodes: readonly XmlNode[], out: WebBlock[], figures: Figures): void {
  for (const img of savedPictures(nodes)) {
    const figure = ++figures.count;
    const description = (img.attrs.alt ?? "").replace(SPACES, " ").trim();
    const reading = figures.readings?.get(figure);
    const offset = description && reading?.text ? description.length + 1 : 0;
    out.push({
      element: img,
      level: null,
      text: [description, reading?.text ?? ""].filter(Boolean).join("\n"),
      figure,
      ...(reading && {
        lines: reading.lines.map((line) => ({
          ...line,
          start: line.start + offset,
          end: line.end + offset,
        })),
        reading: {
          reader: reading.reader,
          ...(reading.unsure?.length && {
            unsure: reading.unsure.map(([from, to]): [number, number] => [
              from + offset,
              to + offset,
            ]),
          }),
          ...(reading.unread && { unread: true }),
        },
      }),
    });
  }
}

/** `blocks`: the indexes of its first and last block. */
export interface WebUnit extends TextUnit {
  blocks: { first: number; last: number };
}

export interface WebPage {
  meta: WebPageMeta;
  article: XmlElement | null;
  blocks: WebBlock[];
  units: WebUnit[];
}

const HEADING = /^h([1-6])$/;

const CONTAINERS = new Set([
  "article",
  "aside",
  "blockquote",
  "body",
  "details",
  "div",
  "dl",
  "figure",
  "footer",
  "header",
  "main",
  "ol",
  "section",
  "summary",
  "ul",
]);

/** One paragraph each, unless they hold blocks of their own. */
const PARAGRAPHS = new Set(["p", "dt", "dd", "figcaption", "caption"]);

export const BLOCK_ELEMENTS = new Set([
  ...CONTAINERS,
  ...PARAGRAPHS,
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "pre",
  "table",
  "hr",
]);

const nameOf = (element: XmlElement) => element.name.toLowerCase();

const isBlock = (node: XmlNode): node is XmlElement =>
  typeof node !== "string" && BLOCK_ELEMENTS.has(nameOf(node));

const SPACES = /[ \t\n\r\f]+/g;

/** As a browser shows it: spaces collapsed, a line break at each `br`. */
function inlineText(nodes: readonly XmlNode[]): string {
  const lines: string[] = [""];
  const walk = (list: readonly XmlNode[]) => {
    for (const node of list) {
      if (typeof node === "string") lines[lines.length - 1] += node;
      else if (nameOf(node) === "br") lines.push("");
      else if (nameOf(node) !== "img") walk(node.children);
    }
  };
  walk(nodes);
  return lines
    .map((line) => line.replace(SPACES, " ").trim())
    .join("\n")
    .trim();
}

function tableText(table: XmlElement): string {
  const rows: string[] = [];
  const walk = (element: XmlElement) => {
    for (const child of elements(element)) {
      const name = nameOf(child);
      if (name === "tr") {
        const cells = elements(child)
          .filter((cell) => nameOf(cell) === "td" || nameOf(cell) === "th")
          .map((cell) => inlineText(cell.children).replace(/\s*\n\s*/g, " "));
        if (cells.some(Boolean)) rows.push(cells.join("\t"));
      } else if (name === "thead" || name === "tbody" || name === "tfoot") walk(child);
    }
  };
  walk(table);
  return rows.join("\n");
}

/** The line break that may open a `pre` isn't part of its text, as in HTML. */
const preText = (pre: XmlElement) =>
  textOf(pre)
    .replace(/^\r?\n/, "")
    .trimEnd();

function collectBlocks(container: XmlElement, out: WebBlock[], figures: Figures): void {
  for (const element of elements(container)) {
    const name = nameOf(element);
    const heading = HEADING.exec(name);
    if (heading) {
      const text = inlineText(element.children);
      if (text) out.push({ element, level: Number(heading[1]), text });
      pushFigures(element.children, out, figures);
    } else if (name === "pre") {
      const text = preText(element);
      if (text.trim()) out.push({ element, level: null, text });
    } else if (name === "table") {
      const text = tableText(element);
      if (text) out.push({ element, level: null, text });
      pushFigures(element.children, out, figures);
    } else if (name === "li") {
      const inline = element.children.filter((node) => !isBlock(node));
      const text = inlineText(inline);
      if (text) out.push({ element, level: null, text });
      pushFigures(inline, out, figures);
      collectBlocks(element, out, figures);
    } else if (PARAGRAPHS.has(name) && !element.children.some(isBlock)) {
      const text = inlineText(element.children);
      if (text) out.push({ element, level: null, text });
      pushFigures(element.children, out, figures);
    } else if (CONTAINERS.has(name) || PARAGRAPHS.has(name)) {
      collectBlocks(element, out, figures);
    }
  }
}

function findElement(root: XmlElement, name: string): XmlElement | null {
  for (const element of elements(root)) {
    if (nameOf(element) === name) return element;
    const inside = findElement(element, name);
    if (inside) return inside;
  }
  return null;
}

function readMeta(root: XmlElement): WebPageMeta {
  const head = findElement(root, "head");
  const content = (key: string): string | null => {
    for (const meta of head ? elements(head) : []) {
      if (nameOf(meta) !== "meta") continue;
      if (meta.attrs.name !== key && meta.attrs.property !== key) continue;
      const value = meta.attrs.content?.trim();
      if (value) return value;
    }
    return null;
  };
  const title = head ? findElement(head, "title") : null;
  return {
    title: (title && inlineText(title.children)) || null,
    address: content("incarnamind:address"),
    siteName: content("og:site_name"),
    author: content("author"),
    published: content("article:published_time"),
    language: root.attrs.lang?.trim() || null,
  };
}

interface Section {
  text: string;
  /** Its length without pictures' text, which never moves where a section is cut. */
  measured: number;
  anchors: Anchor[];
  figures: UnitFigure[];
  hasFigure: boolean;
  first: number;
  part: number;
}

const section = (text: string, first: number, part: number): Section => ({
  text,
  measured: text.length,
  anchors: [],
  figures: [],
  hasFigure: false,
  first,
  part,
});

function unitsOf(blocks: readonly WebBlock[]): WebUnit[] {
  const units: WebUnit[] = [];
  const path: string[] = [];
  const headed = blocks.some((block) => block.level !== null);
  let current: Section | null = null;
  let paragraph = 0;

  const close = (last: number) => {
    if (!current || (!current.text.trim() && !current.hasFigure)) return;
    const sectionPath = path.filter(Boolean);
    units.push({
      page: units.length + 1,
      kind: "section",
      label: {
        path: sectionPath,
        ...(current.part > 1 ? { part: current.part } : {}),
        ...(headed && sectionPath.length === 0 ? { beforeHeading: true } : {}),
        paragraphs: true,
        ...(current.figures.length > 0 ? { figures: current.figures } : {}),
      },
      text: current.text,
      anchors: current.anchors,
      blocks: { first: current.first, last },
    });
  };

  blocks.forEach((block, index) => {
    if (block.level !== null) {
      close(index - 1);
      path.length = block.level - 1;
      path[block.level - 1] = block.text;
      paragraph = 0;
      current = section(block.text, index, 1);
      return;
    }
    if (
      block.figure === undefined &&
      current?.measured &&
      current.measured + 1 + block.text.length > MAX_SECTION_CHARS
    ) {
      close(index - 1);
      current = section("", index, current.part + 1);
    }
    current ??= section("", index, 1);
    if (block.figure !== undefined) {
      current.hasFigure = true;
      if (!block.text) return;
    } else current.measured += (current.measured > 0 ? 1 : 0) + block.text.length;
    if (current.text) current.text += "\n";
    const start = current.text.length;
    current.text += block.text;
    if (block.figure === undefined) {
      paragraph++;
      current.anchors.push({ start, end: current.text.length, target: `p${paragraph}` });
      return;
    }
    const target = `figure${block.figure}`;
    current.anchors.push({ start, end: current.text.length, target });
    block.lines?.forEach((line, number) => {
      current?.anchors.push({
        start: start + line.start,
        end: start + line.end,
        target: `${target}.line${number + 1}`,
        quad: line.quad,
      });
    });
    if (block.reading) {
      const { unsure, ...reading } = block.reading;
      current.figures.push({
        number: block.figure,
        ...reading,
        ...(unsure && {
          unsure: unsure.map(([from, to]): [number, number] => [start + from, start + to]),
        }),
      });
    }
  });
  close(blocks.length - 1);
  return units;
}

/** Throws `ExtractionError` for anything that isn't a snapshot. */
export function readWebPage(
  source: string,
  readings: ReadonlyMap<number, FigureReading> | null = null,
): WebPage {
  const root = parseXml(source);
  if (nameOf(root) !== "html") {
    throw new ExtractionError("unreadable", "This isn't a saved web page.");
  }
  const body = findElement(root, "body");
  const article = body ? (findElement(body, "article") ?? body) : null;
  const blocks: WebBlock[] = [];
  if (article) collectBlocks(article, blocks, { count: 0, readings });
  return { meta: readMeta(root), article, blocks, units: unitsOf(blocks) };
}

export function webUnits(
  source: string,
  readings: ReadonlyMap<number, FigureReading> | null = null,
): TextUnit[] {
  return readWebPage(source, readings).units.map(({ blocks: _blocks, ...unit }) => unit);
}
