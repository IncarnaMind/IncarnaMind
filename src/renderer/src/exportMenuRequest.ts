/**
 * "Export…" in a Mind's menus opens the Export button's own menu, so the one short list of
 * formats is the only place they are chosen: the button of the tab showing the Mind opens
 * its menu when a request for that Mind arrives, if it comes soon enough to be the one asked.
 */
import { create } from "zustand";

/** A request older than this was for a Mind that never showed its Export button. */
const FRESH_MS = 3000;

interface Request {
  mindId: string;
  at: number;
}

export const useExportMenuRequests = create<{ request: Request | null }>()(() => ({
  request: null,
}));

export const requestExportMenu = (mindId: string) =>
  useExportMenuRequests.setState({ request: { mindId, at: Date.now() } });

/** Takes the request for this Mind, once: true if there was a fresh one. */
export function takeExportMenuRequest(mindId: string): boolean {
  const { request } = useExportMenuRequests.getState();
  if (!request || request.mindId !== mindId) return false;
  useExportMenuRequests.setState({ request: null });
  return Date.now() - request.at < FRESH_MS;
}
