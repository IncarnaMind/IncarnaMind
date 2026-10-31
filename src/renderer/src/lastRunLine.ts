import type { UnexpectedEnd } from "../../shared/bridge";
import type { MessageKey, MessageParams } from "../../shared/i18n";

/** The line said once a window starts, and the Note its Open opens, when it names one. */
export interface LastRunLine {
  key: MessageKey;
  params?: MessageParams;
  open?: string;
}

/**
 * The one line said once a window starts, for how the last run or this window's page ended
 * (#1119, #2309), or null when there is nothing to say. `lost` is the core's count of changes the
 * last run couldn't store, null when it doesn't know. Changes sent while the app wasn't answering
 * are never counted, so an unexpected end never says everything was kept. `note` is the one Note
 * a session's end left all its changes in, with its name; `waiting` whether changes wait now,
 * which their own notice says.
 */
export function lastRunLine({
  lost,
  ended,
  note = null,
  waiting = false,
}: {
  lost: number | null;
  ended: UnexpectedEnd | null;
  note?: { mindId: string; name: string } | null;
  waiting?: boolean;
}): LastRunLine | null {
  if (ended?.kind === "session") {
    const count = ended.unsaved;
    if (note) {
      return {
        key: count === 1 ? "unexpectedEnd.session.note.one" : "unexpectedEnd.session.note",
        params: { count, note: note.name },
        open: note.mindId,
      };
    }
    return count === 1
      ? { key: "unexpectedEnd.session.one" }
      : { key: "unexpectedEnd.session", params: { count } };
  }
  if (ended?.kind === "window") {
    return { key: waiting ? "unexpectedEnd.window.short" : "unexpectedEnd.window" };
  }
  if (lost !== null && lost > 0) {
    return lost === 1
      ? { key: "unsaved.lost.one" }
      : { key: "unsaved.lost", params: { count: lost } };
  }
  return ended?.kind === "app" ? { key: "unexpectedEnd.app" } : null;
}

/** The one Note a session's end left every change in, when it names one. */
export function endedInOneNote(ended: UnexpectedEnd | null): string | null {
  if (ended?.kind !== "session") return null;
  const [only, ...others] = ended.minds;
  return only && others.length === 0 && only.count === ended.unsaved ? only.mindId : null;
}
