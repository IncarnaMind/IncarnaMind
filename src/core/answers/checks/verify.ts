/**
 * Verify (#97): a file someone else wrote, checked claim by claim against the
 * User's Documents.
 *
 * 1. `verifyDocument` adds the file to the Library, or finds it there, waits
 *    until its text is read, and makes a Mind of it: its paragraphs, and its
 *    tables as tables (#1368), with each Block's page and each table row's,
 *    all of it third-party text (#78). A deck (#3275) is read slide by slide
 *    (./verifySlides), a slide its page. A Word file (#110) is imported as a
 *    Mind instead, kept to export back into with the results as comments,
 *    and added to the Library as its original. The Mind's settings say which
 *    Document it verifies (src/shared/verification.ts).
 * 2. `findClaims` has the model name its sentences that make claims (./claims)
 *    and records them there.
 * 3. `verifyClaims` checks each claim as Check against Documents does, with
 *    the claim-check function, against the Mind's Folder, the file, its earlier
 *    versions and its copies left out (#80), in Runs third-party from their
 *    start. Each claim's mark shows its result as it comes; the monthly cap or
 *    a plan's limit stops the run, and the claims after it say so (#83). What
 *    the scope couldn't read as the run started is kept with it.
 *
 * One verify run, finding or checking, goes at a time.
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { partsToCheck } from "../../../shared/claimParts";
import { isClaim } from "../../../shared/sentences";
import { setTextOrigin } from "../../../shared/textOrigins";
import type { UnitText } from "../../../shared/units";
import {
  isVerifiedBlock,
  readVerification,
  type Verification,
  writeVerification,
} from "../../../shared/verification";
import { writeBrief } from "../../../shared/verificationBrief";
import {
  BLOCK_ID_ATTRIBUTE,
  type ChatModelChoice,
  type CheckSentencesResult,
  type ClaimCheckAttributes,
  type ClaimCheckPart,
  type ClaimCheckResult,
  type Document,
  type DocumentStatus,
  type DocumentText,
  type FindClaimsResult,
  MIND_SETTINGS_FIELD,
  type Mind,
  type ScannedText,
  type SearchScope,
  type UnreadFile,
  type VerifyClaimsResult,
  type VerifyDocumentResult,
  type WordRefusalReason,
} from "../../api";
import type { PagePart } from "../../documents/extract";
import type { SlideOutline } from "../../documents/formats/pptx";
import { parseModel } from "../../edits";
import { InvalidInputError, isRecord, NotFoundError } from "../../errors";
import type { MindContent } from "../../mindContent";
import { parseFolderChoice, parseMindId } from "../../minds";
import type { PreparedChatModel } from "../../providers/chat";
import { cellName } from "../../workbooks/parse";
import { createElement } from "../blocks";
import { answerTemperature } from "../engine";
import { markdownToBlocks } from "../markdown";
import type { ClaimCheckRequest } from "./claimCheck";
import { claimsAmong } from "./findClaims";
import { recordOpinions } from "./opinions";
import type { CheckRuns } from "./runCheck";
import { runChecks } from "./runChecks";
import {
  checkText,
  everySentence,
  markedSentences,
  markSentence,
  type SelectedSentence,
} from "./sentences";
import { askBrief } from "./verifyBrief";
import { slideBlocks } from "./verifySlides";
import { documentBlocks, tableClaim } from "./verifyTables";
import {
  cellBlockId,
  checkFormulas,
  MOST_TYPED_NUMBERS,
  parseRange,
  rangeName,
  sheetChoices,
  sheetTable,
  workbookOf,
} from "./verifyWorkbook";

/** A Document whose text is read: its Passages can be searched and its pages read. */
const READ: readonly DocumentStatus[] = ["waiting-for-model", "embedding", "ready"];

/** A workbook, checked a sheet at a time (#3278). */
const WORKBOOK_FILE = /\.xlsx$/i;

/** A file Word import takes, or refuses with its reason (an older .doc, macros). */
const WORD_FILE = /\.(?:docx|docm|doc|dotx|dotm|dot)$/i;

