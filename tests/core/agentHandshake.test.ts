import { once } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { serveConnection } from "../../src/core/agents/mcp";
import { AGENT_HANDSHAKE_MAX_BYTES, handshakeLine } from "../../src/shared/agentSocket";

test.each([false, true])(
  "an oversized handshake is refused before token lookup (newline: %s)",
  async (newline) => {
    const socket = new PassThrough();
    const open = vi.fn(async () => {
      throw new Error("An oversized opening must not be admitted.");
    });
    serveConnection(socket, { open, version: "test", paired: vi.fn(), reportError: vi.fn() });
    const closed = once(socket, "close");
    const opening = handshakeLine("x".repeat(AGENT_HANDSHAKE_MAX_BYTES));
    socket.write(newline ? opening : opening.trimEnd());
    await closed;
    expect(open.mock.calls.length).toBe(0);
  },
);
