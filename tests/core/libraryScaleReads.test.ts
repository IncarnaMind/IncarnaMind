import { resolve } from "node:path";
import { StatementSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { ALL_SHARED_ID } from "../../src/core/api";
import { connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { replyingModel } from "../helpers/models";

/**
 * The window asks for a Note's figure schedule and the Documents added since a Note's checks again
 * on every change to the Note or to the Library, and an agent lists the Notes it reads on almost
 * every request. Each answer reads every Document from its row alone: reading a whole Document's
 * record costs queries for each one, and during a 2,000-Document import those calls took most of
 * the main process's busy time (#2772).
 */

const EXAMPLES = resolve(__dirname, "../../resources/examples");

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

/** The database reads `ask` makes until it has answered, its waits included. */
async function readsUntilAnswered(ask: () => Promise<unknown>): Promise<number> {
  const get = vi.spyOn(StatementSync.prototype, "get");
  const all = vi.spyOn(StatementSync.prototype, "all");
  try {
    await ask();
    return get.mock.calls.length + all.mock.calls.length;
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

// protects=an agent asked in an example lists the Notes it reads as fast in a big Library as in a small one: what it was lent, and which Notes are the examples, are read once a call, not once a Note (#3791); fails_when=each Note the list weighs reads the examples and their requests again
test("an agent lent an example lists 12 Notes with about as many reads as 2", async () => {
  const counts: number[] = [];
  for (const count of [2, 12]) {
    const { core } = await startAgentsCore(replyingModel(), { paths: { examples: EXAMPLES } });
    await core.setAgentsEnabled(true);
    const made = await core.createExamples();
    // In no Folder, each Note is weighed on its own: given all, the agent reads it unless it is an example.
    for (let i = 1; i <= count; i++) await core.createMind({ title: `Tides ${i}` });
    // A call reads the record of each Note no older than the pairing, to see whether the pairing
    // wrote it; Notes made in the very millisecond the pairing is would each be read once more.
    const newest = (await core.listMinds()).map((mind) => mind.createdAt).sort().at(-1) ?? "";
    await vi.waitFor(() => expect(new Date().toISOString() > newest).toBe(true));
    const { launch, pairing } = await core.connectAgent({
      name: "Claude Code",
      folderIds: [ALL_SHARED_ID],
      propose: false,
    });
    const agent = await connectLegacyAgent(launch);
    await core.askAgent({
      pairingId: pairing.id,
      mindId: made.mindId,
      ask: { kind: "question", text: "What was gross margin in the third quarter?" },
      onScreen: [],
      scope: null,
    });
    const list = () => agent.callTool({ name: "list_minds", arguments: {} });
    await list();
    // The core reads a Note again for ⌘K's search half a second after it is stored, and a search
    // does so at once: left to its timer, that reading could land in the count.
    await core.searchMinds("tides");
    counts.push(await readsUntilAnswered(list));
  }
  // Read for each Note, the examples and their requests took about 120 reads a Note: 339 for 2
  // Notes, 1,541 for 12. Read once a call, the list takes about as many for 12 as for 2.
  const [two = 0, twelve = 0] = counts;
  expect(two).toBeGreaterThan(0);
  expect(twelve - two).toBeLessThan(10);
});
