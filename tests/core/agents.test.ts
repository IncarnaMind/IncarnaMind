/**
 * Outside agents (#351): an agent connects through the shim the app ships,
 * as Claude Code or Codex would, with the MCP SDK's own client, and searches,
 * reads and cites only the Folders its pairing may read.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Core } from "../../src/core";
import { agentSocketPath } from "../../src/core/agents";
import { estimateTokens } from "../../src/core/answers/context";
import {
  buildAgentShim,
  connectLegacyAgent,
  connectModernAgent,
  resultText,
  startAgentsCore,
} from "../helpers/agents";
import { citingModel } from "../helpers/citations";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
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

  it("keeps a walled Folder's Documents and Notes inside a wider pairing", async () => {
    const { core, launch, coast, finance, budget, pairing } = await pairedToCoast();
    await core.updateLibraryGroup(coast.id, {
      name: coast.name,
      description: coast.description,
      keepInside: true,
    });
    await core.updateAgent(pairing.id, { folderIds: [coast.id, finance.id] });
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
        "cite",
        "list_minds",
        "read_mind",
        "read_passages",
        "search",
        "show_citation",
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
    expect(estimateTokens(definitions)).toBeLessThan(1_500);
    for (const tool of tools) {
      // Kiro's rule, the strictest: letters, digits and underscores, 64 characters with the prefix.
      expect(`mcp__incarnamind__${tool.name}`).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.outputSchema).toBeDefined();
    }
    const alwaysLoaded = tools.filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true);
    expect(alwaysLoaded.map((tool) => tool.name).sort()).toEqual(["ask", "search"]);
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
      expect.objectContaining({ document: "Tides", quote: SPRING }),
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
});
