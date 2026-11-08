import { StatementSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";

/**
 * The window asks for a Note's figure schedule, the ready Question and the Documents added since a
 * Note's checks again on every change to the Note or to the Library. Each answer reads every
 * Document from its row alone: reading a whole Document's record costs queries for each one, and
 * during a 2,000-Document import those calls took most of the main process's busy time (#2772).
 */

async function libraryOf(count: number): Promise<Core> {
  const core = startCore(await createTempDataFolder());
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

/** The database reads `ask` makes as it is called: the core answers each of these synchronously. */
function readsOf<T>(ask: () => Promise<T>): { reads: number; asked: Promise<T> } {
  const get = vi.spyOn(StatementSync.prototype, "get");
  const all = vi.spyOn(StatementSync.prototype, "all");
  try {
    const asked = ask();
    return { reads: get.mock.calls.length + all.mock.calls.length, asked };
  } finally {
    get.mockRestore();
    all.mockRestore();
  }
}

async function readsAt(
  count: number,
  ask: (core: Core, mindId: string) => Promise<unknown>,
): Promise<number> {
  const core = await libraryOf(count);
  const mind = await core.createMind({ title: "Tides" });
  const { reads, asked } = readsOf(() => ask(core, mind.id));
  await asked;
  return reads;
}

test("a Note's figure schedule reads as much with 12 Documents as with 2", async () => {
  const ask = (core: Core, mindId: string) => core.getFigureScheduleChange(mindId, null);
  const two = await readsAt(2, ask);
  expect(two).toBeGreaterThan(0);
  expect(await readsAt(12, ask)).toBe(two);
});

test("the Documents added since a Note's checks read as much with 12 Documents as with 2", async () => {
  const ask = (core: Core, mindId: string) => core.documentsAddedSinceChecks(mindId);
  const two = await readsAt(2, ask);
  expect(two).toBeGreaterThan(0);
  expect(await readsAt(12, ask)).toBe(two);
});

test("the ready Question reads as much with 12 Documents as with 2, and asks about all of them", async () => {
  const counts: number[] = [];
  for (const count of [2, 12]) {
    const core = await libraryOf(count);
    const { reads, asked } = readsOf(() => core.readyQuestion());
    expect((await asked)?.scope?.documentIds).toHaveLength(count);
    counts.push(reads);
  }
  expect(counts[0]).toBeGreaterThan(0);
  expect(counts[1]).toBe(counts[0]);
});
