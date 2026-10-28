/**
 * Verify (#97): a PDF someone else wrote, checked claim by claim against the
 * User's Documents.
 *
 * 1. `verifyDocument` adds the PDF to the Library, or finds it there, waits
 *    until its text is read, and makes a Mind of it: its paragraphs, and its
 *    tables as tables (#1368), with each Block's page and each table row's,
 *    all of it third-party text (#78). The Mind's settings say which
 *    Document it verifies (src/shared/verification.ts).
 * 2. `findClaims` has the model name its sentences that make claims (./claims)
 *    and records them there.
 * 3. `verifyClaims` checks each claim as Check against Documents does, with
 *    the claim-check function, against the Mind's Folder, the PDF, its earlier
 *    versions and its copies left out (#80), in Runs third-party from their
 *    start. Each claim's mark shows its result as it comes; the monthly cap or
 *    a plan's limit stops the run, and the claims after it say so (#83). What
 *    the scope couldn't read as the run started is kept with it.
 *
 * One verify run, finding or checking, goes at a time.
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { isClaim } from "../../../shared/sentences";
import { setTextOrigin } from "../../../shared/textOrigins";
import {
  readVerification,
  type Verification,
  writeVerification,
} from "../../../shared/verification";
import {
  BLOCK_ID_ATTRIBUTE,
  type ChatModelChoice,
  type CheckSentencesResult,
  type ClaimCheckAttributes,
  type ClaimCheckResult,
  type Document,
  type DocumentStatus,
  type DocumentText,
  type FindClaimsResult,
  MIND_SETTINGS_FIELD,
  type Mind,
  type RecordAiUseInput,
  type ScannedText,
  type SearchScope,
  type UnreadFile,
  type VerifyClaimsResult,
  type VerifyDocumentResult,
} from "../../api";
import type { PagePart } from "../../documents/extract";
import { parseModel } from "../../edits";
import { InvalidInputError, isRecord, NotFoundError } from "../../errors";
import type { MindContent } from "../../mindContent";
import { parseFolderChoice, parseMindId } from "../../minds";
import type { PreparedChatModel } from "../../providers/chat";
import { createElement } from "../blocks";
import type { ClaimCheckRequest } from "./claimCheck";
import { claimsAmong } from "./findClaims";
import { runChecks } from "./runChecks";
import { everySentence, markSentence, type SelectedSentence } from "./sentences";
import { documentBlocks, tableClaim } from "./verifyTables";

/** A Document whose text is read: its Passages can be searched and its pages read. */
const READ: readonly DocumentStatus[] = ["waiting-for-model", "embedding", "ready"];

/** The model to verify with, or why there is none (as `checkSentences` says it). */
type Prepared =
  | { ok: true; prepared: PreparedChatModel }
  | {
      ok: false;
      result: Extract<FindClaimsResult, { kind: "not-ready" | "local-mode" | "cancelled" }>;
    };

