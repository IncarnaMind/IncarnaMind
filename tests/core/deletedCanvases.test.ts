/**
 * A Canvas an outside agent published (#3406) is deleted and restored as a Note is: it waits in
 * Recently deleted, its tabs closed and out of every agent's reach, and comes back where it was
 * with its versions. Its Folder's deletion takes it to no Folder, where only the pairing that
 * published it reaches it, given Not in a Folder, and the Folder's restore puts it back. Deleted
 * permanently, by the User or after 30 days, it loses its versions and the files in the data folder
 * that no other Canvas keeps.
 */
import { createHash } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { WindowLayout } from "../../src/core";
import type { CanvasFiles } from "../../src/core/adapters";
import { NOT_IN_A_FOLDER_ID } from "../../src/core/api";
import { createCanvasFiles } from "../../src/main/canvasFiles";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent, resultText, startAgentsCore } from "../helpers/agents";
import { createTempDataFolder, manualClock, queryDatabase, startCore } from "../helpers/core";
import { createSourceFolder } from "../helpers/documents";
import { replyingModel } from "../helpers/models";

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

const DAY = 24 * 60 * 60 * 1000;
const NOT_REACHED = "No such Canvas in the Folders shared with this agent.";

/** A PNG's first bytes: what the file is told by, whatever its name says. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PAGE = '<!doctype html><title>Tides</title><img src="chart.png"><p>Spring tides.</p>';
const NEAP = `${PAGE}<p>Neap tides.</p>`;
const FERRY = `${PAGE}<p>Ferry times.</p>`;

function canvasIdOf(result: unknown): string {
  const { isError, structuredContent } = result as {
    isError?: boolean;
    structuredContent?: { canvasId?: string };
  };
  expect(isError ?? false, resultText(result)).toBe(false);
  return structuredContent?.canvasId ?? "";
}

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The files kept in the data folder's Canvases/, by the hash each is kept under. */
async function keptFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

const tabsOf = (layout: WindowLayout) =>
  layout.groups.flatMap((group) => group.tabs.map((tab) => tab.item));

/**
 * A core keeping Canvases in a folder of their own, through `kept` around the app's own, with
 * "Coast"; `connect` pairs an agent.
 */
async function started(clock = manualClock(), kept = (files: CanvasFiles) => files) {
  const canvasFiles = join(await createTempDataFolder(), "Canvases");
  const { core, dataDir } = await startAgentsCore(replyingModel(), {
    canvasFiles: kept(createCanvasFiles(canvasFiles)),
    now: clock.now,
  });
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  await core.setAgentsEnabled(true);
  const connect = async (name: string, folderIds: string[], propose = true) =>
    connectLegacyAgent((await core.connectAgent({ name, folderIds, propose })).launch);
  const files = await createSourceFolder();
  const chart = join(files, "chart.png");
  await writeFile(chart, PNG);
  const publish = async (agent: Agent, args: Record<string, unknown>) =>
    canvasIdOf(await agent.callTool({ name: "publish_canvas", arguments: args }));
  return { core, dataDir, coast, connect, chart, canvasFiles, clock, publish };
}

const reads = async (agent: Agent, canvasId: string) => {
  const result = await agent.callTool({ name: "read_canvas", arguments: { canvasId } });
  return result.isError ? resultText(result) : "read";
};

