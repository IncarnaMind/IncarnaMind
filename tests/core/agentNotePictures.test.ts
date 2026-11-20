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
import { CHART_NODE, CITATION_NODE, PICTURE_NODE, PROPOSAL_ATTRIBUTE } from "../../src/core/api";
import { createCanvasFiles } from "../../src/main/canvasFiles";
import { readNoteState } from "../../src/renderer/src/noteState";
import { chartPoints, readChart } from "../../src/shared/charts";
import { checkRows } from "../../src/shared/noteHealth";
import { decideProposals, waitingChanges } from "../../src/shared/proposals";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { editMind, heading, note, readMind, writeMind } from "../helpers/minds";
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

/** The app's drawer of SVG pictures as a fake: the SVGs it was given, each drawn as `PNG`. */
function drawer(): Pictures & { drawn: string[] } {
  const drawn: string[] = [];
  return {
    drawn,
    async png(svg) {
      drawn.push(svg);
      return PNG;
    },
  };
}

/**
 * A core whose agent may write in "Orchard", which holds Harvest; `files` holds a chart.png.
 * `pictures`: the drawer of SVGs, none with null.
 */
async function paired({
  language = "en" as "en" | "zh-CN",
  pictures = drawer() as Pictures | null,
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
  return { ...started, core, agent, files, harvest, orchard };
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
      [`data:image/png;base64,${base64(PNG)}`, "Drawn"],
    ]);
    // A drawn SVG keeps the size it was drawn at; a file's picture is drawn at its own.
    expect(pictures.at(-1)?.attrs).toMatchObject({ width: 1, height: 1 });

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

    // The agent reads its pictures back as pictures, without their data, and its chart as it
    // wrote it: the table once, and the chart block under it (#3465).
    const { markdown } = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: written.mindId } }),
    );
    expect(markdown).toContain("![Orchard map](shown in the Note; its data is left out here)");
    expect(markdown).toContain("![Drawn](shown in the Note; its data is left out here)");
    expect(markdown).not.toContain("data:");
    expect(markdown).toMatch(
      /\| Pears \| 610\[\^\d+\] \|\n\n```chart\n\{"kind":"bar","title":"Tonnes picked, 2026"\}\n```\n/,
    );
    expect(markdown.match(/\| Apples \|/g)).toHaveLength(1);

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
      "¶1 is rewritten in words alone: a picture, a chart or a tab goes in a paragraph of its own. Add it with ¶1+.",
    );
    const changed = structured<Written & { status: string; markdown: string }>(
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
    // Read by name, the picture and the chart stand in their place, each named as a paragraph is.
    const { markdown } = changed;
    expect(markdown).toContain(
      "\n\n¶2 ![Map](shown in the Note; its data is left out here)\n\n¶3 Fruit\n\n",
    );
    expect(markdown).toContain("¶8 610 [cite:");
    expect(markdown).toMatch(
      /\n\n¶9 ```chart\n\{"kind":"pie","title":"Share of the harvest"\}\n```$/,
    );
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

  it("charts a table already in the Note from a chart block added after its last cell", async () => {
    const { core, agent } = await paired();
    const { apples, pears } = await tokens(agent);
    const made = structured<Written>(
      await create(agent, [`Apples led ${apples}.`, "", ...table(apples, pears)].join("\n")),
    );
    const read = structured<{ version: string; markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId, named: true } }),
    );
    const last = /(¶\d+) 610 \[cite:/.exec(read.markdown)?.[1];
    const changed = structured<Written>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: made.mindId,
          version: read.version,
          changes: [{ paragraph: `${last}+`, text: '```chart\n{"title": "Tonnes"}\n```' }],
        },
      }),
    );
    expect(changed.refused).toEqual([]);
    const blocks = await blocksOf(core, made.mindId);
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "table",
      CHART_NODE,
    ]);
    const chart = readChart(blocks[3]?.attrs ?? {});
    expect(chart.source).toEqual({ kind: "table", blockId: blocks[2]?.attrs.id });
    expect(chart.data.rows.map((row) => row.values[0]?.citation?.quote)).toEqual([
      "picked 1,840 tonnes of apples in 2026",
      "Pears came to 610 tonnes in 2026",
    ]);
  });

  it("says how to write a table it can't chart: each figure alone in its cell, with its token", async () => {
    const { agent } = await paired();
    const { apples, pears } = await tokens(agent);
    const written = structured<Written>(
      await create(
        agent,
        [
          "| Fruit | 2026 (tonnes) |",
          "|---|---|",
          `| Apples | 1,840 | ${apples}`,
          `| Pears | 610 | ${pears}`,
          "",
          "```chart",
          '{"title": "Tonnes"}',
          "```",
        ].join("\n"),
      ),
    );
    expect(written.refused.map((each) => each.reason)).toEqual([
      "its table holds no column of figures: put each figure alone in its cell, with its token",
    ]);
  });

  it("keeps an SVG that holds a script as a PNG drawn from it, and with nothing to draw it, says so", async () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" onload="fetch(\'https://example.com/\')">',
      "<script>document.title = 'ran';</script>",
      '<foreignObject width="40" height="20"><iframe src="https://example.com/"></iframe></foreignObject>',
      '<rect width="40" height="20" fill="teal"/></svg>',
    ].join("");
    const markdown = `![Drawn](data:image/svg+xml;base64,${base64(svg)})`;
    const pictures = drawer();
    const { core, agent } = await paired({ pictures });
    const written = structured<Written>(await create(agent, markdown));
    expect(written.refused).toEqual([]);
    expect(pictures.drawn).toEqual([svg]);
    const blocks = await blocksOf(core, written.mindId);
    expect(blocks.find((block) => block.kind === PICTURE_NODE)?.attrs.src).toBe(
      `data:image/png;base64,${base64(PNG)}`,
    );
    // Nothing of the SVG is in the Note: not its script, its handler or its markup, as text or data.
    const kept = JSON.stringify(blocks);
    for (const word of ["svg", "script", "onload", "foreignObject", base64(svg).slice(0, 40)]) {
      expect(kept).not.toContain(word);
    }

    const none = await paired({ pictures: null });
    const refused = structured<Written>(await create(none.agent, markdown));
    expect(refused.refused.map((each) => each.reason)).toEqual([
      "its SVG couldn’t be drawn as a picture",
    ]);
    const lines = await blocksOf(none.core, refused.mindId);
    expect(lines.some((block) => block.kind === PICTURE_NODE)).toBe(false);
    expect(lines.map((block) => block.text)).toContain(
      "Picture “Drawn” not added: its SVG couldn’t be drawn as a picture.",
    );
  });

  it("exports to Word with its pictures, the SVG one kept as a PNG, and its chart", async () => {
    const pictures = drawer();
    const { drawn } = pictures;
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
    // The file's picture, the SVG's PNG, and the chart drawn for Word.
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

/** Each chart's values as shown, by row. */
const chartShown = (blocks: Awaited<ReturnType<typeof blocksOf>>) =>
  blocks
    .filter((block) => block.kind === CHART_NODE)
    .map((block) => chartPoints(readChart(block.attrs)).map(({ value }) => value.shown));

describe("an agent replaces or removes a picture or chart by its name (#3429)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("names each picture and chart, and redraws a chart from its table as the same call corrects it", async () => {
    const { core, agent, files } = await paired();
    const { apples, pears } = await tokens(agent);
    const wrong = [
      "| Fruit | 2026 (tonnes) |",
      "|---|---|",
      `| Apples | 1,840 ${apples} |`,
      `| Pears | 710 ${pears} |`,
    ];
    const made = structured<Written>(
      await create(
        agent,
        [
          `Apples led ${apples}.`,
          "",
          `![Map](${join(files, "chart.png")})`,
          "",
          ...wrong,
          "",
          "```chart",
          '{"kind": "bar", "title": "Tonnes"}',
          "```",
        ].join("\n"),
      ),
    );
    expect(chartShown(await blocksOf(core, made.mindId))).toEqual([["1,840", "710"]]);
    const read = structured<{ version: string; markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId, named: true } }),
    );
    expect(read.markdown).toContain(
      "\n\n¶2 ![Map](shown in the Note; its data is left out here)\n\n",
    );
    const cell = /(¶\d+) 710 (\[cite:[^\]]+\])/.exec(read.markdown);
    const chart = /(¶\d+) ```chart\n/.exec(read.markdown)?.[1];
    expect(chart).toBe("¶9");
    const changed = structured<{ status: string; markdown: string }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: made.mindId,
          version: read.version,
          changes: [
            { paragraph: cell?.[1], text: `610 ${cell?.[2]}` },
            { paragraph: chart, text: '```chart\n{"kind": "bar", "title": "Tonnes"}\n```' },
          ],
        },
      }),
    );
    expect(changed.status).toBe("applied");
    const blocks = await blocksOf(core, made.mindId);
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      PICTURE_NODE,
      "table",
      CHART_NODE,
    ]);
    // The one chart there is drawn anew from the corrected table, its table kept by id.
    expect(chartShown(blocks)).toEqual([["1,840", "610"]]);
    expect(readChart(blocks[4]?.attrs ?? {}).source).toEqual({
      kind: "table",
      blockId: blocks[3]?.attrs.id,
    });
    expect(changed.markdown).toMatch(/¶9 ```chart\n\{"kind":"bar","title":"Tonnes"\}\n```$/);
  });

  it("refuses a change on a reading from before the User put another file in a picture", async () => {
    const { core, agent, orchard } = await paired();
    const mind = await core.createMind({ title: "Field notes", folderId: orchard.id });
    const client = await connectToMind(core, mind.id);
    const picture = (src: string) => ({
      type: PICTURE_NODE,
      attrs: { id: "map", src, alt: "Map" },
    });
    writeMind(client, [
      heading(1, "Field notes"),
      note("The map of the orchard."),
      picture(`data:image/png;base64,${base64(PNG)}`),
    ]);
    await client.settled();
    const read = structured<{ version: string; markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    // The same picture by its id and alt, another file in it: the line read is the same.
    writeMind(client, [
      heading(1, "Field notes"),
      note("The map of the orchard."),
      picture(`data:image/svg+xml;base64,${base64(SVG)}`),
    ]);
    await client.settled();
    const again = structured<{ version: string; markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    expect(again.markdown.replace("svg+xml", "png")).toBe(read.markdown);
    expect(again.version).not.toBe(read.version);
    expect(
      refusal(
        await agent.callTool({
          name: "propose_changes",
          arguments: {
            mindId: mind.id,
            version: read.version,
            changes: [{ paragraph: "¶2", remove: true }],
          },
        }),
      ),
    ).toBe(
      "The User changed this note after you read it. Read it again with named, then make your changes again.",
    );
  });

  it("in the User's Note, a picture swapped for another file waits as one change, and so does one taken out", async () => {
    const { core, agent, files, orchard } = await paired();
    const mind = await core.createMind({ title: "Field notes", folderId: orchard.id });
    const client = await connectToMind(core, mind.id);
    const inline = `data:image/svg+xml;base64,${base64(SVG)}`;
    writeMind(client, [
      heading(1, "Field notes"),
      note("The old map of the orchard."),
      {
        type: PICTURE_NODE,
        attrs: { id: "old-map", src: `data:image/png;base64,${base64(PNG)}`, alt: "Old map" },
      },
      note("The packhouse."),
      { type: PICTURE_NODE, attrs: { id: "packhouse", src: inline, alt: "Packhouse" } },
    ]);
    await client.settled();
    const read = structured<{ version: string; markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    expect(read.markdown.split("\n\n")).toEqual([
      "¶0 # Field notes",
      "¶1 The old map of the orchard.",
      "¶2 ![Old map](shown in the Note; its data is left out here)",
      "¶3 The packhouse.",
      "¶4 ![Packhouse](shown in the Note; its data is left out here)",
    ]);
    const proposed = structured<{ status: string; waiting: number; markdown: string }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: read.version,
          changes: [
            { paragraph: "¶2", text: `![New map](${join(files, "chart.png")})` },
            { paragraph: "¶4", remove: true },
          ],
        },
      }),
    );
    expect(proposed).toMatchObject({ status: "waiting", waiting: 2 });
    // Waiting, the Note reads as it is, each picture marked as waiting.
    expect(proposed.markdown).toContain("¶2");
    expect(proposed.markdown).not.toContain("New map");

    const pictures = () =>
      client.blocks
        .toArray()
        .filter((block) => block.toString().startsWith("<picture"))
        .map((block) => {
          const element = block as unknown as {
            getAttribute(name: string): unknown;
          };
          return {
            alt: element.getAttribute("alt"),
            proposal:
              (element.getAttribute(PROPOSAL_ATTRIBUTE) as
                | { id: string; kind: string }
                | undefined) ?? null,
          };
        });
    await client.settled();
    const [old, fresh, packhouse] = pictures();
    expect([old?.alt, fresh?.alt, packhouse?.alt]).toEqual(["Old map", "New map", "Packhouse"]);
    expect([old?.proposal?.kind, fresh?.proposal?.kind]).toEqual(["delete", "insert"]);
    expect(old?.proposal?.id).toBe(fresh?.proposal?.id);
    expect(packhouse?.proposal?.kind).toBe("delete");

    const swap = old?.proposal?.id;
    client.doc.transact(() => {
      decideProposals(client.blocks, (each) => each.id === swap, "accept");
    }, "user");
    await client.settled();
    expect(pictures().map((each) => each.alt)).toEqual(["New map", "Packhouse"]);
    client.doc.transact(() => {
      decideProposals(client.blocks, () => true, "reject");
    }, "user");
    await client.settled();
    expect(waitingChanges(client.blocks)).toBe(0);
    expect(pictures().map((each) => [each.alt, each.proposal])).toEqual([
      ["New map", null],
      ["Packhouse", null],
    ]);
  });

  it("draws a chart again from its table when the agent corrects only the table", async () => {
    const { core, agent } = await paired();
    const { apples, pears } = await tokens(agent);
    const wrong = [
      "| Fruit | 2026 (tonnes) |",
      "|---|---|",
      `| Apples | 1,840 ${apples} |`,
      `| Pears | 710 ${pears} |`,
    ];
    const made = structured<Written>(
      await create(
        agent,
        [...wrong, "", "```chart", '{"kind": "pie", "title": "Tonnes"}', "```"].join("\n"),
      ),
    );
    const read = structured<{ version: string; markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId, named: true } }),
    );
    const cell = /(¶\d+) 710 (\[cite:[^\]]+\])/.exec(read.markdown);
    structured(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: made.mindId,
          version: read.version,
          changes: [{ paragraph: cell?.[1], text: `610 ${cell?.[2]}` }],
        },
      }),
    );
    const blocks = await blocksOf(core, made.mindId);
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "table", CHART_NODE]);
    expect(chartShown(blocks)).toEqual([["1,840", "610"]]);
    // As Update draws it: its kind and title stay.
    expect(readChart(blocks[2]?.attrs ?? {})).toMatchObject({ kind: "pie", title: "Tonnes" });
  });

  it("keeps a chart it can't draw anew as it was, and says why", async () => {
    const { core, agent } = await paired();
    const { apples, pears } = await tokens(agent);
    const made = structured<Written>(
      await create(
        agent,
        [...table(apples, pears), "", "```chart", '{"title": "Tonnes"}', "```"].join("\n"),
      ),
    );
    const read = structured<{ version: string; markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId, named: true } }),
    );
    const chart = /(¶\d+) ```chart\n/.exec(read.markdown)?.[1] ?? "";
    const refused = refusal(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: made.mindId,
          version: read.version,
          changes: [
            { paragraph: chart, text: '```chart\n{"kind": "radar", "title": "Tonnes"}\n```' },
          ],
        },
      }),
    );
    expect(refused).toBe(
      `${chart} is kept as it is. Chart not drawn: its kind is bar, line, pie or scatter.`,
    );
    expect(chartShown(await blocksOf(core, made.mindId))).toEqual([["1,840", "610"]]);
  });
});

