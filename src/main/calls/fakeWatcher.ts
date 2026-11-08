import type { CallWatcher } from "../../core";
import type { CallWatchProblem } from "../../core/api";

/** A test build's call watcher (INCARNAMIND_TEST_CALLS=1): a smoke test says which call apps use the microphone. */
export interface FakeCalls extends CallWatcher {
  /** `exact` false: as macOS 12 and 13 say it, naming only the app in front. */
  use(apps: readonly string[], exact?: boolean): void;
  fail(problem: CallWatchProblem): void;
  /** Whether the core watches now. */
  watching(): boolean;
}

export function createFakeCallWatcher(): FakeCalls {
  let listener: Parameters<CallWatcher["watch"]>[0] | null = null;
  let using: readonly string[] = [];
  let exactly = true;
  return {
    watch(given) {
      listener = given;
      given.apps(using, exactly);
      return () => {
        if (listener === given) listener = null;
      };
    },
    use(apps, exact = true) {
      using = [...apps];
      exactly = exact;
      listener?.apps(using, exactly);
    },
    fail(problem) {
      listener?.problem(problem);
    },
    watching: () => listener !== null,
  };
}
