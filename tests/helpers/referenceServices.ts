/**
 * A local stand-in for Look up's two services (#286): Crossref's
 * `GET /works/{doi}` and arXiv's `GET /api/query?id_list=…`, answering from
 * recorded answers (tests/fixtures/references/), and, for checking reference
 * lists, Crossref's `GET /works?query.bibliographic=…` over a few
 * works, best match first by the words they share, and its
 * `GET /works/{doi}/agency`; and OpenAlex's `GET /works?search=…` and
 * `GET /works/doi:{doi}` over a few works of its own. It records every request, so
 * a test can check that nothing was sent, or only the identifier. No test
 * reaches the real services. Free of the test runner, so the smoke tests use
 * it too.
 */
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/** One request the stand-in received. */
export interface ServiceRequest {
  method: string;
  /** The path and query, as sent. */
  path: string;
  /** How many bytes of body came with it. */
  bodyLength: number;
  userAgent: string;
}

export interface ReferenceServices {
  /** The base URL of every service, e.g. "http://127.0.0.1:51234". */
  readonly url: string;
  /** Every request, in order. */
  readonly requests: ServiceRequest[];
  /**
   * Answers every request with this status from now on, or drops the
   * connection unanswered, as offline ("unreachable"); null: answer again.
   * `only`: just OpenAlex's requests.
   */
  fail(status: number | "unreachable" | null, only?: "openalex"): void;
  /**
   * Holds answers from now on until `release`, as a slow service would;
   * `reached` settles when the first held request comes in. `only`: just
   * OpenAlex's answers, or just Crossref's and arXiv's. Holds made one after
   * another are kept at once, each for its own requests.
   */
  pause(only?: "openalex" | "crossref"): { reached: Promise<void>; release(): void };
  close(): Promise<void>;
}

/** A recorded answer, from tests/fixtures/references. */
export const recordedAnswer = (name: string) =>
  readFileSync(join(__dirname, "../fixtures/references", name), "utf8");

/** A work as Crossref's JSON gives it, for the stand-in's searches and DOIs. */
export interface CrossrefWork {
  DOI: string;
  title: string[];
  author: { family: string; given: string }[];
  issued: { "date-parts": number[][] };
  "container-title"?: string[];
  type?: string;
}

/** A work as OpenAlex's JSON gives it, for the stand-in's searches and DOIs. */
export interface OpenAlexWork {
  id: string;
  doi: string | null;
  display_name: string;
  publication_date: string;
  authorships: { author: { display_name: string } }[];
}

const wordsOf = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** The works whose titles share the most words with `query`, at most five, best first. */
function bestMatches<T>(works: readonly T[], titleOf: (work: T) => string, query: string): T[] {
  const asked = wordsOf(query);
  return works
    .map((work) => {
      let shared = 0;
      for (const word of wordsOf(titleOf(work))) if (asked.has(word)) shared++;
      return { work, shared };
    })
    .filter(({ shared }) => shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 5)
    .map(({ work }) => work);
}

/**
 * Starts the stand-in. `crossref` maps DOIs to recorded Crossref answers (as
 * JSON text); `arxiv` maps arXiv ids to recorded Atom feeds; `works` are
 * searched, and answer their DOIs too, as the list holds them when each
 * request comes in (a test may change it); `registered` maps DOIs Crossref
 * has no record of to the agency that registered them ("datacite"); `openalex`
 * are OpenAlex's works, searched and answering their DOIs. Anything else is
 * a 404, as the real services answer an unknown DOI or id.
 */
