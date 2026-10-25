import type { MessageKey, MessageParams } from "../../shared/i18n";
import type { FlowRoute } from "./taggingDestination";

/**
 * Why six whole sentences rather than pieces joined with a space: each
 * dictionary joins its own (Chinese puts no space after its full stop). Its
 * status row says it in a popover, so the row stays one line; nothing is said
 * while where it sends isn't known.
 */
const SENDS = {
  tags: { service: "status.sends", computer: "status.sends.onThisComputer" },
  organize: {
    service: "status.sends.organize",
    computer: "status.sends.organize.onThisComputer",
  },
  organizeScans: {
    service: "status.sends.organize.scans",
    computer: "status.sends.organize.onThisComputer.scans",
  },
} as const;

export const taggingSends = (
  route: FlowRoute,
  t: (key: MessageKey, params?: MessageParams) => string,
  { folders = false, scans = false }: { folders?: boolean; scans?: boolean } = {},
): string | null => {
  if (route.where === "unknown" || route.where === "none") return null;
  const sends = folders ? (scans ? SENDS.organizeScans : SENDS.organize) : SENDS.tags;
  return route.where === "cloud"
    ? t(sends.service, { service: route.service.name })
    : t(sends.computer);
};
