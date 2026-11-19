/**
 * An agent given Not in a Folder writes and checks its own Note there (#3364): a new User has
 * no Folder, so their AI starts from the Documents in none. Through the shim the app ships, with
 * the MCP SDK's own client, as Claude Code or Codex call it. The agent reaches the Notes in no
 * Folder that it wrote itself and no other, and nothing of a Document outside what it was given.
 */
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Core } from "../../src/core";
import { NOT_IN_A_FOLDER_ID } from "../../src/core/api";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkedWith, claimCheckShown } from "../../src/shared/claimChecks";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { checkingModel, type Plan } from "../helpers/checks";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";

const TIDES = [
  "# Tides",
  "",
  "Spring tides happen twice a month, at new moon and full moon.",
  "",
  "The range of a spring tide is the largest of the month.",
].join("\n");
const BUDGET = "# Budget\n\nThe harbour budget sets aside money for dredging the channel.\n";

const SPRING = "Spring tides come twice in every month.";
const NEAP = "Neap tides have the largest range of the month.";
const NOTE = [SPRING, NEAP].join("\n\n");

const PLANS: Record<string, Plan> = {
  [SPRING]: { verdict: "supported", quote: "Spring tides happen twice a month" },
  [NEAP]: {
    verdict: "contradicted",
    quote: "The range of a spring tide is the largest of the month.",
    says: "Tides says the spring tide's range is the largest.",
  },
};

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Listed {
  folders: {
    id: string;
    name: string;
    documents: number;
    documentList: { id: string; name: string; kind: string }[];
    minds: { id: string }[];
  }[];
}

function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

function refusal(result: unknown): string {
  const { isError, content } = result as { isError?: boolean; content?: { text?: string }[] };
  expect(isError).toBe(true);
  return content?.[0]?.text ?? "";
}

/** A fresh profile: no Folder and no Document, connecting agents on. */
const EXAMPLES = resolve(__dirname, "../../resources/examples");

async function fresh(calls: ModelCall[] = [], language: "en" | "zh-CN" = "en", examples = false) {
  const started = await startAgentsCore(
    checkingModel(PLANS, calls),
    examples ? { paths: { examples: EXAMPLES } } : {},
  );
  const { core } = started;
  if (language !== "en") await core.updateSettings({ user: { language } });
  await core.setAgentsEnabled(true);
  const sources = await createSourceFolder();
  const add = async (name: string, text: string) => {
    const [added] = await addAndProcess(core, [await writeSourceFile(sources, name, text)]);
    if (!added) throw new Error(`${name} wasn't added.`);
    return added;
  };
  const connect = async (folderIds: string[], name = "Claude Code", propose = true) => {
    const { launch, pairing } = await core.connectAgent({ name, folderIds, propose });
    return { agent: await connectLegacyAgent(launch), pairing };
  };
  return { ...started, core, add, connect, calls };
}

const write = async (agent: Agent, title = "Tide summary", markdown = NOTE) =>
  structured<{ mindId: string; folder: string }>(
    await agent.callTool({ name: "create_mind", arguments: { title, markdown } }),
  );

const list = async (agent: Agent) =>
  structured<Listed>(await agent.callTool({ name: "list_minds", arguments: {} })).folders;

/** A Citation of `quote`, which the Documents the agent reads hold word for word. */
async function cited(agent: Agent, quote: string): Promise<string> {
  const { passages } = structured<{ passages: { passageId: string }[] }>(
    await agent.callTool({ name: "search", arguments: { query: "spring tides range" } }),
  );
  const { citations } = structured<{ citations: { cite: string | null }[] }>(
    await agent.callTool({
      name: "cite",
      arguments: { citations: passages.map(({ passageId }) => ({ passageId, quote })) },
    }),
  );
  const found = citations.find((each) => each.cite !== null)?.cite;
  if (!found) throw new Error(`No Passage holds “${quote}”.`);
  return found;
}

/** Each marked sentence of the Note as the window shows it, with whose check it is. */
async function marks(core: Core, mindId: string) {
  const client = await connectToMind(core, mindId);
  await client.settled();
  const versions = new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));
  return claimSpans(readMind(client)).map((span) => ({
    text: span.sentence.text,
    state: claimCheckShown(span.check, {
      footing: "not-yet-known",
      text: span.sentence.text,
      versions,
      folderId: null,
      scope: null,
    }).state,
    by: checkedWith(span.check)?.models.map((model) => model.modelId) ?? [],
  }));
}

