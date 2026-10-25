import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";
import type { Core, Embedder, EmbeddingModelSource, EmbeddingModelStatus } from "../../src/core";
import { createFakeEmbedder } from "../../src/core/embedding/fake";

/** What the fake model server does with requests for one file. */
export interface FileBehaviour {
  /** Sends other bytes of the same size: the download fails its SHA-256 check. */
  corrupt?: boolean;
  /** Sends this many bytes of the response body, then drops the connection. */
  cutAfter?: number;
  /** Holds requests until `release()` is called. */
  held?: boolean;
  /** Sends the body in ten parts, waiting this long before each. */
  chunkDelayMs?: number;
  /** Sends this many bytes of the response body, then nothing more, holding the connection open. */
  stallAfter?: number;
  /** Answers with a redirect to this URL instead. */
  redirectTo?: string;
  /** Answers 200 with a short HTML error page instead of the file. */
  errorPage?: boolean;
}

export interface ModelServer {
  /** Points the core at this server. */
  source: EmbeddingModelSource;
  /** The bytes each file should have, by path. */
  contents: ReadonlyMap<string, Uint8Array>;
  /** Every request, in order, with its Range header, and whether its connection has closed. */
  requests: { path: string; range: string | null; closed: boolean }[];
  behave(path: string, behaviour: FileBehaviour): void;
  /** Lets held requests through, and stops holding new ones. */
  release(): void;
  close(): Promise<void>;
}

/**
 * A local HTTP server for a fake embedding model's files: random bytes of the
 * given sizes, served with Range support like Hugging Face's CDN. Closed when
 * the test finishes. `copyOf` serves another server's files instead, each under
 * `folder/`, as a copy of the models elsewhere would (#1578).
 */
export async function startModelServer(
  files: Record<string, number>,
  copyOf?: { server: ModelServer; folder: string },
): Promise<ModelServer> {
  const contents = new Map<string, Uint8Array>(
    copyOf
      ? [...copyOf.server.contents].map(([path, content]) => [`${copyOf.folder}/${path}`, content])
      : Object.entries(files).map(([path, size]) => [path, new Uint8Array(randomBytes(size))]),
  );
  const behaviours = new Map<string, FileBehaviour>();
  const requests: ModelServer["requests"] = [];
  let releaseHeld = () => {};
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });

  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const path = decodeURIComponent((request.url ?? "/").slice(1));
    const range = request.headers.range ?? null;
    const record = { path, range, closed: false };
    requests.push(record);
    response.on("close", () => {
      record.closed = true;
    });
    const content = contents.get(path);
    if (!content) {
      response.writeHead(404).end();
      return;
    }
    const behaviour = behaviours.get(path) ?? {};
    if (behaviour.held) await held;
    if (behaviour.redirectTo) {
      response.writeHead(302, { location: behaviour.redirectTo }).end();
      return;
    }
    if (behaviour.errorPage) {
      const page = "<html><body>Rate limited</body></html>";
      response.writeHead(200, { "content-length": String(page.length) }).end(page);
      return;
    }
    const body = behaviour.corrupt ? randomBytes(content.byteLength) : content;
    const start = Number(range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
    if (start >= body.byteLength) {
      response.writeHead(416).end();
      return;
    }
    const part = body.subarray(start);
    response.writeHead(range ? 206 : 200, {
      "content-length": String(part.byteLength),
      ...(range && { "content-range": `bytes ${start}-${body.byteLength - 1}/${body.byteLength}` }),
    });
    if (behaviour.chunkDelayMs !== undefined) {
      const size = Math.ceil(part.byteLength / 10);
      for (let at = 0; at < part.byteLength && !response.destroyed; at += size) {
        await new Promise((resolve) => setTimeout(resolve, behaviour.chunkDelayMs));
        response.write(part.subarray(at, at + size));
      }
      response.end();
      return;
    }
    if (behaviour.stallAfter !== undefined && behaviour.stallAfter < part.byteLength) {
      response.write(part.subarray(0, behaviour.stallAfter));
      return;
    }
    if (behaviour.cutAfter !== undefined && behaviour.cutAfter < part.byteLength) {
      response.write(part.subarray(0, behaviour.cutAfter), () => {
        setTimeout(() => response.destroy(), 20);
      });
      return;
    }
    response.end(part);
  };

  const server = createServer((request, response) => {
    serve(request, response).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => {
      releaseHeld();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  onTestFinished(close);

  return {
    source: {
      baseUrl: `http://127.0.0.1:${port}/`,
      files: [...contents].map(([path, content]) => ({
        path,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      })),
    },
    contents,
    requests,
    behave(path, behaviour) {
      behaviours.set(path, behaviour);
    },
    release() {
      releaseHeld();
    },
    close,
  };
}

/**
 * Turns embeddings on with the built-in model, as the User does in Settings:
 * they are off by default (ADR-0009, 2026-10-10), and stay on after a restart.
 */
export async function turnOnEmbeddings(core: Core): Promise<void> {
  await core.saveEmbeddingProvider({ kind: "built-in" });
}

/** The deterministic fake embedder, with switches to make it fail and records of how it was used. */
export interface ControlledEmbedder extends Embedder {
  /** Every text embedded, in order. */
  readonly texts: string[];
  /** The most `embed` calls that were running at once. */
  readonly maxConcurrent: number;
  /** While true, `load` rejects, as if the model couldn't start on this computer. */
  failLoads: boolean;
  /** The next this many `embed` calls reject, as if the process running the model crashed. */
  failEmbeds: number;
}

export function createControlledEmbedder(): ControlledEmbedder {
  const fake = createFakeEmbedder();
  let running = 0;
  const controlled: ControlledEmbedder = {
    texts: [],
    maxConcurrent: 0,
    failLoads: false,
    failEmbeds: 0,
    async load(files) {
      if (controlled.failLoads) throw new Error("This computer can't run the model.");
      await fake.load(files);
    },
    async embed(text) {
      running++;
      (controlled as { maxConcurrent: number }).maxConcurrent = Math.max(
        controlled.maxConcurrent,
        running,
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (controlled.failEmbeds > 0) {
          controlled.failEmbeds--;
          fake.close(); // the model has to be loaded again
          throw new Error("The embedding process stopped.");
        }
        const vector = await fake.embed(text);
        controlled.texts.push(text);
        return vector;
      } finally {
        running--;
      }
    },
    close() {
      fake.close();
    },
  };
  return controlled;
}

/** Resolves with the next "embeddingModel.status" event that satisfies `predicate`. */
export function waitForModel(
  core: Core,
  predicate: (status: EmbeddingModelStatus) => boolean,
  timeout = 10_000,
): Promise<EmbeddingModelStatus> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(
        new Error(`The embedding model didn't reach the expected state within ${timeout} ms.`),
      );
    }, timeout);
    const stop = core.on("embeddingModel.status", (status) => {
      if (!predicate(status)) return;
      clearTimeout(timer);
      stop();
      resolve(status);
    });
  });
}
