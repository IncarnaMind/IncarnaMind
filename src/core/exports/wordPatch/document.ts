/**
 * The main document part written back into (#105). Its paragraphs, tables
 * and kept-as-is Blocks are matched with the Mind's by where each came from;
 * those the Mind kept in order stay where they are, byte for byte unless
 * edited, those it deleted go, and what is new or moved is written after the
 * one before it. A table keeps its rows and cells and is written into cell by
 * cell, unless rows or columns were added, removed or merged: then it is
 * written again, each row and cell from the one it was, with its properties.
 *
 * For review (#107), what changes still waiting add or remove as a whole goes
 * in as IncarnaMind's tracked change. When the User's edits are tracked, what
 * they deleted stays where it was, as their deletion, and what they added or
 * moved goes in as their insertion; a table's rows likewise, and a
 * paragraph's properties they changed with what they were (`w:pPrChange`).
 * Someone's changes from the file still waiting stay as they were there
 * (#108); one the User accepted or rejected leaves no trace.
 */
import type { NodeJSON } from "../../../shared/blockJson";
import { readParagraphFormat } from "../../../shared/paragraphFormat";
import { readWordAtom, wordAtomText } from "../../../shared/wordFiles";
import {
  PARAGRAPH_FORMAT_ATTRIBUTE,
  type ParagraphFormat,
  WORD_ATOM_NODE,
  type WordExportLoss,
} from "../../api";
import type { WordDocument } from "../../documents/formats/docxImport";
import type { Relationship } from "../../documents/formats/docxPackage";
import { child, elements, walk, type XmlElement } from "../../documents/formats/xml";
import {
  type Block,
  isWordChange,
  madeBy,
  type Pendings,
  NO_MARKS as PLAIN,
  type ReviewReading,
  samePendings,
  type TableCell,
  tableLayout,
} from "../../mindText";
import { type DocxWriter, piecesOf, WRITER_NAMESPACES } from "../docx";
import { changedElement, formatChanges } from "../paragraphFormat";
import { dateAttribute, escapeXml, type WordIds } from "../wordml";
import {
  type Authorship,
  type Piece,
  type Review,
  type Tracking,
  trackBlocks,
} from "../wordReview";
import { type AtomPlan, copiedText } from "./atoms";
import { type Counterpart, counterpartsOf, type ListPlace } from "./mind";
import {
  alignTokens,
  asCharacters,
  baseTokens,
  keptKindOf,
  type ParagraphContext,
  sourceOf,
  special,
  type Token,
  withWordChanges,
  writeParagraph,
} from "./paragraph";
import type { DocumentStyles, PatchTarget } from "./parts";
import { Properties, withoutFormatChange } from "./properties";
import {
  appendInside,
  applySplices,
  closeTag,
  endOf,
  type Namespaces,
  openTag,
  parentsOf,
  rescoped,
  type Splice,
  scopeOf,
  selfClosing,
  sliceOf,
  startOf,
} from "./text";

export interface DocumentPatchInput {
  base: WordDocument;
  /** The Mind's Blocks, as JSON. */
  current: readonly NodeJSON[];
  /** Where a node of the Mind came from in the document, if it did. */
  currentKey(node: NodeJSON): string | null;
  /** Whether a node imported from the document was edited since. */
  edited(node: NodeJSON): boolean;
  /** A paragraph's text now, Citations written in the Mind's style. */
  tokensOf(node: NodeJSON): Token[];
  /** What the native writer writes for a Block the document didn't have. */
  blocksOf(node: NodeJSON): Block[];
  /** The bookmark a table of contents links to, for a heading: none for other Blocks. */
  bookmarkOf(node: NodeJSON): { id: number; name: string } | null;
  writer: DocxWriter;
  target: PatchTarget;
  styles: DocumentStyles;
  /** The main part's relationships. */
  relationships: ReadonlyMap<string, Relationship>;
  plan: AtomPlan;
  /** The Bibliography a citation style adds, at the end of the document. */
  bibliography: readonly Block[];
  /** Changes still waiting, as the Mind was read for review (#107). */
  reading: ReviewReading | undefined;
  /** IncarnaMind's tracked changes and comments, and the User's tracked edits. */
  review: Review;
  ids: WordIds;
  /**
   * Whether this version read the Mind's Word look. Until it reads it again, the Mind lacks
   * the file's direct formatting, which is then kept as the file has it rather than removed.
   */
  lookCurrent: boolean;
}

/** A counterpart as imported, and the element its XML is. */
interface Based {
  counterpart: Counterpart;
  element: XmlElement;
}

/** Where new paragraphs take their properties and their text's formatting from. */
interface Reference {
  pPr: string;
  rPr: string;
  format: ParagraphFormat;
}

const formatOf = (node: NodeJSON): ParagraphFormat =>
  readParagraphFormat(node.attrs?.[PARAGRAPH_FORMAT_ATTRIBUTE]);

function writeFormat(properties: Properties, now: ParagraphFormat, before: ParagraphFormat): void {
  const changes = formatChanges(now, before);
  for (const [name, attributes] of [
    ["w:spacing", changes.spacing],
    ["w:ind", changes.ind],
  ] as const) {
    if (Object.keys(attributes).length === 0) continue;
    const element = changedElement(name, properties.get(name), attributes);
    if (element) properties.set(name, element);
    else properties.remove(name);
  }
  if (changes.jc === null) properties.remove("w:jc");
  else if (changes.jc) properties.set("w:jc", `<w:jc w:val="${changes.jc}"/>`);
}

/** CT_TcPr's children, in order. */
const CELL_ORDER = [
  "w:cnfStyle",
  "w:tcW",
  "w:gridSpan",
  "w:hMerge",
  "w:vMerge",
  "w:tcBorders",
  "w:shd",
  "w:noWrap",
  "w:tcMar",
  "w:textDirection",
  "w:tcFitText",
  "w:vAlign",
  "w:hideMark",
  "w:headers",
  "w:cellIns",
  "w:cellDel",
  "w:cellMerge",
  "w:tcPrChange",
];

const isTable = (element: XmlElement | null | undefined) => element?.name === "w:tbl";

/** The next `<w:pPr>` opening tag, not a `<w:pPrChange>` inside one. */
function nextParagraphProperties(xml: string, from: number): number {
  let at = from;
  while (at < xml.length) {
    const found = xml.indexOf("<w:pPr", at);
    if (found === -1) return -1;
    const next = xml[found + 6];
    if (
      next === ">" ||
      next === "/" ||
      next === " " ||
      next === "\n" ||
      next === "\t" ||
      next === "\r"
    )
      return found;
    at = found + 6;
  }
  return -1;
}

/** Whether the tag starting at `at` closes itself, as an empty element can. */
function closesItself(xml: string, at: number): boolean {
  const end = xml.indexOf(">", at);
  return end !== -1 && xml[end - 1] === "/";
}

/**
 * Writes a bookmark into a paragraph after its properties, so Word's schema
 * order holds even when a tracked formatting change nests another `pPr`
 * inside them. A bookmark taken for the paragraph's only content, before
 * its properties, is invalid and breaks the file.
 */
