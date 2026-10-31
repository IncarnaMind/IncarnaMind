/**
 * For a state that is read with a wait and then sent: a read that ends after a later call's has
 * started is older than that call's, so it is dropped rather than sent last (#2302).
 *
 * Each call of the returned function starts a read, and returns whether that read is still the
 * newest one started.
 */
export function newestReads(): () => () => boolean {
  let reads = 0;
  return () => {
    const read = ++reads;
    return () => read === reads;
  };
}
