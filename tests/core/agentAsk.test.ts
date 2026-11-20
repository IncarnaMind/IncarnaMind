/**
 * Ask your AI (#3373, #3419): one line for the User to send in their own AI, in their own words,
 * naming IncarnaMind and the Note by its title; the agent's app opens with it typed where its app
 * documents a link for that, and it is copied for the User to paste elsewhere. The rest (the
 * Note's id, the sentences and what the check found, what to change and leave alone) waits in
 * IncarnaMind for that agent alone, which reads it once with `read_request` while it may read the
 * Note.
 */
import { describe, expect, it } from "vitest";
import type { AgentAsk, AgentClientId } from "../../src/core/api";
import { activityWords } from "../../src/renderer/src/components/agents/agentWords";
import { translate } from "../../src/shared/i18n";
import { agentsAdapter, connectLegacyAgent, resultText } from "../helpers/agents";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";

const OVERSTATED = "Fuel cost doubled over the year.";
const OTHER = "The board approved a new booking system for 2026.";
const TITLE = "Ferry report for the board";

/** A core with agents on, a Folder of ferry notes and a Note in it; each link it opens is kept. */
async function started({ openLink = true } = {}) {
  const dataDir = await createTempDataFolder();
  const links: string[] = [];
  const core = startCore(dataDir, {
    agents: {
      ...(await agentsAdapter(dataDir)),
      ...(openLink && {
        openLink: async (url: string) => {
          links.push(url);
        },
      }),
    },
  });
  const ferries = await core.createLibraryGroup({ name: "Tallow Sound Ferries", description: "" });
  const mind = await core.createMind({ title: TITLE, folderId: ferries.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [note(`Tallow Sound Ferries ran 2,816 crossings. ${OVERSTATED}`), note(OTHER)]);
  await core.setAgentsEnabled(true);
  const connect = async (
    name: string,
    client: AgentClientId | undefined,
    folderIds = [ferries.id],
  ) => {
    const made = await core.connectAgent({ name, folderIds, ...(client && { client }) });
    return { ...made.pairing, launch: made.launch };
  };
  return { core, links, mind, ferries, connect };
}

const fix: AgentAsk = {
  kind: "fix",
  sentences: [{ sentence: OVERSTATED, verdict: "overstated", checkId: "check-1" }],
};

const promptOf = (link: string | undefined, parameter: string) =>
  new URL(link ?? "about:blank").searchParams.get(parameter);

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

const readRequest = (agent: Agent, note?: string) =>
  agent.callTool({ name: "read_request", arguments: note === undefined ? {} : { note } });

/** What `read_request` gave, or the refusal in its words. */
async function requestRead(agent: Agent, note?: string) {
  const result = (await readRequest(agent, note)) as {
    isError?: boolean;
    structuredContent?: { mindId: string; title: string; request: string };
  };
  return result.isError
    ? { refused: resultText(result) }
    : (result.structuredContent ?? { refused: "nothing" });
}

const LONG_FIX = (mindId: string) =>
  `In IncarnaMind, the check of my note “${TITLE}” (mindId: ${mindId}) says this sentence is overstated:\n\n“${OVERSTATED}”\n\nFix that sentence from my Documents, and change nothing else in the note. Then check the note again yourself.`;

describe("asking the User's own AI", () => {
  // protects=the line Claude Code opens with is the User's own words, naming IncarnaMind and the Note, with no id, sentence or instruction, and the rest reaches that agent over its connection once; fails_when=the line carries the id or the sentence, or the request is lost, changed or read twice
  it("opens Claude Code with one line, and keeps the rest for it to read once", async () => {
    const { core, links, mind, connect } = await started();
    const pairing = await connect("Claude Code", "claude-code");
    expect(await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: fix })).toEqual({
      kind: "opened",
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.startsWith("claude-cli://open?q=")).toBe(true);
    const line = promptOf(links[0], "q");
    expect(line).toBe(`Fix the sentence IncarnaMind flagged in “${TITLE}”.`);
    expect(line).not.toContain(mind.id);
    expect(line).not.toContain(OVERSTATED);

    const agent = await connectLegacyAgent(pairing.launch);
    expect(await requestRead(agent, TITLE)).toEqual({
      mindId: mind.id,
      title: TITLE,
      request: LONG_FIX(mind.id),
    });
    const again = await requestRead(agent, TITLE);
    expect(again).toEqual({ refused: translate("en", "agents.problem.noRequest") });
    expect(JSON.stringify(again)).not.toContain(OVERSTATED);
  });

  // protects=the line and the request read in the interface language; fails_when=Chinese gets English words or a verdict out of the dictionary
  it("asks in Chinese when the interface is", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    await core.updateSettings({ user: { language: "zh-CN" } });
    const pairing = await connect("VS Code", "vscode");
    const asked = await core.askAgent({
      pairingId: pairing.id,
      mindId: mind.id,
      ask: { kind: "fix", sentences: [{ sentence: OVERSTATED, verdict: "not-found" }] },
    });
    expect(asked).toEqual({
      kind: "copy",
      text: `把 IncarnaMind 在笔记“${TITLE}”里标出来的那句改好。`,
    });
    const agent = await connectLegacyAgent(pairing.launch);
    expect(await requestRead(agent)).toMatchObject({
      request: `在 IncarnaMind 中，我的笔记“${TITLE}”（mindId：${mind.id}）经核对，这句话在我的文档中找不到：\n\n“${OVERSTATED}”\n\n请根据我的文档改正这句话，笔记的其他内容不要改动。改完后请你自己再核对一遍这篇笔记。`,
    });
  });

  // protects=one request names every sentence that needs a look, each with what its check found, and its line says how many; fails_when=a sentence or its verdict is left out, or the line lists them
  it("asks for every flagged sentence in one request", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const pairing = await connect("VS Code", "vscode");
    const asked = await core.askAgent({
      pairingId: pairing.id,
      mindId: mind.id,
      ask: {
        kind: "fix",
        sentences: [
          { sentence: OVERSTATED, verdict: "overstated" },
          { sentence: OTHER, verdict: "contradicted" },
        ],
      },
    });
    expect(asked).toEqual({
      kind: "copy",
      text: `Fix the 2 sentences IncarnaMind flagged in “${TITLE}”.`,
    });
    const agent = await connectLegacyAgent(pairing.launch);
    expect(await requestRead(agent)).toMatchObject({
      request: `In IncarnaMind, the check of my note “${TITLE}” (mindId: ${mind.id}) says these 2 sentences need a look:\n\n1. This sentence is overstated: “${OVERSTATED}”\n2. This sentence is contradicted by my Documents: “${OTHER}”\n\nFix each of them from my Documents, and change nothing else in the note. Then check the note again yourself.`,
    });
    await core.updateSettings({ user: { language: "zh-CN" } });
    await core.askAgent({
      pairingId: pairing.id,
      mindId: mind.id,
      ask: {
        kind: "fix",
        sentences: [
          { sentence: OVERSTATED, verdict: "units-may-differ" },
          { sentence: OTHER, verdict: "unsupported" },
        ],
      },
    });
    expect(await requestRead(agent)).toMatchObject({
      request: expect.stringContaining(
        `有 2 句需要留意：\n\n1. 这句话的单位可能与我的文档不同：“${OVERSTATED}”\n2. 这句话没有依据：“${OTHER}”`,
      ),
    });
  });

  // protects=each agent with a documented prefill link gets the line in it, every other one is copied; fails_when=an agent opens a link its documentation doesn't give, or one with a link is copied
  it.each([
    ["claude-desktop", "claude://claude.ai/new", "q"],
    ["claude-code", "claude-cli://open", "q"],
    ["codex", "codex://new", "prompt"],
    ["cursor", "cursor://anysphere.cursor-deeplink/prompt", "text"],
  ] as const)("opens %s at its own link", async (client, start, parameter) => {
    const { core, links, mind, connect } = await started();
    const pairing = await connect("My agent", client);
    await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: fix });
    expect(links[0]?.startsWith(`${start}?${parameter}=`)).toBe(true);
    expect(promptOf(links[0], parameter)).toBe(
      `Fix the sentence IncarnaMind flagged in “${TITLE}”.`,
    );
  });

  it.each(["vscode", "gemini-cli", "opencode", "other", undefined] as const)(
    "copies the line for %s, and keeps the same request",
    async (client) => {
      const { core, links, mind, connect } = await started();
      const pairing = await connect("My agent", client);
      const asked = await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: fix });
      expect(asked).toEqual({
        kind: "copy",
        text: `Fix the sentence IncarnaMind flagged in “${TITLE}”.`,
      });
      expect(links).toEqual([]);
      const agent = await connectLegacyAgent(pairing.launch);
      expect(await requestRead(agent)).toMatchObject({ request: LONG_FIX(mind.id) });
    },
  );

  // protects=a question too long for an agent's link is copied whole, never cut; fails_when=a link over the documented limit is opened
  it("copies a question too long for the agent's link", async () => {
    const { core, links, mind, connect } = await started();
    const pairing = await connect("Claude Code", "claude-code");
    const long = `${"The ferry ran late. ".repeat(260)}`.trim();
    const asked = await core.askAgent({
      pairingId: pairing.id,
      mindId: mind.id,
      ask: { kind: "question", text: long },
    });
    expect(asked.kind).toBe("copy");
    expect(asked.kind === "copy" && asked.text.endsWith(long)).toBe(true);
    expect(links).toEqual([]);
  });

  // protects=a link no app on this computer takes still reaches the User, copied; fails_when=the failure is thrown at the User or nothing is given
  it("copies the line when no app takes the link", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      agents: {
        ...(await agentsAdapter(dataDir)),
        openLink: async () => {
          throw new Error("No application knows how to open claude-cli links.");
        },
      },
    });
    const folder = await core.createLibraryGroup({ name: "Ferries", description: "" });
    const mind = await core.createMind({ title: "Ferry report", folderId: folder.id });
    await core.setAgentsEnabled(true);
    const { pairing } = await core.connectAgent({
      name: "Claude Code",
      client: "claude-code",
      folderIds: [folder.id],
    });
    const asked = await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: fix });
    expect(asked).toEqual({
      kind: "copy",
      text: "Fix the sentence IncarnaMind flagged in “Ferry report”.",
    });
  });

  // protects=the User's own words stay in the line and the Note's id goes to the request; fails_when=the typed words are lost, or the id shows in the line
  it("keeps the words typed in the line, and the Note's id in the request", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const pairing = await connect("VS Code", "vscode");
    const agent = await connectLegacyAgent(pairing.launch);
    const question = "What did fuel cost in 2025?";
    const pointer = `My message is about my note “${TITLE}” in IncarnaMind (mindId: ${mind.id}).`;
    expect(
      await core.askAgent({
        pairingId: pairing.id,
        mindId: mind.id,
        ask: { kind: "question", text: question },
      }),
    ).toEqual({ kind: "copy", text: `About my note “${TITLE}” in IncarnaMind:\n\n${question}` });
    expect(await requestRead(agent)).toMatchObject({ request: pointer });
    expect(
      await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: { kind: "note" } }),
    ).toEqual({ kind: "copy", text: `About my note “${TITLE}” in IncarnaMind:` });
    expect(await requestRead(agent)).toMatchObject({ request: pointer });
    // A question about no Note says all there is in its line, and leaves nothing to read.
    expect(
      await core.askAgent({
        pairingId: pairing.id,
        mindId: null,
        ask: { kind: "question", text: question },
      }),
    ).toEqual({ kind: "copy", text: `From my Documents in IncarnaMind:\n\n${question}` });
    expect(await requestRead(agent)).toEqual({
      refused: translate("en", "agents.problem.noRequest"),
    });
  });

  // protects=two requests made before either is sent are both delivered, each once, by the Note the line names or else the newest; fails_when=one is lost, read twice, or a Note read already gets another's
  it("delivers two requests made before either is sent, each once", async () => {
    const { core, mind, ferries, connect } = await started({ openLink: false });
    const pairing = await connect("VS Code", "vscode");
    const crossings = await core.createMind({ title: "Crossings", folderId: ferries.id });
    await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: fix });
    await core.askAgent({
      pairingId: pairing.id,
      mindId: crossings.id,
      ask: { kind: "fix", sentences: [{ sentence: OTHER, verdict: "unsupported" }] },
    });
    // Renamed since: the agent names it as the line did.
    await core.renameMind(mind.id, "Ferry report, final");
    const agent = await connectLegacyAgent(pairing.launch);
    const none = { refused: translate("en", "agents.problem.noRequest") };
    expect(await requestRead(agent, `“${TITLE}”`)).toMatchObject({
      mindId: mind.id,
      title: "Ferry report, final",
    });
    expect(await requestRead(agent, TITLE)).toEqual(none);
    expect(await requestRead(agent, "the crossings note")).toMatchObject({
      mindId: crossings.id,
    });
    expect(await requestRead(agent)).toEqual(none);
  });

  // protects=a request reaches only the agent it was made for, and only while that agent may read the Note; fails_when=another agent reads it, or one whose Folders no longer hold the Note gets its words
  it("refuses the request to another agent, and to one that can't read the Note now", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const elsewhere = await core.createLibraryGroup({ name: "Elsewhere", description: "" });
    const asked = await connect("VS Code", "vscode");
    const other = await connect("Codex", "codex");
    await core.askAgent({ pairingId: asked.id, mindId: mind.id, ask: fix });

    const otherAgent = await connectLegacyAgent(other.launch);
    expect(await requestRead(otherAgent)).toEqual({
      refused: translate("en", "agents.problem.noRequest"),
    });

    await core.updateAgent(asked.id, { folderIds: [elsewhere.id] });
    const agent = await connectLegacyAgent(asked.launch);
    const refused = await requestRead(agent);
    expect(refused).toEqual({ refused: translate("en", "agents.problem.requestOutOfReach") });
    expect(JSON.stringify(refused)).not.toContain(OVERSTATED);
    expect(JSON.stringify(refused)).not.toContain(mind.id);

    const [waiting] = await core.listAgentRequests(mind.id);
    expect(waiting?.readAt).toBeNull();
    await core.updateAgent(asked.id, { folderIds: [mind.folderId ?? ""] });
    expect(await requestRead(agent)).toMatchObject({ request: LONG_FIX(mind.id) });
  });

  // protects=the User can read afterwards what the agent was given, in its activity, and the card knows the request was read; fails_when=the request isn't shown with the call, or its state isn't kept
  it("shows the request read in the agent's activity", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const pairing = await connect("VS Code", "vscode");
    await core.askAgent({ pairingId: pairing.id, mindId: mind.id, ask: fix });
    expect(await core.listAgentRequests(mind.id)).toEqual([
      expect.objectContaining({
        pairingId: pairing.id,
        sentences: [{ sentence: OVERSTATED, checkId: "check-1" }],
        readAt: null,
      }),
    ]);
    const agent = await connectLegacyAgent(pairing.launch);
    await requestRead(agent);
    const [call] = await core.listAgentActivity(pairing.id);
    expect(call).toMatchObject({
      tool: "read_request",
      outcome: "done",
      request: LONG_FIX(mind.id),
    });
    expect(activityWords(call ?? never(), (key, params) => translate("en", key, params))).toBe(
      `Read your request about “${TITLE}”`,
    );
    expect((await core.listAgentRequests(mind.id))[0]?.readAt).not.toBeNull();
    await core.disconnectAgent(pairing.id);
    expect(await core.listAgentRequests(mind.id)).toEqual([]);
  });

  // protects=only an agent that can read the Note now is offered, the one connected or used last first; fails_when=an agent that can't read it, or any while agents are off or in local mode, is offered
  it("offers the agents that read the Note, the latest first, and none while they are off", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const elsewhere = await core.createLibraryGroup({ name: "Elsewhere", description: "" });
    const first = await connect("VS Code", "vscode");
    const later = await connect("Claude Code", "claude-code");
    const codex = await connect("Codex", "codex", [elsewhere.id]);
    expect((await core.listAgentsToAsk(mind.id)).map((each) => each.name)).toEqual([
      later.name,
      first.name,
    ]);
    expect((await core.listAgentsToAsk(null)).map((each) => each.name)).toHaveLength(3);
    await expect(core.askAgent({ pairingId: codex.id, mindId: mind.id, ask: fix })).rejects.toThrow(
      "That agent can’t read this note now.",
    );
    expect(await core.listAgentRequests(mind.id)).toEqual([]);
    await core.setLocalOnly(true);
    expect(await core.listAgentsToAsk(mind.id)).toEqual([]);
    await core.setLocalOnly(false);
    await core.setAgentsEnabled(false);
    expect(await core.listAgentsToAsk(mind.id)).toEqual([]);
  });
});

function never(): never {
  throw new Error("No call was listed.");
}