describe("A Canvas deleted", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("waits in Recently deleted, its tabs closed and out of every agent's reach, and comes back where it was with its versions", async () => {
    const { core, coast, connect, chart, publish } = await started();
    const agent = await connect("Claude Code", [coast.id]);
    const canvasId = await publish(agent, {
      title: "Tide report",
      html: PAGE,
      files: [chart],
      folderId: coast.id,
    });
    canvasIdOf(
      await agent.callTool({
        name: "update_canvas",
        arguments: { canvasId, version: 1, html: NEAP },
      }),
    );
    await core.changeLayout("main", { type: "open", item: { kind: "canvas", canvasId } });
    const host = new URL((await core.showCanvas(canvasId)).url).hostname;

    await core.deleteCanvas(canvasId);

    expect(await core.listCanvases()).toEqual([]);
    const listed = await core.listDeleted();
    expect(listed).toEqual([
      expect.objectContaining({
        kind: "canvas",
        id: canvasId,
        name: "Tide report",
        groupId: coast.id,
      }),
    ]);
    expect(tabsOf(await core.getLayout("main"))).toEqual([]);
    expect(await core.serveCanvas(host, "/")).toBeNull();
    expect(await reads(agent, canvasId)).toBe(NOT_REACHED);
    const update = await agent.callTool({
      name: "update_canvas",
      arguments: { canvasId, version: 2, title: "Tides" },
    });
    expect(resultText(update)).toBe(NOT_REACHED);
    await expect(core.deleteCanvas(canvasId)).rejects.toThrow(
      "That Canvas doesn’t exist or has been deleted.",
    );

    // As Undo of the delete restores it: its tab comes back too.
    await core.restore([{ kind: "canvas", id: canvasId }], { reopen: true });

    expect(await core.listCanvases()).toEqual([
      expect.objectContaining({ id: canvasId, folderId: coast.id, version: 2 }),
    ]);
    expect((await core.listCanvasVersions(canvasId)).map((each) => each.number)).toEqual([2, 1]);
    expect(tabsOf(await core.getLayout("main"))).toEqual([{ kind: "canvas", canvasId }]);
    expect(await reads(agent, canvasId)).toBe("read");
    expect(await core.listDeleted()).toEqual([]);

    // Undo of the Restore: back in Recently deleted, as it was.
    const [waiting] = listed;
    if (!waiting) throw new Error("Nothing was listed.");
    await core.deleteAgain([{ kind: "canvas", id: canvasId, deletedAt: waiting.deletedAt }]);
    expect(await core.listDeleted()).toEqual(listed);
    expect(tabsOf(await core.getLayout("main"))).toEqual([]);
  });

  it("with its Folder goes to no Folder, out of the reach of agents that reached the Folder, and back in it with the Folder's restore", async () => {
    const { core, coast, connect, publish, clock } = await started();
    const writer = await connect("Claude Code", [coast.id, NOT_IN_A_FOLDER_ID]);
    const coastOnly = await connect("Codex", [coast.id]);
    const reader = await connect("Cursor", [coast.id], false);
    const mine = await publish(writer, { title: "Tide report", html: PAGE, folderId: coast.id });
    const theirs = await publish(coastOnly, { title: "Ferry", html: FERRY, folderId: coast.id });
    const early = await publish(writer, { title: "Old tides", html: NEAP, folderId: coast.id });
    const everyone = [writer, coastOnly, reader];
    for (const agent of everyone) {
      for (const canvasId of [mine, theirs]) expect(await reads(agent, canvasId)).toBe("read");
    }
    await core.deleteCanvas(early);
    clock.advance(1000);

    await core.deleteLibraryGroup(coast.id);

    expect((await core.listCanvases()).map((canvas) => [canvas.id, canvas.folderId])).toEqual(
      expect.arrayContaining([
        [mine, null],
        [theirs, null],
      ]),
    );
    // Deleted before its Folder, it still says the Folder it was in.
    expect((await core.listDeleted()).map((item) => [item.kind, item.id, item.groupId])).toEqual([
      ["folder", coast.id, null],
      ["canvas", early, coast.id],
    ]);
    // As a Note an agent wrote: in no Folder, only the pairing that published it reaches it, and
    // only when it was given Not in a Folder.
    expect(await reads(writer, mine)).toBe("read");
    expect(await reads(writer, theirs)).toBe(NOT_REACHED);
    expect(await reads(coastOnly, theirs)).toBe(NOT_REACHED);
    for (const canvasId of [mine, theirs]) expect(await reads(reader, canvasId)).toBe(NOT_REACHED);

    await core.restore([{ kind: "folder", id: coast.id }]);
    await core.restore([{ kind: "canvas", id: early }]);

    expect(
      (await core.listCanvases()).map((canvas) => canvas.folderId).every((id) => id === coast.id),
    ).toBe(true);
    expect(await core.listCanvases()).toHaveLength(3);
    for (const agent of everyone) {
      for (const canvasId of [mine, theirs, early]) {
        expect(await reads(agent, canvasId)).toBe("read");
      }
    }
  });

  it("permanently loses its versions and the files no other Canvas keeps, and a file another Canvas uses stays", async () => {
    const { core, dataDir, connect, chart, canvasFiles, publish } = await started();
    const agent = await connect("Claude Code", [NOT_IN_A_FOLDER_ID]);
    const gone = await publish(agent, { title: "Tide report", html: PAGE, files: [chart] });
    canvasIdOf(
      await agent.callTool({
        name: "update_canvas",
        arguments: { canvasId: gone, version: 1, html: NEAP },
      }),
    );
    const kept = await publish(agent, { title: "Ferry", html: FERRY, files: [chart] });
    const everyFile = [sha256(PAGE), sha256(NEAP), sha256(FERRY), sha256(PNG)].sort();
    expect(await keptFiles(canvasFiles)).toEqual(everyFile);

    await core.deleteCanvas(gone);
    // While it waits, nothing of it goes.
    expect(await keptFiles(canvasFiles)).toEqual(everyFile);
    await core.deletePermanently([{ kind: "canvas", id: gone }]);

    expect(await keptFiles(canvasFiles)).toEqual([sha256(FERRY), sha256(PNG)].sort());
    expect(
      queryDatabase(dataDir, "SELECT 1 FROM canvas_versions WHERE canvas_id = ?", [gone]),
    ).toEqual([]);
    expect(
      queryDatabase(dataDir, "SELECT purged_at IS NOT NULL AS purged FROM canvases WHERE id = ?", [
        gone,
      ]),
    ).toEqual([{ purged: 1 }]);
    expect(await core.listDeleted()).toEqual([]);
    await expect(core.restore([{ kind: "canvas", id: gone }])).rejects.toThrow(
      "“Tide report” was deleted permanently, so it can’t be restored.",
    );
    // Coast, which this agent wasn't given, is more than it reaches (#3544).
    expect(await reads(agent, gone)).toBe(`${NOT_REACHED} ${translate("en", "agents.notShared")}`);
    // The other is drawn whole, its picture too.
    const host = new URL((await core.showCanvas(kept)).url).hostname;
    expect((await core.serveCanvas(host, "/chart.png"))?.type).toBe("image/png");
  });

  it("permanently, while a Canvas with the same file is published, leaves that file to it", async () => {
    const chartHash = sha256(PNG);
    let held: Promise<void> | null = null;
    let letGo = () => {};
    // The chart's removal ends only once the new publish has read its own copy of the chart.
    const { core, connect, chart, publish } = await started(undefined, (real) => ({
      ...real,
      async remove(hash) {
        if (hash === chartHash && held) await held;
        await real.remove(hash);
      },
      async readNamed(path, maxBytes) {
        const read = await real.readNamed(path, maxBytes);
        if (held) setTimeout(letGo, 50);
        return read;
      },
    }));
    const agent = await connect("Claude Code", [NOT_IN_A_FOLDER_ID]);
    const gone = await publish(agent, { title: "Tide report", html: PAGE, files: [chart] });
    await core.deleteCanvas(gone);
    held = new Promise((resolve) => {
      letGo = resolve;
    });

    const purged = core.deletePermanently([{ kind: "canvas", id: gone }]);
    const again = await publish(agent, { title: "Tides again", html: FERRY, files: [chart] });
    await purged;

    const host = new URL((await core.showCanvas(again)).url).hostname;
    expect((await core.serveCanvas(host, "/chart.png"))?.type).toBe("image/png");
  });

  it("30 days ago is deleted permanently at the next start, with its files", async () => {
    const clock = manualClock();
    const { core, dataDir, connect, canvasFiles, publish } = await started(clock);
    const agent = await connect("Claude Code", [NOT_IN_A_FOLDER_ID]);
    const old = await publish(agent, { title: "Old", html: PAGE });
    const recent = await publish(agent, { title: "Recent", html: FERRY });
    await core.deleteCanvas(old);
    clock.advance(25 * DAY);
    await core.deleteCanvas(recent);
    await agent.close();
    core.close();

    clock.advance(6 * DAY);
    const reopened = startCore(dataDir, {
      now: clock.now,
      canvasFiles: createCanvasFiles(canvasFiles),
    });

    await vi.waitFor(async () => expect(await keptFiles(canvasFiles)).toEqual([sha256(FERRY)]));
    await expect(reopened.restore([{ kind: "canvas", id: old }])).rejects.toThrow(
      "“Old” was deleted permanently, so it can’t be restored.",
    );
    await reopened.restore([{ kind: "canvas", id: recent }]);
    expect((await reopened.listCanvases()).map((canvas) => canvas.id)).toEqual([recent]);
  });
});
