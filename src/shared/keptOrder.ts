/**
 * `items` in the order `kept` gives those it holds, with the rest each put in among them at a
 * random place: with nothing kept, a random order. Kept once per install, a list can grow without
 * moving what the User has already seen in it.
 */
export function keptOrder<T>(items: readonly T[], kept: unknown, random: () => number): T[] {
  const earlier = Array.isArray(kept) ? kept : [];
  const ordered = items
    .filter((item) => earlier.includes(item))
    .sort((a, b) => earlier.indexOf(a) - earlier.indexOf(b));
  for (const item of items) {
    if (!ordered.includes(item)) {
      ordered.splice(Math.floor(random() * (ordered.length + 1)), 0, item);
    }
  }
  return ordered;
}
