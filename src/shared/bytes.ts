import type { Translate } from "./locations";

/**
 * A size in decimal units, as file managers on macOS show them: "640 KB",
 * "3.4 MB", "12 MB", "1.2 GB". Under a kilobyte counts as 1 KB, so nothing
 * reads "0". With `kilobyte` 1024, in the binary units Windows shows them in.
 */
export function formatBytes(bytes: number, t: Translate, kilobyte: 1000 | 1024 = 1000): string {
  const megabyte = kilobyte * kilobyte;
  const gigabyte = megabyte * kilobyte;
  const scaled = (value: number) => (value < 10 ? Math.round(value * 10) / 10 : Math.round(value));
  if (bytes >= gigabyte) return t("units.gb", { size: scaled(bytes / gigabyte) });
  if (bytes >= megabyte) return t("units.mb", { size: scaled(bytes / megabyte) });
  return t("units.kb", { size: Math.max(1, Math.round(bytes / kilobyte)) });
}
