/**
 * The fetcher a saved page and web search use: a `fetch` for
 * `fetchPage` (../../documents/web/fetch) that reaches only the public
 * internet. #261's limits still apply (20 seconds, 10 MB, no cookies, the
 * page alone).
 *
 * - Every connection goes through an undici `Agent` whose connect-time
 *   lookup gives only public unicast addresses (./addresses), so DNS
 *   rebinding finds nothing to connect to. A host written as an IP address
 *   skips the lookup, so it is checked before each request.
 * - Redirects are followed here, at most `MAX_REDIRECTS`, each address
 *   checked again.
 * - No proxy: the Agent connects directly, whatever the environment says.
 */
import { isIP, type LookupFunction } from "node:net";
import { Agent, type buildConnector, fetch as undiciFetch } from "undici";
import { WebPageError } from "../../documents/web/errors";
import type { PageFetch, PageRequest } from "../../documents/web/fetch";
import {
  NotPublicError,
  publicAddresses,
  publicOnlyLookup,
  type Resolve,
  systemResolve,
} from "./addresses";

export const MAX_REDIRECTS = 5;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface PublicFetchOptions {
  /** Resolves host names; the system's resolver by default. */
  resolve?: Resolve;
  /**
   * Makes each connection, given the guarded lookup to make it with: undici's
   * own by default. Tests stand a local server in for the web here; the
   * lookup still decides which hosts are reached.
   */
  connector?: (lookup: LookupFunction) => buildConnector.connector;
}

export interface PublicFetch {
  fetch: PageFetch;
  /**
   * Refuses, as `fetch` would before any request, an address that isn't
   * http or https or is written as an address that isn't public: for a page
   * saved already, which is used without fetching it.
   */
  check(address: string): Promise<void>;
  close(): Promise<void>;
}

/** The cause in an error's chain that the guard refused, if any. */
function refusal(error: unknown): NotPublicError | null {
  for (let each: unknown = error; each instanceof Error; each = each.cause) {
    if (each instanceof NotPublicError) return each;
  }
  return null;
}

const notPublic = (host: string, cause?: unknown) =>
  new WebPageError("not-public", `${host} is on this computer or a local network.`, { cause });

/** A web address the fetcher may request: http or https, at a host that isn't refused as written. */
async function checked(address: string, resolve: Resolve): Promise<URL> {
  const url = URL.parse(address);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new WebPageError("invalid-address", "Only http and https addresses are fetched.");
  }
  if (isIP(url.hostname.replace(/^\[(.*)\]$/, "$1")) !== 0) {
    await publicAddresses(url.hostname, resolve).catch((error: unknown) => {
      throw notPublic(url.hostname, error);
    });
  }
  return url;
}

export function createPublicFetch(options: PublicFetchOptions = {}): PublicFetch {
  const resolve = options.resolve ?? systemResolve;
  const lookup = publicOnlyLookup(resolve);
  const agent = new Agent({ connect: options.connector ? options.connector(lookup) : { lookup } });

  const request = async (url: URL, init: PageRequest) => {
    try {
      return await undiciFetch(url, { ...init, redirect: "manual", dispatcher: agent });
    } catch (error) {
      const refused = refusal(error);
      if (refused) throw notPublic(url.hostname, refused);
      throw error;
    }
  };

  const publicFetch: PageFetch = async (address, init) => {
    let url = await checked(address, resolve);
    for (let redirects = 0; ; redirects++) {
      const response = await request(url, init);
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || location === null) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      if (redirects === MAX_REDIRECTS) {
        throw new WebPageError(
          "too-many-redirects",
          `The page redirected more than ${MAX_REDIRECTS} times.`,
        );
      }
      url = await checked(new URL(location, url).href, resolve);
    }
  };

  return {
    fetch: publicFetch,
    check: async (address) => {
      await checked(address, resolve);
    },
    close: () => agent.close(),
  };
}
