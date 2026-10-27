/**
 * Probe for #2104: a packaged start that stalls before its page loads names the step it was in,
 * in the startup test's retained event log. Nothing installs the hook outside that test.
 */
export function probeStep(name: string, extra?: Record<string, unknown>): void {
  (
    globalThis as {
      incarnamindStartupProbe?: {
        step: (name: string, extra?: Record<string, unknown>) => void;
      };
    }
  ).incarnamindStartupProbe?.step(name, extra);
}
