/**
 * Exporting a Mind imported from a Word file back into that file (#105): a
 * new .docx made from the original package kept at import, with every entry
 * the Mind didn't change copied as it is, compressed bytes and all, and only
 * the parts it changed written again, each spliced into its own text
 * (./document, ./paragraph). New Citations become footnotes, and new Blocks
 * are written by the native writer (../docx) into the document's own styles,
 * lists and footnotes (./parts). Every part written is parsed again with
 * xmldom before anything is saved: a part that isn't well-formed XML with
 * every prefix bound stops the export, naming the part (WordPartError).
 * What can't be kept is reported (`WordExportReport`), never dropped silently.
 * Changes still waiting, the User's edits and IncarnaMind's comments go in
 * for review as the export was asked (../wordReview, #107).
 */
import { deflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import * as Y from "yjs";
import type { NodeJSON } from "../../../shared/blockJson";
import type { ResolvedCitationStyle } from "../../../shared/citationStyles";
import { proposalRequestOf } from "../../../shared/proposals";
import type { SourceContext } from "../../../shared/sources";
import { wordFileOf, wordFingerprint, wordSourceOf } from "../../../shared/wordFiles";
import { wordLookOf } from "../../../shared/wordLook";
import {
  CITATION_NODE,
  type CitationFormatRequest,
  FOOTNOTE_NODE,
  type FormattedCitations,
  IMAGE_NODE,
  type WordExportLoss,
  type WordExportReport,
} from "../../api";
import { nodesByPlace, readWordDocument } from "../../documents/formats/docxImport";
import { WORD_LOOK_VERSION } from "../../documents/formats/docxLook";
import { openWordPackage, relationshipsOf, reviewOf } from "../../documents/formats/docxPackage";
import { child, elements, type XmlElement } from "../../documents/formats/xml";
import {
  type Block,
  type FailedSentence,
  plainText,
  type ReadOptions,
  readBlock,
  readInlineNodes,
} from "../../mindText";
import { DocxWriter } from "../docx";
import type { ExportLabels } from "../labels";
import { Review, type ReviewChoices } from "../wordReview";
import { AtomPlan } from "./atoms";
import { styleWritten, type Written } from "./citations";
import { DocumentPatch } from "./document";
import {
  type Counterpart,
  changesWithin,
  counterpartsOf,
  importedChangesWithin,
  isFurniture,
  mindJson,
} from "./mind";
import { WordPackageWriter, WordPartError } from "./package";
import { currentTokens, type Token } from "./paragraph";
import {
  DocumentComments,
  DocumentFootnotes,
  DocumentNumbering,
  DocumentStyles,
  PatchTarget,
  reserveIds,
} from "./parts";

export interface WordPatchInput {
  /** The package kept when the Mind was imported. */
  bytes: Uint8Array;
  /** The Mind's Blocks, in its Yjs document. */
  blocks: Y.XmlFragment;
  /** How the Mind's Blocks are read, as the native export reads them. */
  readOptions: ReadOptions;
  labels: ExportLabels;
  style: ResolvedCitationStyle;
  /** Whether a Numbered Mind shows its Bibliography. */
  bibliography: boolean;
  /** Citations as `[1]` and a list at the end, instead of footnotes (#1600). */
  listed: boolean;
  bibliographyHeading: string;
  sources: SourceContext;
  formatCitations(request: CitationFormatRequest): Promise<FormattedCitations>;
  /** Blocks with their charts' pictures drawn, as the native export draws them. */
  withPictures(blocks: Block[]): Promise<Block[]>;
  /** What the file says for review (#107). */
  review: ReviewChoices;
}

export interface WordPatchResult {
  data: Uint8Array;
  report: WordExportReport;
  commented: FailedSentence[];
  /** The footnotes the finished document refers to, the ones the file already had included (#2193). */
  footnotes: number;
}

/** The text width a section leaves, in twips, for new tables and pictures: US Letter's with 1 inch margins if it doesn't say. */
const DEFAULT_WIDTH = 9360;

/** Content types IncarnaMind knows a Word package to have: a part of any other is listed as unknown. */
const KNOWN_TYPES = [
  /^application\/vnd\.openxmlformats-/,
  /^application\/vnd\.ms-(word|office|package|opentype|excel|powerpoint)/,
  /^image\//,
  /^application\/(xml|pdf|x-emf|x-msmetafile|x-font[\w.-]*)$/,
  /^text\/xml$/,
];

export async function exportWordPatch(input: WordPatchInput): Promise<WordPatchResult> {
  const pkg = await openWordPackage(input.bytes);
  const base = await readWordDocument(pkg, await reviewOf(pkg));
  const writer = new WordPackageWriter(pkg.zip);
  // Checks the part can be spliced: it encodes back to the same bytes.
  await writer.text(pkg.part);

  const doc = input.blocks.doc;
  if (!doc || !wordFileOf(doc)) throw new Error("This Note wasn't imported from a Word file.");
  const reading = input.readOptions.review;
  const yOf = new Map<NodeJSON, Y.XmlElement>();
  const current = input.blocks
    .toArray()
    .flatMap((each) => (each instanceof Y.XmlElement ? [mindJson(each, yOf, reading)] : []))
    .filter((each): each is NodeJSON => each !== null);

  const sourceOf = (node: NodeJSON) => {
    const id = node.attrs?.id;
    return typeof id === "string" ? wordSourceOf(doc, id) : null;
  };
  const currentKey = (node: NodeJSON): string | null => {
    const source = sourceOf(node);
    const element = source ? base.places.get(source.n) : undefined;
    if (!source || !element) return null;
    const fits =
      (node.type === "table" && element.name === "w:tbl") ||
      ((node.type === "paragraph" || node.type === "heading") && element.name === "w:p");
    return fits ? source.n : null;
  };
  const importedByPlace = nodesByPlace(base.structure);
  /**
   * Resolving a change on a node within a Block, such as a line break someone removed, leaves
   * the Block's fingerprint as it was (#858). An import from before changes were read made
   * none of the file's, so only those it recorded count.
   */
  const changesResolvedOrMade = (element: Y.XmlElement, place: string): boolean => {
    const imported = importedByPlace.get(place);
    if (!imported) return false;
    const now = changesWithin(element);
    const before = [...importedChangesWithin(imported)].filter(
      ([, request]) => proposalRequestOf(doc, request) !== null,
    );
    return before.length !== now.size || before.some(([key]) => !now.has(key));
  };
  const editedNodes = new Map<NodeJSON, boolean>();
  const edited = (node: NodeJSON) => {
    const known = editedNodes.get(node);
    if (known !== undefined) return known;
    const source = sourceOf(node);
    const element = yOf.get(node);
    const result =
      !source ||
      !element ||
      wordFingerprint(element) !== source.f ||
      changesResolvedOrMade(element, source.n);
    editedNodes.set(node, result);
    return result;
  };

  const baseIds = new Map([...base.structure.sources].map(([id, source]) => [id, source.n]));
  const baseKey = (node: NodeJSON) => {
    const id = node.attrs?.id;
    return typeof id === "string" ? (baseIds.get(id) ?? null) : null;
  };
  const plan = new AtomPlan(
    base.structure.blocks,
    current,
    baseKey,
    currentKey,
    base.places,
    input.review.trackAs !== null,
  );

  // The parts new content goes into.
  const documentRelationships = await writer.relationshipsOf(pkg.part);
  const styles = await DocumentStyles.read(writer, pkg.part, documentRelationships);
  const numbering = await DocumentNumbering.read(writer, pkg.part, documentRelationships);
  const footnotes = await DocumentFootnotes.read(writer, pkg.part, documentRelationships);
  const comments = await DocumentComments.read(writer, pkg.part, documentRelationships);
  const target = new PatchTarget(
    writer,
    pkg.part,
    documentRelationships,
    await writer.relationshipsOf(footnotes.name),
    styles,
    numbering,
  );
  footnotes.reserveIds(target.ids);
  const bookmarks = new Set<string>();
  await reserveIds(writer, target.ids, bookmarks);
  target.reserveBookmarks(bookmarks);
  const review = new Review(input.review, target.ids, input.labels, () => target.styles.comment);
  const docxWriter = new DocxWriter(input.labels, textWidthOf(base.root), target, review);

  // What is written new, read as the native export reads it, then its Citations styled together.
  const options = input.readOptions;
  const specialOf = (node: NodeJSON) => {
    const element = yOf.get(node);
    const special =
      node.type === CITATION_NODE ||
      node.type === FOOTNOTE_NODE ||
      node.type === "inlineMath" ||
      (node.type === IMAGE_NODE && !node.attrs?.source);
    return element && special ? readInlineNodes([element], options) : [];
  };
  const textOf = (node: NodeJSON) => {
    const element = yOf.get(node);
    return element ? plainText(element) : "";
  };
  const written = new Map<NodeJSON, Written>();
  /** Every paragraph's text now, read once, so what reads it twice sees the same tokens. */
  const tokens = new Map<NodeJSON, Token[]>();
  const order: Written[] = [];
  const visit = (counterparts: readonly Counterpart[]) => {
    for (const counterpart of counterparts) {
      if (counterpart.kind === "paragraph") {
        const each: Written = {
          tokens: currentTokens(
            counterpart.node.content ?? [],
            specialOf,
            textOf,
            reading,
            counterpart.wholeAi,
            options.sentenceChecks,
          ),
        };
        tokens.set(counterpart.node, each.tokens ?? []);
        if (counterpart.key !== null && !edited(counterpart.node)) continue;
        written.set(counterpart.node, each);
        order.push(each);
      } else if (counterpart.kind === "table" && counterpart.key !== null) {
        for (const row of counterpart.node.content ?? []) {
          for (const cell of row.content ?? [])
            visit(counterpartsOf(cell.content ?? [], currentKey, reading));
        }
      } else if (counterpart.kind === "other" || counterpart.kind === "table") {
        const element = yOf.get(counterpart.node);
        const each: Written = { blocks: element ? readBlock(element, options) : [] };
        written.set(counterpart.node, each);
        order.push(each);
      }
    }
  };
  visit(counterpartsOf(current, currentKey, reading));
  const bibliography = await styleWritten(order, {
    style: input.style,
    bibliography: input.bibliography,
    listed: input.listed,
    heading: input.bibliographyHeading,
    sources: input.sources,
    format: input.formatCitations,
    unverified: input.labels.unverified,
    figures: { footnote: options.footnote, labels: input.labels },
  });
  for (const each of order) if (each.blocks) each.blocks = await input.withPictures(each.blocks);

  const patch = new DocumentPatch({
    base,
    current,
    currentKey,
    edited,
    tokensOf: (node): Token[] => {
      const known = written.get(node)?.tokens ?? tokens.get(node);
      if (known) return known;
      const read = currentTokens(
        node.content ?? [],
        specialOf,
        textOf,
        reading,
        false,
        options.sentenceChecks,
      );
      tokens.set(node, read);
      return read;
    },
    blocksOf: (node) => {
      const known = written.get(node)?.blocks;
      if (known) return known;
      const element = yOf.get(node);
      return element ? readBlock(element, options) : [];
    },
    writer: docxWriter,
    target,
    styles,
    relationships: await relationshipsOf(pkg.zip, pkg.part),
    plan,
    bibliography: await input.withPictures(bibliography),
    reading,
    review,
    ids: target.ids,
    lookCurrent: (wordLookOf(doc)?.version ?? 0) >= WORD_LOOK_VERSION,
  });
  let text: string;
  try {
    text = docxWriter.finish(patch.write());
  } catch (error) {
    throw new WordPartError(
      pkg.part,
      `couldn't be written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (text !== base.text) writer.set(pkg.part, text);
  footnotes.add(docxWriter.footnotes);
  await footnotes.flush();
  await comments.flush(review.comments);
  await target.flush();

  const report: WordExportReport = {
    notKept: [...plan.losses, ...patch.losses],
    unknownParts: await unknownParts(writer),
    keptFurniture: keptFurniture(base.structure.blocks, current),
  };
  const data = await writer.write(deflateRawSync, checkWellFormed);
  if (
    writer.changedParts().length > 0 &&
    pkg.zip.names().some((name) => name.startsWith("_xmlsignatures/"))
  ) {
    report.notKept.push(signatureLoss);
  }
  return {
    data,
    report,
    commented: review.commentedSentences(),
    footnotes: docxWriter.footnoteCount,
  };
}

const signatureLoss: WordExportLoss = {
  key: "signature",
  kind: "signature",
  author: null,
  text: "",
};

/** The width of the document's text, from its last section's page size and margins. */
function textWidthOf(root: XmlElement): number {
  const body = child(root, "w:body");
  const sectPr =
    body &&
    elements(body)
      .filter((each) => each.name === "w:sectPr")
      .at(-1);
  const size = sectPr && child(sectPr, "w:pgSz");
  const margins = sectPr && child(sectPr, "w:pgMar");
  const width = Number(size?.attrs["w:w"]);
  const left = Number(margins?.attrs["w:left"]) || 0;
  const right = Number(margins?.attrs["w:right"]) || 0;
  return width > left + right ? width - left - right : DEFAULT_WIDTH;
}

/** The header and the footer whose Blocks the Mind no longer has: they stay in the file. */
function keptFurniture(
  base: readonly NodeJSON[],
  current: readonly NodeJSON[],
): ("header" | "footer")[] {
  const kinds = (blocks: readonly NodeJSON[]) =>
    new Set(blocks.filter(isFurniture).map((node) => node.attrs?.kind as string));
  const now = kinds(current);
  return [...kinds(base)].filter(
    (kind): kind is "header" | "footer" =>
      (kind === "header" || kind === "footer") && !now.has(kind),
  );
}

/** Parts whose content type IncarnaMind doesn't know: copied as they are, and listed. */
async function unknownParts(writer: WordPackageWriter): Promise<string[]> {
  const types = await writer.part("[Content_Types].xml");
  if (!types) return [];
  const overrides = new Map<string, string>();
  const defaults = new Map<string, string>();
  for (const each of elements(types.root)) {
    if (each.name.endsWith("Override") && each.attrs.PartName) {
      overrides.set(each.attrs.PartName.slice(1), each.attrs.ContentType ?? "");
    } else if (each.name.endsWith("Default") && each.attrs.Extension) {
      defaults.set(each.attrs.Extension.toLowerCase(), each.attrs.ContentType ?? "");
    }
  }
  return writer.zip.names().filter((name) => {
    if (name.endsWith("/") || name === "[Content_Types].xml") return false;
    const type =
      overrides.get(name) ?? defaults.get(name.slice(name.lastIndexOf(".") + 1).toLowerCase());
    return type !== undefined && !KNOWN_TYPES.some((known) => known.test(type));
  });
}

/**
 * Throws unless a part written is well-formed XML with every prefix bound,
 * as xmldom (a conforming parser, unlike the reader's own) reads it.
 */
function checkWellFormed(name: string, text: string): void {
  if (!/\.(xml|rels)$/i.test(name)) return;
  const problems: string[] = [];
  try {
    new DOMParser({ onError: (_level, message) => problems.push(message) }).parseFromString(
      text.replace(/^\uFEFF/, ""),
      "text/xml",
    );
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length > 0) {
    throw new WordPartError(name, `couldn't be written as well-formed XML: ${problems[0]}`);
  }
}
