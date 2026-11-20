/**
 * Pictures and charts in a Note an outside agent writes (#3413), through the shim the app ships
 * with the MCP SDK's own client. A picture is a file it names by its full path, read in that call
 * alone by the reader of a Canvas's files, or one inline; its type is told by its bytes. A chart is
 * the assistant's form: a cited table with a ```chart block under it, drawn as the Note's chart with
 * each value's Citation. What can't be kept is one plain line in the Note, and the agent is told.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Pictures } from "../../src/core/adapters";
import { CHART_NODE, CITATION_NODE, PICTURE_NODE } from "../../src/core/api";
import { createCanvasFiles } from "../../src/main/canvasFiles";
import { readChart } from "../../src/shared/charts";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Written {
  mindId: string;
  version?: string;
  refused: { item: string; reason: string }[];
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

/** A PNG of one pixel: a file is told by its bytes, whatever its name says. */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>';
const base64 = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString(
    "base64",
  );

const HARVEST = [
  "# Harvest",
  "",
  "Linnet Valley picked 1,840 tonnes of apples in 2026.",
  "",
  "Pears came to 610 tonnes in 2026.",
].join("\n");

/** A core whose agent may write in "Orchard", which holds Harvest; `files` holds a chart.png. */
async function paired({
  language = "en" as "en" | "zh-CN",
  pictures = null as Pictures | null,
} = {}) {
  const kept = await createTempDataFolder();
  const started = await startAgentsCore(replyingModel(), {
    canvasFiles: createCanvasFiles(join(kept, "Canvases")),
    ...(pictures && { pictures }),
  });
  const { core } = started;
  if (language !== "en") await core.updateSettings({ user: { language } });
  const sources = await createSourceFolder();
  const [harvest] = await addAndProcess(core, [
    await writeSourceFile(sources, "Harvest.md", HARVEST),
  ]);
  if (!harvest) throw new Error("Harvest wasn't added.");
  const orchard = await core.createLibraryGroup({ name: "Orchard", description: "Fruit." });
  await core.assignDocumentGroup(harvest.id, orchard.id);
  await core.setAgentsEnabled(true);
  const { launch } = await core.connectAgent({
    name: "Claude Code",
    folderIds: [orchard.id],
    propose: true,
  });
  const agent = await connectLegacyAgent(launch);
  const files = await createSourceFolder();
  await writeFile(join(files, "chart.png"), PNG);
  return { ...started, core, agent, files, harvest };
}

/** A ready token for each of Harvest's two figures. */
async function tokens(agent: Agent): Promise<{ apples: string; pears: string }> {
  const { passages } = structured<{ passages: { passageId: string }[] }>(
    await agent.callTool({ name: "search", arguments: { query: "apples pears tonnes 2026" } }),
  );
  const { citations } = structured<{ citations: { cite: string | null }[] }>(
    await agent.callTool({
      name: "cite",
      arguments: {
        citations: [
          { passageId: passages[0]?.passageId, quote: "picked 1,840 tonnes of apples in 2026" },
          { passageId: passages[0]?.passageId, quote: "Pears came to 610 tonnes in 2026" },
        ],
      },
    }),
  );
  const [apples, pears] = citations.map((each) => each.cite);
  if (!apples || !pears) throw new Error("No Citations for the figures.");
  return { apples, pears };
}

const create = (agent: Agent, markdown: string) =>
  agent.callTool({ name: "create_mind", arguments: { title: "Harvest report", markdown } });

/** Each top-level Block as the editor's copy of the Note holds it. */
async function blocksOf(core: Parameters<typeof connectToMind>[0], mindId: string) {
  const client = await connectToMind(core, mindId);
  const found: { kind: string; text: string; attrs: Record<string, unknown> }[] = [];
  readMind(client).forEach((block) => {
    found.push({
      kind: block.type.name,
      text: block.textContent.replaceAll("⁠", ""),
      attrs: block.attrs,
    });
  });
  return found;
}

