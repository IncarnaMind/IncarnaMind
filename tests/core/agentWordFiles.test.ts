/**
 * A Word file IncarnaMind writes for an outside agent (#3751), through the shim the app ships with
 * the MCP SDK's own client, as Claude Code calls it: one `save_as_word` call with a Note, or with
 * the agent's Markdown and its Citation tokens, gives a .docx in the Library, written by Export ›
 * Word with its Citations as footnotes, and kept as a file the agent hands over is.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { inspectPackage } from "../../eval/word/corpus";
import { convertToPdf, findLibreOffice } from "../../eval/word/libreoffice";
import type { Core } from "../../src/core";
import { optionsFor } from "../../src/shared/exportOptions";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { footnotesOf, paragraphsOf, part, unzip } from "../helpers/docx";
import {
  type Agent,
  type Handed,
  NORTH,
  refusal,
  started,
  structured,
} from "../helpers/handedFiles";

interface Saved extends Handed {
  citations: { cite: string; check: string; document: string | null }[];
  refused: { item: string; reason: string }[];
}

const SOUTH_TRUE = "The south quay holds 19 boats.";

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

/** The parts of the Library's Word file of the hand-over: its Document's own file, as kept. */
async function wordFileOf(core: Core, saved: Saved) {
  const handed = await core.handedFileOf(saved.mindId ?? "");
  const document = (await core.listDocuments()).find((each) => each.id === handed?.file.documentId);
  if (!handed || !document) throw new Error("The Word file isn't in the Library.");
  const bytes = new Uint8Array(readFileSync(document.path));
  const files = unzip(bytes);
  return {
    handed,
    document,
    bytes,
    body: paragraphsOf(part(files, "word/document.xml")),
    footnotes: Object.values(footnotesOf(part(files, "word/footnotes.xml"))),
    styles: part(files, "word/styles.xml"),
  };
}

