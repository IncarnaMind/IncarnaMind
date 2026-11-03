/**
 * A Word file's footnotes and endnotes written back into their parts (#746).
 * A note the Note's footnote holds is written again only when the User edited
 * its text: its own start tag and id stay, and each of its paragraphs is
 * written as the main document's are (./paragraph), word by word from what
 * the file has, so formatting the editor doesn't show stays. Every other note
 * is byte for byte the file's. A note whose mark is no longer in the Note goes
 * from its part; kept as the User's deletion when their edits are tracked, it
 * stays.
 */
import type { NodeJSON } from "../../../shared/blockJson";
import { readWordAtom } from "../../../shared/wordFiles";
import { FOOTNOTE_NODE, WORD_ATOM_NODE } from "../../api";
import {
  type NoteKind,
  type NoteParagraph,
  noteLead,
  type WordDocument,
  type WordNotesPart,
} from "../../documents/formats/docxImport";
import { child, elements, type XmlElement } from "../../documents/formats/xml";
import type { Inline, ReviewReading } from "../../mindText";
import { WRITER_NAMESPACES } from "../docx";
import { escapeXml, type WordIds } from "../wordml";
import type { Review } from "../wordReview";
import { type AtomPlan, copiedText, isFilesAtom } from "./atoms";
import {
  alignTokens,
  asCharacters,
  baseTokens,
  keptKindOf,
  lineBreak,
  type ParagraphContext,
  sourceOf,
  type Token,
  writeParagraph,
} from "./paragraph";
import {
  closeTag,
  endOf,
  openTag,
  parentsOf,
  rescoped,
  type Splice,
  scopeOf,
  sliceOf,
  startOf,
} from "./text";

export interface NotesPatchInput {
  base: WordDocument;
  current: readonly NodeJSON[];
  plan: AtomPlan;
  /** Whether a footnote of the Note was edited since it was imported. */
  edited(footnote: NodeJSON): boolean;
  /** A note's text now. */
  tokensOf(content: readonly NodeJSON[]): Token[];
  /** What the native writer writes inside a note: a Citation as its source. */
  special(inline: Inline): string;
  /** A new hyperlink's relationship, in the notes part. */
  link(kind: NoteKind, href: string): string;
  linkStyle: string | null;
  addLinkStyle(): string;
  ids: WordIds;
  review: Review;
  reading: ReviewReading | undefined;
}

/** A note's mark in the document, by its source: which part its note is in, and its id. */
function noteOf(base: WordDocument, source: string): { kind: NoteKind; id: string } | null {
  const element = base.places.get(source);
  const id = element?.attrs["w:id"];
  if (!element || id === undefined) return null;
  if (element.name === "w:footnoteReference") return { kind: "footnote", id };
  if (element.name === "w:endnoteReference") return { kind: "endnote", id };
  return null;
}

/** Every node in some Blocks that is a note's mark: a footnote, or a note kept as is. */
function noteMarks(blocks: readonly NodeJSON[], into: NodeJSON[] = []): NodeJSON[] {
  for (const node of blocks) {
    const kind = node.type === WORD_ATOM_NODE ? readWordAtom(node.attrs ?? {}).kind : null;
    if (node.type === FOOTNOTE_NODE || kind === "footnote" || kind === "endnote") into.push(node);
    else noteMarks(node.content ?? [], into);
  }
  return into;
}

/**
 * The changes to the footnotes part and the endnotes part. A note goes only
 * when none of the file's marks of it is written: a file can mark one note
 * twice, and the second mark is kept as is.
 */
export function notesSplices(input: NotesPatchInput): Record<NoteKind, Splice[]> {
  const { base, plan } = input;
  const splices: Record<NoteKind, Splice[]> = { footnote: [], endnote: [] };
  const done = new Set<string>();
  const gone = new Map<string, { kind: NoteKind; element: XmlElement }>();
  const kept = new Set<string>();
  for (const mark of noteMarks(base.structure.blocks)) {
    const source = sourceOf(mark);
    const note = source ? noteOf(base, source) : null;
    const element = note && base.notes[note.kind]?.notes.get(note.id)?.element;
    if (!source || !note || !element) continue;
    const key = `${note.kind}:${note.id}`;
    if (plan.written(source)) kept.add(key);
    else gone.set(key, { kind: note.kind, element });
  }
  for (const [key, { kind, element }] of gone) {
    if (kept.has(key)) continue;
    done.add(key);
    splices[kind].push({ from: startOf(element), to: endOf(element), text: "" });
  }
  for (const footnote of noteMarks(input.current)) {
    const source = sourceOf(footnote);
    if (footnote.type !== FOOTNOTE_NODE || !source) continue;
    // Only the mark the document is written with: a copy is a new note.
    if (!plan.writes(source, footnote, keptKindOf(footnote)) || !input.edited(footnote)) continue;
    const note = noteOf(base, source);
    const part = note ? base.notes[note.kind] : null;
    const found = note && part?.notes.get(note.id);
    if (!note || !part || !found?.paragraphs || done.has(`${note.kind}:${note.id}`)) continue;
    done.add(`${note.kind}:${note.id}`);
    splices[note.kind].push({
      from: startOf(found.element),
      to: endOf(found.element),
      text: noteXml(
        input,
        note.kind,
        part,
        found.element,
        found.paragraphs,
        footnote.content ?? [],
      ),
    });
  }
  return splices;
}

