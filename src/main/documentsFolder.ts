import { join } from "node:path";
import type { Logger } from "../core/adapters";

export function documentsFolder(
  getPath: () => string,
  home: string,
  log: Pick<Logger, "warn">,
): string {
  try {
    return getPath();
  } catch (error) {
    const fallback = join(home, "Documents");
    log.warn("output.documentsUnavailable", { error: String(error), fallback });
    return fallback;
  }
}