/** No part Word's repair prompt is about, and, where LibreOffice is installed (CI), it opens it. */
async function opensWithoutRepair(bytes: Uint8Array, name: string) {
  expect((await inspectPackage(bytes)).problems).toEqual([]);
  const soffice = findLibreOffice();
  if (!soffice) return;
  const folder = mkdtempSync(join(tmpdir(), "incarnamind-word-file-"));
  try {
    const path = join(folder, name);
    writeFileSync(path, bytes);
    const opened = await convertToPdf(soffice, path);
    expect(opened.opened, opened.problem).toBe(true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe("a Word file IncarnaMind writes for an outside agent", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=one call makes a Note a Word Document in the Library, kept and shown as a file the agent handed over, written by Export › Word with the Note's Citations as footnotes, and the same Note saved again is that file's next version (#3751); fails_when=the file isn't a handed-over Document of the Library, it differs from Export › Word's, a Citation is lost, Word would offer to repair it, or a second save makes a second file
  it("saves a Note as a Word file in the Library, as Export › Word writes it, with its Citations", async () => {
    const { core, coast, writer } = await started([], { asItLands: false });
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
    });
    const file = await wordFileOf(core, saved);
    expect(file.handed.file).toMatchObject({ kind: "docx", agent: "Claude Code", version: 1 });
    expect(file.document).toMatchObject({ name: "Harbour brief", kind: "docx" });
    expect(file.body.map((each) => each.text)).toEqual([
      "Harbour brief",
      `${NORTH.slice(0, -1)}[1].`,
    ]);
    expect(file.footnotes).toEqual([expect.stringContaining("Harbour survey")]);

    // Export › Word, with the User's choices, writes the same Word file of the same Note.
    const exported = unzip(
      (
        await core.exportMind(
          mindId,
          optionsFor("docx", (await core.getSettings()).user.exportOptions),
        )
      ).data,
    );
    expect(file.body).toEqual(paragraphsOf(part(exported, "word/document.xml")));
    expect(file.styles).toBe(part(exported, "word/styles.xml"));
    await opensWithoutRepair(file.bytes, "Harbour brief.docx");

    // The same Note, changed, is the same file's next version.
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
    expect(again).toMatchObject({ fileId: saved.fileId, version: 2 });
    expect((await wordFileOf(core, again)).body.at(-1)?.text).toBe("Boats moor at dawn.");
    expect((await core.listDocuments()).filter((each) => each.kind === "docx")).toHaveLength(1);
  });

  // protects=the agent's own Markdown becomes a Word file in one call, its tokens Citations as footnotes, and no Note is made of it; a token that matches nothing is listed with its check and reads as not found where it stood, never dropped (#3751); fails_when=a Note appears beside the file, a Citation is lost, or a marker that matches nothing vanishes from the file or the result
  it("saves the agent's Markdown as a Word file, and reports a marker that matches nothing", async () => {
    const { core, coast, writer } = await started([], { asItLands: false });
    const agent = await connectLegacyAgent(writer.launch);
    const north = await token(agent, "north quay boats", "The north quay holds 42 boats");
    const before = (await core.listMinds()).length;

    const saved = structured<Saved>(
      await save(agent, {
        title: "Quay counts",
        markdown: [
          `The north quay holds 42 boats ${north}.`,
          "",
          `${SOUTH_TRUE.slice(0, -1)} [cite:zz99zz99].`,
        ].join("\n"),
        folderId: coast.id,
      }),
    );
    expect(saved).toMatchObject({ title: "Quay counts", folder: "Coast", version: 1 });
    expect(saved.citations).toEqual([
      expect.objectContaining({ cite: north, check: "found", document: "Harbour survey" }),
      expect.objectContaining({ cite: "[cite:zz99zz99]", check: "unknown", document: null }),
    ]);
    const file = await wordFileOf(core, saved);
    expect(file.document).toMatchObject({ name: "Quay counts", kind: "docx" });
    expect(file.body.map((each) => each.text)).toEqual([
      "Quay counts",
      `${NORTH.slice(0, -1)}[1].`,
      "The south quay holds 19 boats [quote not found].",
    ]);
    expect(file.footnotes).toEqual([expect.stringContaining("Harbour survey")]);
    await opensWithoutRepair(file.bytes, "Quay counts.docx");
    // Only the file's own check Note is new: the Markdown made no Note of its own.
    const notes = await core.listMinds();
    expect(notes).toHaveLength(before + 1);
    expect(notes.map((each) => each.id)).toContain(saved.mindId);
  });

  // protects=Chinese content exports as Chinese Word text, its Citation a footnote naming the Chinese Document, and the interface's Chinese words reach the agent (#3751); fails_when=Chinese text or a Chinese Document's name is garbled or lost, or the file doesn't open
  it("saves Chinese text as a Word file, with its Citation", async () => {
    const { core, coast, writer } = await started([], { asItLands: false });
    await core.updateSettings({ user: { language: "zh-CN" } });
    const sources = await createSourceFolder();
    const [survey] = await addAndProcess(core, [
      await writeSourceFile(sources, "港口调查.md", "# 港口调查\n\n北码头停泊着四十二艘渔船。\n"),
    ]);
    if (!survey) throw new Error("The Chinese survey wasn't added.");
    await core.assignDocumentGroup(survey.id, coast.id);
    const agent = await connectLegacyAgent(writer.launch);
    const cite = await token(agent, "北码头 渔船", "北码头停泊着四十二艘渔船。");

    const saved = structured<Saved>(
      await save(agent, {
        title: "港口简报",
        markdown: `北码头停泊着四十二艘渔船${cite}。`,
        folderId: coast.id,
      }),
    );
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
    await opensWithoutRepair(file.bytes, "港口简报.docx");

    expect(refusal(await save(agent, { title: "港口简报" }))).toBe(
      "给出笔记的 mindId 或你的文字 markdown，只给其中一个。",
    );
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
});
