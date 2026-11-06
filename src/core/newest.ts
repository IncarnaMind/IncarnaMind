/**
 * For a state that is read with a wait and then sent: a read that ends after a later call's has
 * started is older than that call's, so it is dropped rather than sent last (#2302).
 *
 * Each call of the returned function starts a read, or a change that an older read must not undo,
 * and returns whether it is still the newest one started.
 */
export function newestReads(): () => () => boolean {
  let reads = 0;
  return () => {
    const read = ++reads;
    return () => read === reads;
  };
}

/**
 * A state read as the newest one: when that read fails and no later one has started, it is made
 * once more. The read before it was dropped, so a failed newest read would leave the window on
 * the state before the change (#2398). `stopped`: the caller is closing, so nothing more is read.
 */
export async function readNewest<T>(
  newest: () => boolean,
  read: () => Promise<T>,
  stopped: () => boolean = () => false,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (stopped() || !newest()) throw error;
    return read();
  }
}
