/**
 * Copying Blocks with their Citations (#102): a copy's Citations as footnotes. The HTML keeps
 * each Citation as it was, so it pastes back into IncarnaMind as a Citation, and shows it as
 * Word writes a footnote: a numbered marker in the text and a footnote list after it. Word
 * pastes those as footnotes; where footnotes can't be pasted, they read as numbered markers with
 * a list of Sources. The plain text has the same markers and a Sources list. A source and place
 * cited again takes the first note's number and has no note of its own (#1552), as in a Word
 * export.
 */
import { getTextBetween, getTextSerializersFromSchema, type TextSerializer } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import {
  BLOCK_ID_ATTRIBUTE,
  CHART_NODE,
  CITATION_NODE,
  type CitationAttributes,
  FOOTNOTE_NODE,
  PROPOSAL_ATTRIBUTE,
} from "../../../core/api";
import { readChart } from "../../../shared/charts";
import { citationSubject } from "../../../shared/citations";
import { FootnoteNumbering } from "../../../shared/footnoteNumbers";
import { translate } from "../../../shared/i18n";
import { readProposalAttribute } from "../../../shared/proposals";
import { type SourceContext, sourceText } from "../../../shared/sources";
import { tableText } from "./tableText";

type Cited = Partial<CitationAttributes>;

/** The list the footnotes are kept in; pasting it back into a Mind skips it (see `Citation`). */
export const NOTES_ATTRIBUTE = "data-citation-notes";

/** The Citations in a fragment that take a number, top to bottom: not those in a footnote the User wrote. */
export function citationsIn(fragment: Fragment): Cited[] {
  const found: Cited[] = [];
  fragment.descendants((node) => {
    if (node.type.name === FOOTNOTE_NODE) return false;
    if (node.type.name === CITATION_NODE) found.push(node.attrs as Cited);
    return true;
  });
  return found;
}

/**
 * The number of each Citation's note: a source and place cited again has the first one's, and a
 * Citation a change still waiting adds or removes is a note of its own (#107), as every surface
 * numbers it (#2292).
 */
export function noteNumbers(citations: readonly Cited[], context: SourceContext): number[] {
  const numbering = new FootnoteNumbering();
  return citations.map((citation) => {
    const pending =
      readProposalAttribute((citation as Record<string, unknown>)[PROPOSAL_ATTRIBUTE]) !== null;
    return pending
      ? numbering.footnote()
      : numbering.citation(citationSubject(citation, context)).number;
  });
}

/** What marks the visible "[n]" to other apps, as comments until `wordFootnoteHtml` writes Word's own. */
const FALLBACK_START = "[if !supportFootnotes]";
const FALLBACK_END = "[endif]";

/**
 * A marker and what it points at, as Word's clipboard names a footnote's two ends. Word reads the
 * span `mso-special-character:footnote` as the footnote's own number, which it keeps up to date;
 * the "[n]" inside the conditional block is for every app that isn't Word.
 */
function marker(document: Document, number: number, end: "reference" | "note"): HTMLElement {
  const anchor = document.createElement("a");
  anchor.setAttribute("style", `mso-footnote-id:ftn${number}`);
  anchor.setAttribute("href", end === "reference" ? `#_ftn${number}` : `#_ftnref${number}`);
  anchor.setAttribute("name", end === "reference" ? `_ftnref${number}` : `_ftn${number}`);
  anchor.setAttribute("title", "");
  const mark = document.createElement(end === "reference" ? "sup" : "span");
  mark.setAttribute("class", "MsoFootnoteReference");
  const automatic = document.createElement("span");
  automatic.setAttribute("style", "mso-special-character:footnote");
  const visible = document.createElement("span");
  visible.setAttribute("class", "MsoFootnoteReference");
  visible.textContent = `[${number}]`;
  automatic.append(
    document.createComment(FALLBACK_START),
    visible,
    document.createComment(FALLBACK_END),
  );
  mark.append(automatic);
  anchor.append(mark);
  return anchor;
}

/**
 * Clipboard HTML with the fallback markers written as Word's conditional blocks,
 * `<![if !supportFootnotes]>…<![endif]>`, which Word skips and every other app shows. A DOM
 * serializer can only write them as comments, so this runs on the HTML string.
 */
export const wordFootnoteHtml = (html: string): string =>
  html
    .replaceAll(`<!--${FALLBACK_START}-->`, `<!${FALLBACK_START}>`)
    .replaceAll(`<!--${FALLBACK_END}-->`, `<!${FALLBACK_END}>`);

/** Not a footnote of its own, so Word can't number it: the first note's number, linked to it. */
function repeatMarker(document: Document, number: number): HTMLElement {
  const mark = document.createElement("sup");
  mark.setAttribute("class", "MsoFootnoteReference");
  const anchor = document.createElement("a");
  anchor.setAttribute("href", `#_ftn${number}`);
  anchor.append(
    document.createComment(FALLBACK_START),
    document.createTextNode("["),
    document.createComment(FALLBACK_END),
    document.createTextNode(String(number)),
    document.createComment(FALLBACK_START),
    document.createTextNode("]"),
    document.createComment(FALLBACK_END),
  );
  mark.append(anchor);
  return mark;
}

