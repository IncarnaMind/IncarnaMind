/**
 * Serves the every-format set's Web pages from this computer, so the
 * evaluation adds each one through the app's own path: `saveWebPage` by its
 * address, which fetches the page and snapshots it, with nothing reached
 * outside 127.0.0.1 (#155).
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { EvalDocument } from "./evaluationSet";

export interface WebPageServer {
  /** The address each page is saved under. */
  addresses: ReadonlyMap<string, string>;
  close(): Promise<void>;
}

export async function serveWebPages(pages: readonly EvalDocument[]): Promise<WebPageServer> {
  const bodies = new Map<string, Buffer>();
  for (const page of pages) {
    bodies.set(`/${page.key}`, await readFile(page.path));
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = bodies.get(decodeURIComponent(path));
    if (!body) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.byteLength,
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    addresses: new Map(
      pages.map((page) => [page.key, `http://127.0.0.1:${port}/${page.key}`] as const),
    ),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
