/**
 * Outside agents (#351): an agent connects through the shim the app ships,
 * as Claude Code or Codex would, with the MCP SDK's own client, and searches,
 * reads and cites only the Folders its pairing may read.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type Core, DATABASE_FILE } from "../../src/core";
import { agentSocketPath, isSocketPathUsable, MAX_SOCKET_PATH_BYTES } from "../../src/core/agents";
import { READ_PART_TOKENS } from "../../src/core/agents/access";
import { SORTING_MOST, type SortingBatch } from "../../src/core/agents/sorting";
import { estimateTokens } from "../../src/core/answers/context";
import { ALL_SHARED_ID } from "../../src/core/api";
import { openDatabase } from "../../src/core/storage";
import { translate } from "../../src/shared/i18n";
import {
  agentsAdapter,
  buildAgentShim,
  connectLegacyAgent,
  connectModernAgent,
  resultText,
  startAgentsCore,
} from "../helpers/agents";
import { citingModel } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";
import { paragraph, run, wordFile } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

const TIDES = [
  "# Tides",
  "",
  "## Spring tides",
  "",
  "Spring tides happen twice a month, at new moon and full moon, when the sun and the moon pull in line. Their range is the largest of the month.",
  "",
  "## Neap tides",
  "",
  "Neap tides come at the first and third quarters of the moon, when the sun and the moon pull at right angles. Their range is the smallest of the month.",
].join("\n");

const BUDGET = [
  "# Budget 2026",
  "",
  "The harbour budget for 2026 sets aside 4.2 million for dredging the channel before the spring tides.",
].join("\n");

const SPRING = "Spring tides happen twice a month, at new moon and full moon";

/** A Tool call's typed result, once it is known not to be a refusal. */
const structured = <T>(result: unknown): T => {
  const { isError, structuredContent } = result as {
    isError?: boolean;
    structuredContent?: unknown;
  };
  expect(isError ?? false).toBe(false);
  return structuredContent as T;
};

interface SearchOut {
  passages: {
    passageId: string;
    documentId: string;
    document: string;
    location: string | null;
    quote: string | null;
    cite: string | null;
    text: string;
  }[];
  page: number;
  more: boolean;
}

