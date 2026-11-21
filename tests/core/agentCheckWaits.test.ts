/**
 * A check is the User's to start (#3576): what an outside agent writes or hands over waits for the
 * User's Check, as what the assistant writes does, unless Settings › AI checks it as it lands. The
 * agent is told which, where it reads it: in what writing a Note and handing over a file answer.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { checkingModel } from "../helpers/checks";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { DECK, type Handed, handOver, started, structured } from "../helpers/handedFiles";
import type { ModelCall } from "../helpers/models";

const TIDES = "# Tides\n\nSpring tides happen twice a month, at new moon and full moon.";
const NOTE = [
  "Spring tides come twice in every month.",
  "Penguins nest on the cliffs above the harbour.",
].join("\n\n");
const WAITS =
  "2 sentences of the note hold no check result yet. They wait for the User’s Check in IncarnaMind; if they asked you to check the note, check it now with check_mind_yourself, which gives them.";
const CHECK_NOW =
  "2 sentences of the note hold no check result yet, and the User has what is written checked as it lands: check them now, before you finish, with check_mind_yourself, then report_check.";
const FILE_WAITS =
  "Not checked yet: it waits for the User’s Check in IncarnaMind. If they asked you to check it, check it now: check_mind_yourself with its mindId, then report_check.";

/** A core with agents on, Tides in "Coast", and an agent that may write there. */
async function writer(asItLands: boolean) {
  const calls: ModelCall[] = [];
  const { core } = await startAgentsCore(checkingModel({}, calls));
  await core.updateSettings({ user: { checkAssistantWrites: asItLands } });
  const sources = await createSourceFolder();
  const [tides] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
  if (!tides) throw new Error("Tides wasn't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.setAgentsEnabled(true);
  const { launch } = await core.connectAgent({
    name: "Claude Code",
    folderIds: [coast.id],
    propose: true,
  });
  return { core, calls, agent: await connectLegacyAgent(launch) };
}

describe("what an outside agent writes waits for the User's Check (#3576)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=with checking as it lands off, the default, writing a Note tells the agent its sentences wait for the User's Check or their asking, and nothing tells it to check now, while the Note still counts them as not checked; fails_when=create_mind or propose_changes tells the agent to check before it finishes, or says nothing waits
  it("says a Note's sentences wait for the User, and check_mind_yourself still gives them", async () => {
    const { agent, calls } = await writer(false);
    const written = structured<{ mindId: string; next: string | null }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Tide notes", markdown: NOTE },
      }),
    );
    expect(written.next).toBe(WAITS);

    const { version } = structured<{ version: string }>(
      await agent.callTool({
        name: "read_mind",
        arguments: { mindId: written.mindId, named: true },
      }),
    );
    const changed = structured<{ next: string | null }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: written.mindId,
          version,
          changes: [{ paragraph: "¶2+", text: "Neap tides come in between." }],
        },
      }),
    );
    expect(changed.next).toContain("wait for the User’s Check");
    expect(changed.next).not.toContain("before you finish");

    // Asked, the agent checks: every sentence is still there to judge.
    const task = structured<{ sentences: unknown[] }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: written.mindId } }),
    );
    expect(task.sentences).toHaveLength(3);
    expect(calls).toEqual([]);
  });

  // protects=with checking as it lands on, an agent is told to check the Note it wrote before it finishes, as before (#3576); fails_when=the switch on still says the sentences wait
  it("tells the agent to check the Note now while checking as it lands is on", async () => {
    const { agent } = await writer(true);
    const written = structured<{ next: string | null }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Tide notes", markdown: NOTE },
      }),
    );
    expect(written.next).toBe(CHECK_NOW);
  });

  // protects=with checking as it lands off, a file handed over is kept and its check waits for the User, on their own model too: nothing goes to a model until they start it (#3576); fails_when=a hand-over starts IncarnaMind's own check unasked, or tells the agent to check the file now
  it("keeps a handed-over file unchecked until the User turns checking as it lands on", async () => {
    const calls: ModelCall[] = [];
    const { core, coast, writer: pairing, files } = await started(calls, { asItLands: false });
    const agent = await connectLegacyAgent(pairing.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);

    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(first).toMatchObject({ version: 1, status: "not-checked", why: FILE_WAITS });
    expect(first.mindId).not.toBeNull();
    const again = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(again).toMatchObject({ version: 1, status: "not-checked", why: FILE_WAITS });
    expect(calls).toEqual([]);

    // On, the same file's check starts as it did before this setting covered agents.
    await core.updateSettings({ user: { checkAssistantWrites: true } });
    const checked = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(checked.status).not.toBe("not-checked");
    expect(calls.length).toBeGreaterThan(0);
  });

  // protects=once a check of a handed-over file has run, at the User's asking, the file no longer reads as waiting, even where every claim came back as the writer's own view (#3576 review); fails_when=hand_over_file says the file still waits for its first check after one ran
  it("no longer says a handed-over file waits once a check of it ran", async () => {
    const { core, coast, writer: pairing, files } = await started([], { asItLands: false });
    for (const provider of await core.listChatProviders())
      await core.deleteChatProvider(provider.id);
    const agent = await connectLegacyAgent(pairing.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const given = structured<{ task: string; sentences: { n: number }[] }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: first.mindId } }),
    );
    structured(
      await agent.callTool({
        name: "report_check",
        arguments: {
          mindId: first.mindId,
          task: given.task,
          results: given.sentences.map(({ n }) => ({ n, verdict: "own view" })),
        },
      }),
    );
    const after = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(after.why).not.toBe(FILE_WAITS);
    expect(after.status).toBe("checked");
  });

  // protects=with no model and checking as it lands off, a handed-over file says only that it waits for the User, not to check it now (#3576); fails_when=the agent is told to check the file itself unasked
  it("with no model set up, says a handed-over file waits rather than to check it now", async () => {
    const { core, coast, writer: pairing, files } = await started([], { asItLands: false });
    for (const provider of await core.listChatProviders())
      await core.deleteChatProvider(provider.id);
    const agent = await connectLegacyAgent(pairing.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(path, DECK);
    expect(structured<Handed>(await handOver(agent, { path, folderId: coast.id }))).toMatchObject({
      status: "not-checked",
      why: FILE_WAITS,
    });
  });
});