describe("an agent given Not in a Folder writes and checks its own Note there (#3364)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a new User with no Folder connects their AI and has it write and check a Note on day one; fails_when=connecting needs a Folder, create_mind needs a Folder, or check_mind_yourself refuses a Note in no Folder
  it("connects with no Document, writes a Note in no Folder and checks it against the Documents added since", async () => {
    const { core, add, calls } = await fresh();
    expect((await core.getLibrary()).groups).toEqual([]);
    expect(await core.listDocuments()).toEqual([]);
    // As the connect dialog sends it with nothing to read yet.
    const { pairing } = await core.setUpAgent({
      client: "other",
      folderIds: [NOT_IN_A_FOLDER_ID],
      name: "Claude Code",
      propose: true,
    });
    expect(pairing.folderIds).toEqual([NOT_IN_A_FOLDER_ID]);
    const { launch } = await core.connectAgent({
      name: "Codex",
      folderIds: [NOT_IN_A_FOLDER_ID],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);
    await add("Tides.md", TIDES);

    const made = await write(agent);
    expect(made.folder).toBe("Not in a Folder");
    const mind = (await core.listMinds()).find((each) => each.id === made.mindId);
    expect(mind?.folderId).toBeNull();
    expect((await list(agent)).find((each) => each.id === NOT_IN_A_FOLDER_ID)).toMatchObject({
      documents: 1,
      minds: [{ id: made.mindId }],
    });
    const read = structured<{ markdown: string; folder: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId } }),
    );
    expect(read.markdown).toContain(SPRING);

    const given = structured<{ task: string; how: string; sentences: { text: string }[] }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: made.mindId } }),
    );
    expect(given.sentences.map((each) => each.text)).toEqual([SPRING, NEAP]);
    // A Note in no Folder is judged from all the agent reads: no Folder to name in its search.
    expect(given.how).not.toContain("folderIds");
    const twice = await cited(agent, "Spring tides happen twice a month");
    const largest = await cited(agent, "The range of a spring tide is the largest of the month.");
    const reported = structured<{ marked: number; next: string | null }>(
      await agent.callTool({
        name: "report_check",
        arguments: {
          mindId: made.mindId,
          task: given.task,
          results: [
            { n: 1, verdict: "supported", cites: [twice] },
            { n: 2, verdict: "contradicted", cites: [largest] },
          ],
        },
      }),
    );
    expect(reported).toMatchObject({ marked: 2, next: null });
    expect(await marks(core, made.mindId)).toEqual([
      { text: SPRING, state: "supported", by: ["Codex"] },
      { text: NEAP, state: "contradicted", by: ["Codex"] },
    ]);
    expect(calls).toEqual([]);

    // Its changes to its own Note wait for the User, as in a Folder.
    const named = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId, named: true } }),
    );
    const proposed = structured<{ waiting: number }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: made.mindId,
          version: named.version,
          changes: [{ paragraph: "¶2+", text: "Neap tides come between them." }],
        },
      }),
    );
    expect(proposed.waiting).toBe(1);
  });

  // protects=IncarnaMind's own check, started by the agent, reads only what the agent may read; fails_when=check_mind refuses a Note in no Folder or checks it against Documents the agent wasn't given
  it("has IncarnaMind's own check of its Note in no Folder run on the User's model", async () => {
    const calls: ModelCall[] = [];
    const { add, connect } = await fresh(calls);
    await add("Tides.md", TIDES);
    const { agent } = await connect([NOT_IN_A_FOLDER_ID]);
    const made = await write(agent);
    const checked = structured<{ status: string; supported: number; needLook: number }>(
      await agent.callTool({ name: "check_mind", arguments: { mindId: made.mindId } }),
    );
    expect(checked).toMatchObject({ status: "checked", supported: 1, needLook: 1 });
  });

  // protects=the User's own Notes in no Folder, and another agent's, stay out of an agent's reach; fails_when=Not in a Folder lets an agent list, read, change or check a Note it didn't write
  it("can't list, read, change or check a Note in no Folder that it didn't write", async () => {
    const { core, add, connect } = await fresh();
    await add("Tides.md", TIDES);
    const { agent } = await connect([NOT_IN_A_FOLDER_ID]);
    const { agent: other } = await connect([NOT_IN_A_FOLDER_ID], "Cursor");
    const theirs = await write(other, "Cursor's summary");
    const mine = await core.createMind({ title: "My own plans" });
    const own = await write(agent);

    expect((await list(agent)).flatMap((each) => each.minds.map((listed) => listed.id))).toEqual([
      own.mindId,
    ]);
    for (const mindId of [theirs.mindId, mine.id]) {
      for (const [name, args] of [
        ["read_mind", { mindId }],
        ["read_mind", { mindId, named: true }],
        ["propose_changes", { mindId, version: "v", changes: [{ paragraph: "¶1", text: "x" }] }],
        ["check_mind_yourself", { mindId }],
        ["check_mind", { mindId }],
      ] as const) {
        expect(
          refusal(await agent.callTool({ name, arguments: args })),
          `${name} of ${mindId}`,
        ).toBe(
          "No such passage, Document, note or Citation in the Folders shared with this agent.",
        );
      }
    }
  });

  // protects=Documents in a Folder the agent wasn't given stay unknown to it, through a list, a check task or a refusal; fails_when=a count, a name or a passage of such a Document reaches the agent
  it("learns nothing of a Document in a Folder it wasn't given", async () => {
    const { core, add, connect } = await fresh();
    await add("Tides.md", TIDES);
    const budget = await add("Budget.md", BUDGET);
    const { agent } = await connect([NOT_IN_A_FOLDER_ID]);
    const made = await write(agent);
    const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
    await core.assignDocumentGroup(budget.id, finance.id);

    const tides = (await core.listDocuments()).find((each) => each.id !== budget.id);
    expect(await list(agent)).toEqual([
      expect.objectContaining({
        id: NOT_IN_A_FOLDER_ID,
        documents: 1,
        documentList: [{ id: tides?.id, name: "Tides", kind: "markdown" }],
      }),
    ]);
    const { passages } = structured<{ passages: { documentId: string }[] }>(
      await agent.callTool({ name: "search", arguments: { query: "harbour budget dredging" } }),
    );
    expect(passages.map((each) => each.documentId)).not.toContain(budget.id);
    expect(
      refusal(
        await agent.callTool({ name: "read_passages", arguments: { documentId: budget.id } }),
      ),
    ).not.toMatch(/Budget|Finance/);
    // The Note in no Folder is checked against every Document, Budget among them: the agent
    // isn't given its sentences to judge, and the refusal names no Document or Folder.
    for (const name of ["check_mind_yourself", "check_mind"] as const) {
      const said = refusal(await agent.callTool({ name, arguments: { mindId: made.mindId } }));
      expect(said).toMatch(/outside the Folders shared with this agent/);
      expect(said).not.toMatch(/Budget|Finance|dredging/);
    }
    expect(
      refusal(
        await agent.callTool({
          name: "create_mind",
          arguments: { title: "Money", markdown: "Money.", folderId: finance.id },
        }),
      ),
    ).toBe("That Folder isn’t shared with this agent. Share more in Settings → Agents.");
  });

  // protects=an agent sees which Documents it may read, by name and kind, as IncarnaMind's own check does (#3363), and never one outside its reach; fails_when=a list names a Document of a Folder it wasn't given, or none of those it may read
  it("lists the Documents it may read, by name and kind, and none it may not", async () => {
    const { core, add, connect } = await fresh();
    const tides = await add("Tides.md", TIDES);
    const budget = await add("Budget.md", BUDGET);
    const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
    await core.assignDocumentGroup(budget.id, finance.id);
    const { agent } = await connect([NOT_IN_A_FOLDER_ID]);
    const { agent: accountant } = await connect([finance.id], "Cursor");

    const everything = JSON.stringify(await list(agent));
    expect(await list(agent)).toEqual([
      expect.objectContaining({
        documents: 1,
        documentList: [{ id: tides.id, name: "Tides", kind: "markdown" }],
      }),
    ]);
    expect(everything).not.toContain(budget.id);
    expect(everything).not.toContain("Budget");
    expect(await list(accountant)).toEqual([
      expect.objectContaining({
        id: finance.id,
        documentList: [{ id: budget.id, name: "Budget", kind: "markdown" }],
      }),
    ]);
  });

  // protects=the app's own example is not the User's Documents, so an agent given Not in a Folder neither lists nor reads it, and still checks its Note against the User's own; fails_when=an agent summarises the example as the User's, or its Note's check is refused because of the example
  it("leaves the app's own examples out of Not in a Folder", async () => {
    const { core, add, connect } = await fresh([], "en", true);
    const made = await core.createExamples();
    const examples = await vi.waitFor(
      async () => {
        const read = await core.listDocuments({ linkedFolderId: made.linkedFolderId ?? "" });
        expect(read.length).toBeGreaterThan(0);
        expect(read.every((each) => each.status === "ready")).toBe(true);
        return read;
      },
      { timeout: 30_000 },
    );
    const tides = await add("Tides.md", TIDES);
    const { agent } = await connect([NOT_IN_A_FOLDER_ID]);

    expect(await list(agent)).toEqual([
      expect.objectContaining({
        documents: 1,
        documentList: [{ id: tides.id, name: "Tides", kind: "markdown" }],
      }),
    ]);
    const { passages } = structured<{ passages: { documentId: string }[] }>(
      await agent.callTool({ name: "search", arguments: { query: "Northwind Retail net debt" } }),
    );
    const exampleIds = new Set(examples.map((each) => each.id));
    expect(passages.filter((each) => exampleIds.has(each.documentId))).toEqual([]);
    const note = await write(agent);
    const given = structured<{ sentences: { text: string }[] }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: note.mindId } }),
    );
    expect(given.sentences.map((each) => each.text)).toEqual([SPRING, NEAP]);
  });

  // protects=an agent the User gave Folders and not Not in a Folder keeps exactly its reach; fails_when=it can write in no Folder, or reach a Note there, its own included
  it("with Folders and without Not in a Folder, behaves as before", async () => {
    const { core, add, connect } = await fresh();
    const tides = await add("Tides.md", TIDES);
    const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
    await core.assignDocumentGroup(tides.id, coast.id);
    const { agent } = await connect([coast.id]);

    const made = await write(agent);
    expect(made.folder).toBe("Coast");
    expect(
      refusal(
        await agent.callTool({
          name: "create_mind",
          arguments: { title: "Loose", markdown: "Loose.", folderId: NOT_IN_A_FOLDER_ID },
        }),
      ),
    ).toBe("That Folder isn’t shared with this agent. Share more in Settings → Agents.");
    expect((await list(agent)).map((each) => each.id)).toEqual([coast.id]);
    // Its own Note, moved out of its Folder by the User, is out of its reach.
    await core.moveToFolder({ mindIds: [made.mindId], folderId: null });
    expect(
      refusal(await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId } })),
    ).toMatch(/No such passage/);
    expect((await list(agent)).flatMap((each) => each.minds)).toEqual([]);
  });

  // protects=an agent with a Folder and Not in a Folder still writes in its Folder unless told otherwise; fails_when=adding Not in a Folder moves where its Notes go, or not-in-a-folder can't be named
  it("with one Folder and Not in a Folder, writes in the Folder unless it names none", async () => {
    const { core, add, connect } = await fresh();
    const tides = await add("Tides.md", TIDES);
    const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
    await core.assignDocumentGroup(tides.id, coast.id);
    const { agent } = await connect([coast.id, NOT_IN_A_FOLDER_ID]);
    expect((await write(agent)).folder).toBe("Coast");
    const none = structured<{ folder: string; mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Loose", markdown: NOTE, folderId: NOT_IN_A_FOLDER_ID },
      }),
    );
    expect(none.folder).toBe("Not in a Folder");
    expect((await list(agent)).find((each) => each.id === NOT_IN_A_FOLDER_ID)?.minds).toEqual([
      expect.objectContaining({ id: none.mindId }),
    ]);
  });

  // protects=each refusal on this path says what is so and what the User can change; fails_when=an agent that just read the Documents is told it can't read any, or a Note in no Folder is said to have a Folder
  it("says what is so when it reads nothing, or there is nothing to check against, in English and Chinese", async () => {
    for (const language of ["en", "zh-CN"] as const) {
      const { connect } = await fresh([], language);
      const { agent: nothing } = await connect([], "Cursor");
      expect(refusal(await nothing.callTool({ name: "list_minds", arguments: {} }))).toBe(
        language === "en"
          ? "This agent can’t read any Documents yet. Choose its Folders in Settings → Agents."
          : "这个智能体还不能读取任何文档。在“设置 → 智能体”中为它选择文件夹。",
      );
      const { agent } = await connect([NOT_IN_A_FOLDER_ID]);
      const made = await write(agent);
      expect(made.folder).toBe(language === "en" ? "Not in a Folder" : "不在文件夹中");
      expect(
        refusal(
          await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: made.mindId } }),
        ),
      ).toBe(
        language === "en"
          ? "There are no Documents to check this note against yet. The User can add some in IncarnaMind."
          : "还没有可用来核对这篇笔记的文档。用户可以在 IncarnaMind 中添加。",
      );
      const { agent: readOnly } = await connect([NOT_IN_A_FOLDER_ID], "Codex", false);
      expect(
        refusal(
          await readOnly.callTool({
            name: "create_mind",
            arguments: { title: "Summary", markdown: NOTE },
          }),
        ),
      ).toMatch(language === "en" ? /may only read.*Settings → Agents/ : /只能读取.*设置 → 智能体/);
    }
  });
});
