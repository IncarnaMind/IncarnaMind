/**
 * Canvases an outside agent publishes (#3406), through the shim the app ships with the MCP SDK's own
 * client, as Claude Code or Codex call it: it publishes only where it may write, reads and updates
 * what it reaches, and an update built on an older version is refused with the newest. The files a
 * version uses are read from the paths named in that call alone, and any other agent outside its
 * reach can't list, read or update it, nor learn it is there.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Core } from "../../src/core";
import type { CanvasFiles } from "../../src/core/adapters";
import { NOT_IN_A_FOLDER_ID } from "../../src/core/api";
import { createCanvasFiles } from "../../src/main/canvasFiles";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { replyingModel } from "../helpers/models";

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Published {
  canvasId: string;
  title: string;
  folder: string;
  version: number;
  files: string[];
  refused: { item: string; reason: string }[];
}

interface Read {
  canvasId: string;
  title: string;
  version: number;
  html: string;
  offset: number;
  nextOffset: number | null;
  files: { name: string; type: string; size: number }[];
}

interface Listed {
  folders: { id: string; canvases?: { id: string; title: string; version: number }[] }[];
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

/** A PNG's first bytes: what the file is told by, whatever its name says. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PAGE = '<!doctype html><title>Tides</title><img src="chart.png"><p>Spring tides.</p>';

/**
 * A core with "Coast" and "Finance", each with a Document; "Claude Code" may write in Coast and in
 * no Folder, "Codex" may read Finance alone. `files`: a folder of files an agent can name.
 */
