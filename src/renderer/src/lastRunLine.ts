import type { UnexpectedEnd } from "../../shared/bridge";
import type { MessageKey, MessageParams } from "../../shared/i18n";

/**
 * The one line said once a window starts, for how the last run or this window's page ended
 * (#1119, #2309), or null when there is nothing to say. `lost` is the core's count of changes the
 * last run couldn't store: 0 when none, null when it doesn't know, so "everything was kept" is
 * said only when that count says so.
 */
export function lastRunLine(
  lost: number | null,
  ended: UnexpectedEnd | null,
): { key: MessageKey; params?: MessageParams } | null {
  if (ended?.kind === "session") {
    return ended.unsaved === 1
      ? { key: "unexpectedEnd.session.one" }
      : { key: "unexpectedEnd.session", params: { count: ended.unsaved } };
  }
  if (ended?.kind === "window") return { key: "unexpectedEnd.window" };
  if (lost !== null && lost > 0) {
    return lost === 1
      ? { key: "unsaved.lost.one" }
      : { key: "unsaved.lost", params: { count: lost } };
  }
  if (ended?.kind !== "app") return null;
  return { key: lost === 0 ? "unexpectedEnd.app" : "unexpectedEnd.app.unknown" };
}
