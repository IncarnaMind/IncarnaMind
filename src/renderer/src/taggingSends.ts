import type { MessageKey, MessageParams } from "../../shared/i18n";
import type { FlowRoute } from "./taggingDestination";

/**
 * Why six whole sentences rather than pieces joined with a space: each
 * dictionary joins its own (Chinese puts no space after its full stop).
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
  { folders = false, scans = null }: { folders?: boolean; scans?: FlowRoute | null } = {},
): string | null => {
  if (route.where === "unknown" || route.where === "none") return null;
  const readingScans = scans?.where === "cloud" || scans?.where === "local";
  const sameReader =
    readingScans &&
    (route.where === "local"
      ? scans.where === "local"
      : scans.where === "cloud" && route.service.id === scans.service.id);
  if (folders && readingScans && !sameReader) {
    const text =
      route.where === "cloud"
        ? t("status.sends.organize.text", { service: route.service.name })
        : t("status.sends.organize.text.onThisComputer");
    const images =
      scans.where === "cloud"
        ? t("status.sends.scans", { service: scans.service.name })
        : t("status.sends.scans.onThisComputer");
    return t("status.sends.withScans", { text, scans: images });
  }
  const sends = folders ? (sameReader ? SENDS.organizeScans : SENDS.organize) : SENDS.tags;
  return route.where === "cloud"
    ? t(sends.service, { service: route.service.name })
    : t(sends.computer);
};
