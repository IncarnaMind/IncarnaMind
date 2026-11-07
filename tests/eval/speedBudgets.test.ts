/**
 * The speed baseline's budget table (eval/speed/README.md): each flow #1624 gives a budget, on
 * its class of model, held at the 95th percentile of its runs, which with three runs is the
 * slowest; a failed run misses the budget too.
 */
import { describe, expect, test } from "vitest";
import { budgetTable, type FlowRun, flowTable } from "../../eval/speed/report";

function run(
  flow: string,
  model: string,
  times: { sign: number; words: number | null; change?: number; done: number } | null,
): FlowRun {
  return {
    flow,
    model,
    language: "en",
    signs: times && {
      startedAt: "2026-11-07T00:00:00.000Z",
      firstSignMs: times.sign,
      firstWordsMs: times.words,
      firstChangeMs: times.change ?? null,
      doneMs: times.done,
      longestQuietMs: 1000,
    },
    error: times ? null : "The model failed.",
    records: [],
  };
}

const rows = (table: string) => table.split("\n").slice(2);

describe("The budget table", () => {
  test("a Question on a Haiku-class model meets 3 s and 6 s only when its slowest of three runs does", () => {
    const haiku = "anthropic/claude-haiku-5-5";
    const fast = { sign: 10, words: 2500, done: 5000 };
    const table = budgetTable([
      run("question", haiku, fast),
      run("question", haiku, fast),
      run("question", haiku, { sign: 10, words: 3100, done: 5500 }),
    ]);

    expect(rows(table)).toEqual([
      "| Ask a Question, a Haiku-class model | question | anthropic/claude-haiku-5-5 | en | 0.0 s of 0.5 s | **3.1 s** of 3.0 s (words) | 5.5 s of 6.0 s | **missed** |",
    ]);
  });

  test("a Sonnet-class model is held to 6 s and 12 s, an edit to its first change in 8 s, and a flow with no budget isn't listed", () => {
    const table = budgetTable([
      run("question", "anthropic/claude-sonnet-5-5", { sign: 20, words: 5900, done: 11_000 }),
      run("edit-with-ai", "deepseek/deepseek-flash", {
        sign: 600,
        words: 900,
        change: 900,
        done: 1200,
      }),
      run("comparison", "deepseek/deepseek-flash", { sign: 0, words: 0, done: 9000 }),
    ]);

    expect(rows(table)).toEqual([
      "| Ask a Question, a Sonnet-class model | question | anthropic/claude-sonnet-5-5 | en | 0.0 s of 0.5 s | 5.9 s of 6.0 s (words) | 11.0 s of 12.0 s | met |",
      "| Edit a note | edit-with-ai | deepseek/deepseek-flash | en | **0.6 s** of 0.5 s | 0.9 s of 8.0 s (change in the page) | 1.2 s of 15.0 s | **missed** |",
    ]);
  });

  test("a failed run misses the budget, though the runs that finished met it", () => {
    const haiku = "anthropic/claude-haiku-5-5";
    const table = budgetTable([
      run("question", haiku, { sign: 0, words: 2000, done: 4000 }),
      run("question", haiku, null),
    ]);

    expect(rows(table)[0]).toMatch(/\| \*\*missed\*\* \|$/);
  });

  test("the flow table gives the median and the 95th percentile, the slowest of three", () => {
    const haiku = "anthropic/claude-haiku-5-5";
    const table = flowTable([
      run("question", haiku, { sign: 0, words: 1000, done: 2000 }),
      run("question", haiku, { sign: 0, words: 1000, done: 3000 }),
      run("question", haiku, { sign: 0, words: 1000, done: 9000 }),
    ]);

    expect(rows(table)[0]).toContain("| 3.0 s / 9.0 s |");
  });
});
