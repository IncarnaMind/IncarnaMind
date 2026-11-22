/**
 * An agent given all of the User's Documents and Notes, those added later too (#3544): what the
 * consent connects a new agent with. It reaches every Folder outside a wall at the time of each
 * call and what is in no Folder, the User's Notes there included, never the examples; a walled
 * Folder, a Project among them, is shared only on its own. A pairing made before keeps exactly its
 * Folders. Where a result can read as "nothing is there", one line says when the User has more
 * than the agent reaches, naming nothing. Through the shim the app ships, as Claude Code calls it.
 */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Core } from "../../src/core";
import { ALL_SHARED_ID, NOT_IN_A_FOLDER_ID } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";
import {
  agentsAdapter,
  buildAgentShim,
  connectLegacyAgent,
  resultText,
  startAgentsCore,
} from "../helpers/agents";
import { createMemoryKeychain, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { DECK, started as handing, handOver } from "../helpers/handedFiles";
import { replyingModel } from "../helpers/models";

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

const EXAMPLES = resolve(__dirname, "../../resources/examples");
const NOT_SHARED = translate("en", "agents.notShared");

interface Searched {
  passages: { documentId: string; document: string }[];
  notShared?: string;
}

interface Listed {
  folders: { id: string; name: string; minds: { id: string; title: string; yours?: true }[] }[];
  notShared?: string;
}

function structured<T>(result: unknown): T {
  const { isError, structuredContent } = result as {
    isError?: boolean;
    structuredContent?: unknown;
  };
  expect(isError ?? false, resultText(result)).toBe(false);
  return structuredContent as T;
}

function refused(result: unknown): string {
  expect((result as { isError?: boolean }).isError).toBe(true);
  return resultText(result);
}

const search = async (agent: Agent, query = "harbour") =>
  structured<Searched>(await agent.callTool({ name: "search", arguments: { query } }));

const found = async (agent: Agent, query = "harbour") =>
  [...new Set((await search(agent, query)).passages.map((each) => each.documentId))].sort();

const list = async (agent: Agent) =>
  structured<Listed>(await agent.callTool({ name: "list_minds", arguments: {} }));

const readDocument = (agent: Agent, documentId: string) =>
  agent.callTool({ name: "read_passages", arguments: { documentId } });

/** A core with connecting agents on and nothing in it yet, unless the examples are asked for. */
async function fresh({ examples = false, keychain = createMemoryKeychain() } = {}) {
  const started = await startAgentsCore(replyingModel(), {
    keychain,
    ...(examples && { paths: { examples: EXAMPLES } }),
  });
  const { core } = started;
  await core.setAgentsEnabled(true);
  const sources = await createSourceFolder();
  /** A Document that says "harbour", in this Folder or in none. */
  const add = async (name: string, folderId: string | null = null) => {
    const path = await writeSourceFile(
      sources,
      `${name}.md`,
      `# ${name}\n\nThe harbour ${name.toLowerCase()} is on the north quay.\n`,
    );
    const [added] = await addAndProcess(core, [path]);
    if (!added) throw new Error(`${name} wasn't added.`);
    if (folderId !== null) await core.assignDocumentGroup(added.id, folderId);
    return added;
  };
  const folder = (name: string, options: { parentId?: string; keepInside?: boolean } = {}) =>
    core.createLibraryGroup({ name, description: "", ...options });
  const note = (title: string, folderId: string | null = null) =>
    core.createMind({ title, folderId });
  const connect = async (name: string, folderIds: string[], propose = false) => {
    const { launch, pairing } = await core.connectAgent({ name, folderIds, propose });
    return { agent: await connectLegacyAgent(launch), pairing };
  };
  return { ...started, core, keychain, sources, add, folder, note, connect };
}

/** The User's Project: a Linked folder holding the quay plan, made a Project (ADR-0030). */
async function project(core: Core) {
  const files = await createSourceFolder();
  await writeFile(
    join(files, "Quay plan.md"),
    "# Quay plan\n\nThe harbour quay plan adds 31 moorings.\n",
  );
  const linked = await core.addLinkedFolder(files);
  await core.reconcileDocuments();
  await waitForProcessing(
    core,
    (await core.listDocuments()).map((each) => each.id),
  );
  const { folder: bound } = await core.createBoundFolder(linked.folderId);
  const plan = (await core.listDocuments()).find((each) => each.name === "Quay plan");
  if (!plan) throw new Error("The quay plan wasn't read.");
  return { project: bound, plan };
}

describe("an agent given all of the User's Documents and Notes", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a new connection's share is all, and it reaches what the User adds after it: a Folder made later, a Folder inside it, a Linked folder's files and the User's own Notes in no Folder (#3544); fails_when=the share is a list of the Folders there were at the time, or Not in a Folder alone, so what is added later isn't found
  it("reaches the Documents, Folders and Notes added after it was connected", async () => {
    const { core, add, folder, note, connect } = await fresh();
    const { agent, pairing } = await connect("Claude Code", [ALL_SHARED_ID], true);
    expect(pairing.folderIds).toEqual([ALL_SHARED_ID]);
    expect(await search(agent)).toEqual({ passages: [], page: 1, more: false });

    const tides = await add("Tides");
    const coast = await folder("Coast");
    const reef = await add("Reef", coast.id);
    const bays = await folder("Bays", { parentId: coast.id });
    const cove = await add("Cove", bays.id);
    const linked = await createSourceFolder();
    await writeSourceFile(linked, "Ferry.md", "# Ferry\n\nThe harbour ferry leaves at noon.\n");
    await core.addLinkedFolder(linked);
    await core.reconcileDocuments();
    const ferry = await vi.waitFor(
      async () => {
        const read = (await core.listDocuments()).find((each) => each.name === "Ferry");
        expect(read?.status).toBe("ready");
        return read;
      },
      { timeout: 30_000 },
    );
    const plan = await note("Harbour plan");
    const diary = await note("Coast diary", coast.id);

    expect(await found(agent)).toEqual([tides.id, reef.id, cove.id, ferry?.id].sort());
    const listed = await list(agent);
    expect(listed.notShared).toBeUndefined();
    expect(listed.folders.map((each) => each.id)).toEqual([coast.id, bays.id, NOT_IN_A_FOLDER_ID]);
    expect(listed.folders[0]?.minds.map((each) => each.id)).toEqual([diary.id]);
    expect(listed.folders[2]?.minds).toEqual([expect.not.objectContaining({ yours: true })]);
    expect(listed.folders[2]?.minds[0]?.id).toBe(plan.id);
    const read = structured<{ mindId: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: plan.id } }),
    );
    expect(read.mindId).toBe(plan.id);
    // Its own Note goes where a Note the User makes goes, unless it names a Folder.
    const written = structured<{ mindId: string; folder: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Harbour summary", markdown: "The ferry leaves at noon." },
      }),
    );
    expect((await core.listMinds()).find((each) => each.id === written.mindId)?.folderId).toBe(
      null,
    );
  });

  // protects=a Folder that keeps its work inside it, a Project among them, is never part of all: nothing in it is searched, read or listed, it is shared only when ticked on its own, and all with a Project is refused rather than widened (#3544, #3511); fails_when=all reaches a walled Folder, or a Project ticked beside all mixes its work with the rest
  it("leaves a walled Folder, a Project among them, out until it is shared on its own", async () => {
    const { core, add, folder, connect } = await fresh();
    const coast = await folder("Coast");
    const reef = await add("Reef", coast.id);
    const legal = await folder("Legal", { keepInside: true });
    const brief = await add("Brief", legal.id);
    const { project: quay, plan } = await project(core);
    expect(quay.keepInside).toBe(true);
    const { agent, pairing } = await connect("Claude Code", [ALL_SHARED_ID]);

    const all = await search(agent);
    expect([...new Set(all.passages.map((each) => each.documentId))]).toEqual([reef.id]);
    expect(all.notShared).toBe(NOT_SHARED);
    for (const documentId of [brief.id, plan.id]) {
      const said = refused(await readDocument(agent, documentId));
      expect(said).toBe(`${translate("en", "agents.problem.not-found")} ${NOT_SHARED}`);
    }
    expect((await list(agent)).folders.map((each) => each.id)).toEqual([
      coast.id,
      NOT_IN_A_FOLDER_ID,
    ]);

    // All and a Project: refused, and the share stays as it was.
    await expect(
      core.updateAgent(pairing.id, { folderIds: [ALL_SHARED_ID, quay.id] }),
    ).rejects.toThrow(translate("en", "agents.problem.wallShared", { folder: quay.name }));
    await expect(
      core.connectAgent({ name: "Cursor", folderIds: [ALL_SHARED_ID, legal.id] }),
    ).rejects.toThrow(translate("en", "agents.problem.wallShared", { folder: "Legal" }));
    expect((await core.getAgents()).pairings.map((each) => each.folderIds)).toEqual([
      [ALL_SHARED_ID],
    ]);
    expect(await found(agent)).toEqual([reef.id]);

    // Ticked on its own: the Project alone.
    await core.updateAgent(pairing.id, { folderIds: [quay.id] });
    expect(await found(agent)).toEqual([plan.id]);
  });

  // protects=no upgrade widens a share: a pairing made before keeps exactly its Folders, Not in a Folder alone (what first run left) included, as Folders, Documents and Notes are added after (#3544); fails_when=an old pairing is read as all, or as more than its Folders, once this version opens the data folder
  it("leaves an existing connection's share as it was, across a restart of this version", async () => {
    const keychain = createMemoryKeychain();
    const set = await fresh({ keychain });
    const coast = await set.folder("Coast");
    const reef = await set.add("Reef", coast.id);
    const tides = await set.add("Tides");
    const unfiled = await set.core.connectAgent({ name: "Codex", folderIds: [NOT_IN_A_FOLDER_ID] });
    const coastal = await set.core.connectAgent({ name: "Cursor", folderIds: [coast.id] });
    const before = (await set.core.getAgents()).pairings;
    await set.core.close();

    const core = startCore(set.dataDir, {
      createChatModel: set.models.createChatModel,
      agents: await agentsAdapter(set.dataDir),
      keychain,
    });
    expect((await core.getAgents()).pairings).toEqual(before);
    const finance = await core.createLibraryGroup({ name: "Finance", description: "" });
    const sources = await createSourceFolder();
    const [budget] = await addAndProcess(core, [
      await writeSourceFile(sources, "Budget.md", "# Budget\n\nThe harbour budget is set.\n"),
    ]);
    if (!budget) throw new Error("The budget wasn't added.");
    await core.assignDocumentGroup(budget.id, finance.id);
    const plan = await core.createMind({ title: "Harbour plan", folderId: null });

    const codex = await connectLegacyAgent(await core.getAgentLaunch(unfiled.pairing.id));
    expect(await found(codex)).toEqual([tides.id]);
    const listed = await list(codex);
    expect(listed.folders.map((each) => each.id)).toEqual([NOT_IN_A_FOLDER_ID]);
    expect(listed.folders[0]?.minds.map((each) => each.id)).not.toContain(plan.id);
    expect(
      refused(await codex.callTool({ name: "read_mind", arguments: { mindId: plan.id } })),
    ).toContain(NOT_SHARED);
    expect(listed.notShared).toBe(NOT_SHARED);

    const cursor = await connectLegacyAgent(await core.getAgentLaunch(coastal.pairing.id));
    expect(await found(cursor)).toEqual([reef.id]);
    expect((await search(cursor)).notShared).toBe(NOT_SHARED);
    expect((await core.getAgents()).pairings.map((each) => each.folderIds)).toEqual([
      [NOT_IN_A_FOLDER_ID],
      [coast.id],
    ]);
  });

  // protects=the User narrows all to Folders and widens it back in Settings › Agents, and the agent reaches exactly that at its next call (#3544); fails_when=the narrowed agent still finds what it was given before, or widening back doesn't reach what was added meanwhile
  it("narrows to Folders and widens back to all", async () => {
    const { core, add, folder, connect } = await fresh();
    const coast = await folder("Coast");
    const reef = await add("Reef", coast.id);
    const finance = await folder("Finance");
    const budget = await add("Budget", finance.id);
    const tides = await add("Tides");
    const { agent, pairing } = await connect("Claude Code", [ALL_SHARED_ID]);
    expect(await found(agent)).toEqual([reef.id, budget.id, tides.id].sort());

    await core.updateAgent(pairing.id, { folderIds: [coast.id] });
    const narrowed = await search(agent);
    expect(narrowed.passages.map((each) => each.documentId)).toEqual([reef.id]);
    expect(narrowed.notShared).toBe(NOT_SHARED);
    expect(refused(await readDocument(agent, budget.id))).toContain(NOT_SHARED);

    const later = await add("Pilot", finance.id);
    await core.updateAgent(pairing.id, { folderIds: [ALL_SHARED_ID] });
    const widened = await search(agent);
    expect([...new Set(widened.passages.map((each) => each.documentId))].sort()).toEqual(
      [reef.id, budget.id, tides.id, later.id].sort(),
    );
    expect(widened.notShared).toBeUndefined();
  });
});

