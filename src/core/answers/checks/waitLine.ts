/**
 * The shortest wait after a rate limit that a write's row names (#2944). A clock time to the minute
 * says nothing of a second's wait, and the row shouldn't change its words every second while its
 * marks still land.
 */
export const ROW_WAIT_MS = 5_000;

/**
 * What a write's row says of its run's wait after a rate limit (`runItems`' `onPause`): when the
 * wait ends, for a wait of `ROW_WAIT_MS` or more, from its start to its end, and nothing (null) for
 * a shorter one. Once it names a wait it holds it until that wait is over, so it never goes back to
 * its checking words and comes again inside one wait; a wait that runs longer moves its time on.
 */
export function waitLine(now: () => number, show: (until: number | null) => void) {
  let shown: number | null = null;
  return (until: number | null): void => {
    const at = now();
    if (shown !== null && at < shown) {
      if (until !== null && until > shown) {
        shown = until;
        show(until);
      }
      return;
    }
    const next = until !== null && until - at >= ROW_WAIT_MS ? until : null;
    if (next === shown) return;
    shown = next;
    show(next);
  };
}
