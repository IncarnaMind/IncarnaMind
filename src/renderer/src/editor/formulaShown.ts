/**
 * A saved result and the one worked out again, each to as few decimals as still tell them apart:
 * "0.07" against "-0.09", never twelve digits of a ratio (#3493).
 */
export function shownPair(
  saved: string,
  worked: string,
  language: string,
): { saved: string; worked: string } {
  const a = Number(saved);
  const b = Number(worked);
  if (saved.trim() === "" || worked.trim() === "" || !Number.isFinite(a) || !Number.isFinite(b)) {
    return { saved, worked };
  }
  for (const digits of [2, 4, 6, 10]) {
    const format = new Intl.NumberFormat(language, { maximumFractionDigits: digits });
    const pair = { saved: format.format(a), worked: format.format(b) };
    if (pair.saved !== pair.worked || digits === 10) return pair;
  }
  return { saved, worked };
}
