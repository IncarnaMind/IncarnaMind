/**
 * What every run of the User's Codex through its app-server shares (ADR-0026): how it is started,
 * as newline-delimited JSON-RPC on its input and output, and the handshake that opens it.
 */
import type { Writable } from "node:stream";

/** `codex` started as its app-server, talking on its input and output. */
export const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;

/** The handshake's request, IncarnaMind named by `name`; `initialized` follows its answer. */
export const initializeParams = (name: string) => ({
  clientInfo: { name, version: "1" },
  capabilities: { experimentalApi: true },
});

/** One message to the app-server, as the line it reads. */
export const appServerLine = (message: Record<string, unknown>) => `${JSON.stringify(message)}\n`;

/**
 * Writes to an app-server's input: requests by an id of their own, answered by `answered` with the
 * message that answers each; answers to its own requests; notifications.
 */
export function appServerWriter<T>(stdin: Writable) {
  let last = 0;
  const waiting = new Map<number, (message: Record<string, unknown>) => T | undefined>();
  const write = (message: Record<string, unknown>) => {
    if (stdin.writable) stdin.write(appServerLine(message));
  };
  return {
    request(
      method: string,
      params: Record<string, unknown>,
      then: (message: Record<string, unknown>) => T | undefined,
    ): void {
      const id = ++last;
      waiting.set(id, then);
      write({ id, method, params });
    },
    notify(method: string, params?: Record<string, unknown>): void {
      write({ method, ...(params && { params }) });
    },
    respond(id: unknown, result: Record<string, unknown>): void {
      write({ id, result });
    },
    /** A request of the app-server's that IncarnaMind doesn't take. */
    unsupported(id: unknown, method: string): void {
      write({ id, error: { code: -32601, message: `IncarnaMind doesn't take ${method}.` } });
    },
    /** The answer to one of this writer's requests, if `message` is one, handed to its `then`. */
    answered(message: Record<string, unknown>): { value: T | undefined } | null {
      if ("method" in message || typeof message.id !== "number") return null;
      const then = waiting.get(message.id);
      if (!then) return null;
      waiting.delete(message.id);
      return { value: then(message) };
    },
  };
}
