/**
 * A pure function's results for the last `size` inputs it was given, by `key`: a long Note's
 * paragraphs are read again on every change, and all but the one typed in read the same.
 */
export function memoized<Args extends unknown[], Result>(
  size: number,
  key: (...args: Args) => string,
  compute: (...args: Args) => Result,
): (...args: Args) => Result {
  const results = new Map<string, { value: Result }>();
  return (...args: Args) => {
    const id = key(...args);
    const known = results.get(id);
    if (known) {
      // The most recently used goes last, so the oldest is the one to forget.
      results.delete(id);
      results.set(id, known);
      return known.value;
    }
    const value = compute(...args);
    results.set(id, { value });
    if (results.size > size) {
      const oldest = results.keys().next().value;
      if (oldest !== undefined) results.delete(oldest);
    }
    return value;
  };
}
