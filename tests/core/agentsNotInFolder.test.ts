/**
 * An agent that may read Not in a Folder (#507), through the same interface
 * Claude Code or Codex use: the Documents in no Folder at the time of each
 * call, and nothing else. A Linked folder's files are in none until they are
 * filed; a Document moved into a Folder drops out, and one moved out comes in.
 */
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Core } from "../../src/core";
import { NOT_IN_A_FOLDER_ID } from "../../src/core/api";
import { buildAgentShim, connectLegacyAgent, resultText, startAgentsCore } from "../helpers/agents";
import {
  addAndProcess,
  createSourceFolder,
  linkAndProcess,
  writeSourceFile,
} from "../helpers/documents";
import { replyingModel } from "../helpers/models";

const note = (title: string, sentence: string) => `# ${title}\n\n${sentence}\n`;

interface SearchOut {
  passages: { passageId: string; documentId: string; cite: string | null }[];
}

const structured = <T>(result: unknown): T => {
  const { isError, structuredContent } = result as {
    isError?: boolean;
    structuredContent?: unknown;
  };
  expect(isError ?? false).toBe(false);
  return structuredContent as T;
};

/**
 * Five Documents that all say "harbour": Tides and, in a Linked folder, Ferry are in no
 * Folder; Reef and the Linked folder's Pilot are in Coast; Budget is in Finance.
 */
