/**
 * An agent connected to a User who set up no AI model in IncarnaMind (#3533): the Tools that can
 * only refuse without one are not in its list, and are in it again once a model is set up, for an
 * agent that follows a changed list and for one that reads the list at its next start.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildAgentShim,
  connectLegacyAgent,
  connectModernAgent,
  startAgentsCore,
} from "../helpers/agents";
import { replyingModel } from "../helpers/models";

/** `ask` hands the Question to IncarnaMind's model and `check_mind` has it check each sentence. */
const NEED_A_MODEL = ["ask", "check_mind"];

/** A core with agents on and no model set up, and one pairing. */
async function withoutAModel() {
  const started = await startAgentsCore(replyingModel(), {}, { modelSetUp: false });
  const folder = await started.core.createLibraryGroup({ name: "Coast", description: "" });
  await started.core.setAgentsEnabled(true);
  const { launch } = await started.core.connectAgent({
    name: "Claude Code",
    folderIds: [folder.id],
  });
  return { ...started, launch };
}

type Lister = { listTools(): Promise<{ tools: { name: string }[] }> };
const namesOf = async (agent: Lister) => (await agent.listTools()).tools.map((tool) => tool.name);

describe("outside agents while IncarnaMind has no AI model of its own", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=an agent isn't offered a Tool that can only refuse, whichever protocol it speaks, and keeps every Tool that has a way to work; fails_when=ask or check_mind is listed with no model, or a Tool that works without one is hidden
  it("aren't offered the Tools that can only refuse, and keep every other", async () => {
    const { launch } = await withoutAModel();
    for (const agent of [await connectLegacyAgent(launch), await connectModernAgent(launch)]) {
      const names = await namesOf(agent);
      for (const hidden of NEED_A_MODEL) expect(names).not.toContain(hidden);
      // Each of these works with no model: it searches, reads, checks the agent's own way, or says
      // the file wasn't checked and how to check it.
      expect(names).toEqual(
        expect.arrayContaining([
          "search",
          "read_passages",
          "read_request",
          "check_mind_yourself",
          "report_check",
          "hand_over_file",
          "save_as_word",
          "read_deck",
          "propose_deck_changes",
          "create_mind",
          "run_analysis",
        ]),
      );
      expect(names).toHaveLength(22);
    }
  });

  // protects=the Tools come back when a model is set up, to an agent that follows a changed list, to one that reads the list again, and to one that connects after; and go again when it is removed; fails_when=an agent has to be reconnected, or the list stays as it was
  it("are offered again once a model is set up, and not once it is removed", async () => {
    const { core, launch } = await withoutAModel();
    const legacyHeard: string[][] = [];
    const modernHeard: string[][] = [];
    const legacy = await connectLegacyAgent(launch, (names) => legacyHeard.push(names));
    const modern = await connectModernAgent(launch, (names) => modernHeard.push(names));
    const ignoring = await connectLegacyAgent(launch);
    expect(await namesOf(legacy)).not.toContain("ask");

    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    for (const heard of [legacyHeard, modernHeard]) {
      await vi.waitFor(() => expect(heard.at(-1)).toEqual(expect.arrayContaining(NEED_A_MODEL)));
    }
    for (const agent of [legacy, modern, ignoring]) {
      expect(await namesOf(agent)).toEqual(expect.arrayContaining(NEED_A_MODEL));
    }
    // One that connects later, as one that ignored the change does at its next start.
    for (const agent of [await connectLegacyAgent(launch), await connectModernAgent(launch)]) {
      expect(await namesOf(agent)).toEqual(expect.arrayContaining(NEED_A_MODEL));
    }

    await core.deleteChatProvider(provider.id);
    for (const heard of [legacyHeard, modernHeard]) {
      await vi.waitFor(() => expect(heard.at(-1)).not.toContain("ask"));
    }
    expect(await namesOf(await connectLegacyAgent(launch))).not.toContain("check_mind");
  });

  // protects=a model set up first leaves the list whole, as before; fails_when=a User with a model loses a Tool
  it("with a model set up, are offered every Tool", async () => {
    const started = await startAgentsCore(replyingModel());
    const folder = await started.core.createLibraryGroup({ name: "Coast", description: "" });
    await started.core.setAgentsEnabled(true);
    const { launch } = await started.core.connectAgent({ name: "Codex", folderIds: [folder.id] });
    const names = await namesOf(await connectLegacyAgent(launch));
    expect(names).toEqual(expect.arrayContaining(NEED_A_MODEL));
    expect(names).toHaveLength(24);
  });
});