/** The model to verify with, or why there is none (as `checkSentences` says it). */
type Prepared =
  | { ok: true; prepared: PreparedChatModel }
  | {
      ok: false;
      result: Extract<FindClaimsResult, { kind: "not-ready" | "local-mode" | "cancelled" }>;
    };

export interface VerifyOptions extends CheckRuns {
  content: Pick<MindContent, "read" | "edit" | "readSettings">;
  /** Throws unless the Mind exists and this version may write to it. */
  requireMind(mindId: string): void;
  /** Throws unless the Folder exists. */
  requireFolder(folderId: string): void;
  /** Adds the file to the Library, new ones filed in the Folder; the Document it is, or null when it wasn't added. */
  addFile(path: string, folderId: string | null): Promise<Document | null>;
  /** Throws NotFoundError for a Document that is gone. */
  document(documentId: string): Document;
  onStatus(listener: (document: Document) => void): () => void;
  readText(documentId: string): DocumentText;
  /** A live Document's Units as the index keeps them, a workbook's formulas and saved values too (#3278). */
  readUnits(documentId: string): { contentHash: string; units: UnitText[] };
  /** A PDF's text-layer pages that hold a table, laid out (#1368); none when it can't be read again. */
  readTables(documentId: string): Promise<ReadonlyMap<number, PagePart[]>>;
  readScanned(documentId: string): ScannedText;
  /** A deck's slides, read again from its file; null for another kind of file, or when it can't be read again. */
  readSlides(documentId: string): Promise<SlideOutline[] | null>;
  createMind(title: string, folderId: string | null): Mind;
  /** Why a Word file can't be imported as a Mind; null when it can. */
  wordRefusal(path: string): Promise<WordRefusalReason | null>;
  /**
   * Imports someone else's Word file as a Mind named for its Document, the file's original in
   * the Library (#720): the Mind once its first Blocks are in it.
   */
  importWord(input: {
    path: string;
    folderId: string | null;
    documentId: string;
    name: string;
  }): Promise<{ ok: true; mind: Mind } | { ok: false; refusal: WordRefusalReason }>;
  /**
   * Whether the Mind holds every Block of the Word file it was imported from, once its import
   * has stopped; true for a Mind not imported from Word.
   */
  wordWritten(mindId: string): Promise<boolean>;
  /**
   * Takes back for good a Mind whose Word import didn't write every Block, so no Note is left
   * half made: but not one a quit stopped, which goes on at the next start, or one deleted.
   */
  discardWordMind(mindId: string): Promise<void>;
  defaultModel(): ChatModelChoice | null;
  prepare(choice: ChatModelChoice | null): Promise<Prepared>;
  evidenceScope(mindId: string, allDocuments: boolean, verification: Verification): MindCheckScope;
  /** Settles once `evidenceScope` can tell every copy of the file by its text, or `stop` aborts (#2216). */
  evidenceReady(stop: AbortSignal, mindId: string): Promise<void>;
  claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult>;
  withResult(
    check: ClaimCheckAttributes,
    result: ClaimCheckResult,
    at: string,
    blocks: Y.XmlFragment,
    mindId: string,
    sourceText?: string,
    priorParts?: readonly ClaimCheckPart[],
  ): ClaimCheckAttributes;
  /** Keeps the text of the evidence the Mind's checks show (#79). */
  retainEvidence(mindId: string): void;
  /** The files `listUnreadFiles` lists for a Search scope; null for every Document. */
  unread(scope: SearchScope | null): UnreadFile[];
  /** Runs inside the edit that adds the request's marks: what it keeps goes when no mark names it. */
  recordUnread(blocks: Y.XmlFragment, request: string, files: readonly UnreadFile[]): void;
  /** Marks a request's sentences not checked yet "stopped". */
  settleStopped(mindId: string, request: string): void;
  /** Records a request as running, so `cancelCheck` stops it; `done` when it ends. */
  track(requestId: string, mindId: string): { signal: AbortSignal; done(): void };
}

/** What a claim check of the Mind searches, and how its marks record it. */
export interface CheckScope {
  scope: ClaimCheckRequest["scope"];
  marked: ClaimCheckAttributes["scope"];
  wanted: SearchScope | null;
}

