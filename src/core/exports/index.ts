/**
 * Exporting a Mind to Markdown, .docx, PDF or HTML, or its cited pages to a source pack (see
 * `CoreApi.exportMind`). The core makes the file's bytes; the host decides where they go (the
 * desktop app asks with the system save dialog), so nothing here touches the file system. A PDF
 * is printed by the host's `Printer`, from the HTML made here; an HTML file is that same
 * HTML, whole.
 */
import * as Y from "yjs";
import { layoutChart } from "../../shared/chartLayout";
import { chartSvg } from "../../shared/chartSvg";
import { seriesName } from "../../shared/charts";
import type { ResolvedCitationStyle } from "../../shared/citationStyles";
import { citationState, citedLocation, shownDocumentName } from "../../shared/citations";
import type { DrawnPage } from "../../shared/citedPage";
import { comparisonQuestionsOf } from "../../shared/comparisons";
import { formatDate } from "../../shared/dates";
import { titleWithoutSite } from "../../shared/documentNames";
import { type MessageKey, type MessageParams, translate } from "../../shared/i18n";
import type { Translate } from "../../shared/locations";
import { mindScopeOf } from "../../shared/mindScope";
import { mindName, withoutTrailingMarks } from "../../shared/naming";
import type { PrintPaper } from "../../shared/printDocument";
import { pendingProposals } from "../../shared/proposals";
import { readableQuoteText } from "../../shared/readableQuote";
import type { ScopeKind } from "../../shared/searchScope";
import { citationMarksNow, signOffsOf } from "../../shared/signOffs";
import { type SourceDocument, sourcesOf } from "../../shared/sources";
import type { UnitText } from "../../shared/units";
import {
  checkUnreadOf,
  unreadFileNamesOf,
  unreadPartsCounts,
  unreadSection,
} from "../../shared/unreadFiles";
import { verificationOf } from "../../shared/verification";
import { wordFileOf, wordImportProgressOf } from "../../shared/wordFiles";
import type { Logger, Pictures, Printer } from "../adapters";
import { checkRequests, citationSentences } from "../answers/checks/sentences";
import {
  CITATION_PLACES,
  type CitationAttributes,
  type CitationFormatRequest,
  type CitationPlace,
  COMPARISON_TABLE_NODE,
  type Document,
  EXPORT_FORMATS,
  type ExportFormat,
  type ExportMindOptions,
  type FormattedCitations,
  type KeptCitationText,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  type Mind,
  type MindExport,
  type MindExportPreview,
  type SharedDocument,
  type SharePagePreview,
  type UnreadFile,
  WORD_CHANGE_ID,
} from "../api";
import { checkedByLine } from "../checkRecord/labels";
import { citedPageKey } from "../citedPages";
import { InvalidInputError, isRecord, TranslatableError } from "../errors";
import { safeFileName } from "../fileNames";
import type { Language } from "../language";
import {
  type Block,
  countQuestions,
  type FailedCheck,
  type FailedSentence,
  type Footnote,
  footnotesIn,
  NO_MARKS,
  namedLineOf,
  type ReadOptions,
  readBlocks,
  reviewReading,
  theirChangesReading,
} from "../mindText";
import { withChangesAccepted } from "../shownChanges";
import { type CitationCard, citationCard } from "./citationCards";
import { addSources, listCitations, styleCitations, withFigureNotes } from "./citations";
import { piecesOf, renderDocx } from "./docx";
import { bodyFamily, renderHtml } from "./html";
import { exportLabels } from "./labels";
import { renderMarkdown } from "./markdown";
import { printedPdf } from "./printedPdf";
import { renderPrintHtml } from "./printHtml";
import { failedSentences } from "./sentenceChecks";
import {
  drawPictures,
  type PictureDrawn,
  type PicturePlan,
  picturedKind,
  planPicture,
} from "./sharedPictures";
import { renderSharePage, type SharePicture } from "./sharePage";
import { isUnverified, numberCitations, packPages, renderSourcePack } from "./sourcePack";
import { exportWordPatch } from "./wordPatch";
import type { ReviewChoices } from "./wordReview";

/** What a footnote needs of a live Document: a web page's site, address and fetch dates. */
type LiveDocument = SourceDocument;

