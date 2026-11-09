/**
 * An inference session that work may still be running on as its model closes: released under a
 * run, onnxruntime aborts the whole process. A check of what the assistant wrote can still be
 * searching as the core closes (#2830), so the session goes once its last run has ended.
 */
export interface SessionInUse {
  /** Runs `work` on the session; refused once it was let go. */
  use<T>(work: () => Promise<T>): Promise<T>;
  /** Lets the session go now, or as soon as the runs on it end. */
  release(): void;
}

export function sessionInUse(release: () => Promise<void>): SessionInUse {
  let running = 0;
  let closing = false;
  let released = false;
  const letGo = () => {
    if (released) return;
    released = true;
    release().catch((error: unknown) => {
      console.error("An inference session couldn't be released:", error);
    });
  };
  return {
    async use(work) {
      if (closing) throw new Error("The model was closed.");
      running++;
      try {
        return await work();
      } finally {
        running--;
        if (closing && running === 0) letGo();
      }
    },
    release() {
      closing = true;
      if (running === 0) letGo();
    },
  };
}