export type NoDocuments = Extract<CheckSentencesResult, { kind: "no-documents" }>;

/** Where a Mind's claims are checked: how many Documents there, and the scope. */
export interface MindCheckScope {
  searchable: number;
  folderId: string | null;
  /** What a check gives back when there are none; null while there are. */
  empty: NoDocuments | null;
  check: CheckScope;
}

const NO_FORMULAS: ReadonlySet<string> = new Set();

function formulasOf(verification: Verification): ReadonlySet<string> {
  return verification.workbook ? new Set(verification.workbook.formulaBlocks) : NO_FORMULAS;
}

function parseRequest(input: unknown) {
  if (!isRecord(input)) throw new InvalidInputError({ key: "error.verify.request" });
  const { requestId } = input;
  if (typeof requestId !== "string" || requestId === "") {
    throw new InvalidInputError({ key: "error.verify.request" });
  }
  return {
    requestId,
    mindId: parseMindId(input.mindId),
    allDocuments: input.allDocuments === true,
    model: parseModel(input.model),
  };
}

function claimOf(
  sentence: SelectedSentence,
  verification: Verification,
): ReturnType<typeof checkText> | undefined {
  const row = tableClaim(sentence, formulasOf(verification));
  if (row === "not-a-claim") return undefined;
  return row ?? checkText(sentence);
}

