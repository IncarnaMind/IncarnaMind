import { readFileSync } from "node:fs";
import { join } from "node:path";

const styles = readFileSync(join(__dirname, "../../src/renderer/src/styles.css"), "utf8");

export type Theme = "light" | "dark";

const HEX = "#[0-9a-fA-F]{6}";

/**
 * A colour token's value in a theme, from styles.css: its one value, or the side of its
 * `light-dark(light, dark)` (#1262).
 */
export function token(name: string, theme: Theme = "light"): string {
  const match = styles.match(
    new RegExp(`--color-${name}:\\s*(?:(${HEX})|light-dark\\((${HEX}),\\s*(${HEX})\\));`),
  );
  const value = match?.[1] ?? (theme === "light" ? match?.[2] : match?.[3]);
  if (!value) throw new Error(`No --color-${name} in styles.css.`);
  return value;
}

export const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG's contrast ratio between two colours. */
export const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};