export function bookmarkParagraph(xml: string, bookmark: { id: number; name: string }): string {
  const open = xml.indexOf(">") + 1;
  const close = xml.lastIndexOf("</w:p>");
  if (open <= 0 || close === -1) return xml;
  let insertAt = open;
  const exact = xml.startsWith("<w:pPr", open) && /[\s>/]/.test(xml[open + 6] ?? "");
  if (exact && closesItself(xml, open)) {
    insertAt = xml.indexOf(">", open) + 1;
  } else if (exact) {
    const tagEnd = xml.indexOf(">", open) + 1;
    let depth = 1;
    let at = tagEnd;
    while (at < xml.length) {
      const nextOpen = nextParagraphProperties(xml, at);
      const nextClose = xml.indexOf("</w:pPr>", at);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        if (closesItself(xml, nextOpen)) {
          at = xml.indexOf(">", nextOpen) + 1;
          continue;
        }
        depth++;
        at = nextOpen + 6;
      } else {
        at = nextClose + 8;
        depth--;
        if (depth === 0) {
          insertAt = at;
          break;
        }
      }
    }
  }
  return `${xml.slice(0, insertAt)}<w:bookmarkStart w:id="${bookmark.id}" w:name="${bookmark.name}"/>${xml.slice(insertAt, close)}<w:bookmarkEnd w:id="${bookmark.id}"/>${xml.slice(close)}`;
}

export class DocumentPatch {
  private readonly text: string;
  private readonly parents: Map<XmlElement, XmlElement>;
  private readonly based = new Map<string, Based>();
  private readonly baseKey: (node: NodeJSON) => string | null;
  /** Someone's changes in the file as imported (#108), which are never out of date there. */
  private readonly baseReading: ReviewReading;
  readonly losses: WordExportLoss[] = [];
  /** The numId each list of the Mind is written with, once it has one. */
  private readonly lists = new Map<NodeJSON, number>();
  /** Each list of the Mind's items, in order. */
  private readonly listItems = new Map<NodeJSON, Counterpart[]>();
  private readonly context: ParagraphContext;
  /** Paragraphs and tables holding something kept as is that is no longer written there. */
  private readonly forced = new Set<XmlElement>();

  constructor(private readonly input: DocumentPatchInput) {
    const { base } = input;
    this.text = base.text;
    this.parents = parentsOf(base.root);
    const ids = new Map<string, string>();
    for (const [id, source] of base.structure.sources) ids.set(id, source.n);
    this.baseKey = (node) => {
      const id = node.attrs?.id;
      return typeof id === "string" ? (ids.get(id) ?? null) : null;
    };
    this.baseReading = {
      skips: () => false,
      made: (request) => madeBy(base.structure.changes.get(request) ?? null),
    };
    this.collect(
      this.baseOf(base.structure.blocks),
      this.baseKey,
      (counterpart) => {
        const element = counterpart.key ? base.places.get(counterpart.key) : undefined;
        if (counterpart.key && element) this.based.set(counterpart.key, { counterpart, element });
      },
      this.baseReading,
    );
    this.collect(
      counterpartsOf(input.current, input.currentKey, input.reading),
      input.currentKey,
      (counterpart) => {
        this.forceForComments(counterpart);
        if (!counterpart.list) return;
        this.listItems.set(counterpart.list.list, [
          ...(this.listItems.get(counterpart.list.list) ?? []),
          counterpart,
        ]);
      },
      input.reading,
    );
    for (const { counterpart, element } of this.based.values()) {
      if (counterpart.kind !== "paragraph") continue;
      const unwritten = (counterpart.node.content ?? []).some((node) => {
        const source = sourceOf(node);
        const at = source ? base.places.get(source) : undefined;
        return (
          source !== null &&
          at !== undefined &&
          this.contains(element, at) &&
          !input.plan.written(source)
        );
      });
      if (!unwritten) continue;
      for (let at: XmlElement | undefined = element; at; at = this.parents.get(at))
        this.forced.add(at);
    }
    const { writer, styles } = input;
    this.context = {
      text: this.text,
      parents: this.parents,
      places: base.places,
      special: (inline) => writer.inlineXml([inline]),
      hrefOf: (hyperlink) => this.hrefOf(hyperlink),
      newLink: (href) =>
        href.startsWith("#")
          ? `<w:hyperlink w:anchor="${escapeXml(href.slice(1))}" w:history="1">`
          : `<w:hyperlink r:id="${input.target.link(href, false)}" w:history="1">`,
      linkStyle: styles.find("character", "Hyperlink"),
      addLinkStyle: () => styles.id("hyperlink"),
      ids: input.ids,
      review: input.review,
      removedHere: (source) => !input.plan.writtenElsewhere(source),
      lookCurrent: input.lookCurrent,
    };
  }

  /** Copied as it was, a paragraph has no runs a comment's range could start and end in. */
  private forceForComments(counterpart: Counterpart): void {
    const based = counterpart.key ? this.based.get(counterpart.key) : undefined;
    if (
      !based ||
      counterpart.kind !== "paragraph" ||
      !this.input.review.choices.commentFailedChecks ||
      !this.input.tokensOf(counterpart.node).some((token) => token.sentence)
    ) {
      return;
    }
    for (let at: XmlElement | undefined = based.element; at; at = this.parents.get(at))
      this.forced.add(at);
  }

  /** The Mind's counterparts in some of its Blocks, read for review. */
  private currentOf(blocks: readonly NodeJSON[]): Counterpart[] {
    return counterpartsOf(blocks, this.input.currentKey, this.input.reading);
  }

  /** The counterparts in some of the Blocks as imported, with someone's changes in the file. */
  private baseOf(blocks: readonly NodeJSON[]): Counterpart[] {
    return counterpartsOf(blocks, this.baseKey, this.baseReading);
  }

  /**
   * A counterpart's XML with the tracked changes made to it as a whole:
   * what changes still waiting do to it, but someone's it had in the file,
   * which its XML keeps; and, when `added` (it is new, or moved here) and the
   * User's edits are tracked, their insertion.
   */
  private tracked(xml: string, counterpart: Counterpart, added: boolean): string {
    const { review, ids } = this.input;
    const based = counterpart.key ? this.based.get(counterpart.key) : undefined;
    const was = based?.counterpart.pending ?? {};
    const inserted =
      counterpart.pending.inserted?.id === was.inserted?.id
        ? undefined
        : counterpart.pending.inserted;
    const deleted =
      counterpart.pending.deleted?.id === was.deleted?.id ? undefined : counterpart.pending.deleted;
    let out = xml;
    if (deleted) out = trackBlocks(out, review.pending("delete", deleted), ids);
    if (inserted) out = trackBlocks(out, review.pending("insert", inserted), ids);
    const user = review.user("insert");
    if (added && user && !counterpart.pending.inserted) out = trackBlocks(out, user, ids);
    return out;
  }

  /**
   * What the User deleted, kept where it was as their deletion when their
   * edits are tracked: without what the Mind writes elsewhere (a field moved
   * with its paragraph), which can't be in the file twice.
   */
  private removed(based: Based, moved: boolean): string {
    return this.removedCopy(based.element, this.sourcesIn(based.counterpart), moved);
  }

