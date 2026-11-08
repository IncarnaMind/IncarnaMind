import type { Meeting } from "../../core/api";
import { formatBytes } from "../../shared/bytes";
import type { useT } from "./i18n";

/** How far the speech model's download is, while it isn't on this computer yet. */
export function speechModelDownload(
  model: NonNullable<Meeting["transcript"]>["model"],
  t: ReturnType<typeof useT>,
): { percent: number; size: string } | null {
  return model?.state === "downloading" || model?.state === "not-downloaded"
    ? {
        percent: Math.floor((model.downloadedBytes / Math.max(1, model.totalBytes)) * 100),
        size: formatBytes(model.totalBytes, t),
      }
    : null;
}