/** Two Folders: "Coast" with Tides.md, "Finance" with Budget.md. */
async function withLibrary(core: Core) {
  const sources = await createSourceFolder();
  const [tides, budget] = await addAndProcess(core, [
    await writeSourceFile(sources, "Tides.md", TIDES),
    await writeSourceFile(sources, "Budget.md", BUDGET),
  ]);
  if (!tides || !budget) throw new Error("The Documents weren't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.assignDocumentGroup(budget.id, finance.id);
  return { tides, budget, coast, finance };
}

/** A core with agents on, the two Folders, and a pairing that may read "Coast". */
async function pairedToCoast(model = replyingModel()) {
  const started = await startAgentsCore(model);
  const library = await withLibrary(started.core);
  await started.core.setAgentsEnabled(true);
  const connected = await started.core.connectAgent({
    name: "Claude Code",
    folderIds: [library.coast.id],
  });
  return { ...started, ...library, ...connected };
}

describe("outside agents", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("are off by default: nothing listens, and the shim says IncarnaMind isn't reachable", async () => {
    const { core } = await startAgentsCore(replyingModel());
    expect(await core.getAgents()).toEqual({
      enabled: false,
      paused: null,
      pairings: [],
      skills: [],
      skillsOutOfDate: [],
      awaitingInstall: [],
    });
    const { launch, pairing } = await core.connectAgent({ name: "Codex", client: "codex" });
    expect(pairing).toMatchObject({ name: "Codex", client: "codex", folderIds: [] });
    await expect(core.connectAgent({ name: "Codex" })).rejects.toThrow(/already connected/);
    await expect(core.connectAgent({ name: "Odd", client: "../codex" })).rejects.toThrow();

    await expect(connectLegacyAgent(launch)).rejects.toThrow(/IncarnaMind isn't open/);
  });

  it("search the paired Folder: Passages with Locations and a ready Citation that checks as found", async () => {
    const { core, launch, tides, pairing } = await pairedToCoast();
    const agent = await connectLegacyAgent(launch);

    const found = structured<SearchOut>(
      await agent.callTool({ name: "search", arguments: { query: "spring tides new moon" } }),
    );
    expect(found.passages.length).toBeGreaterThan(0);
    const [first] = found.passages;
    expect(first).toMatchObject({ documentId: tides.id, document: "Tides" });
    expect(first?.location).toContain("Spring tides");
    expect(first?.quote).toContain(SPRING);
    expect(first?.cite).toMatch(/^\[cite:[a-z0-9]{8}\]$/);
    // The text an agent reads comes as JSON too, for clients that read only text.
    const asText: unknown = JSON.parse(
      resultText(await agent.callTool({ name: "search", arguments: { query: "spring tides" } })),
    );
    expect(asText).toHaveProperty("passages");

    const checked = structured<{ citations: { check: string }[]; uncited: string[] }>(
      await agent.callTool({
        name: "check_citations",
        arguments: {
          text: [
            "## When tides are high",
            `Spring tides come at new and full moon ${first?.cite}. The moon is made of cheese and nobody cites it.`,
            // Cited after its full stop, as agents often write it: the Citation is this sentence's.
            `- Spring tides come twice in every month. ${first?.cite}`,
            "| Tide type | When it comes in the month |",
            "| --- | --- |",
          ].join("\n"),
        },
      }),
    );
    expect(checked.citations).toEqual([expect.objectContaining({ check: "found" })]);
    expect(checked.uncited).toEqual(["The moon is made of cheese and nobody cites it."]);

    const activity = await core.listAgentActivity(pairing.id);
    expect(activity.map((each) => [each.tool, each.outcome])).toEqual([
      ["check_citations", "done"],
      ["search", "done"],
      ["search", "done"],
    ]);
    expect(activity.at(-1)).toMatchObject({
      summary: "spring tides new moon",
      documentIds: [tides.id],
      effects: [{ action: "read", scope: { kind: "documents" } }],
    });
  });

  // protects=a draft of any length is checked at once, never holding up the app; fails_when=a long run of full stops or spaces with no Citation after it takes seconds to read
  it("check a draft as long as they may send at once, however its full stops and spaces run", async () => {
    const { launch } = await pairedToCoast();
    const agent = await connectLegacyAgent(launch);
    for (const text of [
      `Spring tides come at new and full moon${"!".repeat(99_000)}`,
      `Spring tides come at new and full moon${" ".repeat(99_000)}and neap tides between.`,
    ]) {
      const started = performance.now();
      const checked = structured<{ uncited: string[] }>(
        await agent.callTool({ name: "check_citations", arguments: { text } }),
      );
      // Far above the few milliseconds it takes, and far below the seconds a pattern that
      // backtracks took on such a run, so a slow machine doesn't fail it.
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(checked.uncited[0]).toMatch(/^Spring tides come at new and full moon/);
    }
  });

  it("cite a quote copied from a Passage, and give none for a quote that isn't there", async () => {
    const { launch } = await pairedToCoast();
    const agent = await connectLegacyAgent(launch);
    const [passage] = structured<SearchOut>(
      await agent.callTool({ name: "search", arguments: { query: "neap tides" } }),
    ).passages;
    if (!passage) throw new Error("Nothing was found.");

    const cited = structured<{
      citations: { check: string; cite: string | null; text: string | null }[];
    }>(
      await agent.callTool({
        name: "cite",
        arguments: {
          citations: [
            { passageId: passage.passageId, quote: "Their range is the smallest of the month." },
            { passageId: passage.passageId, quote: "Neap tides happen only in winter." },
          ],
        },
      }),
    );
    expect(cited.citations[0]).toMatchObject({ check: "found", text: null });
    expect(cited.citations[0]?.cite).toMatch(/^\[cite:[a-z0-9]{8}\]$/);
    expect(cited.citations[1]).toMatchObject({ check: "not-found", cite: null });
    expect(cited.citations[1]?.text).toContain("Neap tides come at the first and third quarters");

    const read = structured<{ passages: { passageId: string; text: string }[] }>(
      await agent.callTool({ name: "read_passages", arguments: { passageId: passage.passageId } }),
    );
    expect(read.passages.map((each) => each.passageId)).toEqual([passage.passageId]);
  });

  it("read the User's own workings but never cite them: no Citation in a search, none for a quote, until the User cites them again", async () => {
    const { core, launch, tides } = await pairedToCoast();
    const agent = await connectLegacyAgent(launch);
    await core.setNotCited(tides.id, true);

    const [passage] = structured<SearchOut>(
      await agent.callTool({ name: "search", arguments: { query: "neap tides" } }),
    ).passages;
    expect(passage).toMatchObject({ documentId: tides.id, quote: null, cite: null });
    expect(passage?.text).toContain("Neap tides come at the first and third quarters");

    const read = structured<{ passages: { text: string }[] }>(
      await agent.callTool({
        name: "read_passages",
        arguments: { passageId: passage?.passageId },
      }),
    );
    expect(read.passages[0]?.text).toContain("Neap tides come at the first and third quarters");

    const refused = await agent.callTool({
      name: "cite",
      arguments: {
        citations: [
          { passageId: passage?.passageId, quote: "Their range is the smallest of the month." },
        ],
      },
    });
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toMatch(/own working file/);

    await core.setNotCited(tides.id, false);
    const [again] = structured<SearchOut>(
      await agent.callTool({ name: "search", arguments: { query: "neap tides" } }),
    ).passages;
    expect(again?.cite).toMatch(/^\[cite:[a-z0-9]{8}\]$/);
  });

  it("are refused outside their Folders", async () => {
    const { core, launch, budget, finance, coast } = await pairedToCoast();
    const agent = await connectLegacyAgent(launch);

    const found = structured<SearchOut>(
      await agent.callTool({ name: "search", arguments: { query: "harbour budget dredging" } }),
    );
    expect(found.passages.map((each) => each.documentId)).not.toContain(budget.id);

    const elsewhere = await agent.callTool({
      name: "search",
      arguments: { query: "budget", folderIds: [finance.id] },
    });
    expect(elsewhere.isError).toBe(true);
    expect(resultText(elsewhere)).toMatch(/isn’t shared with this agent/);

    const fromStart = await agent.callTool({
      name: "read_passages",
      arguments: { documentId: budget.id },
    });
    expect(fromStart.isError).toBe(true);
    expect(resultText(fromStart)).toMatch(/No such passage, Document, note or Citation/);

    const listed = structured<{ folders: { id: string; name: string }[] }>(
      await agent.callTool({ name: "list_minds", arguments: {} }),
    );
    expect(listed.folders.map((each) => each.id)).toEqual([coast.id]);

    // A new pairing reads nothing until the User picks its Folders.
    const second = await core.connectAgent({ name: "Cursor" });
    const unscoped = await connectLegacyAgent(second.launch);
    const nothing = await unscoped.callTool({ name: "search", arguments: { query: "tides" } });
    expect(nothing.isError).toBe(true);
    expect(resultText(nothing)).toMatch(/can’t read any Documents yet/);
  });

  it("approves a walled Folder alone, but never beside another Folder", async () => {
    const { core, launch, coast, finance, budget, pairing } = await pairedToCoast();
    await core.updateLibraryGroup(coast.id, {
      name: coast.name,
      description: coast.description,
      keepInside: true,
    });
    await expect(
      core.updateAgent(pairing.id, { folderIds: [coast.id, finance.id] }),
    ).rejects.toThrow(
      "Coast keeps its work inside it, so it can’t share an agent with other Folders",
    );
    await core.updateSettings({ user: { language: "zh-CN" } });
    await expect(
      core.updateAgent(pairing.id, { folderIds: [coast.id, finance.id] }),
    ).rejects.toThrow("“Coast”只在本文件夹内工作，不能和其他文件夹共用一个智能体");
    await core.updateSettings({ user: { language: "en" } });
    const own = await core.createMind({ title: "Coast note", folderId: coast.id });
    const other = await core.createMind({ title: "Finance note", folderId: finance.id });
    const agent = await connectLegacyAgent(launch);

    const listed = structured<{ folders: { id: string; minds: { id: string }[] }[] }>(
      await agent.callTool({ name: "list_minds", arguments: {} }),
    );
    expect(listed.folders.map((folder) => folder.id)).toEqual([coast.id]);
    expect(listed.folders[0]?.minds.map((mind) => mind.id)).toEqual([own.id]);

    const found = structured<SearchOut>(
      await agent.callTool({ name: "search", arguments: { query: "harbour budget" } }),
    );
    expect(found.passages.map((passage) => passage.documentId)).not.toContain(budget.id);
    const outside = await agent.callTool({ name: "read_mind", arguments: { mindId: other.id } });
    expect(outside.isError).toBe(true);
    expect(resultText(outside)).toMatch(/No such passage, Document, note or Citation/);
  });

  it("reads the Folder it is paired to inside a wall, never its sibling, and the whole wall when that is paired", async () => {
    const { core } = await startAgentsCore(replyingModel());
    const sources = await createSourceFolder();
    const [drafts, filed] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Drafts.md",
        "# Drafts\n\nThe harbour lease draft runs to forty pages.\n",
      ),
      await writeSourceFile(
        sources,
        "Filed.md",
        "# Filed\n\nThe harbour notice was served in June.\n",
      ),
    ]);
    if (!drafts || !filed) throw new Error("The Documents weren't added.");
    const client = await core.createLibraryGroup({ name: "Client A", description: "One client." });
    await core.updateLibraryGroup(client.id, {
      name: client.name,
      description: client.description,
      keepInside: true,
    });
    const draftsFolder = await core.createLibraryGroup({
      name: "Drafts",
      description: "",
      parentId: client.id,
    });
    const filedFolder = await core.createLibraryGroup({
      name: "Filed",
      description: "",
      parentId: client.id,
    });
    await core.assignDocumentGroup(drafts.id, draftsFolder.id);
    await core.assignDocumentGroup(filed.id, filedFolder.id);
    await core.setAgentsEnabled(true);

    // Paired to one Folder inside the wall: what it names, and never its sibling.
    const inside = await core.connectAgent({
      name: "Claude Code",
      folderIds: [draftsFolder.id],
    });
    const agent = await connectLegacyAgent(inside.launch);
    const listed = structured<{
      folders: { id: string; name: string; documents: number; minds: unknown[] }[];
    }>(await agent.callTool({ name: "list_minds", arguments: {} }));
    expect(listed.folders).toEqual([
      {
        id: draftsFolder.id,
        name: "Drafts",
        documents: 1,
        documentList: [{ id: drafts.id, name: drafts.name, kind: "markdown" }],
        minds: [],
      },
    ]);
    const found = structured<SearchOut>(
      await agent.callTool({ name: "search", arguments: { query: "harbour" } }),
    );
    expect([...new Set(found.passages.map((passage) => passage.documentId))]).toEqual([drafts.id]);
    const sibling = await agent.callTool({
      name: "read_passages",
      arguments: { documentId: filed.id },
    });
    expect(sibling.isError).toBe(true);

    // Paired to the wall itself: what it names, and the Folders inside it.
    const whole = await core.connectAgent({ name: "Codex", folderIds: [client.id] });
    const wallAgent = await connectLegacyAgent(whole.launch);
    const wholeListed = structured<{
      folders: { id: string; name: string; documents: number; minds: unknown[] }[];
    }>(await wallAgent.callTool({ name: "list_minds", arguments: {} }));
    // The wall and the Folders inside it, each with what is filed in it (#3394).
    expect(wholeListed.folders).toEqual([
      { id: client.id, name: "Client A", documents: 0, documentList: [], minds: [] },
      {
        id: draftsFolder.id,
        name: "Drafts",
        path: "Client A / Drafts",
        documents: 1,
        documentList: [{ id: drafts.id, name: drafts.name, kind: "markdown" }],
        minds: [],
      },
      {
        id: filedFolder.id,
        name: "Filed",
        path: "Client A / Filed",
        documents: 1,
        documentList: [{ id: filed.id, name: filed.name, kind: "markdown" }],
        minds: [],
      },
    ]);
    const wholeFound = structured<SearchOut>(
      await wallAgent.callTool({ name: "search", arguments: { query: "harbour" } }),
    );
    expect([...new Set(wholeFound.passages.map((passage) => passage.documentId))].sort()).toEqual(
      [drafts.id, filed.id].sort(),
    );
  });

  it("never reads the wall inside the wall it is paired to, and refuses two Folders behind one wall", async () => {
    const { core } = await startAgentsCore(replyingModel());
    const sources = await createSourceFolder();
    const [harbour, moon] = await addAndProcess(core, [
      await writeSourceFile(sources, "Harbour.md", "# Harbour\n\nThe harbour wall holds.\n"),
      await writeSourceFile(sources, "Moon.md", "# Moon\n\nThe harbour at night.\n"),
    ]);
    if (!harbour || !moon) throw new Error("The Documents weren't added.");
    const clientA = await core.createLibraryGroup({ name: "Client A", description: "" });
    const clientB = await core.createLibraryGroup({ name: "Client B", description: "" });
    for (const folder of [clientA, clientB])
      await core.updateLibraryGroup(folder.id, {
        name: folder.name,
        description: folder.description,
        keepInside: true,
      });
    const drafts = await core.createLibraryGroup({
      name: "Drafts",
      description: "",
      parentId: clientB.id,
    });
    await core.assignDocumentGroup(harbour.id, clientA.id);
    await core.assignDocumentGroup(moon.id, drafts.id);
    await core.updateLibraryGroup(clientB.id, {
      name: clientB.name,
      description: clientB.description,
      keepInside: true,
      parentId: clientA.id,
    });
    await core.setAgentsEnabled(true);

    // Paired to the outer wall: its own Documents, never the inner wall's.
    const outer = await core.connectAgent({ name: "Claude Code", folderIds: [clientA.id] });
    const agent = await connectLegacyAgent(outer.launch);
    const listed = structured<{
      folders: { id: string; name: string; documents: number; minds: unknown[] }[];
    }>(await agent.callTool({ name: "list_minds", arguments: {} }));
    // The inner wall's Moon is neither counted nor named.
    expect(listed.folders).toEqual([
      {
        id: clientA.id,
        name: "Client A",
        documents: 1,
        documentList: [{ id: harbour.id, name: harbour.name, kind: "markdown" }],
        minds: [],
      },
    ]);
    const found = structured<SearchOut>(
      await agent.callTool({ name: "search", arguments: { query: "harbour" } }),
    );
    expect([...new Set(found.passages.map((passage) => passage.documentId))]).toEqual([harbour.id]);
    const inner = await agent.callTool({
      name: "read_passages",
      arguments: { documentId: moon.id },
    });
    expect(inner.isError).toBe(true);

    // Two Folders behind one wall would read nothing together, so they are refused.
    await expect(
      core.connectAgent({ name: "Codex", folderIds: [drafts.id, clientB.id] }),
    ).rejects.toThrow(/keeps its work inside it/);
    const filed = await core.createLibraryGroup({
      name: "Filed",
      description: "",
      parentId: clientB.id,
    });
    await expect(
      core.connectAgent({ name: "Cursor", folderIds: [drafts.id, filed.id] }),
    ).rejects.toThrow(/keeps its work inside it/);
  });

  it("refuses an explicitly named Folder that a wall removed from an existing pairing", async () => {
    const { core } = await startAgentsCore(replyingModel());
    const { coast, finance } = await withLibrary(core);
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: [coast.id, finance.id],
    });
    await core.updateLibraryGroup(coast.id, {
      name: coast.name,
      description: coast.description,
      keepInside: true,
    });
    const agent = await connectLegacyAgent(launch);

    const outside = await agent.callTool({
      name: "search",
      arguments: { query: "harbour", folderIds: [coast.id] },
    });

    expect(outside.isError).toBe(true);
    expect(resultText(outside)).toMatch(/keeps its work inside it/);
  });

  it("are refused at once after unpairing, and their connection closes", async () => {
    const { core, launch, pairing } = await pairedToCoast();
    const agent = await connectLegacyAgent(launch);
    const closed = new Promise<void>((resolve) => {
      agent.onclose = () => resolve();
    });

    await core.disconnectAgent(pairing.id);
    await closed;
    expect((await core.getAgents()).pairings).toEqual([]);

    const again = await connectLegacyAgent(launch);
    const refused = await again.callTool({ name: "search", arguments: { query: "tides" } });
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toMatch(/no longer connected/);
    await expect(core.getAgentLaunch(pairing.id)).rejects.toThrow();
  });

  it("are paused in Local mode, and refused while connecting agents is off", async () => {
    const { core, launch, pairing } = await pairedToCoast();
    const agent = await connectLegacyAgent(launch);

    await core.setLocalOnly(true);
    expect((await core.getAgents()).paused).toBe("local-mode");
    // Every Tool, `ask` too: nothing is read, and no Question goes to any model.
    const calls: Record<string, Record<string, unknown>> = {
      search: { query: "tides" },
      read_passages: { documentId: "any" },
      cite: { citations: [{ passageId: "any", quote: "Spring tides" }] },
      check_citations: { text: "Spring tides [cite:abcdefgh]." },
      show_citation: { cite: "[cite:abcdefgh]" },
      list_minds: {},
      read_mind: { mindId: "any" },
      ask: { question: "When are spring tides?" },
    };
    for (const [name, args] of Object.entries(calls)) {
      const paused = await agent.callTool({ name, arguments: args });
      expect(paused.isError, name).toBe(true);
      expect(resultText(paused), name).toMatch(/Agents are paused/);
    }

    await core.setLocalOnly(false);
    const resumed = await agent.callTool({ name: "search", arguments: { query: "tides" } });
    expect(resumed.isError ?? false).toBe(false);

    const activity = await core.listAgentActivity(pairing.id);
    expect(activity.filter((each) => each.problem === "local-mode")).toHaveLength(
      Object.keys(calls).length,
    );

    // Turned off: the listener goes, and the connection with it.
    await core.setAgentsEnabled(false);
    await expect(connectLegacyAgent(launch)).rejects.toThrow(/IncarnaMind isn't open/);
  });

  it("listen once however quickly connecting agents is turned on and off", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { core, launch } = await pairedToCoast();
    await Promise.all([
      core.setAgentsEnabled(false),
      core.setAgentsEnabled(true),
      core.setAgentsEnabled(true),
    ]);
    const agent = await connectLegacyAgent(launch);
    const found = await agent.callTool({ name: "search", arguments: { query: "tides" } });
    expect(found.isError ?? false).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("holds an agent’s scoped Folder and Tag suggestions until confirmation", async () => {
    const { core, launch, tides, budget, coast, finance } = await pairedToCoast();
    const shore = await core.createLibraryGroup({
      name: "Shore",
      description: "Tides and waves",
      parentId: coast.id,
    });
    const privateTag = await core.createTag({ name: "Budget cycle" });
    await core.addDocumentTag(budget.id, privateTag.id);
    const agent = await connectLegacyAgent(launch);
    const list = async () =>
      structured<SortingBatch>(await agent.callTool({ name: "list_sorting", arguments: {} }));
    const batch = await list();
    expect(batch.folders.map((f) => f.id).sort()).toEqual([coast.id, shore.id].sort());
    expect(batch.documents.map((d) => d.id)).toEqual([tides.id]);
    expect(batch.documents[0]?.text).toContain(SPRING);
    expect(batch.tags.map((t) => t.id)).not.toContain(privateTag.id);
    const tag = batch.tags[0];
    if (!tag || !batch.documents[0]) throw new Error("Expected sorting choices");
    const proposal = {
      documentId: tides.id,
      version: batch.documents[0].version,
      folderId: shore.id,
      tagIds: [tag.id],
    };
    const submit = (proposals: (typeof proposal)[]) =>
      agent.callTool({ name: "propose_sorting", arguments: { proposals } });
    for (const change of [
      { folderId: finance.id },
      { tagIds: [privateTag.id] },
      { documentId: budget.id },
      { version: "old" },
    ]) {
      expect((await submit([{ ...proposal, ...change }])).isError).toBe(true);
    }
    expect((await submit([proposal, { ...proposal, documentId: budget.id }])).isError).toBe(true);
    expect((await core.getOrganizeReview()).items).toEqual([]);
    const before = await core.listDocuments();
    expect(structured(await submit([proposal]))).toEqual({ waiting: 1 });
    expect((await submit([proposal])).isError).toBe(true);
    expect((await list()).documents).toEqual([]);
    const { items } = await core.getOrganizeReview();
    const item = items[0];
    if (!item) throw new Error("Expected a suggestion");
    expect(items).toHaveLength(1);
    expect(item).toMatchObject({
      origin: "agent",
      agent: "Claude Code",
      documentId: tides.id,
      placement: { kind: "folder", folderId: shore.id },
      tags: [{ name: tag.name }],
    });
    expect((await core.listDocuments()).find((d) => d.id === tides.id)?.tags).toEqual(
      before.find((d) => d.id === tides.id)?.tags,
    );
    const folder = async () =>
      (await core.getLibrary()).assignments.find((a) => a.documentId === tides.id)?.groupId;
    expect(await folder()).toBe(coast.id);
    const dismissed = await core.discardOrganizeReview([item.id]);
    expect(await folder()).toBe(coast.id);
    expect((await list()).documents).toEqual([]);
    if (!dismissed) throw new Error("Expected a discarded suggestion");
    await core.restoreDiscardedOrganizeReview(dismissed);
    await core.confirmOrganizeReview([item.id]);
    expect(await folder()).toBe(shore.id);
    expect((await core.listDocuments()).find((d) => d.id === tides.id)?.tags).toHaveLength(1);
    expect((await list()).documents).toEqual([]);
  });

  it("shares custom Tag names with an earlier connection only after the User allows it", async () => {
    const { core, dataDir, pairing, launch, tides, budget } = await pairedToCoast();
    const shared = await core.createTag({ name: "Estuary fieldwork" });
    const hidden = await core.createTag({ name: "Fiscal forecast" });
    await core.addDocumentTag(tides.id, shared.id);
    await core.addDocumentTag(budget.id, hidden.id);
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE agent_pairings SET share_tag_names = 0 WHERE id = ?", [pairing.id]);
    } finally {
      db.close();
    }
    const agent = await connectLegacyAgent(launch);
    const list = async () =>
      structured<SortingBatch>(await agent.callTool({ name: "list_sorting", arguments: {} }));
    const legacy = await list();
    expect(legacy.tags.every((t) => t.id.startsWith("kind:"))).toBe(true);
    const doc = legacy.documents[0];
    if (!doc) throw new Error("Expected a waiting Document");
    const useTag = (tagId: string) =>
      agent.callTool({
        name: "propose_sorting",
        arguments: { proposals: [{ documentId: doc.id, version: doc.version, tagIds: [tagId] }] },
      });
    expect((await useTag(shared.id)).isError).toBe(true);
    expect((await core.updateAgent(pairing.id, { name: "My helper" })).tagNamesNotShared).toBe(
      true,
    );
    await core.updateAgent(pairing.id, { shareTagNames: true });
    const renewed = await list();
    expect(renewed.tags).toContainEqual({ id: shared.id, name: shared.name });
    expect(renewed.tags.map((t) => t.id)).not.toContain(hidden.id);
    expect((await useTag(hidden.id)).isError).toBe(true);
  });

  // protects=with no Folder yet and no model set up, an agent suggests a Folder and a Tag by name; nothing is made, filed or tagged before Confirm; one name given in two calls is one Folder; a Document nothing fits gets nothing; a name the Library can't take is refused in its own form's words with nothing of the call kept; Confirm makes them and files and tags the Documents (#3610); fails_when=a new name is refused, something is made or filed before Confirm, one name gives two Folders, or a bad name fails as IncarnaMind's own error
  it("suggest new Folders and Tags by name, which Confirm alone makes", async () => {
    const { core } = await startAgentsCore(replyingModel(), {}, { modelSetUp: false });
    const sources = await createSourceFolder();
    await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Quay repair.md",
        "# Quay repair\n\nThe east quay is repaired.",
      ),
      await writeSourceFile(sources, "Dredging plan.md", "# Dredging plan\n\nDredge to 6 metres."),
      await writeSourceFile(
        sources,
        "Pier survey.md",
        "# Pier survey\n\nThe pier needs new piles.",
      ),
      await writeSourceFile(sources, "Holiday list.md", "# Holiday list\n\nSun cream and books."),
    ]);
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({ name: "Claude Code", folderIds: [ALL_SHARED_ID] });
    const agent = await connectLegacyAgent(launch);
    const batch = structured<SortingBatch>(
      await agent.callTool({ name: "list_sorting", arguments: {} }),
    );
    expect(batch.folders).toEqual([]);
    expect(batch.total).toBe(4);
    const of = (name: string) => {
      const doc = batch.documents.find((each) => each.name === name);
      if (!doc) throw new Error(`${name} isn't waiting to be organized.`);
      return { documentId: doc.id, version: doc.version };
    };
    const submit = (proposals: object[]) =>
      agent.callTool({ name: "propose_sorting", arguments: { proposals } });
    const quay = { ...of("Quay repair"), newFolder: "Harbour works", newTags: ["Quays"] };

    for (const [bad, words] of [
      [{ newFolder: " " }, translate("en", "error.folder.lengths")],
      [{ newFolder: "W".repeat(101) }, translate("en", "error.folder.lengths")],
      [{ newTags: [" "] }, translate("en", "error.tag.nameEmpty")],
      [{ folderId: "any" }, translate("en", "agents.sorting.invalid")],
    ] as const) {
      const refused = await submit([quay, { ...quay, ...of("Pier survey"), ...bad }]);
      expect(refused.isError).toBe(true);
      expect(resultText(refused)).toBe(words);
    }
    expect((await core.getOrganizeReview()).items).toEqual([]);

    expect(
      structured(
        await submit([
          quay,
          { ...of("Dredging plan"), newFolder: "harbour works " },
          of("Holiday list"),
        ]),
      ),
    ).toEqual({ waiting: 2 });
    const left = structured<SortingBatch>(
      await agent.callTool({ name: "list_sorting", arguments: {} }),
    );
    expect(left.total).toBe(2);
    expect(left.documents.map((doc) => doc.name).sort()).toEqual(["Holiday list", "Pier survey"]);
    expect(
      structured(
        await submit([{ ...of("Pier survey"), newFolder: "Harbour works", newTags: ["Quays"] }]),
      ),
    ).toEqual({ waiting: 1 });

    const review = await core.getOrganizeReview();
    expect(review.folders).toMatchObject([{ name: "Harbour works", parentId: null }]);
    const proposed = { kind: "newFolder", newFolderId: review.folders[0]?.id };
    const items = new Map(review.items.map((item) => [item.documentId, item]));
    expect(items.get(of("Quay repair").documentId)).toMatchObject({
      origin: "agent",
      agent: "Claude Code",
      placement: proposed,
      tags: [{ tagId: null, name: "Quays" }],
    });
    expect(items.get(of("Dredging plan").documentId)).toMatchObject({
      placement: proposed,
      tags: [],
    });
    expect(items.get(of("Pier survey").documentId)?.placement).toEqual(proposed);
    expect(items.has(of("Holiday list").documentId)).toBe(false);
    expect((await core.getLibrary()).groups).toEqual([]);
    expect((await core.listTags()).map((tag) => tag.name)).not.toContain("Quays");
    expect((await core.getLibrary()).assignments.every((each) => each.groupId === null)).toBe(true);

    await core.confirmOrganizeReview(review.items.map((item) => item.id));
    const { groups, assignments } = await core.getLibrary();
    expect(groups).toMatchObject([{ name: "Harbour works", parentId: null }]);
    const filed = assignments.filter((each) => each.groupId === groups[0]?.id);
    expect(filed.map((each) => each.documentId).sort()).toEqual(
      [of("Quay repair"), of("Dredging plan"), of("Pier survey")]
        .map((each) => each.documentId)
        .sort(),
    );
    const tag = (await core.listTags()).find((each) => each.name === "Quays");
    const tagged = (await core.listDocuments()).filter((doc) =>
      doc.tags.some((each) => each.tagId === tag?.id),
    );
    expect(tagged.map((doc) => doc.name).sort()).toEqual(["Pier survey", "Quay repair"]);
  });

  // protects=a ten-Document Library comes whole in one list_sorting answer and one propose_sorting call takes a Suggestion for each, so no group is split across pages or calls by a count of eight and no call is refused for its size; nothing is made before Confirm (#3626); fails_when=the list pages at eight, a call for ten is refused, or a Folder is made before Confirm
  it("list a small Library in one answer, and take a Suggestion for each Document in one call", async () => {
    const { core } = await startAgentsCore(replyingModel(), {}, { modelSetUp: false });
    const sources = await createSourceFolder();
    const areas = { "Harbour works": 4, "Family health": 3, "Tax return": 3 };
    const files: string[] = [];
    for (const [area, count] of Object.entries(areas))
      for (let at = 1; at <= count; at++)
        files.push(
          await writeSourceFile(sources, `${area} ${at}.md`, `# ${area} ${at}\n\nAbout ${area}.`),
        );
    await addAndProcess(core, files);
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({ name: "Claude Code", folderIds: [ALL_SHARED_ID] });
    const agent = await connectLegacyAgent(launch);
    const batch = structured<SortingBatch>(
      await agent.callTool({ name: "list_sorting", arguments: {} }),
    );
    expect(batch.documents).toHaveLength(10);
    expect(batch).toMatchObject({ total: 10, next: null });
    const proposals = batch.documents.map((doc) => ({
      documentId: doc.id,
      version: doc.version,
      newFolder: doc.name.replace(/ \d+$/, ""),
    }));
    expect(
      structured(await agent.callTool({ name: "propose_sorting", arguments: { proposals } })),
    ).toEqual({ waiting: 10 });
    const review = await core.getOrganizeReview();
    expect(review.folders.map((folder) => folder.name).sort()).toEqual(Object.keys(areas).sort());
    expect(review.items).toHaveLength(10);
    expect((await core.getLibrary()).groups).toEqual([]);
  });

  // protects=a Library past one answer's room still pages, each answer within the size a client reads whole and saying how many wait in all, and a call past what one takes is not refused: it takes what it can and says how many to send again; nothing is made before Confirm (#3626); fails_when=an answer outgrows the bound, a page loses or repeats a Document, a large call is refused, or a Folder is made before Confirm
  it("page a large Library by size, and take what one call can of a larger one", async () => {
    const { core } = await startAgentsCore(replyingModel(), {}, { modelSetUp: false });
    const sources = await createSourceFolder();
    const long = (at: number) =>
      `# Survey ${at}\n\n${"The east quay survey records tide levels and wall cracks each week. ".repeat(40)}`;
    const files: string[] = [];
    for (let at = 1; at <= SORTING_MOST + 1; at++)
      files.push(await writeSourceFile(sources, `Survey ${at}.md`, long(at)));
    await addAndProcess(core, files, 60_000);
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({ name: "Claude Code", folderIds: [ALL_SHARED_ID] });
    const agent = await connectLegacyAgent(launch);
    const pages: SortingBatch[] = [];
    let after: string | null = "";
    while (after !== null) {
      const result = await agent.callTool({
        name: "list_sorting",
        arguments: after ? { after } : {},
      });
      expect(estimateTokens(resultText(result))).toBeLessThanOrEqual(READ_PART_TOKENS);
      const page = structured<SortingBatch>(result);
      pages.push(page);
      after = page.next;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.total === SORTING_MOST + 1)).toBe(true);
    const read = pages.flatMap((page) => page.documents);
    expect(new Set(read.map((doc) => doc.id)).size).toBe(SORTING_MOST + 1);
    const proposals = read.map((doc) => ({
      documentId: doc.id,
      version: doc.version,
      newFolder: "Quay surveys",
    }));
    const first = structured<{ waiting: number; left?: string }>(
      await agent.callTool({ name: "propose_sorting", arguments: { proposals } }),
    );
    expect(first).toEqual({
      waiting: SORTING_MOST,
      left: translate("en", "agents.sorting.left.one", { total: SORTING_MOST + 1 }),
    });
    expect(
      structured(
        await agent.callTool({
          name: "propose_sorting",
          arguments: { proposals: proposals.slice(SORTING_MOST) },
        }),
      ),
    ).toEqual({ waiting: 1 });
    expect((await core.getOrganizeReview()).items).toHaveLength(SORTING_MOST + 1);
    expect((await core.getLibrary()).groups).toEqual([]);
  }, 120_000);

  // protects=a new Folder an agent suggests for a Document in a Folder bound to a folder on disk is proposed inside that Folder, made there only at Confirm, and the Document filed in it, as the Library's own Organize of a Folder makes its subfolders (#3610); fails_when=the new Folder is proposed at the top level, which would take the Document out of its Project, or anything is made before Confirm
  it("suggest a new Folder for a Document in a Project inside the Project", async () => {
    const { core } = await startAgentsCore(replyingModel(), {}, { modelSetUp: false });
    const files = await createSourceFolder();
    await writeFile(join(files, "Quay plan.md"), "# Quay plan\n\nThe east quay holds 31 boats.\n");
    const linked = await core.addLinkedFolder(files);
    await core.reconcileDocuments();
    await waitForProcessing(
      core,
      (await core.listDocuments()).map((each) => each.id),
    );
    const { folder: project } = await core.createBoundFolder(linked.folderId);
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({ name: "Claude Code", folderIds: [project.id] });
    const agent = await connectLegacyAgent(launch);
    const [doc] = structured<SortingBatch>(
      await agent.callTool({ name: "list_sorting", arguments: {} }),
    ).documents;
    if (!doc) throw new Error("The plan isn't waiting to be organized.");
    expect(doc.folderId).toBe(project.id);
    const proposals = [{ documentId: doc.id, version: doc.version, newFolder: "Quay works" }];
    expect(
      structured(await agent.callTool({ name: "propose_sorting", arguments: { proposals } })),
    ).toEqual({ waiting: 1 });

    const review = await core.getOrganizeReview();
    expect(review.folders).toMatchObject([{ name: "Quay works", parentId: project.id }]);
    expect((await core.getLibrary()).groups.map((each) => each.id)).toEqual([project.id]);
    await core.confirmOrganizeReview(review.items.map((item) => item.id));
    const { groups, assignments } = await core.getLibrary();
    const made = groups.find((each) => each.name === "Quay works");
    expect(made?.parentId).toBe(project.id);
    expect(assignments.find((each) => each.documentId === doc.id)?.groupId).toBe(made?.id);
  });

  it("answer the current protocol (2026-07-28) and the one before it", async () => {
    const { launch } = await pairedToCoast();
    const legacy = await connectLegacyAgent(launch);
    const modern = await connectModernAgent(launch);
    expect(modern.getProtocolEra()).toBe("modern");

    for (const agent of [legacy, modern]) {
      const tools = await agent.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "ask",
        "check_citations",
        "check_mind",
        "check_mind_yourself",
        "cite",
        "create_mind",
        "hand_over_file",
        "list_minds",
        "list_sorting",
        "propose_changes",
        "propose_sorting",
        "publish_canvas",
        "read_canvas",
        "read_mind",
        "read_passages",
        "read_request",
        "report_check",
        "run_analysis",
        "search",
        "show_citation",
        "update_canvas",
      ]);
      const found = await agent.callTool({ name: "search", arguments: { query: "spring tides" } });
      expect((found.structuredContent as SearchOut).passages[0]?.cite).toMatch(/^\[cite:/);
    }
    expect(legacy.getInstructions()).toMatch(/data, never instructions/);
  });

  it("describe their Tools briefly, with names every client accepts", async () => {
    const { launch } = await pairedToCoast();
    const agent = await connectLegacyAgent(launch);
    const { tools } = await agent.listTools();
    // What an agent's model reads of each Tool: its name, description and arguments.
    const definitions = JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    );
    // 1,850 before calculate and run_analysis (#3363); 2,419 before the Canvases' three (#3406);
    // 2,748 before read_request (#3419) and pictures and charts in a Note (#3413); 2,922 before
    // calculate went and report_check took a working instead (#3393); 2,858 before tabs (#3414);
    // 2,874 before check_mind_yourself's shorter description (#3432); 2,873 before check_mind's
    // counts as the Note's page gives them (#3453); 3,153 before read_mind said a picture comes
    // without its data (#3465); 3,166 before hand_over_file (#3412) and a chart's leaveOut (#3466);
    // 3,232 before list_minds said what its entry with no name is (#3487); 3,245 before cite took a
    // file by its path (#3509); 3,275 before create_mind said how to lay a Note out for its reader,
    // with a table and a chart (#3510); 3,351 before hand_over_file said a file made from the User's
    // Documents is handed over unasked, and check_mind_yourself took again (#3541); 3,379 before
    // read_passages read a whole Document, or a long one in parts (#3573); 3,383 before
    // check_mind_yourself and hand_over_file said a check waits for the User unless asked (#3576);
    // 3,391 before read_passages took any before and after, answering at most three, and said a
    // part is sized to be read in full (#3586); 3,421 before cite took a list of any length (#3585);
    // 3,417 before propose_sorting took new Folders and Tags by name, and list_sorting asked for
    // every page before a suggestion (#3610); 3,459 before propose_sorting took a Suggestion for
    // every Document one list answer holds (#3626); 3,455 before show_citation showed a Note, file or
    // Canvas again by its id (#3534).
    expect(estimateTokens(definitions)).toBeLessThanOrEqual(3_477);
    for (const tool of tools) {
      // Kiro's rule, the strictest: letters, digits and underscores, 64 characters with the prefix.
      expect(`mcp__incarnamind__${tool.name}`).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
      // Seven write: Proposals the User decides on, a new Note that changes none there is, the marks
      // of a check on a Note the agent wrote, IncarnaMind's or the agent's own, a Canvas or a
      // version of one (#3406), and a file the agent hands over, or a version of it (#3412).
      expect(tool.annotations?.readOnlyHint).toBe(
        ![
          "propose_changes",
          "propose_sorting",
          "create_mind",
          "check_mind",
          "report_check",
          "publish_canvas",
          "update_canvas",
          "hand_over_file",
        ].includes(tool.name),
      );
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.outputSchema).toBeDefined();
    }
    // read_request too: the User's one-line request names nothing a search for Tools would find (#3419).
    const alwaysLoaded = tools.filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true);
    expect(alwaysLoaded.map((tool) => tool.name).sort()).toEqual(["ask", "read_request", "search"]);
  });

  it("ask: IncarnaMind's own Answer, its Citations checked and given as tokens", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [{ marker: 1, passage: passages[0]?.id, quote: SPRING }],
      answer: "Spring tides come twice a month, at new and full moon [^1].",
    });
    const { core, launch, pairing } = await pairedToCoast(model);
    const agent = await connectLegacyAgent(launch);

    const answered = structured<{
      status: string;
      answer: string;
      citations: { cite: string; document: string; quote: string }[];
      unchecked: number;
    }>(await agent.callTool({ name: "ask", arguments: { question: "When are spring tides?" } }));
    expect(answered.status).toBe("done");
    expect(answered.unchecked).toBe(0);
    expect(answered.citations).toEqual([
      expect.objectContaining({
        document: "Tides",
        quote: `${SPRING}, when the sun and the moon pull in line.`,
      }),
    ]);
    const token = answered.citations[0]?.cite ?? "";
    expect(answered.answer).toBe(`Spring tides come twice a month, at new and full moon ${token}.`);

    const checked = structured<{ citations: { check: string }[] }>(
      await agent.callTool({ name: "check_citations", arguments: { text: answered.answer } }),
    );
    expect(checked.citations).toEqual([expect.objectContaining({ check: "found" })]);
    // Nothing of it reached a window: it is in no Mind and no conversation.
    expect(await core.listConversations()).toEqual([]);
    expect((await core.listAgentActivity(pairing.id))[1]).toMatchObject({
      tool: "ask",
      outcome: "done",
      count: 1,
    });
  });

  it("read the Minds of their Folders, with Citations as tokens, and no other Mind", async () => {
    const { core, launch, coast, finance } = await pairedToCoast();
    const inCoast = await core.createMind({ title: "Field notes", folderId: coast.id });
    const inFinance = await core.createMind({ title: "Costs", folderId: finance.id });
    const agent = await connectLegacyAgent(launch);

    const listed = structured<{ folders: { minds: { id: string; title: string }[] }[] }>(
      await agent.callTool({ name: "list_minds", arguments: {} }),
    );
    expect(listed.folders[0]?.minds).toEqual([
      expect.objectContaining({ id: inCoast.id, title: "Field notes" }),
    ]);
    const read = structured<{ title: string; markdown: string; nextOffset: number | null }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: inCoast.id } }),
    );
    expect(read).toMatchObject({ title: "Field notes", nextOffset: null });
    expect(read.markdown).toContain("# Field notes");
    const refused = await agent.callTool({
      name: "read_mind",
      arguments: { mindId: inFinance.id },
    });
    expect(refused.isError).toBe(true);
  });

  it("read someone's changes in a Mind imported from Word as changes, with who made each (#734)", async () => {
    const { core, dataDir, launch, coast } = await pairedToCoast();
    const priya = 'w:author="Priya Nair" w:date="2026-10-02T09:00:00Z"';
    const { mindId } = await importWordBytes(
      core,
      dataDir,
      wordFile({
        body: paragraph(
          `${run("Notice is ")}<w:del w:id="1" ${priya}><w:r><w:delText xml:space="preserve">one month</w:delText></w:r></w:del><w:ins w:id="2" ${priya}>${run("three months")}</w:ins>${run(".")}`,
        ),
      }),
      { origin: "someone-else", folderId: coast.id },
    );
    const agent = await connectLegacyAgent(launch);

    const read = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId } }),
    );
    expect(read.markdown).toContain(
      "Notice is {--one month--}{++three months++}{>>Replaced by Priya Nair, 2 Oct 2026<<}.",
    );
  });

  it("name a renamed Document as it is now, in a Mind they read and in the Citations they check or show", async () => {
    const { core, launch, tides, coast } = await pairedToCoast();
    const agent = await connectLegacyAgent(launch);
    const [found] = structured<SearchOut>(
      await agent.callTool({ name: "search", arguments: { query: "spring tides new moon" } }),
    ).passages;
    if (!found?.cite) throw new Error("Nothing was found to cite.");
    const mind = await core.createMind({ title: "Field notes", folderId: coast.id });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "They come at new moon " },
          {
            type: "citation",
            attrs: {
              passageId: found.passageId,
              documentId: tides.id,
              documentName: "Tides",
              contentHash: tides.contentHash,
              quote: SPRING,
              check: "found",
            },
          },
        ],
      },
    ]);
    await client.settled();
    const checkedFrom = async () =>
      structured<{ citations: { document: string | null }[] }>(
        await agent.callTool({ name: "check_citations", arguments: { text: found.cite } }),
      ).citations[0]?.document;
    const markdown = async () =>
      structured<{ markdown: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id } }),
      ).markdown;
    expect(await markdown()).toContain("Tides");
    expect(await checkedFrom()).toBe("Tides");

    await core.renameDocument(tides.id, "Harbour tide tables");

    expect(await markdown()).toContain("Harbour tide tables");
    expect(await markdown()).not.toContain("Tides");
    expect(await checkedFrom()).toBe("Harbour tide tables");
    expect(
      structured<{ document: string }>(
        await agent.callTool({ name: "show_citation", arguments: { cite: found.cite } }),
      ).document,
    ).toBe("Harbour tide tables");

    // Once the Document is gone the agent is told of neither name: it is outside what it may read.
    await core.deleteDocument(tides.id);
    expect(await checkedFrom()).toBeNull();
    expect(await markdown()).not.toMatch(/Tides|Harbour tide tables/);
  });

  it("never write the token to the log, the database or any file in the data folder", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { core, dataDir, log, launch } = await pairedToCoast();
    const token = launch.env.INCARNAMIND_AGENT_TOKEN ?? "";
    expect(token).toMatch(/^im_/);
    const agent = await connectLegacyAgent(launch);
    await agent.callTool({ name: "search", arguments: { query: "tides" } });
    await agent.callTool({ name: "search", arguments: { query: "" } });
    await core.setLocalOnly(true);
    await agent.callTool({ name: "search", arguments: { query: "tides" } });

    expect(log.lines.join("\n")).not.toContain(token);
    expect(errors.mock.calls.flat().map(String).join("\n")).not.toContain(token);
    const files = await readdir(dataDir, { recursive: true, withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      const bytes = await readFile(join(file.parentPath, file.name));
      expect(bytes.includes(token), file.name).toBe(false);
    }
    errors.mockRestore();
  });
});

