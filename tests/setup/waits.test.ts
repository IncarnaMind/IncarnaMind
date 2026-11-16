import { describe, expect, test, vi } from "vitest";

describe("A test's wait for a state (#3000)", () => {
  // protects=a wait that names no limit outlasts Vitest's own second, so a state a loaded runner reaches late is still seen; fails_when=the suite's setup no longer gives such a wait its limit, and the wait ends after one second; no_claim=how long a wait may take, which its test's timeout bounds.
  test("a wait that names no limit outlasts a second", async () => {
    let reached = false;
    const later = setTimeout(() => {
      reached = true;
    }, 1_300);
    try {
      await vi.waitFor(() => expect(reached).toBe(true));
    } finally {
      clearTimeout(later);
    }
  });

  // protects=a limit a test names is the one its wait gets, as options or as a number, and an interval named alone keeps the suite's limit; fails_when=the setup overrides a named limit, so a wait meant to end soon runs on; no_claim=waits made by helpers, which name their own.
  test("a wait keeps the limit its test names", async () => {
    const never = () => {
      throw new Error("not reached");
    };
    await expect(vi.waitFor(never, { timeout: 60, interval: 10 })).rejects.toThrow("not reached");
    await expect(vi.waitFor(never, 60)).rejects.toThrow("not reached");
    let calls = 0;
    await vi.waitFor(
      () => {
        calls++;
        expect(calls).toBeGreaterThan(2);
      },
      { interval: 5 },
    );
  });
});
