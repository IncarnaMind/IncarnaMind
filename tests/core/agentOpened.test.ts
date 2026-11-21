/**
 * What an outside agent makes opens in IncarnaMind (#3534): a Note it writes, the Note a file it
 * hands over lives in, and a Canvas it publishes. The app comes to the front with it only when the
 * User asked that agent from IncarnaMind and it read the request in this connection; an agent the
 * User works with on its own never pulls the app to the front by itself.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentOpened } from "../../src/core/api";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { type Handed, handOver, started, structured } from "../helpers/handedFiles";
import { plainDeck } from "../helpers/pptx";

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

/** Each of the three makes one thing, and the events they announce, in the order the agent made them. */
async function makeAll(agent: Agent, files: string, folderId: string, name: string) {
  const note = structured<{ mindId: string }>(
    await agent.callTool({
      name: "create_mind",
      arguments: { title: `${name} note`, markdown: "The harbour opens at six." },
    }),
  );
  const path = join(files, `${name} review.pptx`);
  await writeFile(path, plainDeck([{ title: name }, { lines: [`${name} sails at six.`] }]));
  const handed = structured<Handed>(await handOver(agent, { path, folderId }));
  const canvas = structured<{ canvasId: string }>(
    await agent.callTool({
      name: "publish_canvas",
      arguments: { title: `${name} tides`, html: "<p>Tides</p>" },
    }),
  );
  return [
    { kind: "mind", mindId: note.mindId },
    { kind: "mind", mindId: handed.mindId ?? "" },
    { kind: "canvas", canvasId: canvas.canvasId },
  ] satisfies AgentOpened["item"][];
}

describe("what an outside agent makes, opened in IncarnaMind", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=each of the three makes opens, and none takes the front, for an agent the User works with on its own; fails_when=one of them isn't announced, or one is announced to come to the front
  it("opens a Note, a file's Note and a Canvas, and keeps the app where it is, with no request read", async () => {
    const { core, coast, writer, files } = await started();
    const opened: AgentOpened[] = [];
    core.on("agents.opened", (each) => opened.push(each));
    const agent = await connectLegacyAgent(writer.launch);
    const made = await makeAll(agent, files, coast.id, "Alone");
    expect(opened).toEqual(made.map((item) => ({ item, front: false })));
  });

  // protects=an agent that read the request the User made from IncarnaMind is shown to the front with what it makes, in that connection only; looking for a request when none waits doesn't count; fails_when=another connection of the same agent comes to the front, or one that only looked
  it("comes to the front with what an agent makes after it read the User's request, in that connection only", async () => {
    const { core, coast, writer, files } = await started();
    const note = await core.createMind({ title: "Harbour report", folderId: coast.id });
    const opened: AgentOpened[] = [];
    core.on("agents.opened", (each) => opened.push(each));
    const asked = await connectLegacyAgent(writer.launch);
    const looking = await connectLegacyAgent(writer.launch);

    // Nothing waits yet: looking finds none, and what it makes after doesn't come forward.
    expect((await looking.callTool({ name: "read_request", arguments: {} })).isError ?? false).toBe(
      false,
    );
    const before = await makeAll(looking, files, coast.id, "Looking");
    expect(opened.map((each) => each.front)).toEqual([false, false, false]);
    opened.length = 0;

    await core.askAgent({ pairingId: writer.pairing.id, mindId: note.id, ask: { kind: "note" } });
    const read = await asked.callTool({ name: "read_request", arguments: {} });
    expect(read.isError ?? false).toBe(false);
    const after = await makeAll(asked, files, coast.id, "Asked");
    expect(opened).toEqual(after.map((item) => ({ item, front: true })));
    opened.length = 0;

    // Another connection of the same agent, which read nothing: behind, as before.
    const other = await makeAll(looking, files, coast.id, "Other");
    expect(opened).toEqual(other.map((item) => ({ item, front: false })));
    expect(before).toHaveLength(3);
  });
});
