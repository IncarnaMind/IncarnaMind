/**
 * An outside agent writes a new Note (#3306): through the shim the app ships, with the MCP SDK's
 * own client, it hands over a name and Markdown. The Note is there at once in the Folder, says
 * which agent wrote it, holds only Citations IncarnaMind minted, and its text counts as
 * someone else's.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MAX_NOTES_AN_HOUR } from "../../src/core/agents/access";
import { BLOCK_ID_ATTRIBUTE, CITATION_NODE } from "../../src/core/api";
import { noteWriterOf } from "../../src/shared/noteWriter";
import { textOriginOf } from "../../src/shared/textOrigins";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";

const SPRING = "Spring tides happen twice a month, at new moon and full moon.";
const TIDES = ["# Tides", "", `${SPRING} Their range is the largest of the month.`].join("\n");

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Created {
  mindId: string;
  title: string;
  folder: string;
  citations: { cite: string; check: string; document: string | null }[];
  uncited: string[];
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

const create = (agent: Agent, input: Record<string, unknown>) =>
  agent.callTool({ name: "create_mind", arguments: input });

/** A core with agents on, Tides in "Coast" and an agent that may write there. */
async function paired({ propose = true, language = "en" as "en" | "zh-CN" } = {}) {
  const started = await startAgentsCore(replyingModel());
  const { core } = started;
  if (language !== "en") await core.updateSettings({ user: { language } });
  const sources = await createSourceFolder();
  const [tides] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
  if (!tides) throw new Error("Tides wasn't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.setAgentsEnabled(true);
  const { launch, pairing } = await core.connectAgent({
    name: "Claude Code",
    folderIds: [coast.id],
    propose,
  });
  const agent = await connectLegacyAgent(launch);
  return { ...started, core, tides, coast, pairing, agent };
}

async function springToken(agent: Agent): Promise<string> {
  const { passages } = structured<{ passages: { passageId: string }[] }>(
    await agent.callTool({ name: "search", arguments: { query: "spring tides new moon" } }),
  );
  const { citations } = structured<{ citations: { cite: string | null }[] }>(
    await agent.callTool({
      name: "cite",
      arguments: { citations: [{ passageId: passages[0]?.passageId, quote: SPRING }] },
    }),
  );
  const cite = citations[0]?.cite;
  if (!cite) throw new Error("No Citation for the quote.");
  return cite;
}

/** Each top-level Block's kind and words, as the editor's copy of the Note holds them. */
const blocksOf = (client: MindClient) => {
  const found: { kind: string; text: string }[] = [];
  readMind(client).forEach((block) => {
    // Without the word joiner that keeps a "[" the agent wrote from reading as a marker.
    found.push({ kind: block.type.name, text: block.textContent.replaceAll("\u2060", "") });
  });
  return found;
};

const citationsIn = (client: MindClient) => {
  const found: Record<string, unknown>[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === CITATION_NODE) found.push(node.attrs);
  });
  return found;
};