async function twoAgents({ waits }: { waits?: Waits } = {}) {
  const kept = await createTempDataFolder();
  const keptFiles = createCanvasFiles(join(kept, "Canvases"));
  const canvasFiles: CanvasFiles = waits
    ? {
        ...keptFiles,
        readNamed: async (path, maxBytes) => {
          await waits.reading?.();
          return keptFiles.readNamed(path, maxBytes);
        },
        read: async (hash) => {
          await waits.keptRead?.();
          return keptFiles.read(hash);
        },
      }
    : keptFiles;
  const started = await startAgentsCore(replyingModel(), { canvasFiles });
  const { core } = started;
  const sources = await createSourceFolder();
  const [tides, budget] = await addAndProcess(core, [
    await writeSourceFile(sources, "Tides.md", "# Tides\n\nSpring tides come twice a month.\n"),
    await writeSourceFile(sources, "Budget.md", "# Budget\n\nDredging costs 4 million.\n"),
  ]);
  if (!tides || !budget) throw new Error("The Documents weren't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.assignDocumentGroup(budget.id, finance.id);
  await core.setAgentsEnabled(true);
  const writer = await core.connectAgent({
    name: "Claude Code",
    folderIds: [coast.id, NOT_IN_A_FOLDER_ID],
    propose: true,
  });
  const reader = await core.connectAgent({ name: "Codex", folderIds: [finance.id] });
  const files = await createSourceFolder();
  await writeFile(join(files, "chart.png"), PNG);
  return { ...started, core, coast, finance, writer, reader, files };
}

/** Heard as the Canvas files are read: what a test does meanwhile. */
interface Waits {
  /** A file the agent named. */
  reading?: () => Promise<void>;
  /** What a Canvas keeps: its HTML and files. */
  keptRead?: () => Promise<void>;
}

/** A promise to hold a step at, and how to let it go. */
function gate() {
  let open = () => {};
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached = () => {};
  const at = new Promise<void>((resolve) => {
    reached = resolve;
  });
  return { shut, open: () => open(), at, reached: () => reached() };
}

const publish = (agent: Agent, args: Record<string, unknown>) =>
  agent.callTool({ name: "publish_canvas", arguments: args });

describe("Canvases an outside agent publishes", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("are published in a Folder it may write in, read back and updated on the version read", async () => {
    const { core, coast, writer, files } = await twoAgents();
    const agent = await connectLegacyAgent(writer.launch);
    const changed: string[] = [];
    core.on("agents.canvasChanged", (change) => changed.push(`${change.kind} ${change.version}`));

    const published = structured<Published>(
      await publish(agent, {
        title: "Tide report",
        html: PAGE,
        files: [join(files, "chart.png")],
        folderId: coast.id,
      }),
    );
    expect(published).toMatchObject({
      title: "Tide report",
      folder: "Coast",
      version: 1,
      files: ["chart.png"],
      refused: [],
    });
    expect(await core.listCanvases()).toEqual([
      expect.objectContaining({
        id: published.canvasId,
        title: "Tide report",
        folderId: coast.id,
        agent: "Claude Code",
        version: 1,
      }),
    ]);

    const read = structured<Read>(
      await agent.callTool({ name: "read_canvas", arguments: { canvasId: published.canvasId } }),
    );
    expect(read).toMatchObject({ version: 1, html: PAGE, nextOffset: null });
    expect(read.files).toEqual([{ name: "chart.png", type: "image/png", size: PNG.byteLength }]);

    const updated = structured<Published>(
      await agent.callTool({
        name: "update_canvas",
        arguments: { canvasId: published.canvasId, version: 1, html: `${PAGE}<p>Neap tides.</p>` },
      }),
    );
    // The file it named before stays: only what an update names changes.
    expect(updated).toMatchObject({ version: 2, files: ["chart.png"], refused: [] });
    const stale = refusal(
      await agent.callTool({
        name: "update_canvas",
        arguments: { canvasId: published.canvasId, version: 1, title: "Tides" },
      }),
    );
    expect(stale).toBe(
      "This Canvas is at version 2 now, not 1. Read it with read_canvas and build on that version.",
    );
    expect(changed).toEqual(["published 1", "updated 2"]);

    const listed = structured<Listed>(await agent.callTool({ name: "list_minds", arguments: {} }));
    expect(listed.folders.find((folder) => folder.id === coast.id)?.canvases).toEqual([
      expect.objectContaining({ id: published.canvasId, title: "Tide report", version: 2 }),
    ]);
  });

  it("are drawn only at an address minted for a showing, with only their own version's files", async () => {
    const { core, writer, files } = await twoAgents();
    const agent = await connectLegacyAgent(writer.launch);
    const { canvasId } = structured<Published>(
      await publish(agent, { title: "Tides", html: PAGE, files: [join(files, "chart.png")] }),
    );
    const { url, version } = await core.showCanvas(canvasId);
    expect(version).toBe(1);
    const host = new URL(url).hostname;
    expect(host).toMatch(/^[0-9a-f]{32}$/);
    expect(core.canvasShowing(host)).toBe(canvasId);
    expect(core.canvasShowing("0".repeat(32))).toBeNull();

    const page = await core.serveCanvas(host, "/");
    expect(new TextDecoder().decode(page?.bytes)).toBe(PAGE);
    expect(page?.type).toBe("text/html; charset=utf-8");
    expect((await core.serveCanvas(host, "/chart.png"))?.type).toBe("image/png");
    for (const path of ["/../chart.png", "/%2e%2e/incarnamind.db", "/missing.png", "/%E0%A4%A"]) {
      expect(await core.serveCanvas(host, path)).toBeNull();
    }
    // Another showing of the same Canvas has an address of its own.
    expect((await core.showCanvas(canvasId)).url).not.toBe(url);
  });

  it("read only the paths named, and refuse a link, a folder, a device and a file too large in one line each", async () => {
    const { writer, files } = await twoAgents();
    const agent = await connectLegacyAgent(writer.launch);
    const secret = join(await createSourceFolder(), "secret.png");
    await writeFile(secret, PNG);
    await symlink(secret, join(files, "linked.png"));
    await mkdir(join(files, "folder.png"));
    await writeFile(join(files, "big.png"), new Uint8Array(10 * 1024 * 1024 + 1));
    await writeFile(join(files, "notes.html"), "<p>another page</p>");
    const named = [
      join(files, "linked.png"),
      join(files, "folder.png"),
      join(files, "nothing-here.png"),
      join(files, "big.png"),
      join(files, "notes.html"),
      "chart.png",
      ...(process.platform === "win32" ? [] : ["/dev/zero"]),
    ];

    const published = structured<Published>(
      await publish(agent, {
        title: "Tides",
        html: `${PAGE}<link rel="stylesheet" href="https://fonts.example/a.css">`,
        files: named,
      }),
    );
    expect(published.files).toEqual([]);
    const reasons = Object.fromEntries(published.refused.map((each) => [each.item, each.reason]));
    // Nothing more of a path that can't be read is told: a link, a folder, a missing file and a
    // device read alike.
    for (const path of [
      join(files, "linked.png"),
      join(files, "folder.png"),
      join(files, "nothing-here.png"),
      "chart.png",
      ...(process.platform === "win32" ? [] : ["/dev/zero"]),
    ]) {
      expect(reasons[path]).toBe("can’t be read");
    }
    expect(reasons[join(files, "big.png")]).toBe("is larger than 10 MB, the most one file may be");
    expect(reasons[join(files, "notes.html")]).toBe(
      "isn’t a picture, a font, a style sheet, a script or a data file (CSV, JSON or text)",
    );
    expect(reasons["https://fonts.example/a.css"]).toMatch(/^is on the network/);
  });

  it("are out of reach of another agent, which can't list, read or update them, nor tell they are there", async () => {
    const { coast, writer, reader } = await twoAgents();
    const agent = await connectLegacyAgent(writer.launch);
    const other = await connectLegacyAgent(reader.launch);
    const inCoast = structured<Published>(
      await publish(agent, { title: "Coast", html: PAGE, folderId: coast.id }),
    );
    const unfiled = structured<Published>(
      await publish(agent, { title: "Mine", html: PAGE, folderId: NOT_IN_A_FOLDER_ID }),
    );
    expect(unfiled.folder).toBe("");

    const listed = structured<Listed>(await other.callTool({ name: "list_minds", arguments: {} }));
    expect(listed.folders.flatMap((folder) => folder.canvases ?? [])).toEqual([]);
    const unknown = "00000000-0000-4000-8000-000000000000";
    for (const canvasId of [inCoast.canvasId, unfiled.canvasId, unknown]) {
      // What it names is no Canvas it reaches, and the User has more than it was given (#3544).
      expect(refusal(await other.callTool({ name: "read_canvas", arguments: { canvasId } }))).toBe(
        `No such Canvas in the Folders shared with this agent. ${translate("en", "agents.notShared")}`,
      );
    }
    // It may only read, so it publishes nowhere and updates nothing.
    expect(refusal(await publish(other, { title: "Mine", html: PAGE }))).toMatch(/may only read/);
    expect(
      refusal(
        await other.callTool({
          name: "update_canvas",
          arguments: { canvasId: inCoast.canvasId, version: 1, html: PAGE },
        }),
      ),
    ).toMatch(/may only read/);
  });

  it("in a Folder inside a shared one are shared with it, unless that Folder keeps its work inside", async () => {
    const { core, coast } = await twoAgents();
    const engineering = await core.createLibraryGroup({
      name: "Engineering",
      description: "",
      parentId: coast.id,
    });
    const legal = await core.createLibraryGroup({
      name: "Legal",
      description: "",
      parentId: coast.id,
      keepInside: true,
    });
    const inside = await core.connectAgent({
      name: "Cursor",
      folderIds: [engineering.id],
      propose: true,
    });
    const walledIn = await core.connectAgent({ name: "Zed", folderIds: [legal.id], propose: true });
    const inner = structured<Published>(
      await publish(await connectLegacyAgent(inside.launch), {
        title: "Pumps",
        html: PAGE,
        folderId: engineering.id,
      }),
    );
    const walled = structured<Published>(
      await publish(await connectLegacyAgent(walledIn.launch), {
        title: "Leases",
        html: PAGE,
        folderId: legal.id,
      }),
    );

    const coastOnly = await core.connectAgent({ name: "Windsurf", folderIds: [coast.id] });
    const reader = await connectLegacyAgent(coastOnly.launch);
    const listed = structured<Listed>(await reader.callTool({ name: "list_minds", arguments: {} }));
    const canvases = listed.folders.flatMap((folder) => folder.canvases ?? []);
    expect(canvases.map((canvas) => canvas.title)).toEqual(["Pumps"]);
    expect(
      structured<Read>(
        await reader.callTool({ name: "read_canvas", arguments: { canvasId: inner.canvasId } }),
      ).html,
    ).toBe(PAGE);
    expect(
      refusal(
        await reader.callTool({ name: "read_canvas", arguments: { canvasId: walled.canvasId } }),
      ),
    ).toContain("No such Canvas");
  });

  it("cite with the tokens IncarnaMind gave the agent: each a marker that opens its own Citation alone", async () => {
    const { core, coast, writer } = await twoAgents();
    const agent = await connectLegacyAgent(writer.launch);
    const found = structured<{ passages: { passageId: string }[] }>(
      await agent.callTool({ name: "search", arguments: { query: "spring tides twice a month" } }),
    );
    const { citations } = structured<{ citations: { cite: string | null }[] }>(
      await agent.callTool({
        name: "cite",
        arguments: {
          citations: [
            { passageId: found.passages[0]?.passageId, quote: "Spring tides come twice a month." },
          ],
        },
      }),
    );
    const cite = citations[0]?.cite ?? "";
    expect(cite).toMatch(/^\[cite:[a-z0-9]+\]$/);
    const token = cite.slice(6, -1);
    const html = `<p>Spring tides come twice a month ${cite}.</p><p>Made up [cite:zz999999].</p>`;
    const published = structured<Published & { citations: { cite: string; found: boolean }[] }>(
      await publish(agent, { title: "Tides", html, folderId: coast.id }),
    );
    expect(published.citations).toEqual([
      { cite, found: true },
      { cite: "[cite:zz999999]", found: false },
    ]);

    const { url } = await core.showCanvas(published.canvasId);
    const host = new URL(url).hostname;
    const page = new TextDecoder().decode((await core.serveCanvas(host, "/"))?.bytes);
    expect(page).toContain(`data-token="${token}">[1]</incarnamind-cite>`);
    expect(page).toContain("Citation 1: Tides");
    expect(page).toContain(">[citation not found]</incarnamind-cite>");
    expect(page).not.toContain("[cite:");
    // Read back, the agent gets its own text, tokens and all.
    expect(
      structured<Read>(
        await agent.callTool({ name: "read_canvas", arguments: { canvasId: published.canvasId } }),
      ).html,
    ).toBe(html);

    expect(await core.canvasCitation(url, token)).toMatchObject({
      quote: expect.stringContaining("Spring tides"),
      check: "found",
      number: 1,
    });
    expect(await core.canvasCitation(url, "zz999999")).toBeNull();
    // A token of another Canvas, or an address minted for none, opens nothing here.
    const other = structured<Published>(
      await publish(agent, { title: "Other", html: "<p>None.</p>", folderId: coast.id }),
    );
    expect(
      await core.canvasCitation((await core.showCanvas(other.canvasId)).url, token),
    ).toBeNull();
    expect(await core.canvasCitation(`incarnamind-canvas://${"0".repeat(32)}/`, token)).toBeNull();
  });

  it("keep every version, and the User brings an earlier one back as a version of its own", async () => {
    const { core, coast, writer } = await twoAgents();
    const agent = await connectLegacyAgent(writer.launch);
    const { canvasId } = structured<Published>(
      await publish(agent, { title: "Tides", html: "<p>First.</p>", folderId: coast.id }),
    );
    structured<Published>(
      await agent.callTool({
        name: "update_canvas",
        arguments: { canvasId, version: 1, html: "<p>Second.</p>", title: "Tides, shorter" },
      }),
    );
    expect(await core.listCanvasVersions(canvasId)).toEqual([
      expect.objectContaining({ number: 2, title: "Tides, shorter", agent: "Claude Code" }),
      expect.objectContaining({
        number: 1,
        title: "Tides",
        agent: "Claude Code",
        restoredFrom: null,
      }),
    ]);
    const first = await core.showCanvas(canvasId, 1);
    expect(first.version).toBe(1);
    const shown = await core.serveCanvas(new URL(first.url).hostname, "/");
    expect(new TextDecoder().decode(shown?.bytes)).toBe("<p>First.</p>");

    const restored = await core.restoreCanvasVersion(canvasId, 1);
    expect(restored).toMatchObject({ version: 3, title: "Tides" });
    expect((await core.listCanvasVersions(canvasId))[0]).toMatchObject({
      number: 3,
      agent: null,
      restoredFrom: 1,
    });
    // The agent reads what the User brought back, and builds on it.
    expect(
      structured<Read>(await agent.callTool({ name: "read_canvas", arguments: { canvasId } })),
    ).toMatchObject({ version: 3, html: "<p>First.</p>" });
    await expect(core.restoreCanvasVersion(canvasId, 9)).rejects.toThrow();
  });

  it("are refused with a plain line where they can't be kept, and past the HTML's limit", async () => {
    const started = await startAgentsCore(replyingModel());
    const core: Core = started.core;
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: [NOT_IN_A_FOLDER_ID],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);
    expect(refusal(await publish(agent, { title: "Tides", html: PAGE }))).toBe(
      "This copy of IncarnaMind can’t keep Canvases.",
    );
    expect(
      refusal(await publish(agent, { title: "Tides", html: "x".repeat(2 * 1024 * 1024 + 1) })),
    ).toMatch(/^The page is larger than 2 MB without its inline pictures, or 25 MB with them:/);
    // A picture inline counts toward the Canvas's whole size, not its page's.
    const picture = `<img src="data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}">`;
    expect(refusal(await publish(agent, { title: "Tides", html: picture }))).toBe(
      "This copy of IncarnaMind can’t keep Canvases.",
    );
  });
});