/** A footnote's text, its address a link when it has one. */
function noteText(document: Document, text: string, link: string | null): Node[] {
  const at = link === null ? -1 : text.indexOf(link);
  if (link === null || at < 0) return [document.createTextNode(text)];
  const a = document.createElement("a");
  a.setAttribute("href", link);
  a.textContent = link;
  return [
    document.createTextNode(text.slice(0, at)),
    a,
    document.createTextNode(text.slice(at + link.length)),
  ];
}

/**
 * Turns the Citations in serialized HTML into numbered footnote markers and adds the footnote
 * list after it. Each Citation keeps its own element and its data, so it pastes back as one.
 * `citations` are the fragment's own, in the same order as the elements.
 */
export function addFootnotes(
  root: ParentNode,
  citations: readonly Cited[],
  context: SourceContext,
): void {
  const spans = [
    ...root.querySelectorAll<HTMLElement>(`span[data-type="${CITATION_NODE}"]`),
  ].filter((span) => !span.closest(`[data-type="${FOOTNOTE_NODE}"]`));
  if (spans.length === 0 || spans.length !== citations.length) return;
  const document = spans[0]?.ownerDocument ?? window.document;
  const list = document.createElement("div");
  list.setAttribute("style", "mso-element:footnote-list");
  list.setAttribute(NOTES_ATTRIBUTE, "");
  const numbers = noteNumbers(citations, context);
  let listed = 0;
  spans.forEach((span, index) => {
    const number = numbers[index];
    if (number === undefined) return;
    if (number <= listed) {
      span.replaceChildren(repeatMarker(document, number));
      return;
    }
    listed = number;
    const citation = citations[index] ?? {};
    span.replaceChildren(marker(document, number, "reference"));
    const { text, link } = sourceText(citation, context);
    const note = document.createElement("div");
    note.setAttribute("style", "mso-element:footnote");
    note.setAttribute("id", `ftn${number}`);
    const paragraph = document.createElement("p");
    paragraph.setAttribute("class", "MsoFootnoteText");
    paragraph.append(marker(document, number, "note"), " ", ...noteText(document, text, link));
    note.append(paragraph);
    list.append(note);
  });
  root.append(list);
}

const TABLE_NODE = "table";
const TABLE_ROW_NODE = "tableRow";

function tablesIn(fragment: Fragment): Set<unknown> {
  const ids = new Set<unknown>();
  fragment.descendants((node) => {
    if (node.type.name === TABLE_NODE) ids.add(node.attrs[BLOCK_ID_ATTRIBUTE]);
    return true;
  });
  return ids;
}

/** A chart of a table in the copy would write the table's values a second time. */
function withoutChartsOf(fragment: Fragment, tables: Set<unknown>): Fragment {
  const kept: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    const { source } = node.type.name === CHART_NODE ? readChart(node.attrs) : { source: null };
    if (source?.kind !== "table" || !source.blockId || !tables.has(source.blockId)) kept.push(node);
  });
  return Fragment.fromArray(kept);
}

/** prosemirror-tables copies selected cells as their rows, without the table around them. */
function withRowsAsTable(fragment: Fragment, schema: Schema): Fragment {
  const table = schema.nodes[TABLE_NODE];
  return table && fragment.firstChild?.type.name === TABLE_ROW_NODE
    ? Fragment.from(table.create(null, fragment))
    : fragment;
}

/** "" when the copy holds no table and no Citation, so the editor's own text stands. */
export function copiedText(copy: Fragment, schema: Schema, context: SourceContext): string {
  const fragment = withRowsAsTable(copy, schema);
  const citations = citationsIn(fragment);
  const tables = tablesIn(fragment);
  if (citations.length === 0 && tables.size === 0) return "";
  const numbers = noteNumbers(citations, context);
  let next = 0;
  const textSerializers: Record<string, TextSerializer> = {
    ...getTextSerializersFromSchema(schema),
    [CITATION_NODE]: () => `[${numbers[next++]}]`,
  };
  textSerializers[TABLE_NODE] = ({ node }) => tableText(node, textSerializers);
  const copied = schema.topNodeType.create(null, withoutChartsOf(fragment, tables));
  // Not `trim()`: a table's last cell may be empty, and its row ends in a tab.
  const body = getTextBetween(
    copied,
    { from: 0, to: copied.content.size },
    { textSerializers },
  ).replace(/^\n+|\n+$/g, "");
  if (citations.length === 0) return body;
  let highest = 0;
  const sources = citations
    .flatMap((citation, index) => {
      const number = numbers[index];
      if (number !== highest + 1) return [];
      highest = number;
      return [`[${number}] ${sourceText(citation, context).text}`];
    })
    .join("\n");
  return `${body}\n\n${translate(context.language, "citedSource.title")}\n${sources}`;
}
