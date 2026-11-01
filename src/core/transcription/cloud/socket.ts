/**
 * The connection a cloud transcription stream talks over (#141): a WebSocket carrying the
 * User's key in its Authorization header, as the services take it. Tests pass a socket that
 * plays back what a service sent.
 */
import { WebSocket } from "undici";
import { HANDSHAKE_REFUSED } from "./protocol";

export { HANDSHAKE_REFUSED } from "./protocol";

export interface CloudSocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

export interface CloudSocketEvents {
  open(): void;
  message(text: string): void;
  /** It closed, by either side, or never opened (`HANDSHAKE_REFUSED` when the key was turned away). */
  closed(code: number): void;
}

export type CloudConnect = (url: string, apiKey: string, events: CloudSocketEvents) => CloudSocket;

const PROBE_TIMEOUT_MS = 5000;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function keyTurnedAway(url: string, apiKey: string): Promise<boolean> {
  try {
    const { status } = await fetch(url.replace(/^ws/, "http"), {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return status === 401 || status === 403;
  } catch (error) {
    // The process has no logger of its own: its output goes to the app's log.
    console.error("The cloud service couldn't be asked about the key:", messageOf(error));
    return false;
  }
}

export const connectWebSocket: CloudConnect = (url, apiKey, events) => {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
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
    if (opened || closing) return events.closed(event.code);
    void keyTurnedAway(url, apiKey).then((turned) =>
      events.closed(turned ? HANDSHAKE_REFUSED : event.code),
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