describe("a Canvas call that waits while the User changes what the agent may do (#3406)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a Canvas is published only while its agent may still write: a grant the User took back while its files were read publishes nothing; fails_when=publish_canvas writes the Canvas with the grant it had before its files were read
  it("publishes nothing once the write grant is taken back while its files are read", async () => {
    const held = gate();
    let holding = true;
    const { core, coast, writer, files } = await twoAgents({
      waits: {
        reading: async () => {
          if (!holding) return;
          held.reached();
          await held.shut;
        },
      },
    });
    const agent = await connectLegacyAgent(writer.launch);
    const asked = publish(agent, {
      title: "Tide report",
      html: PAGE,
      files: [join(files, "chart.png")],
      folderId: coast.id,
    });
    await held.at;
    await core.updateAgent(writer.pairing.id, { propose: false });
    holding = false;
    held.open();
    expect(refusal(await asked)).toBe(translate("en", "agents.problem.read-only"));
    expect(await core.listCanvases()).toEqual([]);
  });

  // protects=a Canvas's next version is written only while its agent still reaches the Canvas: one whose Folder the User took away while the files were read gets no version; fails_when=update_canvas adds the version with the grant it had before its files were read
  it("adds no version once the Canvas's Folder is taken away while its files are read", async () => {
    const held = gate();
    let holding = false;
    const { core, coast, writer, files } = await twoAgents({
      waits: {
        reading: async () => {
          if (!holding) return;
          held.reached();
          await held.shut;
        },
      },
    });
    const agent = await connectLegacyAgent(writer.launch);
    const { canvasId } = structured<Published>(
      await publish(agent, { title: "Tide report", html: PAGE, folderId: coast.id }),
    );
    holding = true;
    const asked = agent.callTool({
      name: "update_canvas",
      arguments: { canvasId, version: 1, files: [join(files, "chart.png")] },
    });
    await held.at;
    await core.updateAgent(writer.pairing.id, { folderIds: [NOT_IN_A_FOLDER_ID] });
    holding = false;
    held.open();
    expect(refusal(await asked)).toBe(
      `${translate("en", "agents.canvas.notFound")} ${translate("en", "agents.notShared")}`,
    );
    expect((await core.listCanvases()).map((each) => each.version)).toEqual([1]);
  });

  // protects=a Canvas's HTML is given only while its agent still reaches the Canvas once it is read: one whose Folder the User took away meanwhile gives nothing back; fails_when=read_canvas returns the HTML with the reach the agent had before the version was read
  it("gives back no HTML once the Canvas's Folder is taken away while it is read", async () => {
    const held = gate();
    let holding = false;
    const { core, coast, writer } = await twoAgents({
      waits: {
        keptRead: async () => {
          if (!holding) return;
          held.reached();
          await held.shut;
        },
      },
    });
    const agent = await connectLegacyAgent(writer.launch);
    const { canvasId } = structured<Published>(
      await publish(agent, { title: "Tide report", html: PAGE, folderId: coast.id }),
    );
    holding = true;
    const asked = agent.callTool({ name: "read_canvas", arguments: { canvasId } });
    await held.at;
    await core.updateAgent(writer.pairing.id, { folderIds: [NOT_IN_A_FOLDER_ID] });
    holding = false;
    held.open();
    expect(refusal(await asked)).toBe(translate("en", "agents.problem.reachChanged"));
  });
});