async function withHarbour(core: Core) {
  const own = await createSourceFolder();
  const [tides, reef, budget] = await addAndProcess(core, [
    await writeSourceFile(
      own,
      "Tides.md",
      note("Tides", "Spring tides at the harbour come twice a month."),
    ),
    await writeSourceFile(own, "Reef.md", note("Reef", "The harbour reef shelters young coral.")),
    await writeSourceFile(
      own,
      "Budget.md",
      note("Budget", "The harbour budget sets aside money for dredging."),
    ),
  ]);
  const linked = await createSourceFolder();
  await writeSourceFile(
    linked,
    "Ferry.md",
    note("Ferry", "The harbour ferry leaves every thirty minutes."),
  );
  await writeSourceFile(
    linked,
    "Pilot.md",
    note("Pilot", "The harbour pilot boards ships at the outer buoy."),
  );
  const fromLinked = await linkAndProcess(core, linked);
  const ferry = fromLinked.find((each) => each.name.startsWith("Ferry"));
  const pilot = fromLinked.find((each) => each.name.startsWith("Pilot"));
  if (!tides || !reef || !budget || !ferry || !pilot)
    throw new Error("The Documents weren't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
  await core.assignDocumentGroup(reef.id, coast.id);
  await core.assignDocumentGroup(pilot.id, coast.id);
  await core.assignDocumentGroup(budget.id, finance.id);
  await core.setAgentsEnabled(true);
  return { tides, reef, budget, ferry, pilot, coast, finance, own };
}

/** A core with the five Documents, and the agents connected with the Folders given. */
async function started() {
  const { core, ...rest } = await startAgentsCore(replyingModel());
  const library = await withHarbour(core);
  const connect = async (name: string, folderIds: string[]) =>
    connectLegacyAgent((await core.connectAgent({ name, folderIds })).launch);
  return { core, ...rest, ...library, connect };
}

const search = async (
  agent: Awaited<ReturnType<typeof connectLegacyAgent>>,
  folderIds?: string[],
) =>
  structured<SearchOut>(
    await agent.callTool({ name: "search", arguments: { query: "harbour", folderIds } }),
  ).passages;

const found = async (agent: Awaited<ReturnType<typeof connectLegacyAgent>>) =>
  [...new Set((await search(agent)).map((passage) => passage.documentId))].sort();

describe("an agent that may read Not in a Folder", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("searches, reads, cites and lists only the Documents in no Folder, a Linked folder's included", async () => {
    const { connect, tides, ferry, reef, pilot, budget, coast } = await started();
    const agent = await connect("Claude Code", [NOT_IN_A_FOLDER_ID]);
    const control = await connect("Cursor", [coast.id]);

    expect(await found(agent)).toEqual([tides.id, ferry.id].sort());
    const [elsewhere] = await search(control);
    if (!elsewhere?.cite) throw new Error("The control found nothing to cite.");

    const refused = async (name: string, args: Record<string, unknown>) => {
      const result = await agent.callTool({ name, arguments: args });
      expect(result.isError, name).toBe(true);
      return resultText(result);
    };
    for (const documentId of [reef.id, pilot.id, budget.id]) {
      expect(await refused("read_passages", { documentId })).toMatch(
        /No such Passage, Document, Note or Citation/,
      );
    }
    await refused("read_passages", { passageId: elsewhere.passageId });
    await refused("cite", { citations: [{ passageId: elsewhere.passageId, quote: "harbour" }] });
    await refused("show_citation", { cite: elsewhere.cite });
    expect(await refused("search", { query: "harbour", folderIds: [coast.id] })).toMatch(
      /isn’t shared with this agent/,
    );
    const checked = structured<{ citations: { check: string }[] }>(
      await agent.callTool({
        name: "check_citations",
        arguments: { text: `Harbour ${elsewhere.cite}.` },
      }),
    );
    expect(checked.citations).toEqual([expect.objectContaining({ check: "unknown" })]);

    const read = structured<{ documentId: string }>(
      await agent.callTool({ name: "read_passages", arguments: { documentId: ferry.id } }),
    );
    expect(read.documentId).toBe(ferry.id);
    const listed = structured<{ folders: { id: string; name: string; documents: number }[] }>(
      await agent.callTool({ name: "list_minds", arguments: {} }),
    );
    expect(listed.folders).toEqual([
      { id: NOT_IN_A_FOLDER_ID, name: "Not in a Folder", documents: 2, minds: [] },
    ]);
  });

  it("covers the Documents in no Folder at the time of each call", async () => {
    const { core, connect, tides, ferry, reef, budget, finance, coast, own } = await started();
    const agent = await connect("Claude Code", [NOT_IN_A_FOLDER_ID]);
    const [first] = await search(agent);
    const cite = first?.cite;
    if (!cite) throw new Error("Nothing was found to cite.");
    const stillChecks = async () =>
      structured<{ citations: { check: string }[] }>(
        await agent.callTool({ name: "check_citations", arguments: { text: `Harbour ${cite}.` } }),
      ).citations[0]?.check;
    expect(await found(agent)).toEqual([tides.id, ferry.id].sort());
    expect(await stillChecks()).toBe("found");

    // Moved into a Folder after pairing: gone from search, reading and what it cited before.
    for (const each of [tides, ferry]) await core.assignDocumentGroup(each.id, coast.id);
    expect(await found(agent)).toEqual([]);
    const read = await agent.callTool({
      name: "read_passages",
      arguments: { documentId: tides.id },
    });
    expect(read.isError).toBe(true);
    expect(await stillChecks()).toBe("unknown");

    // Moved out, or its Folder deleted: in.
    await core.assignDocumentGroup(reef.id, null);
    await core.deleteLibraryGroup(finance.id);
    expect(await found(agent)).toEqual([reef.id, budget.id].sort());
    // Added later, in no Folder.
    const [late] = await addAndProcess(core, [
      await writeSourceFile(
        own,
        "Lighthouse.md",
        note("Lighthouse", "The harbour lighthouse flashes twice."),
      ),
    ]);
    if (!late) throw new Error("The Document wasn't added.");
    expect(await found(agent)).toEqual([reef.id, budget.id, late.id].sort());
    // A Suggested Folder counts as its Folder while it waits.
    await core.restoreAssignment(late.id, {
      groupId: coast.id,
      source: "automatic",
      suggested: true,
      status: "classified",
      error: null,
      model: null,
    });
    expect(await found(agent)).toEqual([reef.id, budget.id].sort());
    // Deleted: gone.
    await core.deleteDocument(reef.id);
    expect(await found(agent)).toEqual([budget.id]);
  });

  it("reads no Mind, in a Folder or not", async () => {
    const { core, connect, coast } = await started();
    const inCoast = await core.createMind({ title: "Field notes", folderId: coast.id });
    const loose = await core.createMind({ title: "Loose notes" });
    const agent = await connect("Claude Code", [NOT_IN_A_FOLDER_ID]);

    const listed = structured<{ folders: { minds: unknown[] }[] }>(
      await agent.callTool({ name: "list_minds", arguments: {} }),
    );
    expect(listed.folders.flatMap((folder) => folder.minds)).toEqual([]);
    for (const mind of [inCoast, loose]) {
      const result = await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id } });
      expect(result.isError).toBe(true);
    }
  });

  it("is listed after the Folders it is chosen with, and can be narrowed to, but only if it was chosen", async () => {
    const { connect, tides, ferry, reef, pilot, coast, finance } = await started();
    const both = await connect("Claude Code", [coast.id, NOT_IN_A_FOLDER_ID]);
    const coastOnly = await connect("Cursor", [coast.id]);

    expect(await found(both)).toEqual([tides.id, ferry.id, reef.id, pilot.id].sort());
    const unfiled = await search(both, [NOT_IN_A_FOLDER_ID]);
    expect([...new Set(unfiled.map((each) => each.documentId))].sort()).toEqual(
      [tides.id, ferry.id].sort(),
    );
    const listed = structured<{ folders: { id: string }[] }>(
      await both.callTool({ name: "list_minds", arguments: {} }),
    );
    expect(listed.folders.map((each) => each.id)).toEqual([coast.id, NOT_IN_A_FOLDER_ID]);
    const outside = await both.callTool({
      name: "search",
      arguments: { query: "harbour", folderIds: [finance.id] },
    });
    expect(outside.isError).toBe(true);

    const refused = await coastOnly.callTool({
      name: "search",
      arguments: { query: "harbour", folderIds: [NOT_IN_A_FOLDER_ID] },
    });
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toMatch(/isn’t shared with this agent/);
  });

  it("is a choice the core keeps and checks, with the Folders that exist", async () => {
    const { core, coast } = await started();
    const { pairing } = await core.connectAgent({
      name: "Claude Code",
      folderIds: [NOT_IN_A_FOLDER_ID],
    });
    expect(pairing.folderIds).toEqual([NOT_IN_A_FOLDER_ID]);
    const updated = await core.updateAgent(pairing.id, {
      folderIds: [coast.id, NOT_IN_A_FOLDER_ID],
    });
    expect(updated.folderIds).toEqual([coast.id, NOT_IN_A_FOLDER_ID]);
    expect((await core.getAgents()).pairings[0]?.folderIds).toEqual([coast.id, NOT_IN_A_FOLDER_ID]);
    await expect(
      core.updateAgent(pairing.id, { folderIds: [NOT_IN_A_FOLDER_ID, "no-such-folder"] }),
    ).rejects.toThrow(/doesn.t exist/);
    await expect(
      core.connectAgent({ name: "Cursor", folderIds: ["not in a folder"] }),
    ).rejects.toThrow(/doesn.t exist/);
  });

  it("reads a Library of many Documents in no Folder, and still none in a Folder", async () => {
    const { core, connect, coast, own } = await started();
    const files: string[] = [];
    for (let index = 0; index < 120; index++) {
      files.push(
        await writeSourceFile(
          join(own, "many"),
          `Note ${index}.md`,
          note(`Note ${index}`, `The harbour log for day ${index}.`),
        ),
      );
    }
    await addAndProcess(core, files, 60_000);
    const agent = await connect("Claude Code", [NOT_IN_A_FOLDER_ID]);
    const listed = structured<{ folders: { documents: number }[] }>(
      await agent.callTool({ name: "list_minds", arguments: {} }),
    );
    expect(listed.folders[0]?.documents).toBe(122);
    const documents = await core.listDocuments();
    const filed = new Set(
      (await core.getLibrary()).assignments
        .filter((each) => each.groupId !== null)
        .map((each) => each.documentId),
    );
    expect(filed.size).toBe(3);
    const passages = await search(agent);
    for (const passage of passages) expect(filed.has(passage.documentId)).toBe(false);
    expect(documents.length - filed.size).toBe(122);
    expect(coast.id).not.toBe(NOT_IN_A_FOLDER_ID);
  }, 120_000);
});
