/**
 * The commands of the window's list the assistant runs (#1421): each is sent to the windows, and
 * the one whose Question asked for it (`clientId`) runs it as ⌘K does. The window says at once
 * that it started, then how it ended. One that ends in a moment settles its call; one that goes
 * on, as a Check does, or a recording waiting for the system's microphone permission, settles it
 * as started, and its end comes later (`ended`). One its window didn't start within
 * `WINDOW_START_MS`, or that its window closed or reloaded before starting, wasn't done.
 */
import { randomUUID } from "node:crypto";
import { isMessageKey } from "../shared/i18n";
import type { WindowCommandEnd, WindowCommandRequest, WindowCommandResult } from "./api";
import { type ErrorWording, InvalidInputError, isRecord } from "./errors";
import type { createEventHub } from "./events";

/** How long a window has to say it started a command: it does as soon as the command runs. */
export const WINDOW_START_MS = 30_000;

/** How long a started command's call waits for it to end before the turn goes on without it. */
export const WINDOW_SETTLE_MS = 1_000;

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
  if (isRecord(value) && value.started === true) return { started: true };
  if (!isRecord(value) || typeof value.ran !== "boolean") {
    throw new InvalidInputError({ key: "error.commands.windowAnswer" });
  }
  if (value.ran) return { ran: true, changed: value.changed === true };
  const why =
    typeof value.why === "string" && value.why.trim() !== "" ? value.why : "It didn't run.";
  return { ran: false, why, wording: wordingOf(value.wording) };
}

const unanswered = (command: string, why: string): WindowCommandEnd => ({
  ran: false,
  why: `The window didn't answer ${why}, so ${command} wasn't done.`,
  wording: { key: "commands.window.unanswered", values: { command } },
});

const closed = (command: string): WindowCommandEnd => ({
  ran: false,
  why: `The window was closed or reloaded before ${command} ended: it may not have finished.`,
  wording: { key: "commands.window.closed", values: { command } },
});

interface Open {
  clientId: string;
  command: string;
  started: boolean;
  start(): void;
  end(result: WindowCommandEnd): void;
}

export function createWindowCommands(events: ReturnType<typeof createEventHub>) {
  const open = new Map<string, Open>();

  return {
    /**
     * Asks the window to run a command and waits for it to start: resolves with how it ended,
     * when it ends in a moment, or with `started`, its end then going to `ended`, also when
     * `signal` aborts after the start. Rejects if `signal` aborts before it.
     */
    run(
      request: Omit<WindowCommandRequest, "requestId">,
      signal: AbortSignal,
      ended: (result: WindowCommandEnd) => void,
    ): Promise<WindowCommandResult> {
      if (signal.aborted) return Promise.reject(signal.reason);
      const requestId = randomUUID();
      return new Promise<WindowCommandResult>((resolve, reject) => {
        let settled = false;
        let timer = setTimeout(
          () => entry.end(unanswered(request.command, "in time")),
          WINDOW_START_MS,
        );
        const settle = (result: WindowCommandResult): boolean => {
          if (settled) return false;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(result);
          return true;
        };
        // Stopped once it started, it goes on in the window: its call says so, and its end comes.
        const onAbort = () => {
          if (entry.started) {
            settle({ started: true });
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          open.delete(requestId);
          reject(signal.reason);
        };
        const entry: Open = {
          clientId: request.clientId,
          command: request.command,
          started: false,
          start() {
            entry.started = true;
            clearTimeout(timer);
            timer = setTimeout(() => settle({ started: true }), WINDOW_SETTLE_MS);
          },
          end(result) {
            open.delete(requestId);
            if (!settle(result)) ended(result);
          },
        };
        open.set(requestId, entry);
        signal.addEventListener("abort", onAbort, { once: true });
        events.emit("command.windowRun", { ...request, requestId });
      });
    },

    /** Takes the window's word on a request; false when the core no longer waits for it. */
    answer(requestId: unknown, value: unknown): boolean {
      if (typeof requestId !== "string") {
        throw new InvalidInputError({ key: "error.commands.windowAnswer" });
      }
      const entry = open.get(requestId);
      if (!entry) return false;
      const result = resultOf(value);
      if (!("started" in result)) entry.end(result);
      else if (!entry.started) entry.start();
      return true;
    },

    /** The window is gone, or its page started again: what it hadn't started isn't done. */
    forget(clientId: unknown): void {
      if (typeof clientId !== "string") {
        throw new InvalidInputError({ key: "error.commands.windowAnswer" });
      }
      for (const entry of [...open.values()]) {
        if (entry.clientId !== clientId) continue;
        entry.end(
          entry.started
            ? closed(entry.command)
            : unanswered(entry.command, "before it was closed or reloaded"),
        );
      }
    },
  };
}

export type WindowCommands = ReturnType<typeof createWindowCommands>;