export interface ExportsDependencies {
  /** The Mind; throws if it doesn't exist or was deleted. */
  mind(mindId: unknown): Mind;
  /** Reads the Mind's Blocks (see `MindContent.read`). */
  read<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T;
  /** The live Documents: a Citation whose Document was deleted can't be checked. */
  liveDocuments(): readonly (SourceDocument & Pick<Document, "reference">)[];
  /** The text kept of Documents unlinked with their Linked folder: Citations quoting it still check. */
  keptCitationTexts(): KeptCitationText[];
  /** A Citation's quote as its Document's text reads it, or null when the Document or the quote isn't there. */
  readableQuote(attributes: Partial<CitationAttributes>): string | null;
  /** The interface language, which the export's own words are in. */
  language(): Language;
  /** A Folder's, Tag's or Document's name; null for one that isn't there. */
  scopeItemName(kind: ScopeKind, id: string): string | null;
  /** The Mind's citation style (#289), and the language its text is in, which a style may take. */
  citationStyle(mindId: string): { style: ResolvedCitationStyle; textLanguage: Language };
  /** The family the Mind's font is written as in Word and HTML; null: the default. */
  font(mindId: string): string | null;
  /** The Mind's line spacing, a multiple of a single line; null: its text size's own. */
  lineSpacing(mindId: string): number | null;
  /** Whether the Mind shows its Bibliography without a citation style (#102). */
  bibliography(mindId: string): boolean;
  /** Formats Citations in a style, as the editor does (see `CoreApi.formatCitations`). */
  formatCitations(request: CitationFormatRequest): Promise<FormattedCitations>;
  /** A Citation's saved page (#133); null if none is saved. */
  citedPage(citation: Readonly<Record<string, unknown>>): Promise<DrawnPage | null>;
  /**
   * The stored text of the Units a Citation cites, of the version it quotes (`pageTexts` in
   * ../documents): what a web page to share's card shows a part of. Empty once it is gone.
   */
  citedUnits(citation: Partial<CitationAttributes>): UnitText[];
  sharePageTextOnly(mindId: string): string[];
  /** Prints a PDF; null where this copy can't. */
  printer: Printer | null;
  /** The paper a PDF is printed on, which goes by the computer's region (`paperFor`). */
  paper(): PrintPaper;
  /** Draws charts' pictures for Word; without it, a chart goes into Word as its table. */
  pictures?: Pictures;
  /** The package a Mind was imported from (#104); throws if it is gone. */
  wordPackage(mindId: string): Promise<Uint8Array>;
  /** The name the User's edits go under as tracked changes in a Word file (`Settings.author`). */
  author(): string;
  log: Logger;
  now(): string;
}

/** The text's width on A4 and on Letter, in CSS pixels, so Word never scales the picture. */
const PICTURE_WIDTH = 600;
/** Sharp when printed or zoomed. */
const PICTURE_SCALE = 2;

const EXTENSIONS: Readonly<Record<ExportFormat, string>> = {
  markdown: "md",
  docx: "docx",
  pdf: "pdf",
  "source-pack": "pdf",
  html: "html",
  "share-page": "html",
};

/**
 * What the note's file is called (#1945): the title the User gave it; else, when an Answer wrote
 * the note's first line, the Question that made it; else that line. A file name is only cut where
 * a file name can't hold it (`safeFileName`), never to a title's width, and never ends on the
 * mark a sentence does.
 */
function exportName(mind: Mind, blocks: Y.XmlFragment): string {
  // Someone else's file goes back to its author under its own name (#110).
  const verified = blocks.doc ? verificationOf(blocks.doc) : null;
  if (verified?.documentName) return verified.documentName;
  if (mind.title !== "") return mind.title;
  const { line, question } = namedLineOf(blocks);
  return withoutTrailingMarks(question || line);
}

/** A new Mind's title line left empty says nothing in a file: no empty heading at its top. */
function withoutEmptyTitle(blocks: Block[]): Block[] {
  const [first] = blocks;
  const empty =
    first?.kind === "heading" &&
    first.content.every((inline) => inline.kind === "text" && inline.text.trim() === "");
  return empty ? blocks.slice(1) : blocks;
}

// The count alone unless the Mind names the files: an export usually goes to someone else, and a
// file's name can be private.
function unreadBlocks(unread: readonly UnreadFile[], language: Language, names: boolean): Block[] {
  if (unread.length === 0) return [];
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  const line = (text: string) => ({ kind: "text" as const, text, marks: NO_MARKS });
  const section = unreadSection(unread, t, names, unreadPartsCounts(unread, t));
  return [
    { kind: "heading", level: 2, content: [line(section.heading)] },
    { kind: "paragraph", content: [line(section.count)] },
    ...(names
      ? [
          {
            kind: "list" as const,
            ordered: false,
            start: 1,
            items: section.items.map((item) => [
              { kind: "paragraph" as const, content: [line(item)] },
            ]),
          },
        ]
      : section.counts.map((count) => ({
          kind: "paragraph" as const,
          content: [line(count)],
        }))),
  ];
}

/** What an export holds, read once for both its preview and its file. */
interface Prepared {
  format: ExportFormat;
  options: Required<ExportMindOptions>;
  mindId: string;
  title: string;
  readOptions: ReadOptions;
  /** For a Mind imported from a Word file: whether its import is still going. */
  word: { importing: boolean } | null;
  blocks: Block[];
  /** What the Mind's checks couldn't read when they ran (#740); empty when all was read. */
  unread: readonly UnreadFile[];
  unreadNames: boolean;
  preview: MindExportPreview;
  failedSentences: FailedSentence[];
  trackedChanges: number;
  language: Language;
  style: ResolvedCitationStyle;
  textLanguage: Language;
  documents: readonly (SourceDocument & Pick<Document, "reference">)[];
  bibliography: boolean;
  listed: boolean;
  font: string | null;
  lineSpacing: number | null;
  /** Each Citation's footnote with the attributes it was made from, for the source pack. */
  attributesOf: ReadonlyMap<Footnote, Partial<CitationAttributes>>;
}

