import { create } from "zustand";
import { core } from "./core";

/**
 * By id: when what waits on the model's rate limit resumes (ISO 8601 UTC), for the line of the
 * Answer, the check of a Note or the check of what the assistant wrote that waits (#2944). An id
 * with no entry doesn't wait.
 */
export const useRateLimitWaits = create<{ resumes: Readonly<Record<string, string>> }>()(() => ({
  resumes: {},
}));

export function installRateLimitWaits(): void {
  core.on("rateLimit.waiting", ({ id, resumesAt }) =>
    useRateLimitWaits.setState(({ resumes }) => {
      const next = { ...resumes };
      if (resumesAt === null) delete next[id];
      else next[id] = resumesAt;
      return { resumes: next };
    }),
  );
}

/** When what runs under `id` resumes after a rate limit; null while it doesn't wait or `id` isn't known. */
export const useRateLimitResumes = (id: string | null | undefined): string | null =>
  useRateLimitWaits((state) => (id ? (state.resumes[id] ?? null) : null));