interface CheckTask {
  task: string;
  how: string;
  sentences: { n: number; text: string }[];
  checked?: Record<string, unknown>;
}

/** The rows of the Note's check card, as its page counts them, by how many each holds. */
async function pageRows(core: Parameters<typeof connectToMind>[0], mindId: string) {
  const client = await connectToMind(core, mindId);
  await client.settled();
  const { health } = readNoteState({
    doc: client.doc,
    cellFigures: [],
    footing: [],
    documents: await core.listDocuments(),
    keptCitationTexts: [],
    folderId: null,
  });
  return Object.fromEntries(checkRows(health).map(({ row, places }) => [row, places.length]));
}

describe("an agent reads its Note as the User sees it, and its check and the Note count alike (#3465)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  const written = (files: string, apples: string, pears: string) =>
    [
      `Apples led the harvest ${apples}.`,
      "",
      `![Orchard map](${join(files, "chart.png")})`,
      "",
      // A header cell of words enough to read as a sentence, as the walk's were.
      "| Fruit | Picked in 2026 (tonnes) |",
      "|---|---|",
      `| Apples | 1,840 ${apples} |`,
      `| Pears | 610 ${pears} |`,
      "",
      "```chart",
      '{"kind": "bar", "title": "Tonnes picked, 2026"}',
      "```",
    ].join("\n");
  const FENCE = '```chart\n{"kind":"bar","title":"Tonnes picked, 2026"}\n```';

  // protects=an agent asked whether its Note is right reads a chart as a chart and a picture as a picture, in either reading, so it never tells the User the Note holds a duplicated table or a broken picture; fails_when=a reading shows a chart's values as a second table under a table that holds them, or a picture as a data: link cut short
  it("reads a chart as the chart block under its table, and a picture without its data, in both readings", async () => {
    const { core, agent, files } = await paired();
    const { apples, pears } = await tokens(agent);
    const made = structured<Written>(await create(agent, written(files, apples, pears)));
    const read = async (named?: boolean) =>
      structured<{ markdown: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId: made.mindId, named } }),
      ).markdown;

    const whole = await read();
    expect(whole).toContain(
      "![Orchard map](shown in the Note; its data is left out here)\n\n| Fruit | Picked in 2026 (tonnes) |",
    );
    expect(whole).toMatch(/\| Pears \| 610\[\^\d+\] \|\n\n```chart\n/);
    expect(whole).toContain(`${FENCE}\n`);
    expect(whole.match(/\| Apples \|/g)).toHaveLength(1);
    expect(whole).not.toContain("data:");
    const named = await read(true);
    expect(named).toContain("¶2 ![Orchard map](shown in the Note; its data is left out here)\n\n");
    expect(named).toMatch(/¶\d+ ```chart\n\{"kind":"bar","title":"Tonnes picked, 2026"\}\n```/);

    // With its table gone, the chart's values are nowhere else in the Note: they come with it.
    const client = await connectToMind(core, made.mindId);
    await client.settled();
    editMind(client, (blocks) => blocks.filter((block) => block.type !== "table"));
    await client.settled();
    const alone = await read();
    expect(alone).toContain(
      `| Fruit | Picked in 2026 (tonnes) |\n| --- | ---: |\n| Apples | 1,840 |\n| Pears | 610 |\n\n${FENCE}\n\n`,
    );
    expect(alone.match(/\| Apples \|/g)).toHaveLength(1);
  });

  // protects=the Note's "not checked yet" clears once the agent's check has judged every sentence it was given, and a later chat asking whether the Note is right gets its results rather than an empty list; fails_when=a header cell or a chart the check's model found nothing to check in stays counted, a value cell's figure is left out because a check called it nothing to check, or a check with nothing left says nothing of the results
  it("counts as not checked yet just what the agent's check gives, and with none left gives the Note's results", async () => {
    const { core, agent, files } = await paired();
    const { apples, pears } = await tokens(agent);
    const made = structured<Written>(await create(agent, written(files, apples, pears)));
    const task = async () =>
      structured<CheckTask>(
        await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: made.mindId } }),
      );
    const report = async (given: string, results: unknown[]) =>
      structured<{ marked: number; unconfirmed: number[]; next: string | null }>(
        await agent.callTool({
          name: "report_check",
          arguments: { mindId: made.mindId, task: given, results },
        }),
      );

    const given = await task();
    // A header cell names its column: the check gives none, and the Note counts none (#2378).
    const texts = given.sentences.map((each) => each.text);
    expect(texts.slice(0, 5)).toEqual([
      "Apples led the harvest .",
      "Apples",
      "1,840",
      "Pears",
      "610",
    ]);
    expect(texts).toHaveLength(6);
    expect(texts[5]).toMatch(/^\{"kind":"bar","title":"Tonnes picked, 2026"/);
    expect(await pageRows(core, made.mindId)).toMatchObject({ toCheck: 4 });

    // As a real agent judged them: the row labels and the chart nothing to check, and a figure too.
    const byText = (text: string) => given.sentences.find((each) => each.text === text)?.n;
    const first = await report(given.task, [
      { n: byText("Apples led the harvest ."), verdict: "supported", cites: [apples] },
      { n: byText("Apples"), verdict: "nothing to check" },
      { n: byText("1,840"), verdict: "supported", cites: [apples] },
      { n: byText("Pears"), verdict: "nothing to check" },
      { n: byText("610"), verdict: "nothing to check" },
      { n: 6, verdict: "nothing to check" },
    ]);
    // A value cell's figure is checked whatever a check calls it: it is given again.
    expect(first).toMatchObject({ marked: 2, unconfirmed: [byText("610")] });
    expect(first.next).not.toBeNull();
    expect(await pageRows(core, made.mindId)).toMatchObject({ toCheck: 1 });
    const again = await task();
    expect(again.sentences).toEqual([
      { n: 1, text: "610", row: "Pears", column: "Picked in 2026 (tonnes)" },
    ]);
    expect(
      await report(again.task, [{ n: 1, verdict: "supported", cites: [pears] }]),
    ).toMatchObject({ marked: 1, unconfirmed: [], next: null });
    expect(await pageRows(core, made.mindId)).not.toHaveProperty("toCheck");

    // A later chat asking whether it's right learns it is checked, with what the Note's page shows.
    const done = await task();
    expect(done.sentences).toEqual([]);
    expect(done.how).toBe(
      "Nothing is left to check: every sentence of this note that needs a result has one already, and checked gives them as the note’s page counts them. Answer the User from those; there is nothing to hand to report_check.",
    );
    const rows = await pageRows(core, made.mindId);
    expect(done.checked).toMatchObject({
      supported: rows.supported,
      needLook: 0,
      notChecked: 0,
      claims: [],
    });
    expect(rows.supported).toBe(3);
  });

  // protects=a chart the agent finds supported shows checked on the Note, as one IncarnaMind's own check marked, so the Note's count clears and the check doesn't give it again; fails_when=the chart keeps counting as not checked yet once the agent's result is in
  it("marks a chart the agent judges on each of its values, as the Note shows a checked chart", async () => {
    const { core, agent, files } = await paired();
    const { apples, pears } = await tokens(agent);
    const made = structured<Written>(await create(agent, written(files, apples, pears)));
    const given = structured<CheckTask>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: made.mindId } }),
    );
    const results = given.sentences.map(({ n, text }) =>
      text === "Apples" || text === "Pears"
        ? { n, verdict: "nothing to check" }
        : { n, verdict: "supported", cites: text === "610" ? [pears] : [apples, pears] },
    );
    expect(
      structured<{ marked: number }>(
        await agent.callTool({
          name: "report_check",
          arguments: { mindId: made.mindId, task: given.task, results },
        }),
      ),
    ).toMatchObject({ marked: 4, unconfirmed: [], next: null });
    expect(await pageRows(core, made.mindId)).toEqual({ supported: 4 });
    expect(
      structured<CheckTask>(
        await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: made.mindId } }),
      ).sentences,
    ).toEqual([]);
  });

  // protects=an agent that reads on from a Citation it holds gets its Passage, so it never spends a dozen refused calls on it; fails_when=a [cite:…] token, bracketed or bare, given as a passageId is refused, or one of another agent's or none reads anything
  it("reads the Passage a Citation's token stands for, given where a passageId goes", async () => {
    const { agent } = await paired();
    const { apples } = await tokens(agent);
    const read = (passageId: string) =>
      agent.callTool({ name: "read_passages", arguments: { passageId } });
    for (const given of [apples, apples.slice("[cite:".length, -1)]) {
      const { passages } = structured<{ passages: { text: string }[] }>(await read(given));
      expect(passages[0]?.text).toContain("1,840 tonnes of apples");
    }
    expect(refusal(await read("[cite:zzzzzzzz]"))).toBe(
      "No such passage, Document, note or Citation in the Folders shared with this agent.",
    );
  });
});
