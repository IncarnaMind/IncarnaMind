/**
 * A Word file IncarnaMind writes for an outside agent (#3751), through the shim the app ships with
 * the MCP SDK's own client, as Claude Code calls it: one `save_as_word` call with a Note, or with
 * the agent's Markdown and its Citation tokens, gives a .docx written by Export › Word with its
 * Citations as footnotes, saved in the Output location as Export › Word saves one, and kept in the
 * Library as a file the agent hands over is. It holds nothing the agent couldn't read already.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import { inspectPackage } from "../../eval/word/corpus";
import type { Core } from "../../src/core";
import type { Pictures } from "../../src/core/adapters";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { MIND_COMMENTS_FIELD, MIND_WORD_FIELD } from "../../src/core/api";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { NotFoundError } from "../../src/core/errors";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { noAnalysisOutput } from "../../src/shared/analysis";
import { optionsFor } from "../../src/shared/exportOptions";
import { translate } from "../../src/shared/i18n";
import { LIBRARY_FACTS } from "../../src/shared/libraryFacts";
import { addSignOff } from "../../src/shared/signOffs";
import {
  buildAgentShim,
  connectLegacyAgent,
  type RecordedMeeting,
  startMeetingAgentsCore,
} from "../helpers/agents";
import { askAssistant } from "../helpers/assistant";
import { checkGenerate } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { sortReply } from "../helpers/claimSentences";
import { NO_MODEL_FILES, type TestAdapters, tickingClock } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { footnotesOf, paragraphsOf, part, unzip } from "../helpers/docx";
import {
  type Agent,
  gate,
  type Handed,
  handOver,
  NORTH,
  OFFICE,
  refusal,
  SOUTH,
  started,
  structured,
} from "../helpers/handedFiles";
import { connectToMind } from "../helpers/mindClient";
import { readMind, resolveChanges, writeMind } from "../helpers/minds";
import { type GenerateCall, type ModelCall, scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

interface Saved extends Handed {
  citations: { cite: string; check: string; document: string | null }[];
  refused: { item: string; reason: string }[];
  saved: string | null;
  notSaved: string | null;
}

const SOUTH_TRUE = "The south quay holds 19 boats.";
const UNSHARED = {
  en: "This note cites a Document in a Folder that isn’t shared with you, so IncarnaMind won’t write it into a Word file for you. Ask the User to share that Folder with you, or to export the note to Word themselves.",
  "zh-CN":
    "这篇笔记引用了一个没有与你共享的文件夹中的文档，因此 IncarnaMind 不会替你把它写成 Word 文件。请用户把那个文件夹共享给你，或者自己把这篇笔记导出为 Word。",
} as const;

/** A PNG of one pixel. */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** The app's drawer of SVG pictures as a fake: each chart drawn as `PNG`. */
const drawer: Pictures = { png: async () => PNG };

const save = (agent: Agent, args: Record<string, unknown>) =>
  agent.callTool({ name: "save_as_word", arguments: args });

/** A token for `quote`, cited from the first Passage a search for `query` finds that holds it. */
async function token(agent: Agent, query: string, quote: string): Promise<string> {
  const { passages } = structured<{ passages: { passageId: string }[] }>(
    await agent.callTool({ name: "search", arguments: { query } }),
  );
  const { citations } = structured<{ citations: { cite: string | null }[] }>(
    await agent.callTool({
      name: "cite",
      arguments: { citations: passages.map(({ passageId }) => ({ passageId, quote })) },
    }),
  );
  const cite = citations.find((each) => each.cite !== null)?.cite;
  if (!cite) throw new Error(`No Citation for “${quote}”.`);
  return cite;
}

/** A Word file's parts: its body's paragraphs, its footnotes, and all of its text. */
function partsOf(bytes: Uint8Array) {
  const files = unzip(bytes);
  return {
    files,
    body: paragraphsOf(part(files, "word/document.xml")),
    footnotes: Object.values(footnotesOf(part(files, "word/footnotes.xml"))),
    all: [...files.values()].map((each) => each.toString("utf8")).join("\n"),
  };
}

/** The Library's Word file of the hand-over: its Document's own file, as kept. */
async function wordFileOf(core: Core, saved: Saved) {
  const handed = await core.handedFileOf(saved.mindId ?? "");
  const document = (await core.listDocuments()).find((each) => each.id === handed?.file.documentId);
  if (!handed || !document) throw new Error("The Word file isn't in the Library.");
  const bytes = new Uint8Array(readFileSync(document.path));
  return { handed, document, bytes, ...partsOf(bytes) };
}

/** The file saved where Export › Word saves one, at the path the result gave. */
function savedFile(saved: Saved) {
  if (!saved.saved) throw new Error(`The Word file wasn't saved: ${saved.notSaved}`);
  return new Uint8Array(readFileSync(saved.saved));
}

/** Every part but the file's dates: what the words, pictures and footnotes are written as. */
const bodyParts = (files: Map<string, Buffer>) =>
  Object.fromEntries(
    [...files]
      .filter(([name]) => !name.startsWith("docProps/"))
      .map(([name, bytes]) => [name, bytes.toString("base64")]),
  );

/** Export › Word's choices of the User's, without what an agent's file never holds. */
async function agentChoices(core: Core) {
  return {
    ...optionsFor("docx", (await core.getSettings()).user.exportOptions),
    markAiText: false,
    commentFailedChecks: false,
    includeMyComments: false,
    trackChanges: false,
  };
}

/** Ask in your agent on the flagged SOUTH of a saved file's check, and the request the agent reads. */
async function askToFix(core: Core, pairingId: string, agent: Agent, saved: Saved) {
  const checkNote = saved.mindId ?? "";
  const client = await connectToMind(core, checkNote);
  await client.settled();
  const flagged = claimSpans(readMind(client)).find((span) => span.sentence.text === SOUTH);
  if (!flagged) throw new Error("The flagged claim has no mark.");
  await core.askAgent({
    pairingId,
    mindId: checkNote,
    ask: {
      kind: "fix",
      sentences: [
        {
          sentence: SOUTH,
          verdict: "contradicted",
          checkId: flagged.check.id,
          quote: "the south quay holds 19 boats",
        },
      ],
    },
  });
  return structured<{ request: string }>(
    await agent.callTool({ name: "read_request", arguments: {} }),
  ).request;
}

const text = (words: string) => ({ type: "text", text: words });
const paragraphOf = (content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content,
});

const ORDERS = join(process.cwd(), "tests/fixtures/formats/Orders.csv");
const REGION_TOTALS: [string, number][] = [
  ["Central", 8325],
  ["North", 9450],
  ["South", 8700],
  ["West", 9075],
];
/** What the Analysis of Orders gives: its table by region, and each region's total as a figure. */
const ORDERS_ANALYSIS: FakeAnswer = {
  output: {
    ...noAnalysisOutput(),
    results: [
      {
        kind: "table",
        name: "region_totals",
        label: "Total amount by region",
        unit: "",
        table: { columns: ["region", "amount"], rows: REGION_TOTALS, rowCount: 4, columnCount: 2 },
      },
      ...REGION_TOTALS.map(([region, total]) => ({
        kind: "figure" as const,
        name: `total_${region.toLowerCase()}`,
        label: `Total amount, ${region}`,
        unit: "",
        value: total,
      })),
    ],
  },
};

/** The User's assistant: it finds Orders, runs the Analysis, and writes its table and a figure into a new Note. */
function analysingModel() {
  return scriptedModel(
    (call: ModelCall) => {
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "Central" } }] };
      if (!call.results.some((result) => result.tool === "run_analysis")) {
        const orders = shownPassages(search.text).find((each) =>
          each.document.startsWith("Orders"),
        );
        return {
          calls: [
            {
              tool: "run_analysis",
              input: {
                title: "Orders by region",
                inputs: [{ name: "orders", passage: orders?.id ?? "" }],
                code: "pass",
              },
            },
          ],
        };
      }
      if (!call.results.some((result) => result.tool === "create_mind"))
        return {
          calls: [
            {
              tool: "create_mind",
              streamInput: true,
              input: {
                title: "Orders analysis",
                content: "# Orders analysis\n\n[=table 1]\n\nCentral came to [=1].",
              },
            },
          ],
        };
      return { text: "Written." };
    },
    {
      generate: (call: GenerateCall) =>
        call.question === "find-claims"
          ? { text: sortReply(call.prompt) }
          : checkGenerate({})(call),
    },
  );
}

