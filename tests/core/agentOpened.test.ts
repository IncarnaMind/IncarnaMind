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
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { type Handed, handOver, refusal, started, structured } from "../helpers/handedFiles";
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

  // protects=asked to open again what it made, an agent shows a Note, a handed-over file and a Canvas by their ids in front, as it shows a Citation, so the User gets back to it from any client; a file's id shows its newest version; nothing changes (#3534); fails_when=one of them isn't shown, comes up behind, a file shows an older version, or showing writes anything
  it("shows again, in front, a Note, a handed-over file's newest version and a Canvas by their ids, changing nothing", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const note = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Harbour note", markdown: "The harbour opens at six." },
      }),
    );
    const path = join(files, "Harbour review.pptx");
    await writeFile(
      path,
      plainDeck([{ title: "Harbour" }, { lines: ["The ferry sails at six."] }]),
    );
    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    await writeFile(
      path,
      plainDeck([{ title: "Harbour" }, { lines: ["The ferry sails at seven."] }]),
    );
    const second = structured<Handed>(await handOver(agent, { path }));
    expect(second.mindId).not.toBe(first.mindId);
    const canvas = structured<{ canvasId: string }>(
      await agent.callTool({
        name: "publish_canvas",
        arguments: { title: "Harbour tides", html: "<p>Tides</p>" },
      }),
    );
    const minds = await core.listMinds();
    const canvases = await core.listCanvases();
    const opened: AgentOpened[] = [];
    core.on("agents.opened", (each) => opened.push(each));

    const shown = [
      await agent.callTool({ name: "show_citation", arguments: { note: note.mindId } }),
      await agent.callTool({ name: "show_citation", arguments: { file: first.fileId } }),
      await agent.callTool({ name: "show_citation", arguments: { canvas: canvas.canvasId } }),
    ].map((result) => structured<{ shown: true; document: string }>(result));

    expect(shown.map((each) => each.document)).toEqual([
      "Harbour note",
      expect.stringContaining("Harbour review"),
      "Harbour tides",
    ]);
    expect(opened).toEqual([
      { item: { kind: "mind", mindId: note.mindId }, front: true },
      { item: { kind: "mind", mindId: second.mindId }, front: true },
      { item: { kind: "canvas", canvasId: canvas.canvasId }, front: true },
    ]);
    expect(await core.listMinds()).toEqual(minds);
    expect(await core.listCanvases()).toEqual(canvases);
  });

  // protects=showing again reveals nothing the connection may not read: an id that isn't there, a deleted Note, a Note in a Folder the agent wasn't given, and one kind's id passed as another all show nothing and are not found (#3534); fails_when=any of them opens a window, or its refusal says whether the item exists
  it("shows nothing for an id that isn't there, was deleted, isn't shared with the agent, or is of another kind", async () => {
    const { core, coast, writer, more } = await started([], { folders: ["Private"] });
    const agent = await connectLegacyAgent(writer.launch);
    const canvas = structured<{ canvasId: string }>(
      await agent.callTool({
        name: "publish_canvas",
        arguments: { title: "Harbour tides", html: "<p>Tides</p>", folderId: coast.id },
      }),
    );
    const gone = await core.createMind({ title: "Old harbour note", folderId: coast.id });
    await core.deleteMind(gone.id);
    await core.updateAgent(writer.pairing.id, { folderIds: [coast.id] });
    const hidden = await core.createMind({ title: "Pay review", folderId: more[0]?.id ?? null });
    const opened: AgentOpened[] = [];
    core.on("agents.opened", (each) => opened.push(each));
    const refused: string[] = [];
    for (const args of [
      { note: crypto.randomUUID() },
      { note: gone.id },
      { note: hidden.id },
      { note: canvas.canvasId },
      { file: crypto.randomUUID() },
    ]) {
      refused.push(refusal(await agent.callTool({ name: "show_citation", arguments: args })));
    }
    // One refusal for all, so none says whether the item is there.
    expect(refused[0]?.startsWith(translate("en", "agents.problem.not-found"))).toBe(true);
    expect(new Set(refused).size).toBe(1);
    expect(
      refusal(await agent.callTool({ name: "show_citation", arguments: { canvas: hidden.id } })),
    ).toContain(translate("en", "agents.canvas.notFound"));
    expect(opened).toEqual([]);
  });
});