const parentsByPart = new WeakMap<WordNotesPart, Map<XmlElement, XmlElement>>();

/** The note's text with the space after its number it doesn't show, as the file has it. */
function withLead(current: readonly Token[], base: readonly Token[], lead: number): Token[] {
  const from = base.findIndex((token) => token.kind === "char");
  if (lead === 0 || from < 0) return [...current];
  const at = current.findIndex((token) => token.kind === "char");
  const tokens = [...current];
  tokens.splice(at < 0 ? tokens.length : at, 0, ...base.slice(from, from + lead));
  return tokens;
}

/**
 * A note written again: each paragraph from the one it was, the line breaks
 * where the file's paragraphs ended found by comparing the text as Proposals
 * compare it. A paragraph whose end the User removed joins the one before.
 */
function noteXml(
  input: NotesPatchInput,
  kind: NoteKind,
  part: WordNotesPart,
  note: XmlElement,
  paragraphs: readonly NoteParagraph[],
  content: readonly NodeJSON[],
): string {
  let parents = parentsByPart.get(part);
  if (!parents) {
    parents = parentsOf(part.root);
    parentsByPart.set(part, parents);
  }
  const bases = paragraphs.map((paragraph) =>
    baseTokens(paragraph.content, part.origins, input.reading),
  );
  const whole: Token[] = [];
  const ends: number[] = [];
  bases.forEach((tokens, index) => {
    if (index > 0) {
      ends.push(whole.length);
      whole.push(lineBreak());
    }
    whole.push(...tokens);
  });
  const own = new Set<string>();
  for (const paragraph of paragraphs) {
    for (const node of paragraph.content) {
      const source = sourceOf(node);
      if (source) own.add(source);
    }
  }
  // What is kept as is that the note didn't hold, from the text or another file's Note, is its text.
  const current = withLead(
    input.tokensOf(content).flatMap((token) => {
      const { node, source } = token;
      if (token.kind !== "atom" || !source || !node || (own.has(source) && isFilesAtom(node, part)))
        return [token];
      input.plan.copied(node);
      return asCharacters(token, copiedText(node));
    }),
    bases[0] ?? [],
    noteLead(paragraphs[0]?.content ?? []).length,
  );
  const starts = new Map<number, number>();
  for (const step of alignTokens(whole, current)) {
    if (step.step !== "equal") continue;
    const at = ends.indexOf(step.x);
    if (at >= 0) starts.set(step.y, at + 1);
  }
  const lines = new Map<number, Token[]>([[0, []]]);
  let line = lines.get(0) as Token[];
  current.forEach((token, index) => {
    const next = starts.get(index);
    if (next === undefined) line.push(token);
    else {
      line = [];
      lines.set(next, line);
    }
  });

  const context = (element: XmlElement): ParagraphContext => {
    const scope = scopeOf(element, parents);
    return {
      text: part.text,
      parents,
      places: part.places,
      special: (inline) => rescoped(input.special(inline), WRITER_NAMESPACES, scope),
      hrefOf: part.hrefOf,
      newLink: (href) =>
        href.startsWith("#")
          ? `<w:hyperlink w:anchor="${escapeXml(href.slice(1))}" w:history="1">`
          : `<w:hyperlink r:id="${input.link(kind, href)}" w:history="1">`,
      linkStyle: input.linkStyle,
      addLinkStyle: input.addLinkStyle,
      ids: input.ids,
      review: input.review,
      removedHere: () => true,
      // The note's text has only the editor's marks: its colour, font and size stay the file's.
      lookCurrent: false,
    };
  };
  let xml = "";
  for (const element of elements(note)) {
    const index = paragraphs.findIndex((paragraph) => paragraph.element === element);
    if (index < 0) {
      xml += sliceOf(part.text, element);
      continue;
    }
    const tokens = lines.get(index);
    if (!tokens) continue;
    const pPr = child(element, "w:pPr");
    xml += writeParagraph(
      {
        base: { element, tokens: bases[index] ?? [] },
        current: tokens,
        pPr: pPr ? sliceOf(part.text, pPr) : "",
        pPrChanged: false,
        fallbackRun: "",
        scope: scopeOf(element, parents),
        track: true,
      },
      context(element),
    ).xml;
  }
  return `${openTag(part.text, note)}${xml}${closeTag(note)}`;
}