const table = (apples: string, pears: string) => [
  "| Fruit | 2026 (tonnes) |",
  "|---|---|",
  `| Apples | 1,840 ${apples} |`,
  `| Pears | 610 ${pears} |`,
];

describe("pictures and charts in a Note an outside agent writes (#3413)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("keeps a named file and an inline picture, typed by their bytes, and draws the chart under a cited table", async () => {
    const { core, agent, files, harvest } = await paired();
    const { apples, pears } = await tokens(agent);
    // A PNG named as a JPEG is a PNG.
    await writeFile(join(files, "photo.jpg"), PNG);
    const written = structured<Written & { uncited: string[] }>(
      await create(
        agent,
        [
          `Apples led the harvest ${apples}.`,
          "",
          `![Orchard map](${join(files, "chart.png")})`,
          "",
          `![Rows](${join(files, "photo.jpg")}) ![Drawn](data:image/svg+xml;utf8,${SVG})`,
          "",
          ...table(apples, pears),
          "",
          "```chart",
          '{"kind": "bar", "title": "Tonnes picked, 2026"}',
          "```",
        ].join("\n"),
      ),
    );
    expect(written.refused).toEqual([]);
    expect(written.uncited).toEqual([]);

    const blocks = await blocksOf(core, written.mindId);
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      PICTURE_NODE,
      PICTURE_NODE,
      PICTURE_NODE,
      "table",
      CHART_NODE,
    ]);
    const pictures = blocks.filter((block) => block.kind === PICTURE_NODE);
    expect(pictures.map((each) => [each.attrs.src, each.attrs.alt])).toEqual([
      [`data:image/png;base64,${base64(PNG)}`, "Orchard map"],
      [`data:image/png;base64,${base64(PNG)}`, "Rows"],
      [`data:image/svg+xml;base64,${base64(SVG)}`, "Drawn"],
    ]);

    const tableBlock = blocks.find((block) => block.kind === "table");
    const chart = readChart(blocks.find((block) => block.kind === CHART_NODE)?.attrs ?? {});
    expect(chart).toMatchObject({
      kind: "bar",
      title: "Tonnes picked, 2026",
      source: { kind: "table", blockId: tableBlock?.attrs.id },
    });
    expect(
      chart.data.rows.map((row) => [
        row.label,
        row.values[0]?.value,
        row.values[0]?.citation?.quote,
      ]),
    ).toEqual([
      ["Apples", 1840, "picked 1,840 tonnes of apples in 2026"],
      ["Pears", 610, "Pears came to 610 tonnes in 2026"],
    ]);
    expect(chart.data.rows.every((row) => row.values[0]?.citation?.documentId === harvest.id)).toBe(
      true,
    );

    // The agent reads its pictures back as pictures, without their data, and its chart.
    const { markdown } = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: written.mindId } }),
    );
    expect(markdown).toContain("![Orchard map](data:image/png;base64,…)");
    expect(markdown).toContain("![Drawn](data:image/svg+xml;base64,…)");
    expect(markdown).toContain("Tonnes picked, 2026");

    // The Note's check of its own gives the chart to judge as it gives a sentence.
    const task = structured<{ sentences: { text: string }[] }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: written.mindId } }),
    );
    expect(task.sentences.some((each) => each.text.includes("Tonnes picked, 2026"))).toBe(true);
  });

  it("refuses a link, a folder, a device, a missing, large or other file, an address and a picture in a sentence, each in one plain line", async () => {
    const { core, agent, files } = await paired();
    const secret = join(await createSourceFolder(), "secret.png");
    await writeFile(secret, PNG);
    await symlink(secret, join(files, "linked.png"));
    await mkdir(join(files, "folder.png"));
    await writeFile(join(files, "big.png"), new Uint8Array(1024 * 1024 + 1));
    await writeFile(join(files, "page.png"), "<p>a page</p>");
    const unreadable = [
      join(files, "linked.png"),
      join(files, "folder.png"),
      join(files, "nothing-here.png"),
      ...(process.platform === "win32" ? [] : ["/dev/zero"]),
    ];
    const written = structured<Written>(
      await create(
        agent,
        [
          ...unreadable.map((path) => `![](${path})`),
          `![](${join(files, "big.png")})`,
          `![](${join(files, "page.png")})`,
          "![Logo](https://example.com/logo.png)",
          "![](chart.png)",
          `The map ![Map](${join(files, "chart.png")}) shows the rows.`,
        ].join("\n\n"),
      ),
    );
    const reasons = Object.fromEntries(written.refused.map((each) => [each.item, each.reason]));
    // Nothing more of a path that can't be read is told: a link, a folder, a missing file and a
    // device read alike.
    for (const path of unreadable) {
      expect(reasons[path]).toBe(
        "its file can’t be read (a file named by its full path, never a link, a folder or a device)",
      );
    }
    expect(reasons[join(files, "big.png")]).toBe(
      "it is larger than 1 MB, the most a picture in a note may be",
    );
    expect(reasons[join(files, "page.png")]).toBe("it isn’t a PNG, JPEG, GIF, WebP or SVG picture");
    expect(reasons["https://example.com/logo.png"]).toMatch(
      /^a note loads nothing from the internet/,
    );
    expect(reasons["chart.png"]).toBe(
      "give it by its full path on this computer, or as a data: URL",
    );
    expect(reasons[join(files, "chart.png")]).toBe("a picture goes on a line of its own");

    const blocks = await blocksOf(core, written.mindId);
    expect(blocks.some((block) => block.kind === PICTURE_NODE)).toBe(false);
    const lines = blocks.filter((block) => block.kind === "paragraph").map((block) => block.text);
    expect(lines).toContain(
      "Picture “big.png” not added: it is larger than 1 MB, the most a picture in a note may be.",
    );
    expect(lines).toContain(
      "Picture “Logo” not added: a note loads nothing from the internet: give it as a file on this computer or as a data: URL.",
    );
    // A picture in a sentence keeps its alt text there.
    expect(lines).toContain("The map Map shows the rows.");
    expect(lines).toHaveLength(unreadable.length + 5);
  });

  it("draws no chart without a table right above it, nor from JSON it can't read, and says so in the Note", async () => {
    const { core, agent } = await paired({ language: "zh-CN" });
    const { apples, pears } = await tokens(agent);
    const written = structured<Written>(
      await create(
        agent,
        [
          "```chart",
          '{"kind": "bar", "title": "No table"}',
          "```",
          "",
          ...table(apples, pears),
          "",
          "```chart",
          '{"kind": "bubble"}',
          "```",
          "",
          ...table(apples, pears),
          "",
          "```chart",
          "kind: bar",
          "```",
          "",
          ...table(apples, pears),
          "",
          "```chart",
          '{"kind": "scatter", "title": "One series"}',
          "```",
        ].join("\n"),
      ),
    );
    expect(written.refused.map((each) => each.reason)).toEqual([
      "```chart 代码块要紧接在它所绘制的数据表格下方",
      "kind 应为 bar、line、pie 或 scatter",
      "```chart 代码块不是写明 kind 和 title 的 JSON",
      "散点图需要两列数字",
    ]);
    const blocks = await blocksOf(core, written.mindId);
    expect(blocks.some((block) => block.kind === CHART_NODE)).toBe(false);
    expect(blocks.filter((block) => block.text.startsWith("未绘制图表："))).toHaveLength(4);
    expect(blocks.filter((block) => block.kind === "table")).toHaveLength(3);
  });

  it("keeps a value whose token isn't this agent's in the chart, uncited and saying so", async () => {
    const { core, agent } = await paired();
    const { apples } = await tokens(agent);
    const written = structured<Written>(
      await create(
        agent,
        [...table(apples, "[cite:notmine1]"), "", "```chart", '{"title": "Tonnes"}', "```"].join(
          "\n",
        ),
      ),
    );
    expect(written.refused).toEqual([]);
    const blocks = await blocksOf(core, written.mindId);
    const chart = readChart(blocks.find((block) => block.kind === CHART_NODE)?.attrs ?? {});
    expect(chart.kind).toBe("bar");
    expect(chart.data.rows.map((row) => [row.values[0]?.shown, row.values[0]?.citation])).toEqual([
      ["1,840", expect.objectContaining({ quote: "picked 1,840 tonnes of apples in 2026" })],
      ["610", null],
    ]);
    // The table, as in text, says the quote wasn't found.
    expect(blocks.find((block) => block.kind === "table")?.text).toContain("610 [quote not found]");
  });

  it("adds a picture and a chart in a Note the agent wrote, and refuses one in a paragraph's rewrite", async () => {
    const { core, agent, files } = await paired();
    const { apples, pears } = await tokens(agent);
    const made = structured<Written>(await create(agent, `Apples led ${apples}.`));
    const read = structured<{ version: string; markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId, named: true } }),
    );
    const rewrite = refusal(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: made.mindId,
          version: read.version,
          changes: [{ paragraph: "¶1", text: `![Map](${join(files, "chart.png")})` }],
        },
      }),
    );
    expect(rewrite).toBe(
      "¶1 is rewritten in words alone: a picture or a chart goes in a paragraph of its own. Add it with ¶1+.",
    );
    const changed = structured<Written & { status: string }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: made.mindId,
          version: read.version,
          changes: [
            {
              paragraph: "¶1+",
              text: [
                `![Map](${join(files, "chart.png")})`,
                "",
                ...table(apples, pears),
                "",
                "```chart",
                '{"kind": "pie", "title": "Share of the harvest"}',
                "```",
              ].join("\n"),
            },
          ],
        },
      }),
    );
    expect(changed).toMatchObject({ status: "applied", refused: [] });
    // Read by name, the picture and the chart stand in their place, with no name to change.
    const { markdown } = changed as Written & { markdown: string };
    expect(markdown).toContain("\n\n![Map](data:image/png;base64,…)\n\n¶2 Fruit\n\n");
    expect(markdown).toContain("¶7 610 [cite:");
    expect(markdown).toMatch(/\n\n```chart\n\{"kind":"pie","title":"Share of the harvest"\}\n```$/);
    const blocks = await blocksOf(core, made.mindId);
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      PICTURE_NODE,
      "table",
      CHART_NODE,
    ]);
    expect(readChart(blocks.at(-1)?.attrs ?? {}).kind).toBe("pie");
  });

  it("exports to Word with its picture, an SVG drawn as a PNG, and its chart", async () => {
    const drawn: string[] = [];
    const pictures: Pictures = {
      async png(svg) {
        drawn.push(svg);
        return PNG;
      },
    };
    const { core, agent, files } = await paired({ pictures });
    const { apples, pears } = await tokens(agent);
    const written = structured<Written>(
      await create(
        agent,
        [
          `![Orchard map](${join(files, "chart.png")})`,
          "",
          `![Drawn](data:image/svg+xml;base64,${base64(SVG)})`,
          "",
          ...table(apples, pears),
          "",
          "```chart",
          '{"title": "Tonnes picked, 2026"}',
          "```",
        ].join("\n"),
      ),
    );
    const word = unzip((await core.exportMind(written.mindId, { format: "docx" })).data);
    const media = [...word.keys()].filter((name) => name.startsWith("word/media/"));
    // The file's picture, the SVG drawn as a PNG, and the chart's picture.
    expect(media).toHaveLength(3);
    expect(drawn[0]).toBe(SVG);
    expect(drawn[1]).toMatch(/^<svg /);
    const document = word.get("word/document.xml")?.toString("utf8") ?? "";
    expect(document).toContain('descr="Orchard map"');
    expect(document).toContain('descr="Bar chart: Tonnes picked, 2026"');
    const citations = readMind(await connectToMind(core, written.mindId));
    let cited = 0;
    citations.descendants((node) => {
      if (node.type.name === CITATION_NODE) cited++;
    });
    expect(cited).toBe(2);
  });
});