export function createExports(deps: ExportsDependencies) {
  /** `othersComments`: for someone else's file, the comment choice to write with instead of the Note's. */
  const prepare = (mindId: unknown, input: unknown, othersComments?: boolean): Prepared => {
    const parsed = parseExportOptions(input);
    const { format, includeQuestions } = parsed;
    const mind = deps.mind(mindId);
    const language = deps.language();
    const { style, textLanguage } = deps.citationStyle(mind.id);
    const documents = deps.liveDocuments();
    const kept = deps.keptCitationTexts();
    const attributesOf = new Map<Footnote, Partial<CitationAttributes>>();
    let checkedOf: (attributes: Partial<CitationAttributes>) => string[] = () => [];
    const footnote = (attributes: Record<string, unknown>): Footnote => {
      const cited = attributes as Partial<CitationAttributes>;
      const found = footnoteOf(cited, documents, kept, language, deps);
      const checked = checkedOf(cited);
      const note = checked.length > 0 ? { ...found, checked } : found;
      attributesOf.set(note, cited);
      return note;
    };
    const listed =
      (format === "docx" || format === "pdf") &&
      style.form === "numbered" &&
      parsed.citationPlace === "list";
    // Footnotes go right after the word, and so do Numbered's Citations and a shared page's
    // markers; a style decides for its own (./citations), and a list's `[1]` follows a space.
    const trimBeforeCitation =
      (style.form === "numbered" && !listed) || (format === "share-page" && parsed.citationCards);

    const live = new Set(documents.map((document) => document.id));
    let name = mindName(mind);
    const readOptions: ReadOptions = {
      includeQuestions,
      footnote,
      trimBeforeCitation,
      trimBeforeFootnote: true,
      comparisonText: (key, params) => translate(language, key, params),
      documentRemoved: (documentId) => !live.has(documentId),
      // A file leaves a hidden column out; the app says how many, the file says nothing.
      leaveOutHiddenColumns: true,
    };
    const {
      read,
      unread,
      unreadNames,
      questions,
      hiddenColumns,
      word,
      theirChanges,
      trackedChanges,
      othersComments: noteComments,
    } = deps.read(mind.id, (fragment) => {
      const { doc } = fragment;
      name = exportName(mind, fragment);
      const fromWord = doc !== null && wordFileOf(doc) !== null;
      // A Word file shows what is waiting as tracked changes, and can mark AI text (#107); the
      // others show someone's changes from the Word file as changes, or accepted (#734).
      if (format === "docx") readOptions.review = reviewReading(fragment);
      else if (doc && fromWord && format !== "source-pack")
        readOptions.review = theirChangesReading(doc);
      readOptions.sentenceChecks = failedSentences(fragment, {
        versions: new Map(documents.map((document) => [document.id, document.contentHash])),
        folderId: mind.folderId,
        scope: doc ? mindScopeOf(doc) : null,
        scopeItemName: deps.scopeItemName,
        sourceOf: (passage) => footnoteOf(passage, documents, kept, language, deps).source,
      });
      checkedOf = checkedLines(fragment, documents, language);
      const { review } = readOptions;
      const waiting = pendingProposals(fragment);
      return {
        read: readBlocks(fragment, readOptions),
        unread: doc ? checkUnreadOf(doc, checkRequests(fragment)) : [],
        unreadNames: doc ? unreadFileNamesOf(doc.getMap(MIND_SETTINGS_FIELD)) : false,
        questions: countQuestions(fragment),
        hiddenColumns: fragment.toArray().reduce((count, child) => {
          if (!(child instanceof Y.XmlElement) || child.nodeName !== COMPARISON_TABLE_NODE) {
            return count;
          }
          return (
            count +
            comparisonQuestionsOf(child.getAttributes()).filter(
              (question) => question.hidden === true,
            ).length
          );
        }, 0),
        word: doc && fromWord ? { importing: wordImportProgressOf(doc) !== null } : null,
        theirChanges: fromWord
          ? waiting.filter((each) => each.id.startsWith(WORD_CHANGE_ID)).length
          : 0,
        trackedChanges:
          format === "docx" && review ? waiting.filter((each) => !review.skips(each.id)).length : 0,
        othersComments: doc ? (verificationOf(doc)?.comments ?? null) : null,
      };
    });
    // Someone else's file goes back to them: comments that quote the User's Documents only when asked.
    const othersFile = noteComments !== null;
    const commentsNow = othersFile ? (othersComments ?? noteComments) : null;
    const options: Required<ExportMindOptions> =
      commentsNow !== null ? { ...parsed, commentFailedChecks: commentsNow } : parsed;
    const shown = withoutEmptyTitle(read);
    const withUnread = [...shown, ...unreadBlocks(unread, language, unreadNames)];
    const blocks =
      format !== "docx" && options.theirChanges === "accepted"
        ? withChangesAccepted(withUnread)
        : withUnread;
    // A source pack holds the Citations the Mind numbers; the others, every footnote.
    const footnotes =
      format === "source-pack"
        ? numberCitations(blocks, style.form, attributesOf).map((each) => each.footnote)
        : footnotesIn(blocks);
    const fileStem = safeFileName(name || translate(language, "mind.untitled"), "Note");
    const listedPlace: CitationPlace | null =
      (format === "docx" || format === "pdf") && style.form === "numbered" && footnotes.length > 0
        ? (options.citationPlace ?? "footnotes")
        : null;
    const preview: MindExportPreview = {
      fileName: `${format === "source-pack" ? translate(language, "export.pack.fileName", { name: fileStem }) : fileStem}.${EXTENSIONS[format]}`,
      citations: footnotes.length,
      citedDocuments: sourcesOf(
        footnotes.map((each) => attributesOf.get(each) ?? {}),
        { language, documents },
      ).length,
      numbered: style.form === "numbered",
      unverifiedCitations: footnotes.filter((each) => each.unverified).length,
      questions,
      hiddenColumns,
      fromWord: word !== null,
      theirChanges,
      unreadFiles: unread.length,
      unreadFileNames: unreadNames,
      citationPlace: listedPlace,
      markAiText: format === "docx" ? options.markAiText === true : null,
      othersFile,
      othersComments: commentsNow === true,
    };
    const failed = new Map<string, FailedSentence>();
    for (const { sentence } of piecesOf(blocks)) if (sentence) failed.set(sentence.id, sentence);
    return {
      format,
      options,
      mindId: mind.id,
      title: mindName(mind),
      readOptions,
      word,
      blocks,
      unread,
      unreadNames,
      preview,
      failedSentences: [...failed.values()],
      trackedChanges,
      language,
      style,
      textLanguage,
      documents,
      bibliography: deps.bibliography(mind.id),
      listed,
      font: deps.font(mind.id),
      lineSpacing: deps.lineSpacing(mind.id),
      attributesOf,
    };
  };

  /** The source pack's PDF: the Mind's cited pages, as saved, with their quotes marked. */
  const sourcePack = async (prepared: Prepared): Promise<MindExport> => {
    const { title, blocks, style, language, attributesOf, preview, unread, unreadNames } = prepared;
    const citations = numberCitations(blocks, style.form, attributesOf);
    if (citations.length === 0) throw new Error(translate(language, "export.pack.empty"));
    const pages = await packPages(citations, deps.citedPage);
    const data = await printedPdf(deps.printer as Printer, {
      language,
      paper: deps.paper(),
      title: preview.fileName.slice(0, -".pdf".length),
      body: renderSourcePack(title, pages, language, unread, unreadNames),
      notes: [],
    });
    return {
      ...preview,
      footnotes: 0,
      unverifiedCitations: pages.flatMap((page) => page.entries).filter(isUnverified).length,
      data,
      word: null,
      needsDetails: [],
      sentenceChecks: {
        contradicted: 0,
        notFound: 0,
        unsupported: 0,
        needsRecheck: 0,
        commented: false,
        comments: 0,
      },
      trackedChanges: 0,
    };
  };

  const shareBlocks = ({ bibliography, blocks, language, documents, readOptions }: Prepared) =>
    withFigureNotes(
      bibliography
        ? addSources(blocks, { language, documents }, translate(language, "bibliography.title"))
        : blocks,
      { footnote: readOptions.footnote, labels: exportLabels(language) },
    );

  const unitsOf = (attributes: Partial<CitationAttributes>) =>
    deps.citedUnits({
      ...attributes,
      documentId:
        citationState(attributes, deps.liveDocuments()).documentId ?? attributes.documentId ?? null,
    });

  const shareCards = async (prepared: Prepared, blocks: readonly Block[]) => {
    const { language, documents } = prepared;
    const t: Translate = (key, params) => translate(language, key, params);
    const kept = deps.keptCitationTexts();
    const pages = new Map<string, DrawnPage | null>();
    const cards: {
      footnote: Footnote;
      documentId: string | null;
      card: CitationCard;
      plan: PicturePlan | null;
    }[] = [];
    for (const footnote of footnotesIn(blocks, { inFootnotes: false })) {
      const attributes = prepared.attributesOf.get(footnote) ?? {};
      const card = citationCard(attributes, { documents, kept, units: deps.citedUnits, t });
      const key =
        picturedKind(attributes) && card.content.kind !== "missing" && citedPageKey(attributes);
      let plan: PicturePlan | null = null;
      if (key) {
        if (!pages.has(key)) pages.set(key, await deps.citedPage(attributes));
        const page = pages.get(key);
        plan = page
          ? planPicture(
              page,
              attributes,
              card.check,
              page.text.length > 0 ? [] : unitsOf(attributes),
            )
          : null;
      }
      cards.push({ footnote, documentId: attributes.documentId ?? null, card, plan });
    }
    return cards;
  };

  const renderShare = async (
    prepared: Prepared,
    blocks: readonly Block[],
    cards: ReadonlyMap<Footnote, CitationCard>,
    pictures: readonly SharePicture[] = [],
  ) => {
    const { language, preview } = prepared;
    return new TextEncoder().encode(
      renderSharePage({
        blocks: await withPictures(blocks, language, deps),
        labels: exportLabels(language),
        language,
        name: preview.fileName.slice(0, -".html".length),
        at: deps.now(),
        cards,
        pictures,
        checkedLine: prepared.options.checkedLine,
        font: prepared.font,
        lineSpacing: prepared.lineSpacing,
      }),
    );
  };

  /**
   * Draws each picture once, however many Citations show it. One that can't be drawn leaves its
   * Citations their text cards, and the rest of the page is made all the same.
   */
  const drawShared = async (plans: ReadonlyMap<string, PicturePlan & { documentId: string }>) => {
    let drawn: PictureDrawn[] = [];
    try {
      drawn = await drawPictures([...plans.values()]);
    } catch (error) {
      deps.log.error("export.sharePictures", {
        pictures: plans.size,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const pictures: SharePicture[] = [];
    const indexOf = new Map<string, number>();
    [...plans].forEach(([key, plan], at) => {
      const result = drawn[at];
      if (!result) return;
      if ("failed" in result) {
        deps.log.warn("export.sharePicture", {
          documentId: plan.documentId,
          message: result.failed,
        });
        return;
      }
      indexOf.set(key, pictures.length);
      pictures.push({ data: result.data, width: plan.width, height: plan.height });
    });
    return { pictures, indexOf };
  };

  /**
   * A web page to share: its Citations numbered as in Numbered whatever the Mind's style, since
   * its readers click a number for each, with the Bibliography only where a Numbered Mind shows
   * one. A Document the User keeps as text gives its Citations no pictures.
   */
  const sharePage = async (prepared: Prepared): Promise<Uint8Array> => {
    const blocks = shareBlocks(prepared);
    const textOnly = new Set(deps.sharePageTextOnly(prepared.mindId));
    const entries = await shareCards(prepared, blocks);
    const plans = new Map<string, PicturePlan & { documentId: string }>();
    for (const { documentId, plan } of entries) {
      if (plan && documentId !== null && !textOnly.has(documentId)) {
        plans.set(plan.key, { ...plan, documentId });
      }
    }
    const { pictures, indexOf } = await drawShared(plans);
    const cards = new Map<Footnote, CitationCard>();
    for (const { footnote, card, plan } of entries) {
      const picture = plan && plans.has(plan.key) ? indexOf.get(plan.key) : undefined;
      cards.set(
        footnote,
        plan && picture !== undefined
          ? {
              ...card,
              content: {
                kind: "picture",
                picture,
                width: plan.width,
                height: plan.height,
                slide: plan.slide,
                scan: card.content.kind === "quote" && card.content.scan,
              },
            }
          : card,
      );
    }
    return renderShare(prepared, blocks, cards, pictures);
  };

  const previewSharePage = async (mindId: unknown, options: unknown): Promise<SharePagePreview> => {
    const prepared = prepare(mindId, {
      ...(isRecord(options) ? options : {}),
      format: "share-page",
    });
    const blocks = shareBlocks(prepared);
    const textOnly = new Set(deps.sharePageTextOnly(prepared.mindId));
    const unnamed = translate(prepared.language, "export.unnamedDocument");
    const entries = await shareCards(prepared, blocks);
    const documents = new Map<string, SharedDocument & { keys: Set<string> }>();
    for (const { footnote, documentId, plan } of entries) {
      if (!documentId) continue;
      let shared = documents.get(documentId);
      if (!shared) {
        const attributes = prepared.attributesOf.get(footnote) ?? {};
        shared = {
          documentId,
          name: shownDocumentName(attributes, prepared.documents) || unnamed,
          quotes: 0,
          pictures: 0,
          pictureBytes: 0,
          textOnly: textOnly.has(documentId),
          keys: new Set(),
        };
        documents.set(documentId, shared);
      }
      shared.quotes++;
      if (plan && !shared.keys.has(plan.key)) {
        shared.keys.add(plan.key);
        shared.pictures++;
        shared.pictureBytes += plan.bytes;
      }
    }
    const text = await renderShare(
      prepared,
      blocks,
      new Map(entries.map(({ footnote, card }) => [footnote, card])),
    );
    return {
      documents: [...documents.values()].map(({ keys: _, ...shared }) => shared),
      textBytes: text.length,
    };
  };

  /** The Blocks a file or a printed page shows: a citation style's, with its Bibliography and notes. */
  const styledBlocks = async (prepared: Prepared, thin: ThinEntries) => {
    const { language, style, documents } = prepared;
    const labels = exportLabels(language);
    const figures = { footnote: prepared.readOptions.footnote, labels };
    const blocks =
      style.form !== "numbered"
        ? await styleCitations(prepared.blocks, style, thin.format, figures)
        : withFigureNotes(
            prepared.listed
              ? listCitations(
                  prepared.blocks,
                  { language, documents },
                  translate(language, "bibliography.title"),
                  labels.unverified,
                )
              : prepared.bibliography
                ? addSources(
                    prepared.blocks,
                    { language, documents },
                    translate(language, "bibliography.title"),
                  )
                : prepared.blocks,
            figures,
          );
    return { blocks, labels };
  };

  return {
    preview(mindId: unknown, options: unknown): MindExportPreview {
      return prepare(mindId, options).preview;
    },

    previewSharePage,

    /** Prints the Mind as its PDF export lays it out (#1935), on a printer the User chooses. */
    async print(mindId: unknown, options: unknown): Promise<void> {
      if (!deps.printer?.printToPrinter) {
        throw new TranslatableError({ key: "error.print.noPrinter" });
      }
      const prepared = prepare(mindId, {
        ...(isRecord(options) ? options : {}),
        format: "pdf",
      });
      const thin = thinEntries(
        (request) => deps.formatCitations({ ...request, language: prepared.textLanguage }),
        prepared.documents,
      );
      const { blocks, labels } = await styledBlocks(prepared, thin);
      const drawn = await withPictures(blocks, prepared.language, deps);
      const { body, notes } = renderPrintHtml(drawn, labels);
      try {
        await deps.printer.printToPrinter({
          language: prepared.language,
          paper: deps.paper(),
          title: prepared.preview.fileName.slice(0, -".pdf".length),
          ...(prepared.font !== null && { fontFamily: bodyFamily(prepared.font) }),
          body,
          notes,
        });
      } catch (error) {
        deps.log.error("export.printOnPrinterFailed", {
          message: error instanceof Error ? error.message : String(error),
        });
        throw new TranslatableError({ key: "error.print.failed" }, { cause: error });
      }
    },

    /** `othersComments`: for someone else's file, write with this comment choice, not the Note's (#110). */
    async export(mindId: unknown, options: unknown, othersComments?: boolean): Promise<MindExport> {
      const prepared = prepare(mindId, options, othersComments);
      const { title, preview, language, format, documents } = prepared;
      if ((format === "pdf" || format === "source-pack") && !deps.printer) {
        throw new TranslatableError({ key: "error.checkRecord.noPdf" });
      }
      if (format === "source-pack") return sourcePack(prepared);
      const thin = thinEntries(
        (request) => deps.formatCitations({ ...request, language: prepared.textLanguage }),
        documents,
      );
      if (format === "docx" && prepared.word) {
        return exportIntoWord(prepared, prepared.word, thin);
      }
      if (format === "share-page" && prepared.options.citationCards) {
        return {
          ...preview,
          footnotes: 0,
          data: await sharePage(prepared),
          word: null,
          needsDetails: [],
          ...reviewOf(prepared, [], 0),
        };
      }
      const { blocks, labels } = await styledBlocks(prepared, thin);
      let data: Uint8Array;
      let commented: readonly FailedSentence[] = [];
      let checkComments = 0;
      let footnotes = 0;
      if (format === "markdown") {
        data = new TextEncoder().encode(renderMarkdown("", blocks, labels));
      } else if (format === "docx") {
        ({ data, commented, checkComments, footnotes } = renderDocx(
          await withPictures(blocks, language, deps),
          {
            title,
            labels,
            language: language === "zh-CN" ? "zh-CN" : "en-US",
            paper: deps.paper(),
            created: deps.now(),
            review: reviewChoices(prepared, false),
            font: prepared.font,
            lineSpacing: prepared.lineSpacing,
          },
        ));
      } else if (format === "html" || format === "share-page") {
        const drawn = await withPictures(blocks, language, deps);
        data = new TextEncoder().encode(
          renderHtml(drawn, labels, {
            language,
            name: preview.fileName.slice(0, -".html".length),
            font: prepared.font,
            lineSpacing: prepared.lineSpacing,
          }),
        );
      } else {
        // Charts as Word has them: the picture, drawn at twice its size, else the table of values.
        const drawn = await withPictures(blocks, language, deps);
        const { body, notes, footnotes: printedFootnotes } = renderPrintHtml(drawn, labels);
        data = await printedPdf(deps.printer as Printer, {
          language,
          paper: deps.paper(),
          title: preview.fileName.slice(0, -".pdf".length),
          ...(prepared.font !== null && { fontFamily: bodyFamily(prepared.font) }),
          body,
          notes,
        });
        footnotes = printedFootnotes;
      }
      return {
        ...preview,
        footnotes,
        data,
        word: null,
        needsDetails: [...thin.documents],
        ...reviewOf(prepared, commented, checkComments),
      };
    },
  };

  /** What a Word file says for review (#107): the User's edits are tracked only in a file of theirs. */
  function reviewChoices(prepared: Prepared, imported: boolean): ReviewChoices {
    const { options } = prepared;
    return {
      trackAs: imported && options.trackChanges ? deps.author() : null,
      markAiText: options.markAiText,
      commentFailedChecks: options.commentFailedChecks,
      now: deps.now(),
    };
  }

  /** A Mind imported from a Word file, written back into that file (#105). */
  async function exportIntoWord(
    prepared: Prepared,
    word: NonNullable<Prepared["word"]>,
    thin: ThinEntries,
  ): Promise<MindExport> {
    if (word.importing) throw new TranslatableError({ key: "error.export.wordImporting" });
    const { language, style, documents } = prepared;
    // A copy of the Mind as it is now: typing while the file is written doesn't change it.
    const state = deps.read(prepared.mindId, (blocks) =>
      blocks.doc ? Y.encodeStateAsUpdate(blocks.doc) : null,
    );
    const doc = new Y.Doc();
    try {
      if (state) Y.applyUpdate(doc, state);
      const { data, report, commented, checkComments, footnotes } = await exportWordPatch({
        bytes: await deps.wordPackage(prepared.mindId),
        blocks: doc.getXmlFragment(MIND_CONTENT_FIELD),
        readOptions: prepared.readOptions,
        labels: exportLabels(language),
        style,
        bibliography: prepared.bibliography,
        listed: prepared.listed,
        bibliographyHeading: translate(language, "bibliography.title"),
        sources: { language, documents },
        formatCitations: thin.format,
        withPictures: (blocks) => withPictures(blocks, language, deps),
        review: reviewChoices(prepared, true),
      });
      deps.log.info("export.word", {
        notKept: report.notKept.length,
        unknownParts: report.unknownParts.length,
      });
      return {
        ...prepared.preview,
        footnotes,
        data,
        word: report,
        needsDetails: [...thin.documents],
        ...reviewOf(prepared, commented, checkComments),
      };
    } finally {
      doc.destroy();
    }
  }
}

interface ThinEntries {
  format(request: CitationFormatRequest): Promise<FormattedCitations>;
  documents: ReadonlySet<string>;
}

/**
 * The Documents the Saved line counts: those whose entry lacks authors or a date, so its words
 * are what is missing. A record missing only its title is written with the Document's name
 * instead, so it isn't counted (#1910).
 */
function thinEntries(
  format: (request: CitationFormatRequest) => Promise<FormattedCitations>,
  documents: readonly (SourceDocument & Pick<Document, "reference">)[],
): ThinEntries {
  const counted = new Set<string>();
  const byId = new Map(documents.map((document) => [document.id, document]));
  return {
    documents: counted,
    async format(request) {
      const formatted = await format(request);
      for (const entry of formatted.bibliography) {
        if (!entry.needsDetails || entry.documentId === null) continue;
        const fields = byId.get(entry.documentId)?.reference?.fields;
        if (fields && fields.authors.length > 0 && fields.issued !== "") continue;
        counted.add(entry.documentId);
      }
      return formatted;
    },
  };
}

function reviewOf(
  prepared: Prepared,
  commented: readonly FailedSentence[],
  comments: number,
): Pick<MindExport, "sentenceChecks" | "trackedChanges"> {
  const asComments = prepared.format === "docx" && prepared.options.commentFailedChecks;
  const counted = asComments ? commented : prepared.failedSentences;
  const count = (check: FailedSentence["check"]) =>
    counted.filter((each) => each.check === check).length;
  const notFound = counted.filter((each) => each.check === "unsupported" && each.notFound).length;
  return {
    sentenceChecks: {
      contradicted: count("contradicted"),
      notFound,
      // An Unsupported sentence's comment may name its own workings or a court decision instead.
      unsupported:
        count("unsupported") -
        notFound +
        count("own-workings") +
        counted.filter((each) => each.check === "cited-case-unchecked" && each.unsupported).length,
      needsRecheck: count("needs-recheck"),
      commented: asComments,
      comments: asComments ? comments : 0,
    },
    trackedChanges: prepared.trackedChanges,
  };
}

/** A picture that can't be drawn leaves the chart's table, and the log says why. */
async function withPictures(
  blocks: readonly Block[],
  language: Language,
  deps: Pick<ExportsDependencies, "pictures" | "log">,
): Promise<Block[]> {
  const { pictures } = deps;
  if (!pictures) return [...blocks];
  const draw = async (block: Extract<Block, { kind: "chart" }>): Promise<Block> => {
    const { chart } = block;
    const layout = layoutChart(chart, {
      width: PICTURE_WIDTH,
      language,
      legendInside: true,
      seriesName: (index) =>
        seriesName(chart, index, (key, params) => translate(language, key, params)),
    });
    if (layout.points.length === 0) return block;
    try {
      const png = await pictures.png(chartSvg(layout, PICTURE_SCALE));
      const kind = translate(language, `chart.kindName.${chart.kind}`);
      return {
        ...block,
        picture: {
          src: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
          alt: chart.title
            ? translate(language, "export.chart.picture", { kind, title: chart.title })
            : kind,
        },
      };
    } catch (error) {
      deps.log.warn("export.chartPicture", {
        kind: chart.kind,
        points: layout.points.length,
        message: error instanceof Error ? error.message : String(error),
      });
      return block;
    }
  };
  // One at a time: each picture opens a window of its own.
  const inOrder = async <T, U>(items: readonly T[], each: (item: T) => Promise<U>) => {
    const done: U[] = [];
    for (const item of items) done.push(await each(item));
    return done;
  };
  const visit = async (block: Block): Promise<Block> => {
    switch (block.kind) {
      case "chart":
        return draw(block);
      case "list":
        return { ...block, items: await inOrder(block.items, (item) => inOrder(item, visit)) };
      case "quote":
        return { ...block, content: await inOrder(block.content, visit) };
      default:
        return block;
    }
  };
  return inOrder(blocks, visit);
}

function parseExportOptions(input: unknown): Required<ExportMindOptions> {
  if (!isRecord(input)) throw new InvalidInputError("Export options must be an object.");
  const { format, includeQuestions, accept, theirChanges, citationPlace } = input;
  const choice = (
    name: "trackChanges" | "markAiText" | "commentFailedChecks" | "citationCards" | "checkedLine",
    absent = false,
  ) => {
    const value = input[name];
    if (value !== undefined && typeof value !== "boolean") {
      throw new InvalidInputError({ key: "error.export.choice", values: { name } });
    }
    return value ?? absent;
  };
  if (!EXPORT_FORMATS.some((each) => each === format)) {
    throw new InvalidInputError(
      'The export format must be "markdown", "docx", "pdf", "source-pack", "html" or "share-page".',
    );
  }
  if (includeQuestions !== undefined && typeof includeQuestions !== "boolean") {
    throw new InvalidInputError("includeQuestions must be true or false.");
  }
  if (theirChanges !== undefined && theirChanges !== "shown" && theirChanges !== "accepted") {
    throw new InvalidInputError({ key: "error.export.theirChanges" });
  }
  const place = CITATION_PLACES.find((each) => each === citationPlace);
  if (citationPlace !== undefined && place === undefined) {
    throw new InvalidInputError({ key: "error.export.citationPlace" });
  }
  if (
    accept !== undefined &&
    !(Array.isArray(accept) && accept.every((key) => typeof key === "string"))
  ) {
    throw new InvalidInputError("accept must be a list of what can't be kept.");
  }
  // Markdown is an archive, so it keeps Questions; the others are deliverables, so they don't.
  return {
    format: format as ExportFormat,
    includeQuestions: includeQuestions ?? format === "markdown",
    accept: accept ?? [],
    trackChanges: choice("trackChanges"),
    markAiText: choice("markAiText"),
    commentFailedChecks: choice("commentFailedChecks"),
    citationCards: choice("citationCards", true),
    checkedLine: choice("checkedLine"),
    theirChanges: theirChanges ?? "shown",
    citationPlace: place ?? "footnotes",
  };
}

/**
 * People's own checks of each Citation, as its source says them (#1933): "Checked by Ada · 28 Oct
 * 2026", and for a mark made before its text, quote or version changed, "Checked by Ada
 * before it changed · …", never as checked. There is no line for the whole document.
 */
function checkedLines(
  fragment: Y.XmlFragment,
  documents: readonly LiveDocument[],
  language: Language,
): (attributes: Partial<CitationAttributes>) => string[] {
  const marks = fragment.doc ? signOffsOf(fragment.doc) : [];
  if (!marks.some(({ target }) => target.kind === "citation")) return () => [];
  const sentences = citationSentences(fragment);
  const versions = new Map(documents.map((document) => [document.id, document.contentHash]));
  const t: Translate = (key, params) => translate(language, key, params);
  return (attributes) => {
    const sentence =
      typeof attributes.id === "string" ? sentences.get(attributes.id)?.sentence : undefined;
    if (typeof attributes.id !== "string" || sentence === undefined) return [];
    const cited = {
      documentId: attributes.documentId ?? null,
      contentHash: attributes.contentHash ?? null,
      quote: attributes.quote ?? null,
    };
    return citationMarksNow(marks, attributes.id, sentence, cited, versions, null).map((now) =>
      checkedByLine(now, (at) => formatDate(at, language), t),
    );
  };
}

/** The day a web page's version was fetched, as the interface language writes a date. */
function dayOf(at: string, language: Language): string {
  return new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(at));
}

/**
 * A Citation's footnote: its Document's name and its Location's short label,
 * e.g. "Tides, p. 12–13", "Deck, slide 4" or "Model, Revenue, rows 12–14",
 * unverified unless its badge says "Quote found". A live web page's also names
 * its site, its address and the day the quoted version was fetched, as the
 * "accessed" date citation styles read: "Tides, Tide Wiki, § History, ¶ 3,
 * https://tides.example/history, accessed 3 October 2026".
 */
export function footnoteOf(
  attributes: Partial<CitationAttributes>,
  documents: readonly LiveDocument[],
  kept: readonly KeptCitationText[],
  language: Language,
  { readableQuote }: Pick<ExportsDependencies, "readableQuote">,
): Footnote {
  const t: Translate = (key, params) => translate(language, key, params);
  const document = shownDocumentName(attributes, documents) || t("export.unnamedDocument");
  const location = citedLocation(attributes, t);
  const state = citationState(attributes, documents, kept);
  const unverified = state.check !== "found";
  const failed: FailedCheck | null =
    state.check === "not-found" || state.check === "unsupported" || state.check === "contradicted"
      ? {
          check: state.check,
          quote: attributes.quote
            ? (readableQuote(attributes) ?? readableQuoteText(attributes.quote))
            : null,
          verdict: attributes.verdict ?? null,
        }
      : null;
  const web = documents.find((each) => each.id === state.documentId)?.web;
  if (!web) {
    return {
      source: location
        ? t("export.citation.location", { document, location })
        : t("export.citation.document", { document }),
      unverified,
      ...(failed && { failed }),
    };
  }
  const version = web.versions.find((each) => each.contentHash === attributes.contentHash);
  // The site is named after the title, so a title that ends with it leaves it off.
  const parts = [titleWithoutSite(document, web.siteName)];
  if (web.siteName && web.siteName !== document) parts.push(web.siteName);
  if (location) parts.push(location);
  parts.push(web.address);
  if (version)
    parts.push(t("export.citation.accessed", { date: dayOf(version.fetchedAt, language) }));
  return {
    source: parts.join(t("export.citation.separator")),
    unverified,
    link: web.address,
    ...(failed && { failed }),
  };
}
