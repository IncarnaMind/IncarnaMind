import { once } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { serveConnection } from "../../src/core/agents/mcp";
import {
  AGENT_HANDSHAKE_MAX_BYTES,
  challengeLine,
  clientProofLine,
  handshakeLine,
  parseOpeningLine,
  parseServerChallenge,
} from "../../src/shared/agentSocket";

function createTestSocketPair() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const serverSide = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      toClient.write(chunk, encoding, callback);
    },
    final(callback) {
      toClient.end(callback);
    },
  });
  toServer.on("data", (chunk) => serverSide.push(chunk));
  toServer.on("end", () => serverSide.push(null));
  return { serverSide, toServer, toClient };
}

test.each([false, true])(
  "an oversized handshake is refused before token lookup (newline: %s)",
  async (newline) => {
    const socket = new PassThrough();
    const open = vi.fn(async () => {
      throw new Error("An oversized opening must not be admitted.");
    });
    serveConnection(socket, {
      open,
      modelReady: async () => true,
      version: "test",
      paired: vi.fn(),
      reportError: vi.fn(),
    });
    const closed = once(socket, "close");
    const opening = handshakeLine("x".repeat(AGENT_HANDSHAKE_MAX_BYTES));
    socket.write(newline ? opening : opening.trimEnd());
    await closed;
    expect(open.mock.calls.length).toBe(0);
  },
);

describe("v2 mutual HMAC handshake limits and timeouts (ADR-0036)", () => {
  test("an oversized line 3 client proof is refused without calling verify", async () => {
    const { serverSide, toServer, toClient } = createTestSocketPair();
    const verify = vi.fn(async () => null);
    serveConnection(serverSide, {
      open: vi.fn(),
      challenge: async () => ({
        appNonce: "app_nonce_1234567890abcdef",
        proofs: ["a".repeat(64)],
        verify,
      }),
      modelReady: async () => true,
      version: "test",
      paired: vi.fn(),
      reportError: vi.fn(),
    });

    const line2 = new Promise<string>((resolve) => {
      let buf = "";
      toClient.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(buf.slice(0, nl));
      });
    });
    const closed = once(serverSide, "close");

    toServer.write(challengeLine("shim_nonce_1234567890abcdef", "0123456789abcdef"));
    expect(parseServerChallenge(await line2)?.kind).toBe("challenge");

    toServer.write(clientProofLine("b".repeat(AGENT_HANDSHAKE_MAX_BYTES)));
    await closed;
    expect(verify).not.toHaveBeenCalled();
  });

  test("a peer that never sends line 1 is closed on the app handshake timeout", async () => {
    const socket = new PassThrough();
    serveConnection(socket, {
      open: vi.fn(),
      challenge: vi.fn(),
      modelReady: async () => true,
      version: "test",
      paired: vi.fn(),
      reportError: vi.fn(),
      handshakeTimeoutMs: 50,
    });
    const closed = once(socket, "close");
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  test("a peer that sends line 1 and never sends line 3 is closed on the app handshake timeout", async () => {
    const { serverSide, toServer } = createTestSocketPair();
    const verify = vi.fn(async () => null);
    serveConnection(serverSide, {
      open: vi.fn(),
      challenge: async () => ({
        appNonce: "app_nonce_timeout_12345678",
        proofs: ["c".repeat(64)],
        verify,
      }),
      modelReady: async () => true,
      version: "test",
      paired: vi.fn(),
      reportError: vi.fn(),
      handshakeTimeoutMs: 50,
    });
    const closed = once(serverSide, "close");
    toServer.write(challengeLine("shim_nonce_timeout_1234567", "0123456789abcdef"));
    await closed;
    expect(verify).not.toHaveBeenCalled();
  });

  test("v2 line 1 without keyId is rejected", () => {
    expect(
      parseOpeningLine(JSON.stringify({ incarnamind: 2, nonce: "shim_nonce_1234567890abcdef" })),
    ).toBeNull();
  });

  test("an in-flight v1 handshake whose key rotates before modelReady finishes is refused and never paired", async () => {
    const { serverSide, toServer } = createTestSocketPair();
    let stillCurrent = true;
    let releaseModelReady: (ready: boolean) => void = () => undefined;
    const paired = vi.fn();
    serveConnection(serverSide, {
      open: async () => ({
        pairingId: "pairing-1",
        access: {} as never,
        isCurrent: () => stillCurrent,
      }),
      modelReady: () =>
        new Promise<boolean>((resolve) => {
          releaseModelReady = resolve;
        }),
      version: "test",
      paired,
      reportError: vi.fn(),
    });
    const closed = once(serverSide, "close");
    toServer.write(handshakeLine("im_old_v1_token"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    stillCurrent = false;
    releaseModelReady(true);
    await closed;
    expect(paired).not.toHaveBeenCalled();
  });
});
