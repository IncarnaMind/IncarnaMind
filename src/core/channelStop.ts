/** How long a closed model's other end may take to answer what it is on before it is stopped all the same. */
const ANSWER_WAIT_MS = 30_000;

/**
 * Stops the other end of a model's channel once it has answered the requests it is on. Stopped
 * under a run, a Node worker thread aborts the whole process, onnxruntime's native code being
 * under it; a check of what the assistant wrote can still be searching as the core closes
 * (#2830). Nothing waits on the answers: they only tell when it is safe to stop.
 */
export function channelStops<C extends { stop(): void }>() {
  const closing = new Map<C, { left: Set<number>; timer: ReturnType<typeof setTimeout> }>();
  const stopNow = (channel: C) => {
    const entry = closing.get(channel);
    if (entry) clearTimeout(entry.timer);
    closing.delete(channel);
    channel.stop();
  };
  return {
    /** Stops `channel` once it has answered the requests `inFlight`, or now when it is on none. */
    close(channel: C, inFlight: ReadonlySet<number>): void {
      if (inFlight.size === 0) {
        channel.stop();
        return;
      }
      const timer = setTimeout(() => stopNow(channel), ANSWER_WAIT_MS);
      // Waiting never keeps the host from quitting.
      timer.unref?.();
      closing.set(channel, { left: new Set(inFlight), timer });
    },
    /** `channel` answered request `id`. */
    answered(channel: C, id: number): void {
      const entry = closing.get(channel);
      if (!entry) return;
      entry.left.delete(id);
      if (entry.left.size === 0) stopNow(channel);
    },
  };
}
