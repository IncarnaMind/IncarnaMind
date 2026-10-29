/**
 * The commands of the window's list the assistant runs (#1421): each is sent to the windows, the
 * one whose Question asked for it (`clientId`) runs it as ⌘K does, and its answer settles the
 * call. A request still waiting when its Answer stops is withdrawn. One its window closed or
 * reloaded before answering, or didn't answer within `WINDOW_ANSWER_MS`, wasn't done.
 */
import { randomUUID } from "node:crypto";
import { isMessageKey } from "../shared/i18n";
import type { WindowCommandRequest, WindowCommandResult } from "./api";
import { type ErrorWording, InvalidInputError, isRecord } from "./errors";
import type { createEventHub } from "./events";

/** How long a window has to run a command: every one it offers is done in a moment. */
export const WINDOW_ANSWER_MS = 30_000;

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

/** Not done: the window didn't answer, for the reason given in English. */
const unanswered = (command: string, why: string): WindowCommandResult => ({
  ran: false,
  why: `The window didn't answer ${why}, so ${command} wasn't done.`,
  wording: { key: "commands.window.unanswered", values: { command } },
});

interface Waiting {
  clientId: string;
  command: string;
  settle(result: WindowCommandResult): void;
}

export function createWindowCommands(events: ReturnType<typeof createEventHub>) {
  const waiting = new Map<string, Waiting>();

  return {
    /** Asks the window to run a command and waits for how it went; rejects if `signal` aborts first. */
    run(
      request: Omit<WindowCommandRequest, "requestId">,
      signal: AbortSignal,
    ): Promise<WindowCommandResult> {
      if (signal.aborted) return Promise.reject(signal.reason);
      const requestId = randomUUID();
      return new Promise<WindowCommandResult>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          return waiting.delete(requestId);
        };
        const onAbort = () => {
          if (done()) reject(signal.reason);
        };
        const timer = setTimeout(() => {
          if (done()) resolve(unanswered(request.command, "in time"));
        }, WINDOW_ANSWER_MS);
        waiting.set(requestId, {
          clientId: request.clientId,
          command: request.command,
          settle: (result) => {
            if (done()) resolve(result);
          },
        });
        signal.addEventListener("abort", onAbort, { once: true });
        events.emit("command.windowRun", { ...request, requestId });
      });
    },

    /** Settles a request with the window's answer; false when it no longer waits for one. */
    answer(requestId: unknown, value: unknown): boolean {
      if (typeof requestId !== "string") {
        throw new InvalidInputError({ key: "error.commands.windowAnswer" });
      }
      const request = waiting.get(requestId);
      if (!request) return false;
      request.settle(resultOf(value));
      return true;
    },

    /** The window is gone, or its page started again: nothing it was asked to run gets done. */
    forget(clientId: unknown): void {
      if (typeof clientId !== "string") {
        throw new InvalidInputError({ key: "error.commands.windowAnswer" });
      }
      for (const request of [...waiting.values()]) {
        if (request.clientId === clientId) {
          request.settle(unanswered(request.command, "before it was closed or reloaded"));
        }
      }
    },
  };
}

export type WindowCommands = ReturnType<typeof createWindowCommands>;
