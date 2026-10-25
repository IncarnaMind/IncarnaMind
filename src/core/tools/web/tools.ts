/**
 * Web search's Tools for one Answer (#128). `search_web` searches the web
 * through the provider of the Answer's model; `read_web_page` saves a page it
 * found as a Web page Document, through #261's path, and gives that page's
 * Passages, which the Answer cites with `cite` like any other.
 *
 * - Only a page a search of the same Answer returned is read: an address the
 *   model wrote itself could carry the User's data away in it, so it is
 *   refused, saying why.
 * - A page that can't be saved says why, on its card and to the model. It is
 *   never cited: only Passages are.
 * - Both read text other people wrote, so the Run counts as having read a web
 *   page (#78): writes and sends ask from then on.
 * - Neither asks the User first. A search goes to the service the User
 *   allowed (consent asks before the first), and a page is only read, from
 *   an address the search returned.
 */
import { normaliseAddress } from "../../../shared/webAddresses";
import type { ExternalService, WebPageCall, WebPageFailureReason } from "../../api";
import { InvalidInputError } from "../../errors";
import type { WebResult } from "../../providers/webSearch";
import { type Tool, type ToolProviderInfo, WEB_TOOLS } from "..";

const PROVIDER: ToolProviderInfo = { kind: "web", id: "web", name: "Web search" };

/** What saving a page came to: its Document, which can be searched now, or why it wasn't saved. */
export type SavedPage =
  | { outcome: "saved"; documentId: string; name: string }
  | { outcome: "failed"; reason: WebPageFailureReason };

export interface WebToolsOptions {
  /** Where searches go, as consent names it. */
  service: ExternalService;
  /** The Question: what a page is read for when the model doesn't say. */
  question: string;
  /** The pages a search finds, best first. */
  search(query: string, signal: AbortSignal): Promise<WebResult[]>;
  save(address: string, signal: AbortSignal): Promise<SavedPage>;
  /** A saved page's Passages that match `query`, as the Documents' search gives them: what the model cites. */
  passages(
    documentId: string,
    query: string,
    signal: AbortSignal,
  ): Promise<{ text: string; passageCount: number }>;
  /** Hears what a call of `read_web_page` came to, for its card. */
  read(toolCallId: string, call: WebPageCall): void;
}

/** Why a page wasn't saved, as the model reads it. */
const REASONS: Record<WebPageFailureReason, string> = {
  "invalid-address": "it isn't a web address",
  unreachable: "the site can't be reached",
  "timed-out": "the site took too long to answer",
  "not-found": "the page doesn't exist",
  "needs-sign-in": "the page needs a sign-in or a subscription",
  "too-large": "the page is too large",
  "site-error": "the site answered with an error",
  "not-a-page": "it is a file, not a web page",
  video: "it is a video, with little text to read",
  "not-text": "it has too little text to read; it may need JavaScript",
  "not-public": "it is on this computer or a local network",
  "too-many-redirects": "it redirects too many times",
  "not-from-search": "search_web didn't return it in this Answer",
  "local-mode": "Local mode is on, so no page is fetched",
};

function resultsText(query: string, pages: readonly WebResult[]): string {
  if (pages.length === 0) return `The web search found no pages for "${query}".`;
  return [
    `The web search found ${pages.length} pages for "${query}". None is saved yet, and these titles aren't sources: to use a page, read it with ${WEB_TOOLS.read}, then cite the Passages it gives.`,
    "",
    ...pages.map(
      (page, index) =>
        `${index + 1}. ${page.title ?? "(no title)"}: ${page.url}${page.age ? ` (${page.age})` : ""}`,
    ),
  ].join("\n");
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidInputError(`${what} must be text.`);
  }
  return value.trim();
};

export function webTools(options: WebToolsOptions): Tool[] {
  /** The addresses this Answer's searches returned: the only pages it reads. */
  const returned = new Set<string>();

  const search: Tool = {
    name: WEB_TOOLS.search,
    description: `Searches the web through ${options.service.name} and lists the pages it finds, by title and address. Call it only when the Question asks you to search the web or online. Write the query as a search engine wants it. The list isn't a source: read a page with ${WEB_TOOLS.read} before you use it.`,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search the web for." } },
      required: ["query"],
      additionalProperties: false,
    },
    provider: PROVIDER,
    providerTool: WEB_TOOLS.search,
    title: "Search the web",
    effects: () => [
      {
        action: "network",
        scope: { kind: "service", serviceId: options.service.id, name: options.service.name },
      },
    ],
    untrustedResult: true,
    shownInput: (input) => ({ query: input.query }),
    async call(input, context) {
      const query = text(input.query, "query");
      const pages = await options.search(query, context.signal);
      for (const page of pages) returned.add(page.url);
      context.counted?.(pages.length);
      if (pages.length > 0) context.readThirdParty?.("web-page");
      return resultsText(query, pages);
    },
  };

  const read: Tool = {
    name: WEB_TOOLS.read,
    description: `Saves a page that ${WEB_TOOLS.search} found as a Document in the User's Library, and gives its Passages that match query, to cite with cite like any other Passage. Only addresses ${WEB_TOOLS.search} returned in this Answer can be read. Read each page you use, one call per page.`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: `The page's address, as ${WEB_TOOLS.search} gave it.` },
        query: {
          type: "string",
          description:
            "What to look for in the page, in the page's language; the Question when left out.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    provider: PROVIDER,
    providerTool: WEB_TOOLS.read,
    title: "Read a web page",
    // A GET of an address the search returned: nothing of the User's goes with it.
    effects: (input) => [
      {
        action: "read",
        scope: { kind: "host", host: URL.parse(String(input.url))?.hostname ?? "" },
      },
    ],
    untrustedResult: true,
    shownInput: (input) => ({ url: input.url }),
    async call(input, context) {
      const asked = text(input.url, "url");
      const address = normaliseAddress(asked) ?? asked;
      const refuse = (reason: WebPageFailureReason): never => {
        options.read(context.toolCallId, { address, failure: reason });
        throw new Error(`Couldn't save ${address}: ${REASONS[reason]}.`);
      };
      if (!returned.has(address)) return refuse("not-from-search");
      const saved = await options.save(address, context.signal);
      if (saved.outcome === "failed") return refuse(saved.reason);
      const query =
        typeof input.query === "string" && input.query.trim() ? input.query : options.question;
      let found = await options.passages(saved.documentId, query, context.signal);
      // Asked in another language than the page's, its words may be nowhere on it: its title's are.
      if (found.passageCount === 0) {
        const byTitle = await options.passages(saved.documentId, saved.name, context.signal);
        if (byTitle.passageCount > 0) {
          found = {
            ...byTitle,
            text: `Nothing on the page matched "${query}". These are its Passages that match its title; read it again with a query in the page's language to find others.\n\n${byTitle.text}`,
          };
        }
      }
      context.readThirdParty?.("web-page");
      context.counted?.(found.passageCount);
      options.read(context.toolCallId, { address, documentId: saved.documentId, name: saved.name });
      return `Saved "${saved.name}" (${address}) as a Document.\n\n${found.text}`;
    },
  };

  return [search, read];
}
