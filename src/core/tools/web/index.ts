/**
 * Web search, as Answers use it (#128): through the provider of the Answer's
 * model, behind the User's switch in Settings → Search and the consent
 * screen naming that provider; never in Local mode. The pages an Answer reads
 * are saved through #261's path with the guarded fetcher (./fetcher), filed
 * in the Folder the Question was asked in, as its Folder wall allows (#1934),
 * and read once they can be searched. The Tools themselves are in ./tools.
 */
import { searchesTheWeb } from "../../../shared/webSearch";
import type { AnswerWeb } from "../../answers";
import type {
  AnswerPlace,
  ChatModelChoice,
  ChatReadiness,
  Document,
  DocumentStatus,
  ExternalService,
  WebPageResult,
} from "../../api";
import { WebPageError } from "../../documents/web/errors";
import type { PageFetch } from "../../documents/web/fetch";
import { NotFoundError } from "../../errors";
import type { PreparedChatModel } from "../../providers/chat";
import { searchWeb } from "../../providers/webSearch";
import { createPublicFetch, type PublicFetchOptions } from "./fetcher";
import type { SavedPage } from "./tools";

/** What web search sends, and to whom: what an Answer searches for, to its model's provider. */
export const WEB_SEARCH_SENDS = ["web-searches"] as const;

export interface WebSearchOptions {
  /** The User has web search on, and Local mode off. */
  enabled(): boolean;
  readiness(model: ChatModelChoice): Promise<ChatReadiness>;
  /** The model, for the "web-search" flow, once the User has allowed it. */
  prepare(model: ChatModelChoice): Promise<PreparedChatModel>;
  /** Saves a page through #261's path with `fetch`; the caller files it. */
  savePage(address: string, fetch: PageFetch): Promise<WebPageResult>;
  /** The Folder of the Mind or conversation a Question was asked in; null for none. */
  folderOf(place: AnswerPlace): string | null;
  /** Files a new Document in a Folder. */
  file(documentId: string, folderId: string): void;
  /** A live Document; throws `NotFoundError` once it is gone. */
  document(id: string): Document;
  /** Hears each change of a Document's status. Returns a function that stops listening. */
  onStatus(listener: (document: Document) => void): () => void;
  /** The guarded fetcher's resolver and connections: tests stand a local server in for the web. */
  fetch?: PublicFetchOptions;
}

/** Statuses a page's Document can be searched in. */
const SEARCHABLE: readonly DocumentStatus[] = ["ready", "embedding", "waiting-for-model"];
/** Statuses a page's Document ends in without anything to search. */
const UNREADABLE: readonly DocumentStatus[] = ["failed", "no-text"];

export function createWebSearch(options: WebSearchOptions): AnswerWeb & { close(): Promise<void> } {
  const fetcher = createPublicFetch(options.fetch);

  /** Resolves once a Document can be searched: true, or false if it can't be, or is gone. */
  const searchable = (documentId: string, signal: AbortSignal) =>
    new Promise<boolean>((resolve, reject) => {
      const settled = (status: DocumentStatus | null): boolean => {
        if (status !== null && !SEARCHABLE.includes(status) && !UNREADABLE.includes(status)) {
          return false;
        }
        stop();
        signal.removeEventListener("abort", aborted);
        resolve(status !== null && SEARCHABLE.includes(status));
        return true;
      };
      const statusNow = (): DocumentStatus | null => {
        try {
          return options.document(documentId).status;
        } catch (error) {
          if (error instanceof NotFoundError) return null;
          throw error;
        }
      };
      const aborted = () => {
        stop();
        reject(signal.reason);
      };
      const stop = options.onStatus((document) => {
        if (document.id === documentId) settled(document.status);
      });
      if (signal.aborted) return aborted();
      signal.addEventListener("abort", aborted, { once: true });
      settled(statusNow());
    });

  return {
    async service(model: ChatModelChoice): Promise<ExternalService | null> {
      if (!options.enabled()) return null;
      const readiness = await options.readiness(model);
      if (!readiness.ready || !searchesTheWeb(readiness.provider.kind)) return null;
      return readiness.provider.service;
    },

    async search(model, query, signal) {
      const prepared = await options.prepare(model);
      return searchWeb(prepared.model, prepared.provider.kind, query, signal);
    },

    async save(address, place, signal, filing): Promise<SavedPage> {
      const filed = filing(options.folderOf(place));
      if (filed === null) return { outcome: "failed", reason: "kept-inside" };
      // Before a page saved already is used as it is: web search reads only the public internet.
      try {
        await fetcher.check(address);
      } catch (error) {
        if (error instanceof WebPageError) return { outcome: "failed", reason: error.reason };
        throw error;
      }
      const result = await options.savePage(address, fetcher.fetch);
      if (result.outcome === "failed") return { outcome: "failed", reason: result.failure.reason };
      const { document } = result;
      if (!result.existing && filed.folderId !== null) options.file(document.id, filed.folderId);
      if (!(await searchable(document.id, signal)))
        return { outcome: "failed", reason: "not-text" };
      return {
        outcome: "saved",
        documentId: document.id,
        name: options.document(document.id).name,
      };
    },

    close: () => fetcher.close(),
  };
}
