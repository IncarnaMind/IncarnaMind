/**
 * Ask your AI (#3373): a short request for the User to send in their own AI, which opens with it
 * typed where its app documents a link for that, and is copied for the User to paste elsewhere.
 * It names the Note by its title and its id, as `read_mind` takes it, and holds at most the one
 * sentence and a few words of its check, or the words the User typed: nothing else of the Note.
 */
import { describe, expect, it } from "vitest";
import type { AgentClientId } from "../../src/core/api";
import { agentsAdapter } from "../helpers/agents";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";

const OVERSTATED = "Fuel cost doubled over the year.";
const OTHER = "The board approved a new booking system for 2026.";

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
  const mind = await core.createMind({ title: "Ferry report for the board", folderId: ferries.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [note(`Tallow Sound Ferries ran 2,816 crossings. ${OVERSTATED}`), note(OTHER)]);
  await core.setAgentsEnabled(true);
  const connect = (name: string, client: AgentClientId | undefined, folderIds = [ferries.id]) =>
    core.connectAgent({ name, folderIds, ...(client && { client }) }).then((made) => made.pairing);
  return { core, links, mind, ferries, connect };
}

const fix = { kind: "fix", sentence: OVERSTATED, verdict: "overstated" } as const;

const promptOf = (link: string | undefined, parameter: string) =>
  new URL(link ?? "about:blank").searchParams.get(parameter);