export async function startReferenceServices(answers: {
  crossref?: Readonly<Record<string, string>>;
  arxiv?: Readonly<Record<string, string>>;
  works?: readonly CrossrefWork[];
  registered?: Readonly<Record<string, string>>;
  openalex?: readonly OpenAlexWork[];
}): Promise<ReferenceServices> {
  const requests: ServiceRequest[] = [];
  let failure: number | "unreachable" | null = null;
  let failOnly: "openalex" | null = null;
  const holds: {
    only: "openalex" | "crossref" | null;
    arrived(): void;
    waiting: (() => void)[];
  }[] = [];
  const isOpenAlex = (path: string) => {
    const url = new URL(path, "http://localhost");
    return (
      url.pathname.startsWith("/works/doi:") ||
      (url.pathname === "/works" && url.searchParams.has("search"))
    );
  };
  const server = createServer((request, response) => {
    let bodyLength = 0;
    request.on("data", (chunk: Buffer) => {
      bodyLength += chunk.length;
    });
    request.on("end", () => {
      const path = request.url ?? "/";
      const userAgent = request.headers["user-agent"] ?? "";
      requests.push({ method: request.method ?? "", path, bodyLength, userAgent });
      const held = holds.find(
        (hold) => hold.only === null || (hold.only === "openalex") === isOpenAlex(path),
      );
      if (held) {
        held.arrived();
        held.waiting.push(() => answer(path, response));
        return;
      }
      answer(path, response);
    });
  });
  function answer(path: string, response: ServerResponse) {
    const url = new URL(path, "http://localhost");
    const failing = failOnly === null || (failOnly === "openalex" && isOpenAlex(path));
    if (failing && failure !== null) {
      // Offline, the connection drops with no answer.
      if (failure === "unreachable") response.socket?.destroy();
      // A used-up allowance says when it resets, in seconds, as OpenAlex does.
      else
        response.writeHead(failure, failure === 429 ? { "x-ratelimit-reset": "3600" } : {}).end();
      return;
    }
    const json = (body: unknown) =>
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname.startsWith("/works/doi:")) {
      const asked = decodeURIComponent(url.pathname.slice("/works/doi:".length)).toLowerCase();
      const work = answers.openalex?.find(
        (each) => each.doi?.replace("https://doi.org/", "").toLowerCase() === asked,
      );
      if (work) json(work);
      else response.writeHead(404, { "content-type": "text/plain" }).end("Not found.");
      return;
    }
    const search = url.pathname === "/works" ? url.searchParams.get("search") : null;
    if (search !== null) {
      json({
        meta: { count: 0 },
        results: bestMatches(answers.openalex ?? [], (work) => work.display_name, search),
      });
      return;
    }
    const agencyOf = /^\/works\/(.+)\/agency$/.exec(url.pathname)?.[1];
    if (agencyOf !== undefined) {
      const asked = decodeURIComponent(agencyOf).toLowerCase();
      const agency =
        answers.works?.some((work) => work.DOI.toLowerCase() === asked) ||
        Object.keys(answers.crossref ?? {}).some((doi) => doi.toLowerCase() === asked)
          ? "crossref"
          : Object.entries(answers.registered ?? {}).find(
              ([doi]) => doi.toLowerCase() === asked,
            )?.[1];
      if (agency) {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            status: "ok",
            message: { DOI: asked, agency: { id: agency, label: agency } },
          }),
        );
      } else {
        response.writeHead(404, { "content-type": "text/plain" }).end("Resource not found.");
      }
      return;
    }
    const doi = url.pathname.startsWith("/works/")
      ? decodeURIComponent(url.pathname.slice("/works/".length))
      : null;
    const id = url.pathname === "/api/query" ? url.searchParams.get("id_list") : null;
    const work =
      doi === null
        ? undefined
        : answers.works?.find((each) => each.DOI.toLowerCase() === doi.toLowerCase());
    const crossref =
      doi === null
        ? undefined
        : (answers.crossref?.[doi] ?? (work && JSON.stringify({ status: "ok", message: work })));
    const arxiv = id === null ? undefined : answers.arxiv?.[id];
    const query = url.pathname === "/works" ? url.searchParams.get("query.bibliographic") : null;
    if (query !== null) {
      json({
        status: "ok",
        message: { items: bestMatches(answers.works ?? [], (work) => work.title[0] ?? "", query) },
      });
    } else if (crossref !== undefined) {
      response.writeHead(200, { "content-type": "application/json" }).end(crossref);
    } else if (arxiv !== undefined) {
      response.writeHead(200, { "content-type": "application/atom+xml" }).end(arxiv);
    } else {
      response.writeHead(404, { "content-type": "text/plain" }).end("Resource not found.");
    }
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    fail(status, only) {
      failure = status;
      failOnly = only ?? null;
    },
    pause(only) {
      let arrived = () => {};
      const reached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const hold = { only: only ?? null, arrived, waiting: [] as (() => void)[] };
      holds.push(hold);
      return {
        reached,
        release() {
          const index = holds.indexOf(hold);
          if (index >= 0) holds.splice(index, 1);
          for (const each of hold.waiting.splice(0)) each();
        },
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