describe("the line that says the User has more than the agent was given (#3544)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=the line tells only that something exists outside the share: no name, count or kind, the same words for one thing as for many, on search (empty or not), list_minds and a refusal of what isn't reached; fails_when=it names a Folder, Note or Document the agent wasn't given, counts them, or changes with what is outside
  it("names nothing outside the share and is the same for one thing as for many", async () => {
    const { core, add, folder, note, connect } = await fresh();
    const coast = await folder("Coast");
    const reef = await add("Reef", coast.id);
    const kestrel = await folder("Kestrel accounts");
    const osprey = await add("Osprey ledger", kestrel.id);
    const heron = await note("Heron minutes");
    const egret = await note("Egret memo", kestrel.id);
    const plover = await add("Plover tides");
    const outside = ["Kestrel", "Osprey", "Heron", "Egret", "Plover"];
    const { agent } = await connect("Claude Code", [coast.id]);

    const results = [
      await agent.callTool({ name: "search", arguments: { query: "harbour" } }),
      await agent.callTool({ name: "search", arguments: { query: "zebra crossing" } }),
      await agent.callTool({ name: "list_minds", arguments: {} }),
      await readDocument(agent, osprey.id),
      await agent.callTool({ name: "read_mind", arguments: { mindId: heron.id } }),
    ];
    expect(structured<Searched>(results[0]).passages.map((each) => each.documentId)).toEqual([
      reef.id,
    ]);
    expect(structured<Searched>(results[1])).toEqual({
      passages: [],
      page: 1,
      more: false,
      notShared: NOT_SHARED,
    });
    expect(structured<Listed>(results[2]).notShared).toBe(NOT_SHARED);
    for (const result of results) {
      const text = resultText(result);
      expect(text).toContain(NOT_SHARED);
      for (const name of outside) expect(text).not.toContain(name);
      expect(text).not.toMatch(/\d+ (Folder|note|Document)/i);
    }

    // One thing outside: the same words.
    await core.deleteDocuments([osprey.id, plover.id]);
    await core.deleteMind(heron.id);
    await core.deleteMind(egret.id);
    expect((await search(agent)).notShared).toBe(NOT_SHARED);
    await core.deleteLibraryGroup(kestrel.id);
    // Recently deleted counts for nothing.
    const none = await search(agent, "zebra crossing");
    expect(none.notShared).toBeUndefined();
    expect((await list(agent)).notShared).toBeUndefined();
    expect(refused(await readDocument(agent, osprey.id))).toBe(
      translate("en", "agents.problem.not-found"),
    );
  });

  // protects=what counts as outside the share: a walled Folder not given does, even an empty one, and so does a Note of the User's in no Folder for a pairing given Not in a Folder; the examples and Recently deleted don't (#3544); fails_when=the line is missing while a Project is kept from the agent, or shows for the app's own examples, sending the User to Settings for nothing
  it("counts a walled Folder not given and the User's Notes, never the examples", async () => {
    const { core, add, folder, note, connect } = await fresh({ examples: true });
    const made = await core.createExamples();
    await vi.waitFor(
      async () => {
        const read = await core.listDocuments({ linkedFolderId: made.linkedFolderId ?? "" });
        expect(read.length).toBeGreaterThan(0);
        expect(read.every((each) => each.status === "ready")).toBe(true);
      },
      { timeout: 30_000 },
    );
    expect(made.mindId).toBeTruthy();
    const coast = await folder("Coast");
    await add("Reef", coast.id);
    const all = (await connect("Claude Code", [ALL_SHARED_ID])).agent;
    const coastal = (await connect("Cursor", [coast.id])).agent;
    const unfiled = (await connect("Codex", [NOT_IN_A_FOLDER_ID])).agent;
    for (const agent of [all, coastal]) expect((await search(agent)).notShared).toBeUndefined();
    const listed = await list(all);
    expect(listed.folders.find((each) => each.id === NOT_IN_A_FOLDER_ID)?.minds).toEqual([]);
    expect((await search(unfiled, "zebra crossing")).notShared).toBe(NOT_SHARED);

    await core.deleteLibraryGroup(coast.id);
    expect((await search(unfiled)).notShared).toBeUndefined();
    const mine = await note("Harbour plan");
    expect((await search(unfiled)).notShared).toBe(NOT_SHARED);
    expect((await search(all)).notShared).toBeUndefined();
    await core.deleteMind(mine.id);
    expect((await search(unfiled)).notShared).toBeUndefined();

    await folder("Matter", { keepInside: true });
    expect((await search(all)).notShared).toBe(NOT_SHARED);
  });

  // protects=a file an agent handed over is no source for another agent, and counts for nothing outside its share: an agent given all isn't told there is more because of it (#3492, #3544); fails_when=the handed-over file, held back from every other agent, makes them send the User to Settings
  it("leaves a file an agent handed over out of what is outside", async () => {
    const set = await handing();
    await set.core.updateAgent(set.writer.pairing.id, { folderIds: [ALL_SHARED_ID] });
    await set.core.updateAgent(set.reader.pairing.id, { folderIds: [ALL_SHARED_ID] });
    const writer = await connectLegacyAgent(set.writer.launch);
    const reader = await connectLegacyAgent(set.reader.launch);
    expect((await search(reader)).notShared).toBeUndefined();
    const path = join(set.files, "Harbour review.pptx");
    await writeFile(path, DECK);
    const before = (await set.core.listDocuments()).length;
    structured(await handOver(writer, { path }));
    expect((await set.core.listDocuments()).length).toBe(before + 1);
    expect((await search(reader, "quay")).notShared).toBeUndefined();
    expect((await list(reader)).notShared).toBeUndefined();
  });
});