describe("asking the User's own AI", () => {
  // protects=the request names the Note as read_mind finds it and holds the one sentence and its verdict, nothing else of the Note; fails_when=it leaves out the title, the id or the sentence, or carries another sentence of the Note
  it("opens Claude Code with a request naming the Note and holding only that sentence", async () => {
    const { core, links, mind, connect } = await started();
    const agent = await connect("Claude Code", "claude-code");
    expect(await core.askAgent({ pairingId: agent.id, mindId: mind.id, ask: fix })).toEqual({
      kind: "opened",
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.startsWith("claude-cli://open?q=")).toBe(true);
    expect(promptOf(links[0], "q")).toBe(
      `In IncarnaMind, the check of my note “Ferry report for the board” (mindId: ${mind.id}) says this sentence is overstated:\n\n“${OVERSTATED}”\n\nFix that sentence from my Documents, and change nothing else in the note. Then check the note again yourself.`,
    );
    expect(promptOf(links[0], "q")).not.toContain("2,816");
    expect(promptOf(links[0], "q")).not.toContain(OTHER);
  });

  // protects=the request reads in the interface language; fails_when=Chinese gets the English request or a verdict word out of the dictionary
  it("asks in Chinese when the interface is", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    await core.updateSettings({ user: { language: "zh-CN" } });
    const agent = await connect("VS Code", "vscode");
    const asked = await core.askAgent({
      pairingId: agent.id,
      mindId: mind.id,
      ask: { kind: "fix", sentence: OVERSTATED, verdict: "not-found" },
    });
    expect(asked).toEqual({
      kind: "copy",
      text: `在 IncarnaMind 中，我的笔记“Ferry report for the board”（mindId：${mind.id}）经核对，这句话在我的文档中找不到：\n\n“${OVERSTATED}”\n\n请根据我的文档改正这句话，笔记的其他内容不要改动。改完后请你自己再核对一遍这篇笔记。`,
    });
  });

  // protects=each agent with a documented prefill link gets it, every other one is copied; fails_when=an agent opens a link its documentation doesn't give, or one with a link is copied
  it.each([
    ["claude-desktop", "claude://claude.ai/new", "q"],
    ["claude-code", "claude-cli://open", "q"],
    ["codex", "codex://new", "prompt"],
    ["cursor", "cursor://anysphere.cursor-deeplink/prompt", "text"],
  ] as const)("opens %s at its own link", async (client, start, parameter) => {
    const { core, links, mind, connect } = await started();
    const agent = await connect("My agent", client);
    await core.askAgent({ pairingId: agent.id, mindId: mind.id, ask: fix });
    expect(links[0]?.startsWith(`${start}?${parameter}=`)).toBe(true);
    expect(promptOf(links[0], parameter)).toContain(OVERSTATED);
  });

  it.each(["vscode", "gemini-cli", "opencode", "other", undefined] as const)(
    "copies the request for %s",
    async (client) => {
      const { core, links, mind, connect } = await started();
      const agent = await connect("My agent", client);
      const asked = await core.askAgent({ pairingId: agent.id, mindId: mind.id, ask: fix });
      expect(asked.kind).toBe("copy");
      expect(links).toEqual([]);
    },
  );

  // protects=a request too long for an agent's link is copied whole, never cut; fails_when=a link over the documented limit is opened
  it("copies a request too long for the agent's link", async () => {
    const { core, links, mind, connect } = await started();
    const agent = await connect("Claude Code", "claude-code");
    const long = `${"The ferry ran late. ".repeat(260)}`.trim();
    const asked = await core.askAgent({
      pairingId: agent.id,
      mindId: mind.id,
      ask: { kind: "question", text: long },
    });
    expect(asked.kind).toBe("copy");
    expect(asked.kind === "copy" && asked.text.endsWith(long)).toBe(true);
    expect(links).toEqual([]);
  });

  // protects=a link no app on this computer takes still reaches the User, copied; fails_when=the failure is thrown at the User or nothing is given
  it("copies the request when no app takes the link", async () => {
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
    expect(asked.kind).toBe("copy");
  });

  // protects=the chat box's words and the plain note line carry what they should; fails_when=the typed words or the Note's name are lost
  it("carries the words typed, or only the Note named", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const agent = await connect("VS Code", "vscode");
    const question = "What did fuel cost in 2025?";
    expect(
      await core.askAgent({
        pairingId: agent.id,
        mindId: mind.id,
        ask: { kind: "question", text: question },
      }),
    ).toEqual({
      kind: "copy",
      text: `In IncarnaMind, about my note “Ferry report for the board” (mindId: ${mind.id}):\n\n${question}`,
    });
    expect(
      await core.askAgent({
        pairingId: agent.id,
        mindId: null,
        ask: { kind: "question", text: question },
      }),
    ).toEqual({ kind: "copy", text: `From my Documents in IncarnaMind:\n\n${question}` });
    expect(
      await core.askAgent({ pairingId: agent.id, mindId: mind.id, ask: { kind: "note" } }),
    ).toEqual({
      kind: "copy",
      text: `In IncarnaMind, about my note “Ferry report for the board” (mindId: ${mind.id}):`,
    });
  });

  // protects=only an agent that can read the Note now is offered, the one connected or used last first; fails_when=an agent that can't read it, or any while agents are off or in local mode, is offered
  it("offers the agents that read the Note, the latest first, and none while they are off", async () => {
    const { core, mind, connect } = await started({ openLink: false });
    const elsewhere = await core.createLibraryGroup({ name: "Elsewhere", description: "" });
    const first = await connect("VS Code", "vscode");
    const later = await connect("Claude Code", "claude-code");
    await connect("Codex", "codex", [elsewhere.id]);
    expect((await core.listAgentsToAsk(mind.id)).map((each) => each.name)).toEqual([
      later.name,
      first.name,
    ]);
    expect((await core.listAgentsToAsk(null)).map((each) => each.name)).toHaveLength(3);
    await expect(
      core.askAgent({
        pairingId:
          (await core.getAgents()).pairings.find((each) => each.name === "Codex")?.id ?? "",
        mindId: mind.id,
        ask: fix,
      }),
    ).rejects.toThrow("That agent can’t read this note now.");
    await core.setLocalOnly(true);
    expect(await core.listAgentsToAsk(mind.id)).toEqual([]);
    await core.setLocalOnly(false);
    await core.setAgentsEnabled(false);
    expect(await core.listAgentsToAsk(mind.id)).toEqual([]);
  });
});
