import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pair } from "./types";

export const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export const hash = (text: string) => createHash("sha256").update(text).digest().readUInt32BE(0);

export const splitOf = (group: string): Pair["split"] => (hash(group) % 2 === 0 ? "dev" : "test");

/** A row of cells: it has the figures but not the column names, so only the Passage around it says what they are. */
export function isRow(document: string, quote: string): boolean {
  if (/\.(xlsx|csv)$/i.test(document)) return true;
  if (/[一-鿿]/.test(quote)) return (quote.match(/\s|\|/g) ?? []).length >= 2 && /\d/.test(quote);
  return (
    (quote.match(/\d+/g) ?? []).length >= 2 && (quote.match(/\b[a-z]{4,}\b/g) ?? []).length <= 1
  );
}

export function trigrams(text: string): Map<string, number> {
  const flat = text.toLowerCase().replace(/\s+/g, " ");
  const counts = new Map<string, number>();
  for (let i = 0; i + 3 <= flat.length; i++) {
    const gram = flat.slice(i, i + 3);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

export function dice(a: Map<string, number>, b: Map<string, number>): number {
  let shared = 0;
  let total = 0;
  for (const [gram, n] of a) {
    shared += Math.min(n, b.get(gram) ?? 0);
    total += n;
  }
  for (const n of b.values()) total += n;
  return total === 0 ? 0 : (2 * shared) / total;
}
