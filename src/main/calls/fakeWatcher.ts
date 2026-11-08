import type { CallWatcher } from "../../core";
import type { CallWatchProblem } from "../../core/api";

/** A test build's call watcher (INCARNAMIND_TEST_CALLS=1): a smoke test says which call apps use the microphone. */
export interface FakeCalls extends CallWatcher {
  use(apps: readonly string[]): void;
  fail(problem: CallWatchProblem): void;
  /** Whether the core watches now. */
  watching(): boolean;
}

export function createFakeCallWatcher(): FakeCalls {
  let listener: Parameters<CallWatcher["watch"]>[0] | null = null;
  let using: readonly string[] = [];
  return {
    watch(given) {
      listener = given;
      given.apps(using);
      return () => {
        if (listener === given) listener = null;
      };
    },
    use(apps) {
      using = [...apps];
      listener?.apps(using);
    },
    fail(problem) {
      listener?.problem(problem);
    },
    watching: () => listener !== null,
  };
}
