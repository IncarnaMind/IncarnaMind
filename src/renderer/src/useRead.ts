import { useEffect, useState } from "react";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";

/** What a screen knows of a read it depends on: nothing yet, the data, or why it couldn't be read. */
export type Read<T> =
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "failed"; problem: string; retrying: boolean; retry(): void };

export type FailedRead = Extract<Read<unknown>, { state: "failed" }>;

/**
 * One async read, in one of three states, so a screen draws only from data that was read and says
 * where a read failed. It reads when it mounts and again whenever `again` changes or the User
 * presses Try again; a read again that fails drops what the last one gave, so stale data isn't
 * drawn beside a problem. `enabled` false waits. `what` names the read for the log.
 */
export function useRead<T>(
  what: string,
  read: () => Promise<T>,
  again: readonly unknown[] = [],
  enabled = true,
): Read<T> {
  const [result, setResult] = useState<{ data: T } | { problem: string } | null>(null);
  const [tries, setTries] = useState(0);
  const [reading, setReading] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever `again` changes or the User asks.
  useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    let current = true;
    setReading(true);
    read().then(
      (data) => {
        if (!current) return;
        setResult({ data });
        setReading(false);
      },
      (error: unknown) => {
        console.error(`${what} couldn't be read.`, error);
        if (!current) return;
        setResult({ problem: errorMessage(error, translateNow) });
        setReading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [enabled, tries, ...again]);
  if (result === null) return { state: "loading" };
  if ("problem" in result) {
    return {
      state: "failed",
      problem: result.problem,
      retrying: reading,
      retry: () => setTries((count) => count + 1),
    };
  }
  return { state: "ready", data: result.data };
}
