/**
 * The connection a cloud transcription stream talks over (#141): a WebSocket carrying the
 * User's key in its Authorization header, as both services take it. Tests pass a socket that
 * plays back what a service sent.
 */
import { WebSocket } from "undici";

export interface CloudSocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

export interface CloudSocketEvents {
  open(): void;
  message(text: string): void;
  /** It closed, by either side, or never opened. */
  closed(code: number): void;
}

export type CloudConnect = (url: string, apiKey: string, events: CloudSocketEvents) => CloudSocket;

export const connectWebSocket: CloudConnect = (url, apiKey, events) => {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => events.open());
  socket.addEventListener("message", (event) => {
    const { data } = event;
    events.message(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString());
  });
  socket.addEventListener("close", (event) => events.closed(event.code));
  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close: () => socket.close(),
  };
};