export function createVerify(options: VerifyOptions) {
  const { content } = options;
  /** The verify run going now: one at a time. */
  let current: { requestId: string; mindId: string } | null = null;

  /** Resolves once the Document's text is read: true, or false when it can't be (no text, or it failed). */
  const textRead = (documentId: string) =>
    new Promise<boolean>((resolve) => {
      const settled = (document: Document | null): boolean => {
        const status = document?.status ?? null;
        if (status === "queued" || status === "extracting") return false;
        stop();
        resolve(status !== null && READ.includes(status));
        return true;
      };
      const stop = options.onStatus((document) => {
        if (document.id === documentId) settled(document);
      });
      try {
        settled(options.document(documentId));
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          stop();
          throw error;
        }
        settled(null);
      }
    });

  const verificationOf = (mindId: string): Verification => {
    const verification = content.readSettings(mindId, readVerification);
    if (!verification) throw new InvalidInputError({ key: "error.verify.notVerifying" });
    return verification;
  };

  /** Runs one verify request at a time, recorded so `cancelCheck` stops it. */
  async function oneAtATime<T>(
    requestId: string,
    mindId: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | { kind: "busy"; mindId: string }> {
    if (current) return { kind: "busy", mindId: current.mindId };
    current = { requestId, mindId };
    const tracked = options.track(requestId, mindId);
    try {
      return await run(tracked.signal);
    } finally {
      tracked.done();
      current = null;
    }
  }

  function sortingInput(mindId: string, verification: Verification) {
    const sentences = content.read(mindId, (blocks) =>
      everySentence(blocks).flatMap((sentence) => {
        if (!blocks.doc || !isVerifiedBlock(blocks.doc, verification, sentence.blockId)) return [];
        const said = claimOf(sentence, verification)?.claim;
        return said !== undefined && isClaim(said) ? [{ ...sentence, said }] : [];
      }),
    );
    return {
      sentences,
      snapshot: JSON.stringify(
        sentences.map(({ blockId, occurrence, text, said }) => [blockId, occurrence, text, said]),
      ),
    };
  }

  async function findClaims(
    mindId: string,
    model: ChatModelChoice | null,
    signal: AbortSignal,
  ): Promise<FindClaimsResult> {
    const verification = verificationOf(mindId);
    // Claims found in part of the file would leave the rest unchecked for good.
    if (!(await options.wordWritten(mindId))) {
      throw new InvalidInputError({ key: "error.verify.notAllRead" });
    }
    const { empty } = options.evidenceScope(mindId, false, verification);
    if (empty) return empty;
    const ready = await options.prepare(model ?? options.defaultModel());
    if (!ready.ok) return ready.result;
    if (signal.aborted) return { kind: "cancelled" };

    const { sentences, snapshot } = sortingInput(mindId, verification);
    const found = await claimsAmong(
      ready.prepared,
      sentences.map((each) => ({ text: each.said })),
      "someone-else",
      signal,
    );
    if (found.kind !== "found") return found;
    const sorted = (sentence: (typeof sentences)[number], index: number) => {
      const plans = found.parts.get(index);
      return plans === undefined || sentence.said !== sentence.text
        ? plans
        : partsToCheck(sentence.said, plans, sentence.figures ?? [], sentence.projection);
    };
    const claims = sentences.flatMap((sentence, index) => {
      const plans = sorted(sentence, index);
      if (!found.undecided.has(index) && !plans?.some((part) => part.kind === "fact")) return [];
      const parts =
        sentence.said !== sentence.text
          ? [{ kind: "fact" as const, span: { start: 0, end: sentence.text.length } }]
          : plans === undefined
            ? undefined
            : [...plans];
      return [
        {
          blockId: sentence.blockId,
          text: sentence.text,
          occurrence: sentence.occurrence,
          ...(parts && { parts }),
        },
      ];
    });
    content.edit(mindId, (blocks) => {
      const settings = blocks.doc?.getMap<unknown>(MIND_SETTINGS_FIELD);
      const now = settings && readVerification(settings);
      if (settings && now) writeVerification(settings, { ...now, claims, sortedText: snapshot });
      recordOpinions(
        blocks,
        sentences.flatMap((sentence, index) => {
          const parts = sorted(sentence, index);
          return sentence.said === sentence.text &&
            parts !== undefined &&
            !found.undecided.has(index)
            ? [{ ...sentence, parts }]
            : [];
        }),
      );
    });
    // The brief rides the same request's consent and model, and never holds the check up: the card
    // fills it in when it lands, and a brief that can't be written only logs.
    const briefClaims = claims.map((claim, index) => ({
      number: index + 1,
      ...(verification.pages[claim.blockId] !== undefined && {
        page: verification.pages[claim.blockId],
      }),
      text: claim.text,
      sentence: {
        blockId: claim.blockId,
        text: claim.text,
        ...(claim.occurrence !== undefined && { occurrence: claim.occurrence }),
      },
    }));
    void askBrief(
      ready.prepared.model,
      briefClaims,
      snapshot,
      signal,
      answerTemperature(ready.prepared.capabilities.facts.temperature),
    )
      .then((brief) => {
        if (!brief) return;
        content.edit(mindId, (blocks) => {
          const settings = blocks.doc?.getMap<unknown>(MIND_SETTINGS_FIELD);
          if (settings) writeBrief(settings, brief);
        });
      })
      .catch((error: unknown) => {
        console.error("The brief of a verified document couldn't be kept.", error);
      });
    options.retainEvidence(mindId);
    return { kind: "found", claims: verificationOf(mindId).claims?.length ?? 0 };
  }

  async function verifyClaims(
    input: ReturnType<typeof parseRequest>,
    signal: AbortSignal,
  ): Promise<VerifyClaimsResult> {
    const { mindId, requestId } = input;
    let verification = verificationOf(mindId);
    if (verification.sortedText !== sortingInput(mindId, verification).snapshot) {
      const found = await findClaims(mindId, input.model, signal);
      if (found.kind !== "found") return found;
      verification = verificationOf(mindId);
    }
    if (signal.aborted || verification.sortedText !== sortingInput(mindId, verification).snapshot)
      return { kind: "cancelled" };
    if (!verification.claims || verification.claims.length === 0) return { kind: "nothing" };
    await options.evidenceReady(signal, mindId);
    if (signal.aborted) return { kind: "cancelled" };
    const { empty, check } = options.evidenceScope(mindId, input.allDocuments, verification);
    if (empty) return empty;
    const ready = await options.prepare(input.model ?? options.defaultModel());
    if (!ready.ok) return ready.result;
    if (signal.aborted || verification.sortedText !== sortingInput(mindId, verification).snapshot)
      return { kind: "cancelled" };

    const startedAt = options.now().toISOString();
    const claims = verification.claims;
    const unread = options.unread(check.wanted);
    const queued = content.edit(mindId, (blocks) => {
      const sentences = everySentence(blocks);
      const marked = claims.flatMap((claim) => {
        const sentence = sentences.find(
          (each) =>
            each.blockId === claim.blockId &&
            each.text === claim.text &&
            each.occurrence === (claim.occurrence ?? 0),
        );
        if (!sentence) return [];
        const owners = markedSentences(blocks).filter(
          (mark) =>
            mark.element === sentence.element && mark.from < sentence.to && mark.to > sentence.from,
        );
        const previous = owners.find((mark) => mark.check.text === sentence.text)?.check.parts;
        const priorParts = owners.length === 1 ? owners[0]?.check.parts : undefined;
        const marked: ClaimCheckAttributes = {
          id: randomUUID(),
          request: requestId,
          action: "check-against-documents",
          state: "checking",
          reason: null,
          detail: null,
          providerId: ready.prepared.provider.id,
          modelId: ready.prepared.modelId,
          text: sentence.text,
          evidence: null,
          says: null,
          unsupported: null,
          calculation: null,
          citedCaseUnchecked: false,
          citedCaseFound: false,
          scope: check.marked,
          versions: [],
          excluded: [],
          checkedAt: startedAt,
        };
        const said = claimOf(sentence, verification) ?? {
          claim: sentence.text,
          context: sentence.context,
        };
        const contextualRow = said.claim !== sentence.text;
        const row =
          sentence.element.parent instanceof Y.XmlElement ? sentence.element.parent.parent : null;
        const rowFigures =
          contextualRow && row instanceof Y.XmlElement && row.nodeName === "tableRow"
            ? sentences
                .filter(
                  (each) =>
                    each.element.parent instanceof Y.XmlElement &&
                    each.element.parent.parent === row,
                )
                .flatMap((each) => each.figures ?? [])
            : sentence.figures;
        const worked = (rowFigures ?? []).filter(
          (figure) => figure.calculated !== null || figure.analysisRecord?.label !== undefined,
        );
        markSentence(sentence.element, sentence.from, sentence.to, marked);
        return [
          {
            id: marked.id,
            ...said,
            ...(previous && { previous }),
            ...(priorParts && { priorParts }),
            ...(worked.length > 0 && { figures: worked }),
          },
        ];
      });
      if (marked.length > 0) options.recordUnread(blocks, requestId, unread);
      return marked;
    });
    if (queued.length === 0) return { kind: "nothing" };

    const { checked, stop } = await runChecks(options, {
      mindId,
      requestId,
      queued,
      scope: check.scope,
      prepared: ready.prepared,
      thirdParty: [{ via: "read", source: "checked-document" }],
      signal,
    });
    if (signal.aborted) {
      options.settleStopped(mindId, requestId);
      return { kind: "cancelled" };
    }
    return { kind: "checked", claims: queued.length, checked, stop };
  }

  /**
   * A Word file as a Mind imported from it, refused before anything is added, its original the
   * Document it verifies; every Block is the document being checked.
   */
  async function verifyWordFile(
    path: string,
    folderId: string | null,
  ): Promise<VerifyDocumentResult> {
    const refusal = await options.wordRefusal(path);
    if (refusal) return { ok: false, reason: "word", refusal };
    const document = await options.addFile(path, folderId);
    if (!document) return { ok: false, reason: "word", refusal: "unreadable" };
    const { name } = options.document(document.id);
    const made = await options.importWord({ path, folderId, documentId: document.id, name });
    if (!made.ok) return { ok: false, reason: "word", refusal: made.refusal };
    // Recorded before the rest is written, so an import a quit cut short still verifies.
    content.edit(made.mind.id, (blocks) => {
      if (!blocks.doc) return;
      writeVerification(blocks.doc.getMap(MIND_SETTINGS_FIELD), {
        documentId: document.id,
        documentName: name,
        pages: {},
        claims: null,
        comments: false,
      });
    });
    if (!(await options.wordWritten(made.mind.id))) {
      await options.discardWordMind(made.mind.id);
      return { ok: false, reason: "word", refusal: "unreadable" };
    }
    content.edit(made.mind.id, (blocks) => {
      if (!blocks.doc) return;
      const ids = blocks.toArray().flatMap((each) => {
        const id = each instanceof Y.XmlElement ? each.getAttribute(BLOCK_ID_ATTRIBUTE) : null;
        return typeof id === "string" ? [id] : [];
      });
      setTextOrigin(blocks.doc, ids, "checked-document");
    });
    return { ok: true, mind: made.mind, documentId: document.id };
  }

  /**
   * A workbook's sheet, or a range of it, as a Note's one table (#3278): each row a claim on its
   * typed-in numbers, every formula worked out again and the results that differ kept with the
   * Mind. Without a sheet, the sheets are listed to choose from, and nothing is made.
   */
  async function verifyWorkbookFile(
    path: string,
    folderId: string | null,
    chosen: { sheet: unknown; range: unknown },
  ): Promise<VerifyDocumentResult> {
    const document = await options.addFile(path, folderId);
    if (!document) return { ok: false, reason: "unreadable" };
    if (!(await textRead(document.id))) {
      const now = options.document(document.id);
      return { ok: false, reason: now.status === "no-text" ? "no-text" : "unreadable" };
    }
    const { name } = options.document(document.id);
    const { contentHash, units } = options.readUnits(document.id);
    const model = workbookOf(document.id, contentHash, units);
    if (!model) return { ok: false, reason: "no-text" };
    if (chosen.sheet === undefined) {
      return {
        ok: false,
        reason: "choose-sheet",
        documentId: document.id,
        sheets: sheetChoices(model),
      };
    }
    const sheet =
      typeof chosen.sheet === "string" ? model.byName.get(chosen.sheet.toUpperCase()) : null;
    const range =
      typeof chosen.range === "string" && chosen.range.trim() !== ""
        ? parseRange(chosen.range)
        : null;
    if (!sheet || (typeof chosen.range === "string" && chosen.range.trim() !== "" && !range)) {
      return { ok: false, reason: "range" };
    }
    const table = sheetTable(sheet, range);
    if (table.typed > MOST_TYPED_NUMBERS) {
      return { ok: false, reason: "too-many", typed: table.typed, most: MOST_TYPED_NUMBERS };
    }
    if (table.typed === 0 && table.formulas === 0) return { ok: false, reason: "no-text" };

    const formulas = await checkFormulas(model, sheet, range);
    const page = units.find((unit) => unit.label?.sheet === sheet.name)?.page ?? 1;
    const mind = options.createMind(name, folderId);
    content.edit(mind.id, (blocks) => {
      const doc = blocks.doc;
      if (!doc) return;
      const elements = [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            { type: "text", text: range ? `${sheet.name}!${rangeName(range)}` : sheet.name },
          ],
        },
        table.node,
      ].map((node) => createElement(node));
      blocks.insert(0, elements);
      const pages: Record<string, number> = {};
      for (const element of elements) {
        for (const each of [element, ...element.createTreeWalker(() => true)]) {
          const id = each instanceof Y.XmlElement ? each.getAttribute(BLOCK_ID_ATTRIBUTE) : null;
          if (typeof id === "string") pages[id] = page;
        }
      }
      setTextOrigin(doc, Object.keys(pages), "checked-document");
      const grid = elements[1];
      const formulaBlocks = table.rows.flatMap((row, at) =>
        row.formulas.flatMap((column) => {
          const id = grid && cellBlockId(grid, table, at, column);
          return id ? [id] : [];
        }),
      );
      const differs = formulas.differs.flatMap((each) => {
        const id =
          grid &&
          cellBlockId(
            grid,
            table,
            table.rows.findIndex((row) => row.row === each.row),
            table.columns.indexOf(each.column),
          );
        return id
          ? [
              {
                blockId: id,
                cell: cellName(each.row, each.column),
                saved: each.saved,
                worked: each.worked,
              },
            ]
          : [];
      });
      writeVerification(doc.getMap(MIND_SETTINGS_FIELD), {
        documentId: document.id,
        documentName: name,
        pages,
        claims: null,
        comments: false,
        workbook: {
          sheet: sheet.name,
          range: range ? rangeName(range) : null,
          formulaBlocks,
          checked: formulas.checked,
          unchecked: formulas.unchecked,
          differs,
        },
      });
    });
    return { ok: true, mind, documentId: document.id };
  }

  return {
    async verifyDocument(input: unknown): Promise<VerifyDocumentResult> {
      if (!isRecord(input)) throw new InvalidInputError({ key: "error.verify.request" });
      const { path } = input;
      if (typeof path !== "string" || path.trim() === "") {
        throw new InvalidInputError({ key: "error.verify.noPath" });
      }
      const folderId = parseFolderChoice(input.folderId);
      if (folderId !== null) options.requireFolder(folderId);
      if (WORD_FILE.test(path)) return verifyWordFile(path, folderId);
      if (WORKBOOK_FILE.test(path)) {
        return verifyWorkbookFile(path, folderId, { sheet: input.sheet, range: input.range });
      }

      const document = await options.addFile(path, folderId);
      if (!document) return { ok: false, reason: "unreadable" };
      if (!(await textRead(document.id))) {
        const now = options.document(document.id);
        if (now.status === "no-text") return { ok: false, reason: "no-text" };
        const locked = now.failure?.reason === "password-protected";
        return { ok: false, reason: locked ? "password-protected" : "unreadable" };
      }
      const text = options.readText(document.id);
      const { name, kind } = options.document(document.id);
      // A Markdown file keeps its own shape: its headings are headings, not "#" in a paragraph (#2771).
      const markdown = kind === "markdown";
      const slides = markdown ? null : await options.readSlides(document.id);
      const found = markdown
        ? []
        : slides
          ? slideBlocks(slides)
          : documentBlocks(
              text.pages,
              await options.readTables(document.id),
              options.readScanned(document.id).pages,
            );
      if (markdown) {
        if (!text.pages.some((each) => each.text.trim() !== ""))
          return { ok: false, reason: "no-text" };
      } else if (found.length === 0) return { ok: false, reason: "no-text" };

      const mind = options.createMind(name, folderId);
      content.edit(mind.id, (blocks) => {
        const doc = blocks.doc;
        if (!doc) return;
        const nodes = markdown
          ? markdownToBlocks(text.pages.map((each) => each.text).join("\n\n"))
          : found.map(({ node }) => node);
        const elements = nodes.map((node) => createElement(node));
        blocks.insert(0, elements);
        const pages: Record<string, number> = {};
        const record = (element: Y.XmlElement, page: number | undefined) => {
          if (page === undefined) return;
          for (const each of [element, ...element.createTreeWalker(() => true)]) {
            const id = each instanceof Y.XmlElement ? each.getAttribute(BLOCK_ID_ATTRIBUTE) : null;
            if (typeof id === "string") pages[id] = page;
          }
        };
        elements.forEach((element, index) => {
          if (markdown) {
            record(element, text.pages[0]?.page ?? 1);
            return;
          }
          const shown = found[index]?.pages ?? [];
          record(element, shown[0]);
          // A table over two pages: each row's cells have the page the row is on.
          element.toArray().forEach((row, at) => {
            if (row instanceof Y.XmlElement) record(row, shown[at]);
          });
        });
        setTextOrigin(doc, Object.keys(pages), "checked-document");
        writeVerification(doc.getMap(MIND_SETTINGS_FIELD), {
          documentId: document.id,
          documentName: name,
          pages,
          claims: null,
          comments: false,
        });
      });
      return { ok: true, mind, documentId: document.id };
    },

    async findClaims(input: unknown): Promise<FindClaimsResult> {
      const parsed = parseRequest(input);
      options.requireMind(parsed.mindId);
      return oneAtATime(parsed.requestId, parsed.mindId, (signal) =>
        findClaims(parsed.mindId, parsed.model, signal),
      );
    },

    async verifyClaims(input: unknown): Promise<VerifyClaimsResult> {
      const parsed = parseRequest(input);
      options.requireMind(parsed.mindId);
      return oneAtATime(parsed.requestId, parsed.mindId, (signal) => verifyClaims(parsed, signal));
    },
  };
}
