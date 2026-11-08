import { StatementSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";

/**
 * The window asks for a Note's figure schedule and the ready Question again on every change to the
 * Note or to the Library. Each answer reads every Document from its row alone: reading a whole
 * Document's record costs a query for each one, and during a 2,000-Document import those calls
 * held the main process for most of its time (#2772).
 */

const cores: Core[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.close();
});

async function libraryOf(count: number): Promise<Core> {
  const core = startCore(await createTempDataFolder());
  cores.push(core);
  const folder = await createSourceFolder();
  const paths: string[] = [];
  for (let i = 1; i <= count; i++) {
    paths.push(
      await writeSourceFile(folder, `Tide notes ${i}.md`, `# Tide notes ${i}\n\nHigh water ${i}.`),
    );
  }
  await addAndProcess(core, paths);
  return core;
}

/** How many single-row reads `ask` makes as it is called: the core answers both synchronously. */
function rowReads(ask: () => Promise<unknown>): { reads: number; asked: Promise<unknown> } {
  const get = vi.spyOn(StatementSync.prototype, "get");
  try {
    const asked = ask();
    return { reads: get.mock.calls.length, asked };
  } finally {
    get.mockRestore();
  }
}

test("a Note's figure schedule reads as much with 12 Documents as with 2", async () => {
  const counts: number[] = [];
  for (const count of [2, 12]) {
    const core = await libraryOf(count);
    const mind = await core.createMind({ title: "Tides" });
    const { reads, asked } = rowReads(() => core.getFigureScheduleChange(mind.id, null));
    await expect(asked).resolves.toMatchObject({ token: expect.any(String) });
    counts.push(reads);
  }
  expect(counts[1]).toBe(counts[0]);
});

test("the ready Question reads as much with 12 Documents as with 2, and asks about all of them", async () => {
  const counts: number[] = [];
  for (const count of [2, 12]) {
    const core = await libraryOf(count);
    const { reads, asked } = rowReads(() => core.readyQuestion());
    const ready = (await asked) as Awaited<ReturnType<Core["readyQuestion"]>>;
    expect(ready?.scope?.documentIds).toHaveLength(count);
    counts.push(reads);
  }
  expect(counts[1]).toBe(counts[0]);
});