  /** An element as the User's deletion, without what the Mind writes elsewhere; "" when their edits aren't tracked. */
  private removedCopy(element: XmlElement, sources: readonly string[], moved: boolean): string {
    const user = this.input.review.user("delete");
    if (!user) return "";
    const start = startOf(element);
    const ranges: [number, number][] = [];
    for (const source of sources) {
      if (!this.input.plan.writtenElsewhere(source)) continue;
      const [first, last = first] = source
        .split("..")
        .map((each) => this.input.base.places.get(each));
      if (!first || !last || !this.contains(element, first)) continue;
      ranges.push([startOf(first) - start, endOf(last) - start]);
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const splices: Splice[] = [];
    for (const [from, to] of ranges) {
      const last = splices.at(-1);
      if (last && from < last.to) continue;
      splices.push({ from, to, text: "" });
    }
    let copy = applySplices(sliceOf(this.text, element), splices);
    // What moved is written again where it is now, with its paragraphs' ids: those must stay unique.
    if (moved) copy = copy.replace(/\s(?:w14:paraId|w14:textId)="[^"]*"/g, "");
    return trackBlocks(copy, user, this.input.ids);
  }

  /** The sources of what is kept as is in a counterpart as imported, in its cells too. */
  private sourcesIn(counterpart: Counterpart): string[] {
    if (counterpart.kind === "paragraph") {
      return (counterpart.node.content ?? []).flatMap((node) => {
        const source = sourceOf(node);
        return source ? [source] : [];
      });
    }
    if (counterpart.kind !== "table") return [];
    return (counterpart.node.content ?? []).flatMap((row) =>
      (row.content ?? []).flatMap((cell) =>
        counterpartsOf(cell.content ?? [], this.baseKey).flatMap((inner) => this.sourcesIn(inner)),
      ),
    );
  }

  /**
   * The pieces of text written, in document order, for finding where comments
   * go: a paragraph written as it was is the User's; one written again, its
   * new words by who wrote them, and its sentences with a check that isn't
   * good; new Blocks as the native writer writes them.
   */
  private *pieces(counterparts: readonly Counterpart[]): Generator<Piece> {
    for (const counterpart of counterparts) {
      if (counterpart.pending.inserted) continue;
      const based = counterpart.key ? this.based.get(counterpart.key) : undefined;
      if (counterpart.kind === "paragraph") {
        if (based && !this.needsWriting(counterpart, based)) {
          yield { key: counterpart.node, authorship: "own" };
          continue;
        }
        const tokens = based
          ? withWordChanges(this.input.tokensOf(counterpart.node), counterpart.pending)
          : this.input.tokensOf(counterpart.node);
        for (const each of alignTokens(based ? this.baseTokensOf(based) : [], tokens)) {
          if (each.step === "delete" || each.step === "proposed") continue;
          const token = tokens[each.y] as Token;
          const authorship: Authorship =
            each.step === "equal"
              ? "own"
              : token.kind !== "char"
                ? "neither"
                : token.ai
                  ? "ai"
                  : /^\s$/u.test(token.char)
                    ? "neither"
                    : "own";
          yield { key: token, authorship, sentence: token.sentence };
        }
      } else if (counterpart.kind === "table" && based) {
        if (!this.input.edited(counterpart.node) && !this.forced.has(based.element)) {
          yield { key: counterpart.node, authorship: "own" };
          continue;
        }
        for (const row of counterpart.node.content ?? []) {
          for (const cell of row.content ?? [])
            yield* this.pieces(this.currentOf(cell.content ?? []));
        }
      } else if (counterpart.kind === "kept") {
        yield { key: counterpart.node, authorship: "own" };
      } else {
        yield* piecesOf(this.input.blocksOf(counterpart.node));
      }
    }
  }

  /** Every counterpart, those in tables' cells too. */
  private collect(
    counterparts: readonly Counterpart[],
    keyOf: (node: NodeJSON) => string | null,
    visit: (counterpart: Counterpart) => void,
    reading?: ReviewReading,
  ): void {
    for (const counterpart of counterparts) {
      visit(counterpart);
      if (counterpart.kind !== "table") continue;
      for (const row of counterpart.node.content ?? []) {
        for (const cell of row.content ?? [])
          this.collect(counterpartsOf(cell.content ?? [], keyOf, reading), keyOf, visit, reading);
      }
    }
  }

  private hrefOf(hyperlink: XmlElement): string | null {
    const anchor = hyperlink.attrs["w:anchor"];
    const target = this.input.relationships.get(hyperlink.attrs["r:id"] ?? "");
    if (target?.external) return anchor ? `${target.target}#${anchor}` : target.target;
    return anchor ? `#${anchor}` : null;
  }

  /** The main part's text with every change made. */
  write(): string {
    const body = child(this.input.base.root, "w:body");
    if (!body) return this.text;
    const current = this.currentOf(this.input.current);
    this.input.review.mark(this.pieces(current));
    const splices = this.container({
      element: body,
      contentStart: body.openEnd ?? startOf(body),
      base: this.baseOf(this.input.base.structure.blocks),
      current,
      extra: [],
    });
    if (this.input.bibliography.length > 0) {
      const user = this.input.review.user("insert");
      const rendered = this.input.writer.render(this.input.bibliography);
      const xml = this.newXml(user ? trackBlocks(rendered, user, this.input.ids) : rendered);
      const last = elements(body).at(-1);
      splices.push(
        last?.name === "w:sectPr"
          ? { from: startOf(last), to: startOf(last), text: xml }
          : appendInside(this.text, body, xml),
      );
    }
    if (selfClosing(body)) {
      // An empty body: what goes into it, in order, inside it.
      const added = splices.map((splice) => splice.text).join("");
      return this.input.review.finish(
        applySplices(this.text, [appendInside(this.text, body, added)]),
      );
    }
    splices.push(...this.unwrittenOutside(splices));
    return this.input.review.finish(applySplices(this.text, splices));
  }

  /** XML the native writer wrote, for where it goes. */
  private newXml(xml: string, scope?: Namespaces): string {
    return rescoped(xml, WRITER_NAMESPACES, scope ?? scopeOf(this.input.base.root, this.parents));
  }

  // -------------------------------------------------------------------------
  // Containers

  /**
   * The changes to a container's counterparts: the body's, or a cell's. Those in
   * `extra` (cells merged into this one) are kept or removed where they are,
   * but nothing new goes into them: they aren't shown.
   */
  private container(spec: {
    element: XmlElement;
    contentStart: number;
    base: readonly Counterpart[];
    current: readonly Counterpart[];
    extra: readonly XmlElement[];
  }): Splice[] {
    const { element } = spec;
    const scope = scopeOf(element, this.parents);
    const baseKeys = spec.base.flatMap((counterpart) =>
      counterpart.key && this.based.has(counterpart.key) ? [counterpart.key] : [],
    );
    const baseIndex = new Map(baseKeys.map((key, index) => [key, index]));
    const seen = new Set<string>();
    const matched = spec.current.map((counterpart) => {
      if (!counterpart.key || seen.has(counterpart.key) || !baseIndex.has(counterpart.key))
        return -1;
      seen.add(counterpart.key);
      return baseIndex.get(counterpart.key) as number;
    });
    const kept = longestIncreasing(matched);
    const keptKeys = new Set([...kept].map((index) => baseKeys[index] as string));

    const splices: Splice[] = [];
    for (const key of baseKeys) {
      if (keptKeys.has(key)) continue;
      const based = this.based.get(key) as Based;
      // A kept-as-is Block the Mind moved is the same element: it can't be both here and there.
      const moved = seen.has(key);
      // Someone's insertion of it rejected, or deletion accepted, leaves no trace.
      const resolved = !moved && hasWordChange(based.counterpart.pending);
      splices.push({
        from: startOf(based.element),
        to: endOf(based.element),
        text:
          (moved && based.counterpart.kind === "kept") || resolved
            ? ""
            : this.removed(based, moved),
      });
    }

    const inElement = (node: XmlElement) => {
      for (let at = this.parents.get(node); at; at = this.parents.get(at)) {
        if (at === element) return true;
        if (at.name === "w:tc" || at.name === "w:body") return false;
      }
      return false;
    };
    let anchor = spec.contentStart;
    /** The counterpart written last: whether it is a table, and its place among the base's if it stayed. */
    let previous: { table: boolean; index: number | null } | null = null;
    spec.current.forEach((counterpart, index) => {
      const keptHere = matched[index] !== -1 && kept.has(matched[index] as number);
      const based = counterpart.key ? this.based.get(counterpart.key) : undefined;
      const table =
        counterpart.kind === "table" || (counterpart.kind === "kept" && isTable(based?.element));
      // Two tables next to each other would run together into one.
      const apart =
        table &&
        previous?.table === true &&
        !(keptHere && previous.index !== null && previous.index === (matched[index] as number) - 1);
      if (keptHere && based) {
        if (apart)
          splices.push({
            from: startOf(based.element),
            to: startOf(based.element),
            text: "<w:p/>",
          });
        splices.push(
          ...this.rewriteInPlace(counterpart, based, () =>
            this.referenceAround(spec.current, index),
          ),
        );
        if (inElement(based.element)) anchor = endOf(based.element);
      } else {
        const xml = this.counterpartXml(counterpart, scope, () =>
          this.referenceAround(spec.current, index),
        );
        splices.push({ from: anchor, to: anchor, text: apart ? `<w:p/>${xml}` : xml });
      }
      previous = { table, index: keptHere ? (matched[index] as number) : null };
    });

    // A cell ends with a paragraph, and so does the body before its last section's properties,
    // unless it still ends with the table it ended with in the file: LibreOffice takes minutes
    // to lay out a paragraph after a table nested thousands deep.
    if (splices.length > 0) {
      const last = spec.current.at(-1);
      const lastBased = last?.key ? this.based.get(last.key) : undefined;
      const endsInTable =
        last === undefined || last.kind === "table" || isTable(lastBased?.element);
      const stillLast =
        lastBased !== undefined &&
        last?.key === baseKeys.at(-1) &&
        keptKeys.has(lastBased.counterpart.key ?? "");
      if (endsInTable && !stillLast) {
        splices.push({ from: anchor, to: anchor, text: "<w:p/>" });
      }
    }
    // A merged cell whose every paragraph went still needs one.
    for (const cell of spec.extra) {
      const counterparts = baseKeys.filter(
        (key) => this.parents.get((this.based.get(key) as Based).element) === cell,
      );
      if (counterparts.length > 0 && counterparts.every((key) => !keptKeys.has(key))) {
        splices.push(appendInside(this.text, cell, "<w:p/>"));
      }
    }
    return splices;
  }

  /** The changes to a counterpart the Mind kept in its place: none unless it changed. */
  private rewriteInPlace(
    counterpart: Counterpart,
    based: Based,
    references: () => Reference[],
  ): Splice[] {
    const { element } = based;
    const replace = (xml: string): Splice[] =>
      xml === sliceOf(this.text, element)
        ? []
        : [{ from: startOf(element), to: endOf(element), text: xml }];
    if (counterpart.kind === "paragraph") {
      if (!this.needsWriting(counterpart, based)) return [];
      return replace(
        this.tracked(
          this.paragraphXml(counterpart, based, scopeOf(element, this.parents), references),
          counterpart,
          false,
        ),
      );
    }
    if (counterpart.kind === "table") {
      const pending = hasPending(counterpart);
      if (!this.input.edited(counterpart.node) && !this.forced.has(element) && !pending) return [];
      if (!pending) return this.table(counterpart, based, true);
      const [whole] = this.table(counterpart, based, false);
      return replace(this.tracked(whole?.text ?? sliceOf(this.text, element), counterpart, false));
    }
    if (counterpart.kind === "kept") {
      const atom = readWordAtom(counterpart.node.attrs ?? {});
      if (atom.source && this.input.plan.writes(atom.source, counterpart.node, atom.kind))
        return replace(this.tracked(sliceOf(this.text, element), counterpart, false));
      this.input.plan.copied(counterpart.node);
      return replace(
        this.tracked(
          this.newXml(this.input.writer.render(textBlocks(counterpart.node))),
          counterpart,
          false,
        ),
      );
    }
    return [];
  }

  /** A counterpart's XML, written where it wasn't before. */
  private counterpartXml(
    counterpart: Counterpart,
    scope: Namespaces,
    references: () => Reference[],
  ): string {
    return this.tracked(this.untrackedXml(counterpart, scope, references), counterpart, true);
  }

  private untrackedXml(
    counterpart: Counterpart,
    scope: Namespaces,
    references: () => Reference[],
  ): string {
    const based = counterpart.key ? this.based.get(counterpart.key) : undefined;
    const moved = (element: XmlElement) =>
      rescoped(
        sliceOf(this.text, element),
        scopeOf(this.parents.get(element) ?? element, this.parents),
        scope,
      );
    if (counterpart.kind === "paragraph") {
      if (based && !this.needsWriting(counterpart, based)) return moved(based.element);
      return this.paragraphXml(counterpart, based ?? null, scope, references);
    }
    if (counterpart.kind === "table" && based) {
      if (!this.input.edited(counterpart.node) && !this.forced.has(based.element))
        return moved(based.element);
      const [splice] = this.table(counterpart, based, false);
      const from = scopeOf(this.parents.get(based.element) ?? based.element, this.parents);
      return rescoped(splice?.text ?? "", from, scope);
    }
    if (counterpart.kind === "kept") {
      const atom = readWordAtom(counterpart.node.attrs ?? {});
      if (based && atom.source && this.input.plan.writes(atom.source, counterpart.node, atom.kind))
        return moved(based.element);
      if (atom.source) this.input.plan.copied(counterpart.node);
      return this.newXml(this.input.writer.render(textBlocks(counterpart.node)), scope);
    }
    // What changes still waiting do to it as a whole is the counterpart's, tracked once.
    const blocks = this.input
      .blocksOf(counterpart.node)
      .map((block): Block => ({ ...block, inserted: undefined, deleted: undefined }));
    return this.newXml(this.input.writer.render(blocks), scope);
  }

  /**
   * Whether an imported paragraph must be written again: edited, changed as a
   * whole by a change still waiting that it didn't have in the file, moved in
   * or out of a list, or holding what goes.
   */
  private needsWriting(counterpart: Counterpart, based: Based): boolean {
    if (this.input.bookmarkOf(counterpart.node)) return true;
    return (
      !samePendings(counterpart.pending, based.counterpart.pending) ||
      this.input.edited(counterpart.node) ||
      this.forced.has(based.element) ||
      !sameList(counterpart.list, based.counterpart.list) ||
      this.sectionMoved(counterpart, based)
    );
  }

  private sectionMoved(counterpart: Counterpart, based: Based): boolean {
    const own = child(child(based.element, "w:pPr") ?? based.element, "w:sectPr");
    const ownSource = own ? this.input.base.places.placeOf(own) : null;
    const now = this.sectionSources(counterpart);
    return (
      (ownSource !== null && !now.includes(ownSource)) || now.some((each) => each !== ownSource)
    );
  }

  private contains(outer: XmlElement, inner: XmlElement): boolean {
    for (let at = this.parents.get(inner); at; at = this.parents.get(at))
      if (at === outer) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Paragraphs

  /** The section breaks a paragraph holds now, by source, that it writes. */
  private sectionSources(counterpart: Counterpart): string[] {
    const sources: string[] = [];
    for (const node of counterpart.node.content ?? []) {
      const source = sourceOf(node);
      const element = source ? this.input.base.places.get(source) : undefined;
      if (
        source &&
        element?.name === "w:sectPr" &&
        this.input.plan.writes(source, node, "sectionBreak")
      ) {
        sources.push(source);
      }
    }
    return sources;
  }

  private paragraphXml(
    counterpart: Counterpart,
    based: Based | null,
    scope: Namespaces,
    references: () => Reference[],
  ): string {
    const { plan } = this.input;
    const tokens = this.input.tokensOf(counterpart.node).flatMap((token): Token[] => {
      const { node } = token;
      if (token.kind !== "atom" || !token.source || !node) return [token];
      if (plan.writes(token.source, node, keptKindOf(node))) return [token];
      if (token.inline) {
        // A note kept as is is a new footnote with only its text, so it is said, as a copy is.
        if (node.type === WORD_ATOM_NODE) plan.copied(node);
        return [special(token.inline)];
      }
      if (!plan.isForeign(node) && !plan.written(token.source)) return [];
      plan.copied(node);
      return asCharacters(token, copiedText(node));
    });
    const filePPr = based ? this.pPrOf(based.element) : "";
    const basePPr = based
      ? resolvedMark(filePPr, based.counterpart.pending, counterpart.pending)
      : "";
    const properties = this.paragraphProperties(counterpart, based, references, basePPr);
    const { rPr } = properties;
    const user = this.input.review.user("insert");
    const pPr =
      user && based && properties.pPr !== basePPr
        ? this.propertiesChanged(properties.pPr, basePPr, user)
        : properties.pPr;
    const { xml, lost } = writeParagraph(
      {
        base: based ? { element: based.element, tokens: this.baseTokensOf(based) } : null,
        current: based ? withWordChanges(tokens, counterpart.pending) : tokens,
        pPr,
        pPrChanged: pPr !== filePPr,
        fallbackRun: rPr,
        scope,
        track: !counterpart.pending.inserted,
      },
      {
        ...this.context,
        special: (inline) => this.newXml(this.input.writer.inlineXml([inline]), scope),
        newLink: (href) => this.newXml(this.context.newLink(href), scope),
      },
    );
    if (lost > 0) {
      const text = (counterpart.node.content ?? []).map((each) => each.text ?? "").join("");
      this.losses.push({
        key: `edit:${counterpart.key ?? text}`,
        kind: "edit",
        author: null,
        text: text.slice(0, 120),
      });
    }
    const bookmark = this.input.bookmarkOf(counterpart.node);
    return bookmark ? bookmarkParagraph(xml, bookmark) : xml;
  }

  /** A paragraph's text as imported, with someone's changes to it in the file. */
  private baseTokensOf(based: Based): Token[] {
    return withWordChanges(
      baseTokens(based.counterpart.node.content ?? [], this.input.base.origins, this.baseReading),
      based.counterpart.pending,
    );
  }

  /** A paragraph's new properties that say what they were before the User changed them (`w:pPrChange`). */
  private propertiesChanged(pPr: string, was: string, by: Tracking): string {
    const before =
      Properties.paragraph(was).remove("w:rPr", "w:sectPr", "w:pPrChange").toXml() || "<w:pPr/>";
    const change = `<w:pPrChange w:id="${this.input.ids.take("annotation")}" w:author="${escapeXml(by.author)}"${dateAttribute(by.date)}>${before}</w:pPrChange>`;
    return Properties.paragraph(pPr).set("w:pPrChange", change).toXml();
  }

  private pPrOf(element: XmlElement): string {
    const pPr = child(element, "w:pPr");
    return pPr ? sliceOf(this.text, pPr) : "";
  }

  /**
   * A paragraph's properties as they are to be written, and the run
   * properties its new text starts from: an imported paragraph's own, changed
   * only where the Mind changed what it is (a heading's level, a list it is
   * in, a section break it ends); a new one's from the paragraph it follows,
   * as pressing Enter there would make it, or the list item beside it.
   */
  private paragraphProperties(
    counterpart: Counterpart,
    based: Based | null,
    references: () => Reference[],
    basePPr: string,
  ): { pPr: string; rPr: string } {
    const { styles } = this.input;
    const level =
      counterpart.node.type === "heading"
        ? Math.min(Math.max(Number(counterpart.node.attrs?.level) || 1, 1), 6)
        : null;
    let properties: Properties;
    let rPr = "";
    let formatBefore: ParagraphFormat = {};
    if (based) {
      properties = Properties.paragraph(basePPr);
      formatBefore = formatOf(based.counterpart.node);
      rPr = runOfMark(properties.get("w:rPr"));
      const baseLevel =
        based.counterpart.node.type === "heading"
          ? Number(based.counterpart.node.attrs?.level) || 1
          : null;
      if (level !== baseLevel) {
        const direct = properties.has("w:outlineLvl");
        if (level !== null && direct && baseLevel !== null) {
          properties.set("w:outlineLvl", `<w:outlineLvl w:val="${level - 1}"/>`);
        } else if (level !== null) {
          properties.remove("w:outlineLvl");
          properties.set(
            "w:pStyle",
            `<w:pStyle w:val="${escapeXml(styles.id(`heading${level}` as "heading1"))}"/>`,
          );
        } else {
          properties.remove("w:outlineLvl");
          if (!direct) properties.remove("w:pStyle");
        }
      }
      if (!sameList(counterpart.list, based.counterpart.list))
        this.setList(properties, counterpart.list, based);
    } else if (level !== null) {
      properties = Properties.paragraph("");
      properties.set(
        "w:pStyle",
        `<w:pStyle w:val="${escapeXml(styles.id(`heading${level}` as "heading1"))}"/>`,
      );
    } else if (counterpart.list) {
      const sibling = this.siblingOf(counterpart);
      properties = Properties.paragraph(sibling ? cleaned(this.pPrOf(sibling.element)) : "");
      if (sibling) formatBefore = formatOf(sibling.counterpart.node);
      rPr = sibling ? this.lastRunOf(sibling) : "";
      if (!sibling) {
        properties.set("w:pStyle", `<w:pStyle w:val="${escapeXml(styles.id("listParagraph"))}"/>`);
      }
      this.setList(properties, counterpart.list, null);
    } else {
      const reference = references()[0];
      properties = Properties.paragraph(reference ? reference.pPr : "");
      formatBefore = reference?.format ?? {};
      rPr = reference?.rPr ?? "";
    }
    const format = formatOf(counterpart.node);
    writeFormat(
      properties,
      this.input.lookCurrent ? format : { ...formatBefore, ...format },
      formatBefore,
    );

    // A section break goes with the paragraph that holds it now.
    const sections = this.sectionSources(counterpart);
    const sectPr = properties.get("w:sectPr");
    const ownSection = based
      ? child(child(based.element, "w:pPr") ?? based.element, "w:sectPr")
      : undefined;
    const ownSource = ownSection ? this.input.base.places.placeOf(ownSection) : null;
    const wanted = sections[0] ?? null;
    if (sectPr && wanted !== ownSource) properties.remove("w:sectPr");
    if (wanted && wanted !== ownSource) {
      const element = this.input.base.places.get(wanted);
      if (element) properties.set("w:sectPr", sliceOf(this.text, element));
    }
    return { pPr: !based || properties.changed ? properties.toXml() : basePPr, rPr };
  }

  /** Puts a paragraph in the list it is in now, or takes it out of any. */
  private setList(properties: Properties, list: ListPlace | null, based: Based | null): void {
    if (!list) {
      const own = properties.has("w:numPr");
      properties.remove("w:numPr");
      // Numbered by its style: only a list of none turns that off.
      if (based?.counterpart.list && !own) {
        properties.set("w:numPr", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>');
      }
      return;
    }
    const numId = this.numIdOf(list);
    properties.set(
      "w:numPr",
      `<w:numPr><w:ilvl w:val="${Math.min(list.depth, 8)}"/><w:numId w:val="${numId}"/></w:numPr>`,
    );
  }

  /** The numbering a list of the Mind is written with: that of its imported items, else a new one. */
  private numIdOf(list: ListPlace): number {
    const known = this.lists.get(list.list);
    if (known !== undefined) return known;
    for (const item of this.listItems.get(list.list) ?? []) {
      const based = item.key ? this.based.get(item.key) : undefined;
      if (!based?.counterpart.list || based.counterpart.list.ordered !== list.ordered) continue;
      const numId = numIdIn(this.pPrOf(based.element));
      if (numId !== null && numId !== "0") {
        this.lists.set(list.list, Number(numId));
        return Number(numId);
      }
    }
    const start = Math.max(Math.trunc(Number(list.list.attrs?.start)) || 1, 0);
    const numId = this.input.target.list(list.ordered, Math.min(list.depth, 8), start);
    this.lists.set(list.list, numId);
    return numId;
  }

  /** An imported item of the same list, the nearest before this one, else after: a new item takes its look. */
  private siblingOf(counterpart: Counterpart): Based | null {
    if (!counterpart.list) return null;
    const items = this.listItems.get(counterpart.list.list) ?? [];
    const at = items.indexOf(counterpart);
    const order = [...items.slice(0, at).reverse(), ...items.slice(at + 1)];
    for (const item of order) {
      const based = item.key ? this.based.get(item.key) : undefined;
      if (based && based.element.name === "w:p") return based;
    }
    return null;
  }

  /** The run properties of a paragraph's last text: what text typed after it would take. */
  private lastRunOf(based: Based): string {
    const nodes = based.counterpart.node.content ?? [];
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index] as NodeJSON;
      if (node.type !== "text") continue;
      const run = this.input.base.origins.get(node);
      const rPr = run ? child(run, "w:rPr") : undefined;
      if (!run || this.inHyperlink(run)) continue;
      return rPr ? withoutFormatChange(sliceOf(this.text, rPr)) : "";
    }
    return runOfMark(Properties.paragraph(this.pPrOf(based.element)).get("w:rPr"));
  }

  private inHyperlink(element: XmlElement): boolean {
    for (let at = this.parents.get(element); at && at.name !== "w:p"; at = this.parents.get(at)) {
      if (at.name === "w:hyperlink") return true;
    }
    return false;
  }

  /**
   * What new paragraphs among a container's counterparts take their look from: the
   * nearest plain imported paragraph before, else after.
   */
  private referenceAround(counterparts: readonly Counterpart[], index: number): Reference[] {
    const plain = (counterpart: Counterpart | undefined) => {
      const based = counterpart?.key ? this.based.get(counterpart.key) : undefined;
      return based &&
        based.counterpart.node.type === "paragraph" &&
        !based.counterpart.list &&
        based.element.name === "w:p"
        ? based
        : null;
    };
    for (const order of [counterparts.slice(0, index).reverse(), counterparts.slice(index + 1)]) {
      for (const counterpart of order) {
        const based = plain(counterpart);
        if (based) {
          return [
            {
              pPr: cleaned(this.pPrOf(based.element)),
              rPr: this.lastRunOf(based),
              format: formatOf(based.counterpart.node),
            },
          ];
        }
      }
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Tables

  /** A table's changes: cell by cell when its shape is the same, else the table written again. */
  private table(counterpart: Counterpart, based: Based, inPlace: boolean): Splice[] {
    const { element } = based;
    const baseRows = based.counterpart.node.content ?? [];
    const rows = counterpart.node.content ?? [];
    const span = (cell: NodeJSON, name: string) =>
      Math.max(Math.trunc(Number(cell.attrs?.[name])) || 1, 1);
    const sameShape =
      rows.length === baseRows.length &&
      rows.every((row, r) => {
        const baseCells = baseRows[r]?.content ?? [];
        const cells = row.content ?? [];
        return (
          cells.length === baseCells.length &&
          cells.every((cell, c) => {
            const baseCell = baseCells[c] as NodeJSON;
            return (
              span(cell, "colspan") === span(baseCell, "colspan") &&
              span(cell, "rowspan") === span(baseCell, "rowspan")
            );
          })
        );
      });
    if (!sameShape) {
      const xml = this.rebuiltTable(counterpart, based);
      return [{ from: startOf(element), to: endOf(element), text: xml }];
    }
    const splices: Splice[] = [];
    rows.forEach((row, r) => {
      const baseRow = baseRows[r] as NodeJSON;
      const tr = this.input.base.origins.get(baseRow);
      const header = isHeaderRow(row);
      if (tr && header !== isHeaderRow(baseRow)) splices.push(...this.headerSplices(tr, header));
      (row.content ?? []).forEach((cell, c) => {
        const baseCell = (baseRow.content ?? [])[c] as NodeJSON;
        const tc = this.input.base.origins.get(baseCell);
        if (!tc) {
          this.paddingLost(cell);
          return;
        }
        splices.push(...this.cell(tc, baseCell, cell));
      });
    });
    if (inPlace) return splices;
    const start = startOf(element);
    const xml = applySplices(
      sliceOf(this.text, element),
      splices.map((splice) => ({ ...splice, from: splice.from - start, to: splice.to - start })),
    );
    return [{ from: start, to: endOf(element), text: xml }];
  }

  /** Text typed into a place no cell of the document fills, which can't be written. */
  private paddingLost(cell: NodeJSON): void {
    const text = [...flatText(cell)].join("").trim();
    if (text)
      this.losses.push({
        key: `edit:cell:${text.slice(0, 40)}`,
        kind: "edit",
        author: null,
        text: text.slice(0, 120),
      });
  }

  private cell(tc: XmlElement, baseCell: NodeJSON, cell: NodeJSON): Splice[] {
    const tcPr = child(tc, "w:tcPr");
    return this.container({
      element: tc,
      contentStart: tcPr ? endOf(tcPr) : (tc.openEnd ?? startOf(tc)),
      base: this.baseOf(baseCell.content ?? []),
      current: this.currentOf(cell.content ?? []),
      extra: this.input.base.merged.get(baseCell) ?? [],
    });
  }

  private headerSplices(tr: XmlElement, header: boolean): Splice[] {
    const trPr = child(tr, "w:trPr");
    if (trPr) {
      const properties = elements(trPr).filter((each) => each.name !== "w:tblHeader");
      const inner =
        properties.map((each) => sliceOf(this.text, each)).join("") +
        (header ? "<w:tblHeader/>" : "");
      return [
        { from: startOf(trPr), to: endOf(trPr), text: inner ? `<w:trPr>${inner}</w:trPr>` : "" },
      ];
    }
    if (!header) return [];
    const before = child(tr, "w:tblPrEx");
    const at = before ? endOf(before) : (tr.openEnd ?? startOf(tr));
    return [{ from: at, to: at, text: "<w:trPr><w:tblHeader/></w:trPr>" }];
  }

  /**
   * A table whose rows or columns changed, written again: its properties as
   * they were, its grid as it was if it is as wide, each row and cell from the
   * one the Mind's came from (properties and content), new ones like those
   * beside them, and merged cells as Word writes them.
   */
  private rebuiltTable(counterpart: Counterpart, based: Based): string {
    const { element } = based;
    const text = this.text;
    const tblPr = child(element, "w:tblPr");
    const grid = child(element, "w:tblGrid");
    const widths = grid
      ? elements(grid)
          .filter((each) => each.name === "w:gridCol")
          .map((each) => Number(each.attrs["w:w"]) || 0)
      : [];

    const rows = counterpart.node.content ?? [];
    const shapes: TableCell[][] = rows.map((row) =>
      (row.content ?? []).map((cell) => ({
        header: cell.type === "tableHeader",
        colspan: Math.max(Math.trunc(Number(cell.attrs?.colspan)) || 1, 1),
        rowspan: Math.max(Math.trunc(Number(cell.attrs?.rowspan)) || 1, 1),
        align: null,
        content: [],
      })),
    );
    const nodeOf = new Map<TableCell, NodeJSON>();
    for (const [r, cells] of shapes.entries()) {
      for (const [c, cell] of cells.entries())
        nodeOf.set(cell, (rows[r]?.content ?? [])[c] as NodeJSON);
    }
    const layout = tableLayout(shapes);
    const total = widths.reduce((sum, width) => sum + width, 0) || 9000;
    const columnWidths =
      widths.length === layout.columns && widths.every((width) => width > 0)
        ? widths
        : Array.from({ length: layout.columns }, () => Math.floor(total / layout.columns));
    const gridXml =
      grid && widths.length === layout.columns
        ? sliceOf(text, grid)
        : `<w:tblGrid>${columnWidths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`;

    // Where each of the Mind's cells came from: the cell whose paragraphs it holds.
    const baseCells = new Map<string, { tc: XmlElement; tr: XmlElement; node: NodeJSON }>();
    for (const baseRow of based.counterpart.node.content ?? []) {
      const tr = this.input.base.origins.get(baseRow);
      for (const baseCell of baseRow.content ?? []) {
        const tc = this.input.base.origins.get(baseCell);
        if (!tr || !tc) continue;
        for (const inner of counterpartsOf(baseCell.content ?? [], this.baseKey)) {
          if (inner.key) baseCells.set(inner.key, { tc, tr, node: baseCell });
        }
      }
    }
    const originOf = (cell: NodeJSON) => {
      for (const inner of this.currentOf(cell.content ?? [])) {
        const found = inner.key ? baseCells.get(inner.key) : undefined;
        if (found) return found;
      }
      return null;
    };
    const used = new Set<XmlElement>();
    const chainOf = (from: XmlElement, upTo: XmlElement) => {
      const chain: XmlElement[] = [];
      for (let at = this.parents.get(from); at && at !== upTo; at = this.parents.get(at))
        chain.unshift(at);
      return chain;
    };
    const rowWrappers = new Wrapping(text);
    let rowChain: XmlElement[] = [];

    // Each row of the Mind's from the row it was, once; the document's others the User deleted.
    const rowOrigins = rows.map((row) => {
      const found = (row.content ?? []).map(originOf).find((each) => each !== null)?.tr ?? null;
      const tr = found && !used.has(found) ? found : null;
      if (tr) used.add(tr);
      return { found, tr };
    });
    const baseRows = (based.counterpart.node.content ?? []).flatMap((baseRow) => {
      const tr = this.input.base.origins.get(baseRow);
      return tr ? [{ tr, node: baseRow }] : [];
    });
    let removedTo = 0;
    /** The document's rows before `until` that the Mind no longer has, as the User's deletions. */
    const removedRows = (until: number) => {
      let removed = "";
      for (; removedTo < until; removedTo++) {
        const { tr, node } = baseRows[removedTo] as { tr: XmlElement; node: NodeJSON };
        if (used.has(tr)) continue;
        const sources = (node.content ?? []).flatMap((cell) =>
          counterpartsOf(cell.content ?? [], this.baseKey).flatMap((inner) =>
            this.sourcesIn(inner),
          ),
        );
        removed += this.removedCopy(tr, sources, false);
      }
      return removed;
    };
    const userInsert = this.input.review.user("insert");

    let xml = openTag(text, element) + (tblPr ? sliceOf(text, tblPr) : "") + gridXml;
    xml += this.keptBetween(element);
    layout.rows.forEach((slots, r) => {
      const row = rows[r] as NodeJSON;
      const { found, tr } = rowOrigins[r] as { found: XmlElement | null; tr: XmlElement | null };
      if (tr) xml += removedRows(baseRows.findIndex((each) => each.tr === tr));
      // A new row goes where the row before it is: inside a repeating section, say.
      if (found) rowChain = chainOf(found, element);
      xml += rowWrappers.to(rowChain);
      const header = isHeaderRow(row);
      let rowXml = tr ? openTag(text, tr) : "<w:tr>";
      const tblPrEx = tr ? child(tr, "w:tblPrEx") : undefined;
      if (tblPrEx) rowXml += sliceOf(text, tblPrEx);
      const trPr = tr ? child(tr, "w:trPr") : undefined;
      const rowProperties = trPr
        ? elements(trPr)
            .filter((each) => each.name !== "w:tblHeader")
            .map((each) => sliceOf(text, each))
            .join("")
        : "";
      const rowPr = rowProperties + (header ? "<w:tblHeader/>" : "");
      if (rowPr) rowXml += `<w:trPr>${rowPr}</w:trPr>`;
      const cellWrappers = new Wrapping(text);
      let cellChain: XmlElement[] = [];
      let column = 0;
      for (const slot of slots) {
        const colspan = slot.cell?.colspan ?? 1;
        const width = columnWidths
          .slice(column, column + colspan)
          .reduce((sum, each) => sum + each, 0);
        column += colspan;
        if (!slot.cell || slot.continued) {
          rowXml += `${cellWrappers.to(cellChain)}<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${colspan > 1 ? `<w:gridSpan w:val="${colspan}"/>` : ""}${slot.continued ? "<w:vMerge/>" : ""}</w:tcPr><w:p/></w:tc>`;
          continue;
        }
        const node = nodeOf.get(slot.cell) as NodeJSON;
        const origin = originOf(node);
        const fresh = origin && !used.has(origin.tc) ? origin : null;
        if (fresh) used.add(fresh.tc);
        if (origin) cellChain = chainOf(origin.tc, origin.tr);
        rowXml += cellWrappers.to(cellChain) + this.rebuiltCell(node, fresh, slot.cell, width);
      }
      const whole = `${rowXml}${cellWrappers.to([])}</w:tr>`;
      xml += !tr && userInsert ? trackBlocks(whole, userInsert, this.input.ids) : whole;
    });
    xml += removedRows(baseRows.length);
    return `${xml}${rowWrappers.to([])}${closeTag(element)}`;
  }

  private rebuiltCell(
    node: NodeJSON,
    origin: { tc: XmlElement; node: NodeJSON } | null,
    shape: TableCell,
    width: number,
  ): string {
    const text = this.text;
    const tcPr = origin ? child(origin.tc, "w:tcPr") : undefined;
    const properties = new CellProperties(tcPr ? sliceOf(text, tcPr) : "");
    properties.set("w:tcW", `<w:tcW w:w="${width}" w:type="dxa"/>`);
    properties.remove("w:hMerge", "w:vMerge", "w:gridSpan");
    if (shape.colspan > 1) properties.set("w:gridSpan", `<w:gridSpan w:val="${shape.colspan}"/>`);
    if (shape.rowspan > 1) properties.set("w:vMerge", '<w:vMerge w:val="restart"/>');
    let content: string;
    if (origin) {
      const { tc } = origin;
      const splices = this.cell(tc, origin.node, node);
      const start = startOf(tc);
      const patched = applySplices(
        sliceOf(text, tc),
        splices.map((splice) => ({ ...splice, from: splice.from - start, to: splice.to - start })),
      );
      const own = child(tc, "w:tcPr");
      const from = (own ? endOf(own) : (tc.openEnd ?? start)) - start;
      content = selfClosing(tc) ? "" : patched.slice(from, patched.length - closeTag(tc).length);
    } else {
      content = this.currentOf(node.content ?? [])
        .map((counterpart) =>
          this.counterpartXml(counterpart, scopeOf(this.input.base.root, this.parents), () => []),
        )
        .join("");
    }
    if (!content.trimEnd().endsWith("</w:p>") && !content.trimEnd().endsWith("<w:p/>"))
      content += "<w:p/>";
    const open = origin ? openTag(text, origin.tc) : "<w:tc>";
    return `${open}${properties.toXml()}${content}</w:tc>`;
  }

  /** Marks between a table's rows and cells (a bookmark) that are still written, kept at its start. */
  private keptBetween(table: XmlElement): string {
    let xml = "";
    for (const each of walk(table, (element) => element.name !== "w:tc")) {
      const place = this.input.base.places.placeOf(each);
      if (place && each.name !== "w:tc" && this.input.plan.written(place))
        xml += sliceOf(this.text, each);
    }
    return xml;
  }

  // -------------------------------------------------------------------------

  /**
   * Kept-as-is marks between paragraphs (a bookmark the Mind holds in the
   * paragraph after it) that nothing writes any more: removed where they are,
   * unless what holds them is written again anyway.
   */
  private unwrittenOutside(splices: readonly Splice[]): Splice[] {
    // A table's rows aren't what holds a mark between them: only paragraphs and kept Blocks are.
    const holders = new Set(
      [...this.based.values()]
        .filter((each) => each.counterpart.kind !== "table")
        .map((each) => each.element),
    );
    const covered = (element: XmlElement) =>
      splices.some(
        (splice) =>
          splice.from < splice.to && splice.from <= startOf(element) && endOf(element) <= splice.to,
      );
    const removed: Splice[] = [];
    for (const based of this.based.values()) {
      if (based.counterpart.kind !== "paragraph") continue;
      for (const node of based.counterpart.node.content ?? []) {
        const source = sourceOf(node);
        const element = source ? this.input.base.places.get(source) : undefined;
        if (!source || !element || this.input.plan.written(source)) continue;
        let inside = false;
        for (let at = this.parents.get(element); at; at = this.parents.get(at)) {
          if (holders.has(at)) inside = true;
        }
        if (!inside && !covered(element))
          removed.push({ from: startOf(element), to: endOf(element), text: "" });
      }
    }
    return removed;
  }
}

/** The properties of a wrapper (a content control's, custom XML's), written when it is opened. */
const WRAPPER_PROPERTIES = new Set(["w:sdtPr", "w:sdtEndPr", "w:customXmlPr"]);

/**
 * Wrappers (content controls, custom XML) around rows or cells as a table is
 * written again: opened and closed so that exactly those a row or cell was in
 * are open. One closed once isn't opened again, so its id isn't written twice.
 */
class Wrapping {
  private open: XmlElement[] = [];
  private readonly closed = new Set<XmlElement>();

  constructor(private readonly text: string) {}

  to(chain: readonly XmlElement[]): string {
    const wanted = chain.filter((each) => this.open.includes(each) || !this.closed.has(each));
    let same = 0;
    while (same < this.open.length && same < wanted.length && this.open[same] === wanted[same])
      same++;
    let xml = "";
    for (let at = this.open.length - 1; at >= same; at--) {
      const element = this.open[at] as XmlElement;
      xml += closeTag(element);
      this.closed.add(element);
    }
    for (const element of wanted.slice(same)) {
      xml += openTag(this.text, element);
      for (const each of elements(element)) {
        if (WRAPPER_PROPERTIES.has(each.name)) xml += sliceOf(this.text, each);
      }
    }
    this.open = wanted;
    return xml;
  }
}

/** A cell's properties, changed in place. */
class CellProperties {
  private readonly properties: Properties;
  constructor(xml: string) {
    this.properties = Properties.ofOrder("w:tcPr", xml, CELL_ORDER);
  }
  set(name: string, xml: string): void {
    this.properties.set(name, xml);
  }
  remove(...names: string[]): void {
    this.properties.remove(...names);
  }
  toXml(): string {
    return this.properties.toXml() || "<w:tcPr/>";
  }
}

/** Whether changes still waiting add or remove a counterpart as a whole. */
const hasPending = (counterpart: Counterpart) =>
  counterpart.pending.inserted !== undefined || counterpart.pending.deleted !== undefined;

/** Whether someone's change from the file adds or removes something as a whole (#108). */
const hasWordChange = (pending: Pendings) =>
  isWordChange(pending.inserted) || isWordChange(pending.deleted);

/**
 * A paragraph's properties without the mark of someone's change to the whole
 * paragraph (#108) that the User accepted or rejected since.
 */
function resolvedMark(pPr: string, was: Pendings, now: Pendings): string {
  const names = [
    ...(isWordChange(was.inserted) && was.inserted.id !== now.inserted?.id ? ["w:ins"] : []),
    ...(isWordChange(was.deleted) && was.deleted.id !== now.deleted?.id ? ["w:del"] : []),
  ];
  const properties = Properties.paragraph(pPr);
  const rPr = properties.get("w:rPr");
  if (names.length === 0 || !rPr) return pPr;
  const run = Properties.run(rPr)
    .remove(...names)
    .toXml();
  if (run) properties.set("w:rPr", run);
  else properties.remove("w:rPr");
  return properties.toXml();
}

const sameList = (a: ListPlace | null, b: ListPlace | null): boolean =>
  (a === null && b === null) ||
  (a !== null && b !== null && a.ordered === b.ordered && a.depth === b.depth);

const isHeaderRow = (row: NodeJSON) =>
  (row.content ?? []).length > 0 &&
  (row.content ?? []).every((cell) => cell.type === "tableHeader");

/** The numId a paragraph's own numbering names, if it has any. */
function numIdIn(pPr: string): string | null {
  return /<w:numId\b[^>]*\bw:val="([^"]*)"/.exec(pPr)?.[1] ?? null;
}

/**
 * Properties to start a new paragraph from: what makes a paragraph the one it
 * is (its section, a frame, a page break before it, a tracked change to it)
 * left out.
 */
function cleaned(pPr: string): string {
  const properties = Properties.paragraph(pPr).remove(
    "w:sectPr",
    "w:pPrChange",
    "w:framePr",
    "w:pageBreakBefore",
    "w:numPr",
    "w:outlineLvl",
  );
  const rPr = properties.get("w:rPr");
  if (rPr) {
    const run = Properties.run(rPr).remove(
      "w:ins",
      "w:del",
      "w:moveFrom",
      "w:moveTo",
      "w:rPrChange",
    );
    const xml = run.toXml();
    if (xml) properties.set("w:rPr", xml);
    else properties.remove("w:rPr");
  }
  return properties.toXml();
}

/** A paragraph mark's run properties as a run's: without its own tracked changes. */
function runOfMark(rPr: string | null): string {
  if (!rPr) return "";
  return Properties.run(rPr)
    .remove("w:ins", "w:del", "w:moveFrom", "w:moveTo", "w:rPrChange")
    .toXml();
}

/** A kept-as-is Block's text, a paragraph a line, for writing a copy. */
function textBlocks(node: NodeJSON): Block[] {
  return wordAtomText(readWordAtom(node.attrs ?? {}))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({
      kind: "paragraph",
      content: [{ kind: "text", text: line, marks: { ...PLAIN } }],
    }));
}

function* flatText(node: NodeJSON): Generator<string> {
  if (node.text) yield node.text;
  for (const each of node.content ?? []) yield* flatText(each);
}

/** The indices in the longest increasing run of `values` (ignoring -1s): what stays in its place. */
function longestIncreasing(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const tailIndex: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  values.forEach((value, index) => {
    if (value < 0) return;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((tails[middle] as number) < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
    tailIndex[low] = index;
    previous[index] = low > 0 ? (tailIndex[low - 1] as number) : -1;
  });
  const kept = new Set<number>();
  for (let at = tailIndex[tails.length - 1] ?? -1; at >= 0; at = previous[at] as number) {
    kept.add(values[at] as number);
  }
  return kept;
}
