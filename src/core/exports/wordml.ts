/**
 * Pieces of WordprocessingML (the XML inside a .docx) that every Word writer
 * shares: text runs, escaping, footnotes (which Citations become), tracked
 * insertions and deletions, comments, and the ids they are numbered with. A
 * Mind exported as a new .docx (./docx) is written with them, so a Citation
 * is the same footnote, and a change the same tracked change, whichever
 * writer made it.
 *
 * Each piece is a string of XML in the `w:` namespace, which the part it goes
 * into declares. Dates are ISO 8601 in UTC, as `Date.toISOString` gives them.
 */

/** WordprocessingML's namespace (`w:`), and the relationships' (`r:`). */
export const W_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ---------------------------------------------------------------------------
// Text

/** Characters XML can't hold at all, even escaped. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it removes.
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Text for XML, in an element or a quoted attribute: escaped, and without what XML can't hold. */
export function escapeXml(text: string): string {
  return text
    .replace(NOT_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface RunFormat {
  /** A character style, e.g. "Hyperlink". */
  style?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  /** Word's yellow text highlight, as the editor's. */
  highlight?: boolean;
  underline?: boolean;
  /** Monospaced, for code inside a link (code elsewhere uses its character style). */
  monospace?: boolean;
  smallCaps?: boolean;
  /** Raised or lowered, as a citation style may write a number or a formula. */
  script?: "superscript" | "subscript";
  /** A font by name, for every script. */
  font?: string;
  /** In points. */
  size?: number;
  /** Hex "RRGGBB". */
  color?: string;
}

export const fontsXml = (font: string) => {
  const name = escapeXml(font);
  return `<w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:eastAsia="${name}" w:cs="${name}"/>`;
};

/** Word keeps sizes in half points. */
export const halfPoints = (points: number) => Math.round(points * 2);

const sizeXml = (points: number) =>
  `<w:sz w:val="${halfPoints(points)}"/><w:szCs w:val="${halfPoints(points)}"/>`;

/**
 * A run of text in a format: tabs and line breaks become Word's. Empty text
 * is no run at all.
 */
export function run(text: string, format: RunFormat = {}): string {
  return runOf(text, format, "w:t");
}

/** A run of deleted text, for a tracked deletion (`deletion`): Word keeps it in `w:delText`. */
export function deletedRun(text: string, format: RunFormat = {}): string {
  return runOf(text, format, "w:delText");
}

function runOf(text: string, format: RunFormat, textElement: "w:t" | "w:delText"): string {
  if (!text) return "";
  // In the order the schema requires.
  const rPr = [
    format.style ? `<w:rStyle w:val="${escapeXml(format.style)}"/>` : "",
    format.monospace
      ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>'
      : format.font
        ? fontsXml(format.font)
        : "",
    format.bold ? "<w:b/>" : "",
    format.italic ? "<w:i/>" : "",
    format.smallCaps ? "<w:smallCaps/>" : "",
    format.strike ? "<w:strike/>" : "",
    format.color ? `<w:color w:val="${escapeXml(format.color)}"/>` : "",
    format.size ? sizeXml(format.size) : "",
    format.highlight ? '<w:highlight w:val="yellow"/>' : "",
    format.underline ? '<w:u w:val="single"/>' : "",
    format.script ? `<w:vertAlign w:val="${format.script}"/>` : "",
  ].join("");
  let content = "";
  for (const part of text.split(/(\r\n|\r|\n|\t)/)) {
    if (part === "\t") content += "<w:tab/>";
    else if (part === "\n" || part === "\r\n" || part === "\r") content += "<w:br/>";
    else if (part) {
      content += `<${textElement} xml:space="preserve">${escapeXml(part)}</${textElement}>`;
    }
  }
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}${content}</w:r>`;
}

// ---------------------------------------------------------------------------
// Footnotes

/**
 * The ids of Word's footnote styles in a document: these, in a new one; an
 * imported document may name them otherwise (in Chinese Word, "aff1"…).
 */
export interface FootnoteStyles {
  text: string;
  reference: string;
}

const FOOTNOTE_STYLES: FootnoteStyles = { text: "FootnoteText", reference: "FootnoteReference" };

/** Where a footnote is referred to in the text: its number, in the footnote reference style. */
export function footnoteReference(id: number, style = FOOTNOTE_STYLES.reference): string {
  return `<w:r><w:rPr><w:rStyle w:val="${escapeXml(style)}"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
}

/**
 * A footnote, for the footnotes part: one paragraph in the footnote text
 * style, its number, then `runs`.
 */
export function footnote(id: number, runs: string, styles = FOOTNOTE_STYLES): string {
  return `<w:footnote w:id="${id}"><w:p><w:pPr><w:pStyle w:val="${escapeXml(styles.text)}"/></w:pPr><w:r><w:rPr><w:rStyle w:val="${escapeXml(styles.reference)}"/></w:rPr><w:footnoteRef/></w:r>${runs}</w:p></w:footnote>`;
}

// ---------------------------------------------------------------------------
// Cross-references

/** Named as Word names its own hidden bookmarks: "_Ref" and nine digits. */
export const noteBookmark = (id: number): string => `_Ref${900_000_000 + id}`;

export function bookmarked(id: number, name: string, xml: string): string {
  return `<w:bookmarkStart w:id="${id}" w:name="${escapeXml(name)}"/>${xml}<w:bookmarkEnd w:id="${id}"/>`;
}

/**
 * Word's own cross-reference to a footnote (Insert › Cross-reference › Footnote number, formatted):
 * the number of the footnote that the bookmark `name` encloses the mark of, in the footnote
 * reference style, which Word keeps up to date. `shown` is the number until it is updated, as
 * XML text already: digits, or the writer's own mark for them.
 */
export function noteNumber(name: string, shown: string, style = FOOTNOTE_STYLES.reference): string {
  const mark = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
  return (
    mark("begin") +
    `<w:r><w:instrText xml:space="preserve"> NOTEREF ${escapeXml(name)} \\f \\h </w:instrText></w:r>` +
    mark("separate") +
    `<w:r><w:rPr><w:rStyle w:val="${escapeXml(style)}"/></w:rPr><w:t>${shown}</w:t></w:r>` +
    mark("end")
  );
}

/**
 * The footnotes part (word/footnotes.xml): the separator lines Word draws
 * above the footnotes, as footnotes -1 and 0 (which the settings name), then
 * the footnotes, numbered from 1.
 */
export function footnotesPart(footnotes: readonly string[]): string {
  const separator = (type: string, id: number, mark: string) =>
    `<w:footnote w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><${mark}/></w:r></w:p></w:footnote>`;
  return (
    `${XML_DECLARATION}<w:footnotes xmlns:w="${W_NAMESPACE}" xmlns:r="${R_NAMESPACE}">` +
    separator("separator", -1, "w:separator") +
    separator("continuationSeparator", 0, "w:continuationSeparator") +
    footnotes.join("") +
    "</w:footnotes>"
  );
}

// ---------------------------------------------------------------------------
// Tracked changes

/** A change's date, to the second, as Word writes it; nothing if it has none. */
export const dateAttribute = (date: string | null): string =>
  date ? ` w:date="${escapeXml(date.slice(0, 19))}Z"` : "";

/**
 * Runs inserted as a tracked change, by `author` at `date`: Word shows them
 * as an insertion to accept or reject. `runs` are made with `run`.
 */
export function insertion(id: number, author: string, date: string | null, runs: string): string {
  return `<w:ins w:id="${id}" w:author="${escapeXml(author)}"${dateAttribute(date)}>${runs}</w:ins>`;
}

/**
 * Runs deleted as a tracked change, by `author` at `date`: Word shows them
 * struck through until the deletion is accepted or rejected. `runs` are made
 * with `deletedRun`.
 */
export function deletion(id: number, author: string, date: string | null, runs: string): string {
  return `<w:del w:id="${id}" w:author="${escapeXml(author)}"${dateAttribute(date)}>${runs}</w:del>`;
}

// ---------------------------------------------------------------------------
// Comments

/** How a package names its comments part: by this relationship from the document, and this content type. */
export const COMMENTS_RELATIONSHIP = `${R_NAMESPACE}/comments`;
export const COMMENTS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";

/**
 * The ids of Word's comment styles in a document: these, in a new one; an
 * imported document may name them otherwise.
 */
export interface CommentStyles {
  text: string;
  reference: string;
}

const COMMENT_STYLES: CommentStyles = { text: "CommentText", reference: "CommentReference" };

/** Where the range the comment `id` covers starts. */
export function commentStart(id: number): string {
  return `<w:commentRangeStart w:id="${id}"/>`;
}

/** Where the range the comment `id` covers ends, and the comment's mark after it. */
export function commentEnd(id: number, reference = COMMENT_STYLES.reference): string {
  return `<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="${escapeXml(reference)}"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`;
}

/**
 * Content with the comment `id` on it, in the text: the range it covers, and
 * the comment's mark after it, in the CommentReference style.
 */
export function commented(id: number, content: string, reference?: string): string {
  return `${commentStart(id)}${content}${commentEnd(id, reference)}`;
}

/**
 * A comment, for the comments part: by `author` at `date`, its text a
 * paragraph a line, in the CommentText style.
 */
export function comment(
  id: number,
  author: string,
  date: string | null,
  text: string,
  styles = COMMENT_STYLES,
): string {
  const mark = `<w:r><w:rPr><w:rStyle w:val="${escapeXml(styles.reference)}"/></w:rPr><w:annotationRef/></w:r>`;
  const paragraphs = text
    .split(/\r\n|\r|\n/)
    .map(
      (line, index) =>
        `<w:p><w:pPr><w:pStyle w:val="${escapeXml(styles.text)}"/></w:pPr>${index === 0 ? mark : ""}${run(line)}</w:p>`,
    );
  return `<w:comment w:id="${id}" w:author="${escapeXml(author)}"${dateAttribute(date)}>${paragraphs.join("")}</w:comment>`;
}

/** The comments part (word/comments.xml). */
export function commentsPart(comments: readonly string[]): string {
  return `${XML_DECLARATION}<w:comments xmlns:w="${W_NAMESPACE}" xmlns:r="${R_NAMESPACE}">${comments.join("")}</w:comments>`;
}

// ---------------------------------------------------------------------------
// Ids

/**
 * The highest id Word takes: it reads ids as 32-bit signed numbers, and
 * repairs a file with one at or above 0x80000000, or with an id used twice.
 */
export const MAX_ID = 0x7fffffff;

/**
 * What an id numbers. Footnotes, with their references; annotations, which
 * share one set of ids here: tracked insertions and deletions, comments with
 * their ranges, and bookmarks; and drawings (`wp:docPr`).
 */
export type IdKind = "footnote" | "annotation" | "drawing";

/** The first id of each kind: footnotes -1 and 0 are the separators. */
const FIRST: Readonly<Record<IdKind, number>> = { footnote: 1, annotation: 0, drawing: 1 };

/**
 * The ids of one Word document: each one handed out is the lowest free id
 * of its kind, so unique within it, and below 0x80000000. Ids a document
 * already has are reserved first, so writing into it leaves its own as they are.
 */
export class WordIds {
  private readonly used: Record<IdKind, Set<number>> = {
    footnote: new Set(),
    annotation: new Set(),
    drawing: new Set(),
  };
  private readonly next = { ...FIRST };

  /** An id the document has already: it isn't handed out. */
  reserve(kind: IdKind, id: number): void {
    this.used[kind].add(id);
  }

  /** A new id of the kind. Throws if none is left below 0x80000000. */
  take(kind: IdKind): number {
    let id = this.next[kind];
    while (this.used[kind].has(id)) id++;
    if (id > MAX_ID) throw new Error(`No ${kind} ids are left below 0x80000000.`);
    this.used[kind].add(id);
    this.next[kind] = id + 1;
    return id;
  }
}
