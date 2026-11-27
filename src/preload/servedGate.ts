export interface ServedIpc {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  send(channel: string, ...args: unknown[]): void;
}

/**
 * Holds preload IPC calls until the main process serves its channels (`servedChannel`), flushes
 * every queued call in FIFO order before opening the direct path, and thereafter forwards calls
 * synchronously in the turn they are made (#2104, #2336).
 */
export function createServedGate(ipc: ServedIpc, servedChannel: string): ServedIpc {
  let isServed = false;
  let hasFailed = false;
  let failed: unknown;
  let queue: (() => void)[] | null = [];

  ipc.invoke(servedChannel).then(
    () => {
      while (queue !== null && queue.length > 0) {
        const pending = queue;
        queue = [];
        for (const run of pending) {
          try {
            run();
          } catch {
            // Keep flushing the rest of the startup queue if one synchronous handler throws.
          }
        }
      }
      queue = null;
      isServed = true;
    },
    (error: unknown) => {
      hasFailed = true;
      failed = error;
      const pending = queue ?? [];
      queue = null;
      for (const run of pending) {
        try {
          run();
        } catch {
          // Keep settling the rest of the startup queue on failure.
        }
      }
    },
  );

  const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
    if (isServed) return ipc.invoke<T>(channel, ...args);
    if (hasFailed) return Promise.reject(failed);
    return new Promise<T>((resolve, reject) => {
      queue?.push(() => {
        if (hasFailed) {
          reject(failed);
          return;
        }
        try {
          ipc.invoke<T>(channel, ...args).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      });
    });
  };

  const send = (channel: string, ...args: unknown[]): void => {
    if (isServed) {
      ipc.send(channel, ...args);
      return;
    }
    if (hasFailed) return;
    queue?.push(() => {
      if (hasFailed) return;
      ipc.send(channel, ...args);
    });
  };

  return { invoke, send };
}
