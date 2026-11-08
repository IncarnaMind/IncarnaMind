/**
 * The connection a cloud transcription stream talks over (#141): a WebSocket carrying the
 * User's key in a header, as each service takes it. Tests pass a socket that plays back what a
 * service sent.
 */
import { WebSocket } from "undici";
import { OUT_OF_CREDIT } from "../../providers/creditWords";
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
/** Of a refusal's body, only its start is read: enough for the service's words, never kept or logged. */
const BODY_READ = 4096;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A refused handshake's answer, read in the order the chat providers' errors are: no credit (a
 * 402, or any 4xx but a 401 in credit's words, as xAI's 403), then the key (a 401 or 403, or a 400
 * naming an API key, as xAI's), else neither (0).
 */
export function handshakeRefusalOf(status: number, body: string): number {
  if (
    status === 402 ||
    (status >= 400 && status < 500 && status !== 401 && OUT_OF_CREDIT.test(body))
  ) {
    return HANDSHAKE_NO_CREDIT;
  }
  if (status === 401 || status === 403 || (status === 400 && /api[ _-]?key/i.test(body))) {
    return HANDSHAKE_REFUSED;
  }
  return 0;
}

async function startOf(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < BODY_READ) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text.slice(0, BODY_READ);
}

/**
 * Why a handshake failed, asked again over plain HTTPS with the same key, since a WebSocket that
 * never opened tells nothing of the answer: the key turned away, no credit, or neither.
 */
async function handshakeRefusal(url: string, headers: Record<string, string>): Promise<number> {
  try {
    const response = await fetch(url.replace(/^ws/, "http"), {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const { status } = response;
    return handshakeRefusalOf(status, status >= 400 && status < 500 ? await startOf(response) : "");
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
