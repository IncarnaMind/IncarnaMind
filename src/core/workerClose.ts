export interface ClosableWorkerThread {
  postMessage(value: { close: true }): void;
  terminate(): Promise<number>;
  unref(): void;
  once(event: "exit", listener: () => void): unknown;
}

const WORKER_CLOSE_GRACE_MS = 5_000;

/**
 * Stops a worker thread without interrupting V8 mid-C++-call: Node 24 aborts in `node_zlib.cc`
 * (`init_done_ && "close before init"`) if `terminate()` lands while a worker is inside
 * synchronous zlib decompression. Asks the worker to close its port and exit cleanly, unrefs it
 * so it never delays process exit, and falls back to `terminate()` only if it hangs.
 */
export function closeWorkerThread(
  thread: ClosableWorkerThread,
  message: { close: true } = { close: true },
): void {
  thread.unref();
  let exited = false;
  const fallback = setTimeout(() => {
    if (!exited) void thread.terminate();
  }, WORKER_CLOSE_GRACE_MS);
  fallback.unref();
  thread.once("exit", () => {
    exited = true;
    clearTimeout(fallback);
  });
  try {
    thread.postMessage(message);
  } catch {
    clearTimeout(fallback);
    void thread.terminate();
  }
}