/** A Citation of `document` as the editor keeps one, with an id of its own. */
const citation = (
  document: { id: string; name: string; contentHash?: string | null },
  quote: string,
  id: string = randomUUID(),
) => ({
  type: "citation",
  attrs: {
    id,
    passageId: `passage-${id}`,
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash ?? null,
    pageFrom: null,
    pageTo: null,
    quote,
    check: "found",
  },
});

describe("a Word file IncarnaMind writes for an outside agent", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=one call makes a Note a Word file in the Output location, where Export › Word puts one and the User can open or show it, and keeps it in the Library as a file the agent handed over; it is what Export › Word writes, part for part, its Citations as footnotes, and its package has none of the faults the package check looks for; the same Note changed is that file's next version, saved beside the first (#3751); fails_when=no file is in the Output location, the result doesn't give its path, a part differs from Export › Word's, a Citation is lost, the package check finds a fault, or a second version replaces the first file
  it("saves a Note as a Word file where Export › Word saves one, and keeps it in the Library", async () => {
    const shown: string[] = [];
    const { core, coast, writer } = await started([], {
      asItLands: false,
      adapters: {
        shell: {
          openPath: async () => undefined,
          showItemInFolder: (path) => {
            shown.push(path);
          },
        },
      },
    });
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    const agent = await connectLegacyAgent(writer.launch);
    const north = await token(agent, "north quay boats", "The north quay holds 42 boats");
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Harbour brief",
          markdown: `The north quay holds 42 boats ${north}.`,
          folderId: coast.id,
        },
      }),
    );

    const saved = structured<Saved>(await save(agent, { mindId }));
    expect(saved).toMatchObject({
      title: "Harbour brief",
      folder: "Coast",
      version: 1,
      status: "not-checked",
      citations: [],
      refused: [],
      saved: join(output, "Harbour brief.docx"),
      notSaved: null,
    });
    const file = await wordFileOf(core, saved);
    expect(file.handed.file).toMatchObject({ kind: "docx", agent: "Claude Code", version: 1 });
    expect(file.document).toMatchObject({ name: "Harbour brief", kind: "docx" });
    expect(savedFile(saved)).toEqual(file.bytes);
    expect(file.body.map((each) => each.text)).toEqual([
      "Harbour brief",
      `${NORTH.slice(0, -1)}[1].`,
    ]);
    expect(file.footnotes).toEqual([expect.stringContaining("Harbour survey")]);
    expect((await inspectPackage(file.bytes)).problems).toEqual([]);
    // Open and Show in Finder take it, as they take a file Export saved.
    await core.showSavedFile(saved.saved ?? "");
    expect(shown).toEqual([saved.saved]);

    // Export › Word, with the User's choices, writes the same Word file of the same Note.
    const exported = unzip((await core.exportMind(mindId, await agentChoices(core))).data);
    expect(bodyParts(file.files)).toEqual(bodyParts(exported));

    // The same Note, changed, is the same file's next version, saved beside the first.
    const { version } = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
    );
    structured(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId,
          version,
          changes: [{ paragraph: "¶1+", text: "Boats moor at dawn." }],
        },
      }),
    );
    const again = structured<Saved>(await save(agent, { mindId }));
    expect(again).toMatchObject({
      fileId: saved.fileId,
      version: 2,
      saved: join(output, "Harbour brief 2.docx"),
    });
    expect(partsOf(savedFile(again)).body.at(-1)?.text).toBe("Boats moor at dawn.");
    expect(partsOf(savedFile(saved)).body.at(-1)?.text).toBe(`${NORTH.slice(0, -1)}[1].`);
    expect((await core.listDocuments()).filter((each) => each.kind === "docx")).toHaveLength(1);
  });

  // protects=the same Note or text saved again, unchanged, is written with its item's date, so it is the same version with its first check and the file saved before, though the clock moved on; changed, it is the next version and a file beside the first (#3751); fails_when=each call makes a version, the second call doesn't read the first one's check, or the Output location gets a second copy of the same words
  it("keeps the same Note or text saved again as its version, with its check and its one file", async () => {
    const { core, coast, writer } = await started([], { adapters: { now: tickingClock() } });
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    const agent = await connectLegacyAgent(writer.launch);
    const north = await token(agent, "north quay boats", "The north quay holds 42 boats");
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Harbour brief",
          markdown: `The north quay holds 42 boats ${north}.`,
          folderId: coast.id,
        },
      }),
    );

    const first = structured<Saved>(await save(agent, { mindId }));
    expect(first).toMatchObject({ version: 1, status: "checked" });
    const again = structured<Saved>(await save(agent, { mindId }));
    expect(again).toMatchObject({
      fileId: first.fileId,
      version: 1,
      mindId: first.mindId,
      status: "checked",
      supported: first.supported,
      needLook: first.needLook,
      claims: first.claims,
      saved: first.saved,
    });

    const written = {
      title: "Quay counts",
      markdown: `The north quay holds 42 boats ${north}.`,
      folderId: coast.id,
    };
    const one = structured<Saved>(await save(agent, written));
    const two = structured<Saved>(await save(agent, written));
    expect(two).toMatchObject({
      fileId: one.fileId,
      version: 1,
      mindId: one.mindId,
      saved: join(output, "Quay counts.docx"),
    });
    expect(one.fileId).not.toBe(first.fileId);

    const changed = structured<Saved>(await save(agent, { ...written, markdown: OFFICE }));
    expect(changed).toMatchObject({
      fileId: one.fileId,
      version: 2,
      saved: join(output, "Quay counts 2.docx"),
    });
    expect(readdirSync(output).sort()).toEqual([
      "Harbour brief.docx",
      "Quay counts 2.docx",
      "Quay counts.docx",
    ]);
  });

  // protects=the agent's own Markdown becomes a Word file in one call, part for part the file Export › Word writes of a Note create_mind makes of the same Markdown, its tokens Citations as footnotes, and no Note is made of it; a token that matches nothing is listed with its check and reads as not found where it stood, never dropped (#3751); fails_when=a Note appears beside the file, a part differs from Export › Word's, a Citation is lost, or a marker that matches nothing vanishes from the file or the result
  it("saves the agent's Markdown as a Word file, and reports a marker that matches nothing", async () => {
    const { core, coast, writer } = await started([], { asItLands: false });
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    const agent = await connectLegacyAgent(writer.launch);
    const north = await token(agent, "north quay boats", "The north quay holds 42 boats");
    const before = (await core.listMinds()).length;
    const markdown = [
      `The north quay holds 42 boats ${north}.`,
      "",
      `${SOUTH_TRUE.slice(0, -1)} [cite:zz99zz99].`,
    ].join("\n");

    const saved = structured<Saved>(
      await save(agent, { title: "Quay counts", markdown, folderId: coast.id }),
    );
    expect(saved).toMatchObject({
      title: "Quay counts",
      folder: "Coast",
      version: 1,
      saved: join(output, "Quay counts.docx"),
    });
    expect(saved.citations).toEqual([
      expect.objectContaining({ cite: north, check: "found", document: "Harbour survey" }),
      expect.objectContaining({ cite: "[cite:zz99zz99]", check: "unknown", document: null }),
    ]);
    const file = await wordFileOf(core, saved);
    expect(savedFile(saved)).toEqual(file.bytes);
    expect(file.document).toMatchObject({ name: "Quay counts", kind: "docx" });
    expect(file.body.map((each) => each.text)).toEqual([
      "Quay counts",
      `${NORTH.slice(0, -1)}[1].`,
      "The south quay holds 19 boats [quote not found].",
    ]);
    expect(file.footnotes).toEqual([expect.stringContaining("Harbour survey")]);
    expect((await inspectPackage(file.bytes)).problems).toEqual([]);
    // Only the file's own check Note is new: the Markdown made no Note of its own.
    const notes = await core.listMinds();
    expect(notes).toHaveLength(before + 1);
    expect(notes.map((each) => each.id)).toContain(saved.mindId);

    // The same Markdown as a Note, exported by hand: the same Word file, part for part.
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Quay counts", markdown, folderId: coast.id },
      }),
    );
    const exported = unzip((await core.exportMind(mindId, await agentChoices(core))).data);
    expect(bodyParts(file.files)).toEqual(bodyParts(exported));
  });

  // protects=a Note with headings, a table, a picture, a chart and Citations, all of it the agent's to read, gives the body Export › Word writes, part for part (#3751); fails_when=a heading, a cell, the picture, the chart's drawing or a footnote differs from Export › Word's
  it("writes a Note with a heading, a table, a picture and a chart as Export › Word does", async () => {
    const { core, coast, writer, files } = await started([], {
      asItLands: false,
      adapters: { pictures: drawer },
    });
    await writeFile(join(files, "map.png"), PNG);
    const agent = await connectLegacyAgent(writer.launch);
    const north = await token(agent, "north quay boats", "The north quay holds 42 boats");
    const south = await token(agent, "south quay boats", "the south quay holds 19 boats");
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Harbour brief",
          markdown: [
            "## Quays",
            "",
            `The north quay holds 42 boats ${north}.`,
            "",
            "| Quay | Boats |",
            "|---|---|",
            `| North | 42 ${north} |`,
            `| South | 19 ${south} |`,
            "",
            "```chart",
            '{"kind": "bar", "title": "Boats by quay"}',
            "```",
            "",
            `![Harbour map](${join(files, "map.png")})`,
          ].join("\n"),
          folderId: coast.id,
        },
      }),
    );

    const saved = structured<Saved>(await save(agent, { mindId }));
    const file = partsOf(savedFile(saved));
    expect(file.body.map((each) => each.text)).toEqual(
      expect.arrayContaining(["Quays", `${NORTH.slice(0, -1)}[1].`]),
    );
    const document = part(file.files, "word/document.xml");
    expect(document).toContain("<w:tbl>");
    expect(document).toContain('descr="Harbour map"');
    expect(document).toContain('descr="Bar chart: Boats by quay"');
    expect(file.footnotes).toEqual(
      expect.arrayContaining([expect.stringContaining("Harbour survey")]),
    );
    const exported = unzip((await core.exportMind(mindId, await agentChoices(core))).data);
    expect(bodyParts(file.files)).toEqual(bodyParts(exported));
  });

  // protects=a Note that cites a Document the agent doesn't reach is never written for it, in words that say why and what the User can do; once it doesn't, its file and its check Note hold none of anyone's waiting change, the User's comment, a failed check's comment or a person's Checked by line, which Export › Word by hand would write (#3751); fails_when=a file is written with a source the agent can't read, missing or not, or any of those parts reaches the file or the check Note's text
  it("writes a Note's file with only what the agent may read", async () => {
    const { core, coast, writer, added } = await started([], { asItLands: false });
    const [survey] = added;
    if (!survey) throw new Error("The survey wasn't added.");
    const vault = await core.createLibraryGroup({ name: "Vault", description: "" });
    const [ledger] = await addAndProcess(core, [
      await writeSourceFile(
        await createSourceFolder(),
        "Ledger.md",
        "# Ledger\n\nThe ledger shows 9,931 crowns.\n",
      ),
    ]);
    if (!ledger) throw new Error("The ledger wasn't added.");
    await core.assignDocumentGroup(ledger.id, vault.id);
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    await core.updateSettings({ user: { personId: "person-1" } });
    const mind = await core.createMind({ title: "Harbour memo", folderId: coast.id });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      {
        type: "paragraph",
        content: [
          text("The north quay holds 42 boats"),
          citation(survey, "The north quay holds 42 boats"),
          text("."),
        ],
      },
      {
        type: "paragraph",
        content: [
          text("The ledger shows 9,931 crowns"),
          citation(ledger, "The ledger shows 9,931 crowns."),
          text("."),
        ],
      },
    ]);
    await client.settled();
    const agent = await connectLegacyAgent(writer.launch);

    expect(refusal(await save(agent, { mindId: mind.id }))).toBe(UNSHARED.en);
    expect(readdirSync(output)).toEqual([]);
    expect((await core.listDocuments()).filter((each) => each.kind === "docx")).toEqual([]);

    // Without the ledger: the User's comment on the first sentence, a Checked by line on its
    // Citation, a sentence the check finds contradicted, and another agent's change waiting.
    const cited = citation(survey, "The north quay holds 42 boats", "cited-north");
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          {
            type: "text",
            text: "The north quay holds 42 boats",
            marks: [{ type: "comment", attrs: { id: "remark" } }],
          },
          cited,
          text("."),
        ],
      },
      { type: "paragraph", attrs: { id: "p2" }, content: [text(SOUTH)] },
    ]);
    client.doc.getMap(MIND_COMMENTS_FIELD).set("remark", {
      id: "remark",
      author: null,
      createdAt: "2026-11-01T09:00:00Z",
      text: "Private remark for me alone.",
      resolvedAt: null,
      replies: [],
    });
    addSignOff(client.doc, {
      id: "mark-1",
      target: { kind: "citation", id: "cited-north" },
      at: "2026-11-01T09:00:00.000Z",
      contentHash: "checked-before-it-changed",
      deletedAt: null,
      name: "Ada Quill",
      personId: "person-1",
    });
    await client.settled();
    await core.checkMind({ requestId: randomUUID(), mindId: mind.id, mode: "all" });
    const pilot = await connectLegacyAgent(
      (await core.connectAgent({ name: "Pilot", folderIds: [coast.id], propose: true })).launch,
    );
    const { version } = structured<{ version: string }>(
      await pilot.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    structured(
      await pilot.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version,
          changes: [{ paragraph: "¶2+", text: "Rival words from another agent." }],
        },
      }),
    );
    // Export › Word by hand, with each of them asked for, writes every one of them.
    const byHand = partsOf(
      (
        await core.exportMind(mind.id, {
          format: "docx",
          trackChanges: true,
          includeMyComments: true,
          commentFailedChecks: true,
        })
      ).data,
    );
    for (const words of [
      "Rival words from another agent.",
      "Private remark for me alone.",
      "Ada Quill",
      "not 17",
    ]) {
      expect(byHand.all).toContain(words);
    }

    const saved = structured<Saved>(await save(agent, { mindId: mind.id }));
    const file = partsOf(savedFile(saved));
    expect(file.body.map((each) => each.text)).toEqual([`${NORTH.slice(0, -1)}[1].`, SOUTH]);
    const { markdown } = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: saved.mindId } }),
    );
    for (const words of [
      "Rival words",
      "Private remark",
      "Ada Quill",
      "Checked by",
      "not 17",
      "9,931",
      "Ledger",
    ]) {
      expect(file.all).not.toContain(words);
      expect(markdown).not.toContain(words);
    }
    expect(file.all).not.toContain("<w:comment ");
    expect(file.all).not.toContain("<w:ins ");
  });

  // protects=a Meeting's Transcript has the reach of its Note: a Note citing the Transcript of a Meeting the agent reaches is written, and one citing a Meeting's it doesn't is refused saying why, the Meeting's own Note with it (#3751); fails_when=a Transcript behind an unshared Note reaches a file, or a shared Meeting's can't be written
  it("writes a Transcript's Citations only where the agent reaches its Meeting", async () => {
    const harbourLine = "We'll move the first North crossing to ten past seven.";
    const saleLine = "The board agreed to sell the Tern for a million pounds.";
    const { core, recordMeeting } = await startMeetingAgentsCore({
      mine: [harbourLine, saleLine],
      theirs: ["The harbour can open the slipway earlier.", "Penhallow Shipping signs in April."],
    });
    const coast = await core.createLibraryGroup({ name: "Coast", description: "" });
    const hidden = await core.createLibraryGroup({ name: "Private", description: "" });
    const harbour: RecordedMeeting = await recordMeeting(coast.id, "Harbour meeting");
    const sale: RecordedMeeting = await recordMeeting(hidden.id, "Sale meeting");
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    await core.setAgentsEnabled(true);
    const agent = await connectLegacyAgent(
      (await core.connectAgent({ name: "Claude Code", folderIds: [coast.id], propose: true }))
        .launch,
    );
    const cites = async (mindId: string, meeting: RecordedMeeting, words: string) => {
      const client = await connectToMind(core, mindId);
      writeMind(client, [
        {
          type: "paragraph",
          content: [
            text(words.slice(0, -1)),
            citation({ id: meeting.transcriptId, name: "Transcript" }, words),
            text("."),
          ],
        },
      ]);
      await client.settled();
    };

    await cites(harbour.mindId, harbour, harbourLine);
    const meetingFile = structured<Saved>(await save(agent, { mindId: harbour.mindId }));
    expect(meetingFile).toMatchObject({
      title: "Harbour meeting",
      saved: join(output, "Harbour meeting.docx"),
    });
    expect(partsOf(savedFile(meetingFile)).all).toContain("first North crossing");

    const memo = await core.createMind({ title: "Crossings memo", folderId: coast.id });
    await cites(memo.id, harbour, harbourLine);
    expect(structured<Saved>(await save(agent, { mindId: memo.id })).saved).toBe(
      join(output, "Crossings memo.docx"),
    );
    await cites(memo.id, sale, saleLine);
    expect(refusal(await save(agent, { mindId: memo.id }))).toBe(UNSHARED.en);
    expect(readdirSync(output).sort()).toEqual(["Crossings memo.docx", "Harbour meeting.docx"]);
  });

  // protects=Chinese content exports as Chinese Word text, its Citation a footnote naming the Chinese Document, part for part the file Export › Word writes of the same Markdown as a Note, and the interface's Chinese words reach the agent, for either mistake in what it gives (#3751); fails_when=Chinese text or a Chinese Document's name is garbled or lost, a part differs from Export › Word's, or one mistake is refused in words that fit only the other
  it("saves Chinese text as a Word file, with its Citation, and says in Chinese what to give", async () => {
    const { core, coast, writer } = await started([], { asItLands: false });
    await core.updateSettings({ user: { language: "zh-CN" } });
    const sources = await createSourceFolder();
    const [survey] = await addAndProcess(core, [
      await writeSourceFile(sources, "港口调查.md", "# 港口调查\n\n北码头停泊着四十二艘渔船。\n"),
    ]);
    if (!survey) throw new Error("The Chinese survey wasn't added.");
    await core.assignDocumentGroup(survey.id, coast.id);
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    const agent = await connectLegacyAgent(writer.launch);
    const cite = await token(agent, "北码头 渔船", "北码头停泊着四十二艘渔船。");

    const saved = structured<Saved>(
      await save(agent, {
        title: "港口简报",
        markdown: `北码头停泊着四十二艘渔船${cite}。`,
        folderId: coast.id,
      }),
    );
    expect(saved.saved).toBe(join(output, "港口简报.docx"));
    expect(saved.citations).toEqual([
      expect.objectContaining({ check: "found", document: "港口调查" }),
    ]);
    const file = await wordFileOf(core, saved);
    expect(file.document.name).toBe("港口简报");
    expect(file.body.map((each) => each.text)).toEqual([
      "港口简报",
      "北码头停泊着四十二艘渔船[1]。",
    ]);
    expect(file.footnotes).toEqual([expect.stringContaining("港口调查")]);
    expect((await inspectPackage(file.bytes)).problems).toEqual([]);
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "港口简报",
          markdown: `北码头停泊着四十二艘渔船${cite}。`,
          folderId: coast.id,
        },
      }),
    );
    const exported = unzip((await core.exportMind(mindId, await agentChoices(core))).data);
    expect(bodyParts(file.files)).toEqual(bodyParts(exported));

    const which = "只给其中一个：笔记的 mindId，或你的文字 markdown。";
    expect(refusal(await save(agent, { title: "港口简报" }))).toBe(which);
    expect(
      refusal(await save(agent, { mindId: saved.mindId, title: "港口简报", markdown: "北码头。" })),
    ).toBe(which);
  });

  // protects=when the Output location is gone or IncarnaMind may not write in it, the agent is told so in the words Export › Word's line says, in the User's language, and the file is still kept in the Library (#3751); fails_when=the call fails without saying why, claims a path, or loses the Library's copy
  it.each(["en", "zh-CN"] as const)(
    "says in plain words when the Output location can't take the file (%s)",
    async (language) => {
      const { core, coast, writer } = await started([], { asItLands: false });
      await core.updateSettings({ user: { language } });
      const agent = await connectLegacyAgent(writer.launch);
      const say = (key: "export.failed.gone" | "export.failed.readOnly") =>
        translate(language, "export.failed.save", { reason: translate(language, key) });

      const parent = await createSourceFolder();
      const gone = join(parent, "Exports");
      await mkdir(gone);
      await core.setOutputLocation(gone);
      await rm(parent, { recursive: true });
      const lost = structured<Saved>(
        await save(agent, { title: "Quay counts", markdown: OFFICE, folderId: coast.id }),
      );
      expect(lost).toMatchObject({ version: 1, saved: null, notSaved: say("export.failed.gone") });
      expect((await wordFileOf(core, lost)).document.name).toBe("Quay counts");

      if (process.platform === "win32" || process.getuid?.() === 0) return;
      const locked = await createSourceFolder();
      await core.setOutputLocation(locked);
      await chmod(locked, 0o500);
      try {
        const refused = structured<Saved>(
          await save(agent, { title: "Harbour hours", markdown: OFFICE, folderId: coast.id }),
        );
        expect(refused).toMatchObject({ saved: null, notSaved: say("export.failed.readOnly") });
      } finally {
        await chmod(locked, 0o700);
      }
      expect(readdirSync(locked)).toEqual([]);
    },
  );

  // protects=a Note that IncarnaMind can't write yet, or that is gone, is refused in IncarnaMind's own words the agent can pass on, never a bare failure (#3751); fails_when=the agent hears only that the call failed
  it("says why a Note can't be written: still being imported", async () => {
    const { core, coast, writer } = await started([], { asItLands: false });
    const mind = await core.createMind({ title: "Imported memo", folderId: coast.id });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [{ type: "paragraph", content: [text("Half of it.")] }]);
    client.doc.getMap(MIND_WORD_FIELD).set("import", { done: 1, total: 3 });
    await client.settled();
    const agent = await connectLegacyAgent(writer.launch);
    expect(refusal(await save(agent, { mindId: mind.id }))).toBe(
      translate("en", "error.export.wordImporting"),
    );
  });

  // protects=a folderId names where a Note's file is kept, so a Note saved into another Folder is an item there and never a dead end, and Ask in your agent on that item's check names the folderId to save it with, so the next save is its next version; the refusal for giving both mindId and markdown, or neither, fits both (#3751); fails_when=the folderId is ignored without a word, the request leads to a new item elsewhere, or a refusal names only one of the mistakes
  it("keeps a Note's file in the Folder named, and says what to give for either mistake", async () => {
    const { core, coast, writer, more, added } = await started([], { folders: ["Archive"] });
    const [archive] = more;
    const [survey] = added;
    if (!archive || !survey) throw new Error("No Archive Folder.");
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    const agent = await connectLegacyAgent(writer.launch);
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Harbour brief", markdown: SOUTH, folderId: coast.id },
      }),
    );
    const own = structured<Saved>(await save(agent, { mindId }));
    expect(await askToFix(core, writer.pairing.id, agent, own)).not.toContain("folderId");
    // The Archive item's check reads the Archive's Documents.
    await core.assignDocumentGroup(survey.id, archive.id);
    const filed = structured<Saved>(await save(agent, { mindId, folderId: archive.id }));
    expect(own).toMatchObject({ folder: "Coast", version: 1 });
    expect(filed).toMatchObject({ folder: "Archive", version: 1 });
    expect(filed.fileId).not.toBe(own.fileId);
    expect((await core.handedFileOf(filed.mindId ?? ""))?.file.folderId).toBe(archive.id);

    const filedRequest = await askToFix(core, writer.pairing.id, agent, filed);
    expect(filedRequest).toMatch(
      new RegExp(
        `save it again with save_as_word and that mindId, with folderId ${archive.id}\\.$`,
      ),
    );
    const { version } = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
    );
    structured(
      await agent.callTool({
        name: "propose_changes",
        arguments: { mindId, version, changes: [{ paragraph: "¶1", text: SOUTH_TRUE }] },
      }),
    );
    const next = structured<Saved>(await save(agent, { mindId, folderId: archive.id }));
    expect(next).toMatchObject({ fileId: filed.fileId, version: 2, folder: "Archive" });

    const which = "Give exactly one: mindId for a note, or markdown for your text.";
    expect(refusal(await save(agent, { title: "Brief" }))).toBe(which);
    expect(refusal(await save(agent, { mindId, markdown: "Hi." }))).toBe(which);
  });

  // protects=Ask in your agent on the check of a Word file IncarnaMind wrote asks the agent to fix the Note with propose_changes and save it again by its mindId, or, for its own text, to read it from the check's Note and save the corrected Markdown under the same title, in English and Chinese, never naming a made-up path (#3751); fails_when=the request points at a file on disk, names an item's inner key, or tells the agent to hand a file over
  it("asks the agent to fix a Word file's flagged sentence where it was written from", async () => {
    const { core, coast, writer } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Harbour brief", markdown: SOUTH, folderId: coast.id },
      }),
    );
    const fromNote = structured<Saved>(await save(agent, { mindId }));
    const fromText = structured<Saved>(
      await save(agent, { title: "Quay counts", markdown: SOUTH, folderId: coast.id }),
    );
    const ask = (saved: Saved) => askToFix(core, writer.pairing.id, agent, saved);

    const noteRequest = await ask(fromNote);
    expect(noteRequest).toMatch(
      /^In IncarnaMind, the check of the Word file saved from my note “Harbour brief” \(version 1\) says this is contradicted by my Documents:/,
    );
    expect(noteRequest).toContain(`“${SOUTH}”`);
    expect(noteRequest).toMatch(
      new RegExp(
        `Fix it in the note \\(mindId: ${mindId}\\) from my Documents with propose_changes, change nothing else, then save it again with save_as_word and that mindId\\.$`,
      ),
    );
    const textRequest = await ask(fromText);
    expect(textRequest).toMatch(
      /^In IncarnaMind, the check of the Word file you saved from your own text, “Quay counts” \(version 1\), says this is contradicted by my Documents:/,
    );
    expect(textRequest).toContain(
      `Its text is in the note mindId ${fromText.mindId} (read_mind). Fix it from my Documents, change nothing else, and save it again with save_as_word, the title “Quay counts”, folderId ${coast.id} and the corrected markdown.`,
    );

    await core.updateSettings({ user: { language: "zh-CN" } });
    const noteZh = await ask(fromNote);
    expect(noteZh).toContain("从我的笔记“Harbour brief”生成的 Word 文件（第 1 版）经核对");
    expect(noteZh).toContain(
      `请根据我的文档，用 propose_changes 在这篇笔记（mindId：${mindId}）里改正，其他内容不要改动，然后用 save_as_word 和这个 mindId 重新生成 Word 文件。`,
    );
    const textZh = await ask(fromText);
    expect(textZh).toContain("你用自己写的文字生成的 Word 文件“Quay counts”（第 1 版）经核对");
    expect(textZh).toContain(
      `它的文字在笔记 mindId ${fromText.mindId} 中（用 read_mind 读取）。请根据我的文档改正，其他内容不要改动，然后用 save_as_word、标题“Quay counts”、folderId ${coast.id} 和改正后的 markdown 重新生成。`,
    );
    for (const request of [noteRequest, textRequest, noteZh, textZh]) {
      expect(request).not.toContain("incarnamind:");
      expect(request).not.toContain("hand_over_file");
    }
  });

  // protects=the check Note of a Word file IncarnaMind wrote can itself be saved as Word, as a new file of its own, never refused as a file the Library holds already (#3751); fails_when=the agent is told to change a file it never wrote
  it("saves a Word file's check Note as a Word file of its own", async () => {
    const { core, coast, writer } = await started([], { asItLands: false });
    const agent = await connectLegacyAgent(writer.launch);
    const saved = structured<Saved>(
      await save(agent, { title: "Quay counts", markdown: OFFICE, folderId: coast.id }),
    );
    const ofCheck = structured<Saved>(
      await save(agent, { mindId: saved.mindId, title: "Quay counts" }),
    );
    expect(ofCheck).toMatchObject({ version: 1 });
    expect(ofCheck.fileId).not.toBe(saved.fileId);
    expect((await core.listDocuments()).filter((each) => each.kind === "docx")).toHaveLength(2);
  });

  // protects=a text saved as A, then B, then A again ("undo that and save again") is the item's next version each time, never refused as a file the Library holds, and its Output location holds each file once, whether that location is inside an allowed Linked folder or not (#3751); fails_when=the third save is refused, tells the agent to change a file it never wrote, or writes a second copy of A
  it.each(["outside", "inside"] as const)(
    "saves the same words as an earlier version again, with the Output location %s a Linked folder",
    async (where) => {
      const { core, coast, writer } = await started([], { asItLands: false });
      const output = join(await createSourceFolder(), "Exports");
      await mkdir(output);
      if (where === "inside") {
        const linked = await core.addLinkedFolder(dirname(output));
        await core.setLinkedFolderWriting(linked.id, true);
      }
      await core.setOutputLocation(output);
      const agent = await connectLegacyAgent(writer.launch);
      const words = (markdown: string) => ({ title: "Quay counts", markdown, folderId: coast.id });

      const first = structured<Saved>(await save(agent, words(OFFICE)));
      await core.reconcileDocuments();
      const second = structured<Saved>(await save(agent, words(SOUTH_TRUE)));
      await core.reconcileDocuments();
      const again = await save(agent, words(OFFICE));
      await core.reconcileDocuments();
      const third = structured<Saved>(again);
      expect([first.version, second.version, third.version]).toEqual([1, 2, 3]);
      expect(third).toMatchObject({ fileId: first.fileId, saved: first.saved, notSaved: null });
      expect(readdirSync(output).sort()).toEqual(["Quay counts 2.docx", "Quay counts.docx"]);
    },
  );

  // protects=an outside agent's save never waits on a question nobody at the window may see: where the default folder can't take the file, or the Output location is in a Linked folder the User hasn't answered for, it returns at once with the file kept in the Library and says in plain words what the User can answer in IncarnaMind, in their language (#3751); fails_when=the call waits on an answer, a question is raised, or the agent isn't told what the User can do
  it.each(["en", "zh-CN"] as const)(
    "never waits on a question for an outside agent (%s)",
    async (language) => {
      const { core, coast, writer, dataDir } = await started([], { asItLands: false });
      await core.updateSettings({ user: { language } });
      const agent = await connectLegacyAgent(writer.launch);
      const asked: unknown[] = [];
      core.on("fileWrite.requested", (request) => asked.push(request));
      const suggested = join(dataDir, "Documents", "IncarnaMind");
      await mkdir(dirname(suggested), { recursive: true });
      await writeFile(suggested, "Not a folder.");

      const blocked = structured<Saved>(
        await save(agent, { title: "Quay counts", markdown: OFFICE, folderId: coast.id }),
      );
      expect(blocked).toMatchObject({
        version: 1,
        saved: null,
        notSaved: translate(language, "agents.handOver.word.askLocation"),
      });
      expect((await wordFileOf(core, blocked)).document.name).toBe("Quay counts");

      const linked = await createSourceFolder();
      await core.addLinkedFolder(linked);
      await mkdir(join(linked, "Exports"));
      await core.setOutputLocation(join(linked, "Exports"));
      const unanswered = structured<Saved>(
        await save(agent, { title: "Harbour hours", markdown: OFFICE, folderId: coast.id }),
      );
      expect(unanswered).toMatchObject({
        saved: null,
        notSaved: translate(language, "agents.handOver.word.askLinked", {
          folder: basename(linked),
        }),
      });
      expect(asked).toEqual([]);
      expect(await core.listFileWriteRequests()).toEqual([]);
      expect(readdirSync(join(linked, "Exports"))).toEqual([]);
    },
  );

  // protects=a Note whose Analysis read a Document the agent doesn't reach, which its table's note and its worked-out figure would name, is never written for it, though no Citation of that Document is in its Blocks: what decides is every Document the file itself would name (#3751); fails_when=a file is kept or saved that names the unshared Document, its rows or its sheet
  it("refuses a Note whose Analysis read a Document the agent doesn't reach", async () => {
    const { core, coast, writer } = await started([], {
      asItLands: false,
      model: analysingModel(),
      analysisRuntime: createFakeAnalysisRuntime({ answer: () => ORDERS_ANALYSIS }),
    });
    const vault = await core.createLibraryGroup({ name: "Vault", description: "" });
    const [orders] = await addAndProcess(core, [ORDERS]);
    if (!orders) throw new Error("Orders wasn't added.");
    await core.assignDocumentGroup(orders.id, vault.id);
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    // The assistant's Analysis runs on a chat model that may use it, the User's consent given.
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    if (provider.service) await core.allowDataFlow("chat", provider.service.id);
    const answer = await askAssistant(core, {
      text: "Using Orders.csv, total the amount by region and write the table into a new note called Orders analysis.",
      mindId: (await core.createMind({ title: "Questions" })).id,
      analyse: true,
    });
    const madeId = answer.toolCalls.findLast((call) => call.tool === "create_mind")?.mindChange
      ?.mindId;
    if (!madeId) throw new Error("The Answer made no Note.");
    const client = await connectToMind(core, madeId);
    await client.settled();
    await resolveChanges(client, "accept");
    await client.settled();
    await core.moveToFolder({ mindIds: [madeId], folderId: coast.id });
    // Export › Word by hand names the Document the Analysis read, in the table's note and the
    // figure's, though no Citation of it is in the Note.
    const byHand = partsOf((await core.exportMind(madeId, { format: "docx" })).data);
    expect(byHand.footnotes).toEqual([
      expect.stringContaining("from 40 rows of Orders"),
      expect.stringContaining("orders: Orders, rows 1–41"),
    ]);

    const agent = await connectLegacyAgent(writer.launch);
    expect(refusal(await save(agent, { mindId: madeId }))).toBe(UNSHARED.en);
    expect(readdirSync(output)).toEqual([]);
    expect((await core.listDocuments()).filter((each) => each.kind === "docx")).toEqual([]);
  });

  // protects=a Note naming what no shared Folder gives the agent is told the truth: a Citation of a Document no longer in the Library, or of the Library's own facts, refuses the file in words that say so and what the User can do; a chip of a Document deleted since is written, as read_mind already shows the agent its name (#3751); fails_when=the agent is told to ask for a Folder to be shared, or a chip's name blocks the file
  it.each(["en", "zh-CN"] as const)(
    "says what is true when a Note names what the agent can't be given (%s)",
    async (language) => {
      const { core, coast, writer } = await started([], { asItLands: false });
      await core.updateSettings({ user: { language } });
      const [ledger] = await addAndProcess(core, [
        await writeSourceFile(
          await createSourceFolder(),
          "Old ledger.md",
          "# Old ledger\n\nThe ledger shows 9,931 crowns.\n",
        ),
      ]);
      if (!ledger) throw new Error("The ledger wasn't added.");
      await core.assignDocumentGroup(ledger.id, coast.id);
      const output = await createSourceFolder();
      await core.setOutputLocation(output);
      const noteWith = async (title: string, content: JSONContent[]) => {
        const mind = await core.createMind({ title, folderId: coast.id });
        const client = await connectToMind(core, mind.id);
        writeMind(client, [paragraphOf(content)]);
        await client.settled();
        return mind.id;
      };
      const cited = await noteWith("Ledger memo", [
        text("The ledger shows 9,931 crowns"),
        citation(ledger, "The ledger shows 9,931 crowns."),
        text("."),
      ]);
      const chipped = await noteWith("Ledger list", [
        text("See "),
        { type: "documentChip", attrs: { documentId: ledger.id, name: "Old ledger" } },
        text("."),
      ]);
      const facts = await noteWith("Library facts", [
        text("The Library holds two Documents"),
        citation({ id: LIBRARY_FACTS, name: "Library" }, "2 Documents"),
        text("."),
      ]);
      await core.deleteDocument(ledger.id);
      const agent = await connectLegacyAgent(writer.launch);

      expect(refusal(await save(agent, { mindId: cited }))).toBe(
        translate(language, "agents.handOver.word.deleted"),
      );
      expect(refusal(await save(agent, { mindId: facts }))).toBe(
        translate(language, "agents.handOver.word.libraryFacts"),
      );
      const chip = structured<Saved>(await save(agent, { mindId: chipped }));
      expect(partsOf(savedFile(chip)).all).toContain("Old ledger");
      const { markdown } = structured<{ markdown: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId: chipped } }),
      );
      expect(markdown).toContain("Old ledger");
    },
  );

  // protects=Ask in your agent on a User's Note's Word file says the fix waits for the User, to tell them so and to save again once they accept it, in English and Chinese; saved before the accept, the file is the same version with the same flagged claim, and after it the next version with the claim fixed (#3751); fails_when=the request says the change lands at once, a waiting change reaches the file, or the accepted fix makes no new version
  it("asks for a fix to a User's Note to wait for their accept, then saves it as the next version", async () => {
    const { core, coast, writer } = await started();
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    const mind = await core.createMind({ title: "Harbour memo", folderId: coast.id });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [{ type: "paragraph", attrs: { id: "p1" }, content: [text(SOUTH)] }]);
    await client.settled();
    const agent = await connectLegacyAgent(writer.launch);
    const first = structured<Saved>(await save(agent, { mindId: mind.id }));
    expect(first.claims.map((each) => each.text)).toContain(SOUTH);

    const request = await askToFix(core, writer.pairing.id, agent, first);
    expect(request).toMatch(
      new RegExp(
        `Propose the fix in the note \\(mindId: ${mind.id}\\) from my Documents with propose_changes, and change nothing else\\. The note is mine, so your change waits for me to accept it, and a Word file holds no change that waits: tell me so, and save it again with save_as_word and that mindId once I have accepted it\\.$`,
      ),
    );
    await core.updateSettings({ user: { language: "zh-CN" } });
    expect(await askToFix(core, writer.pairing.id, agent, first)).toContain(
      "这篇笔记是我的，你的修改要等我接受，而 Word 文件不会写入待处理的修改：请告诉我这一点，等我接受后，再用 save_as_word 和这个 mindId 重新生成 Word 文件。",
    );
    await core.updateSettings({ user: { language: "en" } });

    const { version } = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );
    structured(
      await agent.callTool({
        name: "propose_changes",
        arguments: { mindId: mind.id, version, changes: [{ paragraph: "¶1", text: SOUTH_TRUE }] },
      }),
    );
    const waiting = structured<Saved>(await save(agent, { mindId: mind.id }));
    expect(waiting).toMatchObject({ fileId: first.fileId, version: 1, mindId: first.mindId });
    expect(waiting.claims).toEqual(first.claims);

    await client.settled();
    await resolveChanges(client, "accept");
    const accepted = structured<Saved>(await save(agent, { mindId: mind.id }));
    expect(accepted).toMatchObject({ fileId: first.fileId, version: 2 });
    expect(partsOf(savedFile(accepted)).body.map((each) => each.text)).toEqual([SOUTH_TRUE]);
    expect(accepted.claims.map((each) => each.text)).not.toContain(SOUTH);
  });

  // protects=a file IncarnaMind saved earlier is found again only where a save would put it: a folder or a link under its name is passed over, and a link put in the Output location's place leads nowhere a save may write, so no file there is taken as saved nor offered to Open and Show (#3751); fails_when=a link or folder under the name is taken for the file, or a file in a link's target is registered as saved
  it("finds the file saved before only in the Output location itself", async () => {
    const { core, coast, writer } = await started([], { asItLands: false });
    const agent = await connectLegacyAgent(writer.launch);
    const words = { title: "Quay counts", markdown: OFFICE, folderId: coast.id };
    const first = await createSourceFolder();
    await core.setOutputLocation(first);
    const saved = structured<Saved>(await save(agent, words));
    const original = join(first, "Quay counts.docx");
    expect(saved.saved).toBe(original);

    const second = await createSourceFolder();
    await mkdir(join(second, "Quay counts.docx"));
    await symlink(original, join(second, "Quay counts 2.docx"));
    await core.setOutputLocation(second);
    expect(structured<Saved>(await save(agent, words))).toMatchObject({
      version: 1,
      saved: join(second, "Quay counts 3.docx"),
    });

    const elsewhere = await createSourceFolder();
    await copyFile(original, join(elsewhere, "Quay counts.docx"));
    const third = join(await createSourceFolder(), "Exports");
    await mkdir(third);
    await core.setOutputLocation(third);
    await rm(third, { recursive: true });
    await symlink(elsewhere, third);
    const swapped = structured<Saved>(await save(agent, words));
    expect(swapped).toMatchObject({
      saved: null,
      notSaved: translate("en", "error.files.outside"),
    });
    await expect(core.showSavedFile(join(elsewhere, "Quay counts.docx"))).rejects.toThrow(
      NotFoundError,
    );
  });

  // protects=the same words saved after IncarnaMind was closed and opened again are still the same version, with its check and the same one file (#3751); fails_when=a restart makes the next save a new version or a second copy
  it("keeps the same words as the same version after IncarnaMind starts again", async () => {
    const { core, coast, writer, restart } = await started([], { asItLands: false });
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    const words = { title: "Quay counts", markdown: OFFICE, folderId: coast.id };
    const before = structured<Saved>(await save(await connectLegacyAgent(writer.launch), words));
    const reopened = await restart();
    const after = structured<Saved>(await save(await connectLegacyAgent(writer.launch), words));
    expect(after).toMatchObject({
      fileId: before.fileId,
      version: 1,
      mindId: before.mindId,
      saved: before.saved,
    });
    expect(readdirSync(output)).toEqual(["Quay counts.docx"]);
    await reopened.showSavedFile(after.saved ?? "").catch((error: unknown) => {
      expect(error).not.toBeInstanceOf(NotFoundError);
    });
    reopened.close();
  });

  // protects=an agent that hands over the Word file IncarnaMind saved for it, from where it was saved, is given that file's item and its check, never told the Library holds it already (#3751); fails_when=the hand-over is refused, tells the agent to change a file it never wrote, or makes a second item of the same file
  it("answers a hand-over of the saved Word file with its own item", async () => {
    const { core, coast, writer } = await started([], { asItLands: false });
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    const agent = await connectLegacyAgent(writer.launch);
    const saved = structured<Saved>(
      await save(agent, { title: "Quay counts", markdown: OFFICE, folderId: coast.id }),
    );
    const handed = structured<Handed>(await handOver(agent, { path: saved.saved ?? "" }));
    expect(handed).toMatchObject({ fileId: saved.fileId, version: 1, mindId: saved.mindId });
    expect((await core.listDocuments()).filter((each) => each.kind === "docx")).toHaveLength(1);
  });

  // protects=Open and Show in Finder on a saved Word file that was moved or deleted are refused in IncarnaMind's own plain words, in English and Chinese, which the conversation's card and Export's saved line show after "Couldn't open it:", and nothing is handed to the system (#3751); fails_when=the system's own words, or nothing at all, is what the User gets
  it("says a saved file is no longer there when Open or Show finds it gone", async () => {
    const handed: string[] = [];
    const { core, coast, writer } = await started([], {
      asItLands: false,
      adapters: {
        shell: {
          openPath: async (path) => {
            handed.push(path);
          },
          showItemInFolder: (path) => {
            handed.push(path);
          },
        },
      },
    });
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    const agent = await connectLegacyAgent(writer.launch);
    const saved = structured<Saved>(
      await save(agent, { title: "Quay counts", markdown: OFFICE, folderId: coast.id }),
    );
    await rm(saved.saved ?? "");
    for (const act of [core.openSavedFile, core.showSavedFile]) {
      const failure = await act(saved.saved ?? "").then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(NotFoundError);
      expect(failure).toMatchObject({ wording: { key: "error.files.savedGone" } });
    }
    expect(handed).toEqual([]);
    expect(
      translate("en", "export.failed.open", { reason: translate("en", "error.files.savedGone") }),
    ).toBe("Couldn’t open it: the file is no longer there; it was moved or deleted");
    expect(
      translate("zh-CN", "export.failed.show", {
        reason: translate("zh-CN", "error.files.savedGone"),
      }),
    ).toBe("无法显示文件：这个文件已不在原处，它被移动或删除了");
  });

  // protects=an agent the User let only read is refused in the words create_mind's refusal uses, and nothing is written (#3751); fails_when=it writes a file without the write grant, or says so in other words
  it("refuses an agent that may only read, as the other write Tools do", async () => {
    const { core, reader } = await started([], { asItLands: false });
    const agent = await connectLegacyAgent(reader.launch);
    const words = refusal(
      await agent.callTool({ name: "create_mind", arguments: { title: "Brief", markdown: "Hi." } }),
    );
    expect(words).toContain("may only read");
    expect(refusal(await save(agent, { title: "Brief", markdown: "Hi." }))).toBe(words);
    expect((await core.listDocuments()).filter((each) => each.kind === "docx")).toEqual([]);
  });

  // protects=the Word file IncarnaMind saved, handed over again from where it was saved once the User took its item's Folder from the agent, is refused as any item out of the agent's reach is, though its check Note was moved where the agent still reaches it, and nothing new is kept (#3751); fails_when=the call answers with the item, its version or its check while its Folder is out of the agent's reach
  it("refuses the saved Word file handed over again once its Folder is out of the agent's reach", async () => {
    const { core, coast, writer, more } = await started([], {
      asItLands: false,
      folders: ["Moorings"],
    });
    const moorings = more[0]?.id ?? "";
    await core.setOutputLocation(await createSourceFolder());
    const agent = await connectLegacyAgent(writer.launch);
    const saved = structured<Saved>(
      await save(agent, { title: "Quay counts", markdown: OFFICE, folderId: coast.id }),
    );
    await core.moveToFolder({ mindIds: [saved.mindId ?? ""], folderId: moorings });
    await core.updateAgent(writer.pairing.id, { folderIds: [moorings] });
    const documents = await core.listDocuments();
    const minds = await core.listMinds();

    const handed = await handOver(agent, { path: saved.saved ?? "", folderId: moorings });
    expect(refusal(handed)).toBe(translate("en", "agents.handOver.notFound"));
    expect(await core.listDocuments()).toHaveLength(documents.length);
    expect(await core.listMinds()).toHaveLength(minds.length);
    expect((await core.handedFileOf(saved.mindId ?? ""))?.file.version).toBe(1);
  });

  // protects=a Note's Word file is kept only while the agent still reaches the Note: one the User moved out of its reach while the file was written is refused as at the call's start, with no Document, no check Note and no file in the Output location (#3751); fails_when=the Word file of a Note the agent no longer reaches is kept in the Library, gets a check Note, or is saved for the User
  it("refuses a Note moved out of the agent's reach while its Word file is written, and keeps nothing", async () => {
    const saving = await chartedNoteSaving();
    const asked = saving.save();
    await saving.drawn;
    await saving.moveOutOfReach();
    saving.draw();
    expect(refusal(await asked)).toBe(await saving.refusedNow());
    await saving.keptNothing();
  });

  // protects=a Note's Word file waiting its turn behind another hand-over is kept only if the agent still reaches the Note when its turn comes: one the User moved meanwhile is refused, with no Document, no check Note and no file in the Output location (#3751); fails_when=the queued call keeps the Word file of a Note the agent reached only when the call began
  it("refuses a Note moved out of the agent's reach while its Word file waits its turn, and keeps nothing", async () => {
    const scan = gate();
    const recognizer = createFakeTextRecognizer({
      script: { pages: { 1: { lines: ["The lease of the boathouse ends in 2029."] } } },
    });
    const saving = await chartedNoteSaving({
      textRecognizer: {
        load: (files) => recognizer.load(files),
        async read(page, number) {
          scan.reached();
          await scan.shut;
          return recognizer.read(page, number);
        },
        readFile: (file, number) => recognizer.readFile(file, number),
        close: () => recognizer.close(),
      },
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    // A scanned PDF handed over first holds the hand-overs' turn while its page is read.
    const lease = join(saving.files, "Boathouse lease.pdf");
    await writeFile(lease, buildPdf([{ scan: SCANNED_PAGE }]));
    const first = handOver(saving.agent, { path: lease, folderId: saving.coast });
    await scan.at;
    let answered = false;
    const asked = saving.save().finally(() => {
      answered = true;
    });
    await saving.drawn;
    saving.draw();
    // The rest of the file is written in moments, and the call then waits its turn.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await saving.moveOutOfReach();
    expect(answered).toBe(false);
    scan.open();
    structured(await first);
    expect(refusal(await asked)).toBe(await saving.refusedNow());
    await saving.keptNothing();
  });

  // protects=a Note left where the agent reaches it while its Word file is written is saved as before: in the Library with its check Note, and in the Output location (#3751); fails_when=reading the Note's reach again refuses or loses a file the agent may have
  it("saves a Note's Word file as before when the Note stays in the agent's reach as it is written", async () => {
    const saving = await chartedNoteSaving();
    const asked = saving.save();
    await saving.drawn;
    saving.draw();
    const saved = structured<Saved>(await asked);
    expect(saved).toMatchObject({ version: 1, saved: join(saving.output, "Harbour chart.docx") });
    expect(saved.mindId).not.toBeNull();
    expect((await saving.core.listDocuments()).filter((each) => each.kind === "docx")).toHaveLength(
      1,
    );
    expect(readdirSync(saving.output)).toEqual(["Harbour chart.docx"]);
  });

  // protects=an agent's Word file names only sources its own read of the Note shows it: a file another agent cited by its path, which read_mind shows it as a Document not shared with it, keeps the Note from being written for it, in the words for any Document out of its reach, while the agent that cited the file gets the Word file (#3751); fails_when=the Word file's footnote names a file the agent's own read of the Note hides
  it("writes no Word file naming another agent's file cited by its path, which read_mind hides", async () => {
    const { core, coast, writer } = await started([], { asItLands: false });
    const output = await createSourceFolder();
    await core.setOutputLocation(output);
    const citer = await connectLegacyAgent(writer.launch);
    const notes = join(await createSourceFolder(), "Quay notes.md");
    await writeFile(notes, "# Quay notes\n\nThe east quay holds 31 boats.\n");
    const { citations } = structured<{ citations: { cite: string | null }[] }>(
      await citer.callTool({
        name: "cite",
        arguments: { citations: [{ path: notes, quote: "The east quay holds 31 boats" }] },
      }),
    );
    const { mindId } = structured<{ mindId: string }>(
      await citer.callTool({
        name: "create_mind",
        arguments: {
          title: "Quays",
          markdown: `The east quay holds 31 boats ${citations[0]?.cite}.`,
          folderId: coast.id,
        },
      }),
    );
    const sharing = await core.connectAgent({
      name: "Gemini CLI",
      folderIds: [coast.id],
      propose: true,
    });
    const other = await connectLegacyAgent(sharing.launch);

    // The other agent reads the sentence, and its source only as one not shared with it.
    const read = structured<{ markdown: string }>(
      await other.callTool({ name: "read_mind", arguments: { mindId } }),
    );
    expect(read.markdown).toBe(
      `# Quays\n\nThe east quay holds 31 boats[^1].\n\n[^1]: ${translate("en", "agents.mind.outsideCitation")}\n`,
    );
    const named = structured<{ markdown: string }>(
      await other.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
    );
    expect(named.markdown).toBe("¶0 # Quays\n\n¶1 The east quay holds 31 boats [kept:1].");

    expect(refusal(await save(other, { mindId }))).toBe(UNSHARED.en);
    expect(readdirSync(output)).toEqual([]);
    expect((await core.listDocuments()).filter((each) => each.kind === "docx")).toEqual([]);

    // The agent that gave the file's path gets the Word file, its footnote naming the file.
    const saved = structured<Saved>(await save(citer, { mindId }));
    expect(partsOf(savedFile(saved)).footnotes).toEqual(["Quay notes, § Quay notes"]);
  });
});

