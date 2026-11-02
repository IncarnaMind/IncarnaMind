import type { Translate } from "./locations";

const KILOBYTE = 1000;
const MEGABYTE = 1000 * KILOBYTE;
const GIGABYTE = 1000 * MEGABYTE;

/**
 * A size in decimal units, as file managers on macOS show them: "640 KB",
 * "3.4 MB", "12 MB", "1.2 GB". Under a kilobyte counts as 1 KB, so nothing
 * reads "0".
 */
export function formatBytes(bytes: number, t: Translate): string {
  const scaled = (value: number) => (value < 10 ? Math.round(value * 10) / 10 : Math.round(value));
  if (bytes >= GIGABYTE) return t("units.gb", { size: scaled(bytes / GIGABYTE) });
  if (bytes >= MEGABYTE) return t("units.mb", { size: scaled(bytes / MEGABYTE) });
  return t("units.kb", { size: Math.max(1, Math.round(bytes / KILOBYTE)) });
}