describe("a Note an outside agent writes (#3306)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("is there at once in the agent's Folder, with its Citations checked, as the agent's text", async () => {
    const { core, agent, coast, tides, pairing } = await paired();
    const before = await core.listMinds();
    const spring = await springToken(agent);
    const made = structured<Created>(
      await create(agent, {
        title: "Tide report",
        markdown: [
          `Spring tides come twice a month ${spring}.`,
          "",
          "- The harbour floods every winter.",
          "- King tides are rare [cite:notmine1].",
        ].join("\n"),
      }),
    );
    expect(made).toMatchObject({ title: "Tide report", folder: "Coast" });
    expect(made.citations).toEqual([
      expect.objectContaining({ cite: spring, check: "found", document: "Tides" }),
      expect.objectContaining({ cite: "[cite:notmine1]", check: "unknown", document: null }),
    ]);
    expect(made.uncited).toEqual(["The harbour floods every winter.", "King tides are rare."]);

    const minds = await core.listMinds();
    expect(minds).toHaveLength(before.length + 1);
    expect(minds.find((mind) => mind.id === made.mindId)).toMatchObject({
      title: "Tide report",
      folderId: coast.id,
    });

    const client = await connectToMind(core, made.mindId);
    expect(blocksOf(client)).toEqual([
      { kind: "heading", text: "Tide report" },
      { kind: "paragraph", text: "Spring tides come twice a month ." },
      {
        kind: "bulletList",
        text: "The harbour floods every winter.King tides are rare [quote not found].",
      },
    ]);
    // Only the token IncarnaMind minted is a Citation, checked again as the Document is now.
    expect(citationsIn(client)).toEqual([
      expect.objectContaining({ documentId: tides.id, quote: SPRING, check: "found" }),
    ]);
    // Every Block is someone else's text, and the Note says who wrote it.
    for (const block of client.blocks.toArray()) {
      const id = block instanceof Y.XmlElement ? block.getAttribute(BLOCK_ID_ATTRIBUTE) : null;
      expect(textOriginOf(client.doc, String(id))).toBe("outside-agent");
    }
    expect(noteWriterOf(client.doc)).toMatchObject({
      source: "outside-agent",
      agent: "Claude Code",
      pairingId: pairing.id,
    });

    // The agent reads it back like any Note in its Folders.
    const read = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId } }),
    );
    expect(read.markdown).toContain("Spring tides come twice a month");
    const activity = await core.listAgentActivity(pairing.id);
    expect(activity.find((each) => each.tool === "create_mind")).toMatchObject({
      outcome: "done",
      summary: "Tide report",
      effects: [
        { action: "read", scope: { kind: "documents" } },
        { action: "write", scope: { kind: "mind", mindId: made.mindId } },
      ],
    });
  });

  it("keeps a heading the text begins with as the Note's only one", async () => {
    const { core, agent } = await paired();
    const made = structured<Created>(
      await create(agent, {
        title: "Harbour",
        markdown: "# Harbour survey\n\nThe quay is 40 m long.",
      }),
    );
    const client = await connectToMind(core, made.mindId);
    expect(blocksOf(client)).toEqual([
      { kind: "heading", text: "Harbour survey" },
      { kind: "paragraph", text: "The quay is 40 m long." },
    ]);
  });

  it("is refused in plain words: no leave to write, another Folder, no Folder named, text it can't keep", async () => {
    const { core, agent, coast } = await paired();
    const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
    const fine = { title: "Report", markdown: "The quay is 40 m long." };
    expect(refusal(await create(agent, { ...fine, folderId: finance.id }))).toBe(
      "That Folder isn’t shared with this agent. Share more in Settings → Agents.",
    );
    expect(refusal(await create(agent, { ...fine, title: " " }))).toBe("title must be text.");
    expect(refusal(await create(agent, { ...fine, markdown: "x".repeat(100_001) }))).toBe(
      "markdown is longer than 100000 characters.",
    );
    const spring = await springToken(agent);
    expect(refusal(await create(agent, { ...fine, markdown: `Costs rose $x ${spring} y$.` }))).toBe(
      "In the text, a Citation sits where it can’t stay one, such as in a formula or a link’s address: write it after the words it cites.",
    );
    expect(await core.listMinds()).toHaveLength(0);

    const other = await core.connectAgent({
      name: "Codex",
      folderIds: [coast.id, finance.id],
      propose: true,
    });
    const codex = await connectLegacyAgent(other.launch);
    expect(refusal(await create(codex, fine))).toBe(
      "Give folderId: one of the Folders list_minds lists.",
    );
    const made = structured<Created>(await create(codex, { ...fine, folderId: finance.id }));
    expect(made.folder).toBe("Finance");

    const reader = await paired({ propose: false });
    expect(refusal(await create(reader.agent, fine))).toBe(
      "This agent may only read. To let it write new notes and propose changes to your notes, allow it in Settings → Agents.",
    );
    expect(await reader.core.listMinds()).toHaveLength(0);
  });

  it("writes at most so many Notes an hour, and says so in the interface language", async () => {
    const { core, agent, pairing } = await paired({ language: "zh-CN" });
    for (let n = 1; n <= MAX_NOTES_AN_HOUR; n++) {
      structured<Created>(await create(agent, { title: `报告 ${n}`, markdown: "码头长 40 米。" }));
    }
    expect(refusal(await create(agent, { title: "报告", markdown: "码头长 40 米。" }))).toBe(
      "这个智能体在过去一小时内已新建 20 篇笔记，达到上限。稍后再试。",
    );
    expect(await core.listMinds()).toHaveLength(MAX_NOTES_AN_HOUR);
    const activity = await core.listAgentActivity(pairing.id);
    expect(activity.find((each) => each.outcome === "refused")).toMatchObject({
      tool: "create_mind",
      problem: "too-many",
    });
  });
});
