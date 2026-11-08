import { create } from "zustand";
import type { WrittenCheckProgress } from "../../core/api";
import { backgroundCheck } from "./checks";
import { core } from "./core";

/**
 * By request: how far each check of what the assistant wrote is while it runs (#2830), for the
 * line under the Answer's card. Its Note's badge shows it as running through `backgroundCheck`.
 */
export const useWrittenChecks = create<{
  running: Readonly<Record<string, WrittenCheckProgress>>;
}>()(() => ({ running: {} }));

export function installWrittenChecks(): void {
  core.on("writtenCheck.progress", (event) => {
    useWrittenChecks.setState(({ running }) => {
      const next = { ...running };
      if (event.running) next[event.request] = event;
      else delete next[event.request];
      return { running: next };
    });
    backgroundCheck(event.mindId, event.request, event.running);
  });
}

/** How far the check under `request` is, while it runs; null once it ended, or before its first word. */
export const useWrittenProgress = (request: string): WrittenCheckProgress | null =>
  useWrittenChecks((state) => state.running[request] ?? null);
