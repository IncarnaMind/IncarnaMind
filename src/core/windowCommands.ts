/**
 * The commands of the window's list the assistant runs (#1421): each is sent to the windows, the
 * one whose Question asked for it runs it as ⌘K does, and its answer settles the call. A request
 * still waiting when its Answer stops is withdrawn.
 */
import { randomUUID } from "node:crypto";
import { isMessageKey } from "../shared/i18n";
import type { WindowCommandRequest, WindowCommandResult } from "./api";
import { type ErrorWording, InvalidInputError, isRecord } from "./errors";
import type { createEventHub } from "./events";

function wordingOf(value: unknown): ErrorWording | null {
  if (!isRecord(value) || !isMessageKey(value.key)) return null;
  const values = isRecord(value.values)
    ? Object.fromEntries(
        Object.entries(value.values).filter(
          (entry): entry is [string, string | number] =>
            typeof entry[1] === "string" || typeof entry[1] === "number",
        ),
      )
    : undefined;
  return values ? { key: value.key, values } : { key: value.key };
}

function resultOf(value: unknown): WindowCommandResult {
  if (!isRecord(value) || typeof value.ran !== "boolean") {
    throw new InvalidInputError({ key: "error.commands.windowAnswer" });
  }
  if (value.ran) return { ran: true, changed: value.changed === true };
  const why =
    typeof value.why === "string" && value.why.trim() !== "" ? value.why : "It didn't run.";
  return { ran: false, why, wording: wordingOf(value.wording) };
}

export function createWindowCommands(events: ReturnType<typeof createEventHub>) {
  const waiting = new Map<string, (result: WindowCommandResult) => void>();

  return {
    /** Asks the window to run a command and waits for how it went; rejects if `signal` aborts first. */
    run(
      request: Omit<WindowCommandRequest, "requestId">,
      signal: AbortSignal,
    ): Promise<WindowCommandResult> {
      if (signal.aborted) return Promise.reject(signal.reason);
      const requestId = randomUUID();
      return new Promise<WindowCommandResult>((resolve, reject) => {
        const onAbort = () => {
          if (waiting.delete(requestId)) reject(signal.reason);
        };
        waiting.set(requestId, (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        });
        signal.addEventListener("abort", onAbort, { once: true });
        events.emit("command.windowRun", { ...request, requestId });
      });
    },

    answer(requestId: unknown, value: unknown): void {
      if (typeof requestId !== "string") {
        throw new InvalidInputError({ key: "error.commands.windowAnswer" });
      }
      const settle = waiting.get(requestId);
      if (!settle) return;
      const result = resultOf(value);
      waiting.delete(requestId);
      settle(result);
    },
  };
}

export type WindowCommands = ReturnType<typeof createWindowCommands>;