const CHARTED = [
  "Boats moor at dawn.",
  "",
  "| Quay | Boats |",
  "|---|---|",
  "| North | 42 |",
  "| South | 19 |",
  "",
  "```chart",
  '{"kind": "bar", "title": "Boats by quay"}',
  "```",
].join("\n");

const SCANNED_PAGE = readFileSync(join(process.cwd(), "tests/fixtures/scans/en-clean.jpg"));

/**
 * The agent's `save_as_word` of a Note with a chart in Coast, held as its chart is drawn into the
 * file (`drawn`) until `draw`; `moveOutOfReach` files the Note in a Folder the agent doesn't reach.
 */
async function chartedNoteSaving(adapters: TestAdapters = {}) {
  const drawing = gate();
  let holding = false;
  const pictures: Pictures = {
    png: async () => {
      if (holding) {
        holding = false;
        drawing.reached();
        await drawing.shut;
      }
      return PNG;
    },
  };
  const { core, coast, writer, files } = await started([], {
    asItLands: false,
    adapters: { pictures, ...adapters },
  });
  const unshared = await core.createLibraryGroup({ name: "Board only", description: "" });
  const output = await createSourceFolder();
  await core.setOutputLocation(output);
  const agent = await connectLegacyAgent(writer.launch);
  const { mindId } = structured<{ mindId: string }>(
    await agent.callTool({
      name: "create_mind",
      arguments: { title: "Harbour chart", markdown: CHARTED, folderId: coast.id },
    }),
  );
  return {
    core,
    coast: coast.id,
    files,
    output,
    agent,
    save: () => {
      holding = true;
      return save(agent, { mindId });
    },
    drawn: drawing.at,
    draw: drawing.open,
    moveOutOfReach: () => core.moveToFolder({ mindIds: [mindId], folderId: unshared.id }),
    /** The words a call made now is refused in, the Note out of the agent's reach. */
    refusedNow: async () => refusal(await save(agent, { mindId })),
    /** No Word file in the Library, no check Note of one, and none in the Output location. */
    keptNothing: async () => {
      expect((await core.listDocuments()).filter((each) => each.kind === "docx")).toEqual([]);
      const checkNote = translate("en", "verify.mindTitle", { name: "Harbour chart" });
      expect((await core.listMinds()).map((each) => each.title)).not.toContain(checkNote);
      expect(readdirSync(output)).toEqual([]);
    },
  };
}
