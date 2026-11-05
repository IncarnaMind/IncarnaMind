/**
 * The connection a cloud transcription stream talks over (#141): a WebSocket carrying the
 * User's key in a header, as each service takes it. Tests pass a socket that plays back what a
 * service sent.
 */
import { WebSocket } from "undici";
import { HANDSHAKE_NO_CREDIT, HANDSHAKE_REFUSED } from "./protocol";

export { HANDSHAKE_NO_CREDIT, HANDSHAKE_REFUSED } from "./protocol";

export interface CloudSocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

export interface CloudSocketEvents {
  open(): void;
  message(text: string): void;
  /**
   * It closed, by either side, or never opened (`HANDSHAKE_REFUSED` when the key was turned
   * away, `HANDSHAKE_NO_CREDIT` when the account has none), with the reason the service gave.
   */
  closed(code: number, reason?: string): void;
}

/** The header a service reads the key from, and what comes before the key in it. */
export interface CloudAuth {
  header: string;
  prefix: string;
}

export const BEARER: CloudAuth = { header: "Authorization", prefix: "Bearer " };

/** No header at all for an empty key: a server of the User's own may take none. */
export const authHeaders = (apiKey: string, auth: CloudAuth = BEARER): Record<string, string> =>
  apiKey === "" ? {} : { [auth.header]: `${auth.prefix}${apiKey}` };

export type CloudConnect = (
  url: string,
  apiKey: string,
  events: CloudSocketEvents,
  auth?: CloudAuth,
) => CloudSocket;

const PROBE_TIMEOUT_MS = 5000;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Why a handshake failed, asked again over plain HTTPS with the same key, since a WebSocket that
 * never opened tells nothing of the answer: the key turned away, no credit, or neither.
 */
async function handshakeRefusal(url: string, headers: Record<string, string>): Promise<number> {
  try {
    const { status } = await fetch(url.replace(/^ws/, "http"), {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (status === 401 || status === 403) return HANDSHAKE_REFUSED;
    return status === 402 ? HANDSHAKE_NO_CREDIT : 0;
  } catch (error) {
    // The process has no logger of its own: its output goes to the app's log.
    console.error("The cloud service couldn't be asked about the key:", messageOf(error));
    return 0;
  }
}

export const connectWebSocket: CloudConnect = (url, apiKey, events, auth) => {
  const headers = authHeaders(apiKey, auth);
  const socket = new WebSocket(url, { headers });
  socket.binaryType = "arraybuffer";
  let opened = false;
  let closing = false;
  socket.addEventListener("open", () => {
    opened = true;
    events.open();
  });
  socket.addEventListener("message", (event) => {
    const { data } = event;
    events.message(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString());
  });
  socket.addEventListener("close", (event) => {
    if (opened || closing) return events.closed(event.code, event.reason);
    void handshakeRefusal(url, headers).then((refusal) =>
      events.closed(refusal || event.code, event.reason),
    );
  });
  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close: () => {
      closing = true;
      socket.close();
    },
  };
};
