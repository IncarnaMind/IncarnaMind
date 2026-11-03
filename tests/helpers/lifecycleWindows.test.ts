import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { windowsOf } from "../../e2e/lifecycle";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
  vi.restoreAllMocks();
});

async function endpoint(listener: RequestListener): Promise<number> {
  const server = createServer(listener);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The observer has no test port.");
  return address.port;
}

test.each(["no response", "unfinished body"] as const)(
  "a copy with %s cannot hide another copy’s usable window",
  async (how) => {
    const received = Promise.withResolvers<void>();
    const stalled = await endpoint((_request, response) => {
      if (how === "unfinished body") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.flushHeaders();
        response.write("[");
      }
      received.resolve();
    });
    const usable = await endpoint((_request, response) => {
      response.end(JSON.stringify([{ type: "page", url: "file:///fixture/index.html" }]));
    });
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const counts = [windowsOf(stalled), windowsOf(usable)];
    await received.promise;
    expect(await counts[1]).toBe(1);
    timeout.abort(new DOMException("The old endpoint did not respond.", "TimeoutError"));
    expect(await Promise.all(counts)).toEqual([0, 1]);
  },
);

test.each(["not JSON", JSON.stringify({ targets: [] })])(
  "malformed observer data remains an error: %s",
  async (body) => {
    const port = await endpoint((_request, response) => response.end(body));
    await expect(windowsOf(port)).rejects.toThrow();
  },
);
