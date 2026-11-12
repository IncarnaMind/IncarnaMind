/**
 * Which window holds what in the core (#2921). A host tells it three facts about a window, by
 * whatever key the host knows the window by: that it made a call, that it is gone, and that its
 * page started again. The window's own id (`clientId`) is read from the calls that give a window
 * something to hold, and each feature says once what it lets go.
 */
import type { CoreApiMethod } from "./api";
import { isRecord } from "./errors";

/** How a host names one of its windows; the desktop app uses the id of the window's web contents. */
export type HostWindow = number | string;

/** What one feature has a window hold. */
export interface WindowHeld {
  /** The calls that give a window something to hold: the window's id is their input's `clientId`. */
  calls: readonly CoreApiMethod[];
  /** The window closed or crashed. */
  gone(clientId: string): void;
  /** Its page started again. Left out when what the window holds outlives a reload. */
  reloaded?(clientId: string): void;
}

export function createWindowPresence(
  held: readonly WindowHeld[],
  reportError: (error: unknown) => void,
) {
  const naming = new Set<CoreApiMethod>(held.flatMap((each) => each.calls));
  const ids = new Map<HostWindow, string>();

  // One feature failing to let go must not leave the others holding.
  const letGo = (clientId: string, when: "gone" | "reloaded") => {
    for (const each of held) {
      try {
        each[when]?.(clientId);
      } catch (error) {
        reportError(error);
      }
    }
  };

  return {
    /** The window made this call, before the call runs. */
    called(window: HostWindow, method: CoreApiMethod, input: unknown): void {
      if (!naming.has(method) || !isRecord(input)) return;
      const { clientId } = input;
      if (typeof clientId !== "string" || clientId === "") return;
      const before = ids.get(window);
      ids.set(window, clientId);
      // A window has one page: under another id, the page that had the old one can't come back.
      if (before !== undefined && before !== clientId) letGo(before, "gone");
    },

    /** The window closed or crashed. */
    gone(window: HostWindow): void {
      const clientId = ids.get(window);
      if (clientId === undefined) return;
      ids.delete(window);
      letGo(clientId, "gone");
    },

    /** The window's page started again: it is the same window, and may keep the same id. */
    reloaded(window: HostWindow): void {
      const clientId = ids.get(window);
      if (clientId !== undefined) letGo(clientId, "reloaded");
    },
  };
}

export type WindowPresence = ReturnType<typeof createWindowPresence>;
