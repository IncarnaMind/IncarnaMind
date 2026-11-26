import { crc32, inflateRawSync } from "node:zlib";
import { DOMParser, type Element, type Node } from "@xmldom/xmldom";
import { child, elements, type XmlElement } from "../../src/core/documents/formats/xml";

/**
 * The files in a ZIP archive (a .docx), by path. Checks each entry's CRC-32
 * and size, so a broken archive fails here rather than in Word.
 */
export function unzip(data: Uint8Array): Map<string, Buffer> {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("Not a ZIP archive: no end of central directory.");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Bad central directory.");
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`Bad local header: ${name}`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    const content = method === 8 ? inflateRawSync(raw) : raw;
    if (content.length !== size || crc32(content) !== checksum) {
      throw new Error(`Corrupt entry: ${name}`);
    }
    files.set(name, content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** A text part of a .docx, which must be there. */
export function part(files: Map<string, Buffer>, name: string): string {
  const content = files.get(name);
  if (!content) throw new Error(`The package has no ${name}.`);
  return content.toString("utf8");
}

/**
 * Throws unless `xml` is well-formed: one root element, tags properly nested,
 * attributes quoted and unique, and no stray "<", ">" or "&" in text.
 */
export function checkWellFormed(xml: string): void {
  const markup =
    /<\?[^?]*\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*(\/?)>/g;
  const stack: string[] = [];
  let roots = 0;
  let last = 0;
  const checkText = (text: string) => {
    if (/[<>]/.test(text) || /&(?!(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(text)) {
      throw new Error(`Malformed XML near: ${text.slice(0, 80)}`);
    }
  };
  for (const match of xml.matchAll(markup)) {
    checkText(xml.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[0].startsWith("<?")) continue;
    const [, closing, name, attributes = "", selfClosing] = match;
    const names = [...attributes.matchAll(/([\w:.-]+)="([^"]*)"/g)].map((attribute) => {
      checkText(attribute[2] as string);
      return attribute[1];
    });
    if (new Set(names).size !== names.length) throw new Error(`Repeated attribute on <${name}>.`);
    if (closing) {
      const open = stack.pop();
      if (open !== name) throw new Error(`</${name}> closes <${open}>.`);
    } else {
      if (stack.length === 0) roots++;
      if (!selfClosing) stack.push(name as string);
    }
  }
  checkText(xml.slice(last));
  if (stack.length > 0) throw new Error(`Unclosed <${stack.join(">, <")}>.`);
  if (roots !== 1) throw new Error(`Expected one root element, found ${roots}.`);
}

const decodeEntities = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/**
 * The text of some WordprocessingML: footnote references as "[n]", tabs and
 * line breaks as "\t" and "\n".
 */
export function textOf(xml: string): string {
  let text = "";
  const pieces =
    /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:footnoteReference w:id="(\d+)"\/>|<w:tab\/>|<w:br\/>/g;
  for (const match of xml.matchAll(pieces)) {
    if (match[1] !== undefined) text += decodeEntities(match[1]);
    else if (match[2] !== undefined) text += `[${match[2]}]`;
    else text += match[0] === "<w:tab/>" ? "\t" : "\n";
  }
  return text;
}

export interface DocxParagraph {
  /** Its paragraph style, if it has one. */
  style?: string;
  /** Its list numbering: "numId/level". */
  list?: string;
  text: string;
}

/** The paragraphs of a document body or footnotes part, in order. */
export function paragraphsOf(xml: string): DocxParagraph[] {
  const paragraphs: DocxParagraph[] = [];
  for (const match of xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>|<w:p\/>/g)) {
    const body = match[1] ?? "";
    const paragraph: DocxParagraph = { text: textOf(body) };
    const style = /<w:pStyle w:val="([^"]+)"\/>/.exec(body)?.[1];
    if (style) paragraph.style = style;
    const list = /<w:numPr><w:ilvl w:val="(\d+)"\/><w:numId w:val="(\d+)"\/><\/w:numPr>/.exec(body);
    if (list) paragraph.list = `${list[2]}/${list[1]}`;
    paragraphs.push(paragraph);
  }
  return paragraphs;
}

/** One character of a paragraph as Word shows it, and its run's properties. */
export interface RunCharacter {
  char: string;
  /** Each property written out with its attributes sorted, the properties sorted; a tracked format change left out. */
  format: string[];
}

const writtenOut = (element: XmlElement): string =>
  `${element.name}{${Object.entries(element.attrs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")}}[${elements(element).map(writtenOut).join(",")}]`;