export interface VerifyOptions {
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
  /** A PDF's text-layer pages that hold a table, laid out (#1368); none when it can't be read again. */
  readTables(documentId: string): Promise<ReadonlyMap<number, PagePart[]>>;
  readScanned(documentId: string): ScannedText;
  createMind(title: string, folderId: string | null): Mind;
  defaultModel(): ChatModelChoice | null;
  prepare(choice: ChatModelChoice | null): Promise<Prepared>;
  evidenceScope(mindId: string, allDocuments: boolean, verification: Verification): MindCheckScope;
  claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult>;
  withResult(
    check: ClaimCheckAttributes,
    result: ClaimCheckResult,
    at: string,
  ): ClaimCheckAttributes;
  /** Keeps the text of the evidence the Mind's checks show (#79). */
  retainEvidence(mindId: string): void;
  recordAiUse(inputs: RecordAiUseInput[]): void;
  /** The files `listUnreadFiles` lists for a Search scope; null for every Document. */
  unread(scope: SearchScope | null): UnreadFile[];
  /** Runs inside the edit that adds the request's marks: what it keeps goes when no mark names it. */
  recordUnread(blocks: Y.XmlFragment, request: string, files: readonly UnreadFile[]): void;
  /** Marks a request's sentences not checked yet "stopped". */
  settleStopped(mindId: string, request: string): void;
  /** Records a request as running, so `cancelCheck` stops it; `done` when it ends. */
  track(requestId: string, mindId: string): { signal: AbortSignal; done(): void };
  now(): Date;
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

function claimOf(sentence: SelectedSentence): { claim: string; context: string } | undefined {
  const row = tableClaim(sentence);
  if (row === "not-a-claim") return undefined;
  return row ?? { claim: sentence.text, context: sentence.context };
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

  async function findClaims(
    mindId: string,
    model: ChatModelChoice | null,
    signal: AbortSignal,
  ): Promise<FindClaimsResult> {
    const verification = verificationOf(mindId);
    const { empty } = options.evidenceScope(mindId, false, verification);
    if (empty) return empty;
    const ready = await options.prepare(model ?? options.defaultModel());
    if (!ready.ok) return ready.result;
    if (signal.aborted) return { kind: "cancelled" };

    const sentences = content.read(mindId, (blocks) =>
      everySentence(blocks).flatMap((sentence) => {
        if (!(sentence.blockId in verification.pages)) return [];
        const said = claimOf(sentence)?.claim;
        return said !== undefined && isClaim(said)
          ? [{ blockId: sentence.blockId, text: sentence.text, said }]
          : [];
      }),
    );
    const found = await claimsAmong(
      ready.prepared,
      sentences.map((each) => each.said),
      "someone-else",
      signal,
    );
    if (found.kind !== "found") return found;
    const claims = sentences
      .filter((_, index) => found.claims.has(index))
      .map(({ blockId, text }) => ({ blockId, text }));
    content.edit(mindId, (blocks) => {
      const settings = blocks.doc?.getMap<unknown>(MIND_SETTINGS_FIELD);
      const now = settings && readVerification(settings);
      if (settings && now) writeVerification(settings, { ...now, claims });
    });
    return { kind: "found", claims: claims.length };
  }

  async function verifyClaims(
    input: ReturnType<typeof parseRequest>,
    signal: AbortSignal,
  ): Promise<VerifyClaimsResult> {
    const { mindId, requestId } = input;
    const verification = verificationOf(mindId);
    if (!verification.claims || verification.claims.length === 0) return { kind: "nothing" };
    const { empty, check } = options.evidenceScope(mindId, input.allDocuments, verification);
    if (empty) return empty;
    const ready = await options.prepare(input.model ?? options.defaultModel());
    if (!ready.ok) return ready.result;
    if (signal.aborted) return { kind: "cancelled" };

    const startedAt = options.now().toISOString();
    const claims = verification.claims;
    const unread = options.unread(check.wanted);
    const queued = content.edit(mindId, (blocks) => {
      const sentences = everySentence(blocks);
      const marked = claims.flatMap((claim) => {
        const sentence = sentences.find(
          (each) => each.blockId === claim.blockId && each.text === claim.text,
        );
        if (!sentence) return [];
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
          correction: null,
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
        markSentence(sentence.element, sentence.from, sentence.to, marked);
        const said = claimOf(sentence) ?? { claim: sentence.text, context: sentence.context };
        return [{ id: marked.id, ...said }];
      });
      if (marked.length > 0) options.recordUnread(blocks, requestId, unread);
      return marked;
    });
    if (queued.length === 0) return { kind: "nothing" };

    const { checked, stop } = await runChecks(options, {
      mindId,
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

  return {
    async verifyDocument(input: unknown): Promise<VerifyDocumentResult> {
      if (!isRecord(input)) throw new InvalidInputError({ key: "error.verify.request" });
      const { path } = input;
      if (typeof path !== "string" || path.trim() === "") {
        throw new InvalidInputError({ key: "error.verify.noPath" });
      }
      const folderId = parseFolderChoice(input.folderId);
      if (folderId !== null) options.requireFolder(folderId);

      const document = await options.addFile(path, folderId);
      if (!document) return { ok: false, reason: "unreadable" };
      if (!(await textRead(document.id))) {
        const now = options.document(document.id);
        return { ok: false, reason: now.status === "no-text" ? "no-text" : "unreadable" };
      }
      const text = options.readText(document.id);
      const found = documentBlocks(
        text.pages,
        await options.readTables(document.id),
        options.readScanned(document.id).pages,
      );
      if (found.length === 0) return { ok: false, reason: "no-text" };

      const { name } = options.document(document.id);
      const mind = options.createMind(name, folderId);
      content.edit(mind.id, (blocks) => {
        const doc = blocks.doc;
        if (!doc) return;
        const elements = found.map(({ node }) => createElement(node));
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