describe("the agents' socket", () => {
  it("is in the data folder, or in the temporary folder when that path is too long for a socket", () => {
    expect(agentSocketPath("/Users/ada/Library/Application Support/IncarnaMind", "darwin")).toBe(
      "/Users/ada/Library/Application Support/IncarnaMind/agents.sock",
    );
    const deep = `/Users/ada/${"Very long folder name/".repeat(5)}IncarnaMind`;
    const fallback = agentSocketPath(deep, "darwin");
    expect(fallback).toMatch(/incarnamind-[0-9a-f]{16}\.sock$/);
    expect(agentSocketPath(deep, "darwin")).toBe(fallback);
    expect(agentSocketPath("C:\\Users\\ada\\AppData\\Roaming\\IncarnaMind", "win32")).toMatch(
      /^\\\\\.\\pipe\\incarnamind-agents-[0-9a-f]{16}$/,
    );
  });

  // protects=when both the data folder and the temporary folder exceed the Unix socket path limit, agentSocketPath falls back to a short writable folder so agents still connect; and when no usable socket can open, setup and enable refuse in plain words without writing an unreachable address or reporting connected (#3598); fails_when=a 100+ byte socket path is written to agent settings or reported as connected
  it("falls back to a short folder when both data and temp paths exceed the limit, and refuses to connect when no socket can open (#3598)", async () => {
    const deepData = `/Users/ada/${"Very long data folder/".repeat(5)}IncarnaMind`;
    const deepTemp = `/Users/ada/${"Very long temp folder/".repeat(6)}tmp`;
    const shortFallback = agentSocketPath(deepData, "darwin", {
      tempDir: deepTemp,
      shortDir: "/tmp",
      canUseDir: () => true,
    });
    expect(shortFallback).toMatch(/^\/tmp\/incarnamind-[0-9a-f]{16}\.sock$/);
    expect(Buffer.byteLength(shortFallback)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    expect(isSocketPathUsable(shortFallback)).toBe(true);

    const unusable = agentSocketPath(deepData, "darwin", {
      tempDir: deepTemp,
      shortDir: "/tmp",
      canUseDir: () => false,
    });
    expect(Buffer.byteLength(unusable)).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
    expect(isSocketPathUsable(unusable)).toBe(false);

    // When the socket path is too long to open, enabling or setting up refuses in plain words,
    // writes no settings file, and leaves no agent connected.
    const dataDir = await createTempDataFolder();
    const fakeHome = await createTempDataFolder();
    const base = await agentsAdapter(dataDir);
    if (!base) throw new Error("No agent adapter.");
    const core = startCore(dataDir, {
      paths: { home: fakeHome },
      agents: { ...base, socketPath: unusable },
    });
    const folder = await core.createLibraryGroup({ name: "Coast", description: "Tides" });
    await expect(core.setAgentsEnabled(true)).rejects.toThrow(/path is too long/i);
    expect((await core.getAgents()).enabled).toBe(false);
    await expect(
      core.setUpAgent({ client: "claude-code", folderIds: [folder.id] }),
    ).rejects.toThrow(/path is too long/i);
    await expect(
      core.connectAgent({ name: "Claude Code", folderIds: [folder.id] }),
    ).rejects.toThrow(/path is too long/i);
    expect((await core.getAgents()).pairings).toEqual([]);
    expect(await readdir(fakeHome)).toEqual([]);
    core.close();

    // When the socket path fits in length but its parent folder can't be opened, enabling and connecting refuse cleanly.
    const missingSocket = join(dataDir, "no-such-folder", "a.sock");
    const core2 = startCore(dataDir, {
      agents: { ...base, socketPath: missingSocket },
    });
    const folder2 = await core2.createLibraryGroup({ name: "Harbour", description: "Tides" });
    await expect(core2.setAgentsEnabled(true)).rejects.toThrow(
      /couldn’t open its local connection/i,
    );
    expect((await core2.getAgents()).enabled).toBe(false);
    await expect(
      core2.connectAgent({ name: "Claude Code", folderIds: [folder2.id] }),
    ).rejects.toThrow(/couldn’t open its local connection/i);
    expect((await core2.getAgents()).pairings).toEqual([]);
    core2.close();

    // End-to-end with both a long data folder and a long redirected temp folder:
    // the fallback socket in /tmp opens and accepts a real agent handshake.
    const longRoot = await createTempDataFolder();
    const longData = join(longRoot, "a".repeat(45), "b".repeat(45), "data");
    const longTemp = join(longRoot, "t".repeat(45), "u".repeat(45), "tmp");
    const fallbackPath = agentSocketPath(longData, process.platform, { tempDir: longTemp });
    expect(isSocketPathUsable(fallbackPath)).toBe(true);
    const liveCore = startCore(longData, {
      agents: { ...base, socketPath: fallbackPath },
    });
    const liveFolder = await liveCore.createLibraryGroup({ name: "Coast", description: "Tides" });
    await liveCore.setAgentsEnabled(true);
    const liveConnected = await liveCore.connectAgent({
      name: "Claude Code",
      folderIds: [liveFolder.id],
    });
    const liveAgent = await connectLegacyAgent(liveConnected.launch);
    expect((await liveAgent.listTools()).tools.length).toBeGreaterThan(0);
    await liveAgent.close();
    liveCore.close();
  });
});
