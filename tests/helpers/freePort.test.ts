import type { Server } from "node:net";
import { expect, test, vi } from "vitest";
import { freePort } from "../../e2e/lifecycle";

const reported = vi.hoisted(() => ({ port: 0, times: 0 }));

// The system's next listen on port 0 may answer with a port it just gave and closed.
vi.mock("node:net", async (importOriginal) => {
  const net = await importOriginal<typeof import("node:net")>();
  return {
    ...net,
    createServer: (): Server => {
      const server = net.createServer();
      const address = server.address.bind(server);
      server.address = () => {
        if (reported.times === 0) return address();
        reported.times--;
        return { address: "127.0.0.1", family: "IPv4", port: reported.port };
      };
      return server;
    },
  };
});

test("a port the system gives again is never handed to a second copy", async () => {
  Object.assign(reported, { port: 41_000, times: 2 });
  const first = await freePort();
  const second = await freePort();
  expect(first).toBe(41_000);
  expect(second).not.toBe(41_000);
  expect(reported.times).toBe(0);
});