const RUN_CHARACTERS: Readonly<Record<string, string>> = {
  "w:tab": "\t",
  "w:br": "\n",
  "w:cr": "\n",
  "w:noBreakHyphen": "‑",
  "w:softHyphen": "­",
};
const NOT_SHOWN = new Set(["w:p", "w:pPr", "w:del", "w:moveFrom", "w:txbxContent"]);

/**
 * A paragraph's own characters as Word shows them, each with its run's properties: not a nested
 * paragraph's (a text box's), nor deleted text. For telling which formatting an edit kept.
 */
export function runCharacters(p: XmlElement): RunCharacter[] {
  const out: RunCharacter[] = [];
  const visit = (node: XmlElement) => {
    for (const each of elements(node)) {
      if (NOT_SHOWN.has(each.name)) continue;
      if (each.name !== "w:r") {
        visit(each);
        continue;
      }
      const rPr = child(each, "w:rPr");
      const format = (rPr ? elements(rPr) : [])
        .filter((property) => property.name !== "w:rPrChange")
        .map(writtenOut)
        .sort();
      for (const inner of elements(each)) {
        const text =
          inner.name === "w:t"
            ? inner.children.filter((piece): piece is string => typeof piece === "string").join("")
            : RUN_CHARACTERS[inner.name];
        for (const char of text ?? "") out.push({ char, format });
      }
    }
  };
  visit(p);
  return out;
}

/** The text of each footnote in footnotes.xml, by id, leaving out Word's separators. */
export function footnotesOf(xml: string): Record<string, string> {
  const footnotes: Record<string, string> = {};
  for (const match of xml.matchAll(/<w:footnote w:id="(\d+)">([\s\S]*?)<\/w:footnote>/g)) {
    footnotes[match[1] as string] = textOf(match[2] as string).trim();
  }
  return footnotes;
}

const childElements = (node: Node): Element[] => {
  const found: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) found.push(child as Element);
  }
  return found;
};

const named = (node: Node, name: string) =>
  childElements(node).find((each) => each.nodeName === name);

/** A paragraph's text with every change accepted: a footnote's mark as [*], a text box's left out. */
function acceptedText(paragraph: Element): string {
  let text = "";
  const visit = (node: Node) => {
    for (const child of childElements(node)) {
      const name = child.nodeName;
      if (["w:pPr", "w:rPr", "w:del", "w:moveFrom", "w:txbxContent", "mc:Fallback"].includes(name))
        continue;
      if (name === "w:t") text += child.textContent ?? "";
      else if (name === "w:tab") text += "\t";
      else if (name === "w:br") text += "\n";
      else if (name === "w:footnoteReference") text += "[*]";
      else visit(child);
    }
  };
  visit(paragraph);
  return text;
}

/**
 * The body's paragraphs as Word shows them with every tracked change
 * accepted (#107): insertions kept, deletions gone, a row deleted gone, and a
 * paragraph whose mark is deleted run into the next one in its cell or the
 * body. Table cells' paragraphs come in order, row by row. Walked with a
 * stack of its own: a table can nest thousands deep.
 */
export function acceptedParagraphs(documentXml: string): string[] {
  const document = new DOMParser().parseFromString(documentXml, "text/xml");
  const body = document.documentElement && named(document.documentElement, "w:body");
  const lines: string[] = [];
  let pending: { text: string; parent: Node | null } | null = null;
  const flush = () => {
    if (pending) lines.push(pending.text);
    pending = null;
  };
  const stack: Element[] = body ? childElements(body).reverse() : [];
  while (stack.length > 0) {
    const node = stack.pop() as Element;
    if (node.nodeName === "w:p") {
      if (pending && pending.parent !== node.parentNode) flush();
      const text: string = (pending?.text ?? "") + acceptedText(node);
      const mark = named(named(node, "w:pPr") ?? node, "w:rPr");
      const markDeleted = mark?.parentNode?.nodeName === "w:pPr" && named(mark, "w:del");
      pending = { text, parent: node.parentNode };
      if (!markDeleted) flush();
      continue;
    }
    if (node.nodeName === "w:tr") {
      const trPr = named(node, "w:trPr");
      if (trPr && named(trPr, "w:del")) continue;
    }
    if (["w:tbl", "w:tr", "w:tc", "w:sdt", "w:sdtContent", "w:customXml"].includes(node.nodeName)) {
      if (node.nodeName === "w:tbl") flush();
      stack.push(...childElements(node).reverse());
    }
  }
  flush();
  return lines;
}
