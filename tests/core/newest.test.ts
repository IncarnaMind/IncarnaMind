import { describe, expect, test } from "vitest";
import { newestReads, readNewest } from "../../src/core/newest";

describe("readNewest", () => {
  // protects=a newest read that fails is made once more, so the state before it isn't kept; fails_when=the first failure is reported without a second read; no_claim=what the second read returns.
  test("a newest read that fails is made once more", async () => {
    const newest = newestReads()();
    let reads = 0;

    const value = await readNewest(newest, async () => {
      reads++;
      if (reads === 1) throw new Error("Ollama is down");
      return "stored";
    });

    expect(value).toBe("stored");
    expect(reads).toBe(2);
  });

  // protects=an older read that fails is not read again, because a newer read will send the state; fails_when=a stale read is made again; no_claim=the newer read.
  test("an older read that fails is not made again", async () => {
    const start = newestReads();
    const older = start();
    start();
    let reads = 0;

    await expect(
      readNewest(older, async () => {
        reads++;
        throw new Error("Ollama is down");
      }),
    ).rejects.toThrow("Ollama is down");
    expect(reads).toBe(1);
  });

  // protects=a retry that also fails is reported, not swallowed; fails_when=the failure disappears; no_claim=the caller's own catch.
  test("a retry that also fails is reported", async () => {
    const newest = newestReads()();
    let reads = 0;

    await expect(
      readNewest(newest, async () => {
        reads++;
        throw new Error("Ollama is down");
      }),
    ).rejects.toThrow("Ollama is down");
    expect(reads).toBe(2);
  });

  // protects=a closing caller reads nothing more; fails_when=the retry runs after the core closed; no_claim=the caller's abort check.
  test("a stopped caller does not read again", async () => {
    const newest = newestReads()();
    let reads = 0;

    await expect(
      readNewest(
        newest,
        async () => {
          reads++;
          throw new Error("Ollama is down");
        },
        () => true,
      ),
    ).rejects.toThrow("Ollama is down");
    expect(reads).toBe(1);
  });
});
