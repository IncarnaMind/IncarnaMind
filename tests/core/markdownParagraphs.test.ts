/**
 * A Markdown file with no headings is cited by its paragraphs, as a Word file with none is (#3657):
 * through the agents' `search` and `cite`, as Claude Code calls them, a quote names its paragraph,
 * and two quotes of one paragraph side by side are one chip (#3654). A Note cited before, whose
 * Citations name the whole file, keeps them as they were once the file is read again: they are
 * checked at the place they name, numbered apart from new ones, and exported as they were.
 */
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { ALL_SHARED_ID, CITATION_NODE, type CitationLocation } from "../../src/core/api";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import { openDatabase } from "../../src/core/storage";
import { numberFootnotes } from "../../src/renderer/src/editor/citationNumbers";
import { citedLocation } from "../../src/shared/citations";
import { translate } from "../../src/shared/i18n";
import {
  agentsAdapter,
  buildAgentShim,
  connectLegacyAgent,
  startAgentsCore,
} from "../helpers/agents";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { footnotesOf, part, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";

const TRANSCRIPT = [
  "Interviewer: How did the harbour change after the war?",
  "",
  "Alex Moran: The east quay grew first.",
  "",
  "Alex Moran: The fishing fleet doubled within ten years, and the east quay held 31 boats by 1956.",
  "",
  "Interviewer: And the ferry?",
  "",
  "Alex Moran: The ferry ran all winter until the new bridge opened in 1971.",
].join("\n");
const FLEET = "The fishing fleet doubled within ten years";
const BOATS = "the east quay held 31 boats by 1956";
const FERRY = "The ferry ran all winter";
const PARAGRAPH = (number: number) => `¶ ${number}`;

interface Cited {
  citations: { check: string; cite: string | null; location: string | null }[];
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

/** Each Citation of the Note: its number, and the place of the Citation whose chip shows it. */
async function chipsOf(core: ReturnType<typeof startCore>, mindId: string) {
  const client = await connectToMind(core, mindId);
  const documents = await core.listDocuments();
  return numberFootnotes(readMind(client), "numbered", { documents }).citations.map(
    (each) => `${each.number}@${each.shownBy}`,
  );
}

describe("a Markdown file with no headings, cited by paragraph (#3657)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a heading-less Markdown transcript's quotes name their paragraphs through the agents' tools, and quotes of one paragraph side by side make one chip; fails_when=cite answers with no place, or the three quotes get three numbers
  it("names each quote's paragraph through search and cite, and two of one paragraph side by side are one chip", async () => {
    const { core } = await startAgentsCore(replyingModel());
    const sources = await createSourceFolder();
    const [interview] = await addAndProcess(core, [
      await writeSourceFile(sources, "Harbour interview.md", TRANSCRIPT),
    ]);
    if (!interview) throw new Error("The interview wasn't added.");
    await core.setAgentsEnabled(true);
    const agent = await connectLegacyAgent(
      (await core.connectAgent({ name: "Claude Code", folderIds: [ALL_SHARED_ID], propose: true }))
        .launch,
    );

    const { passages } = structured<{
      passages: { passageId: string; location: string | null }[];
    }>(
      await agent.callTool({ name: "search", arguments: { query: "fishing fleet ferry winter" } }),
    );
    expect(passages[0]?.location).toMatch(/^¶ /);

    const passageId = passages[0]?.passageId;
    const { citations } = structured<Cited>(
      await agent.callTool({
        name: "cite",
        arguments: { citations: [FLEET, BOATS, FERRY].map((quote) => ({ passageId, quote })) },
      }),
    );
    expect(citations.map((each) => [each.check, each.location])).toEqual([
      ["found", PARAGRAPH(3)],
      ["found", PARAGRAPH(3)],
      ["found", PARAGRAPH(5)],
    ]);

    const tags = citations.map((each) => each.cite).join(" ");
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Harbour",
          markdown: `The fleet doubled, the east quay grew and the ferry kept running ${tags}.`,
        },
      }),
    );
    // "1 2": the first chip stands for the two quotes of paragraph 3.
    expect(await chipsOf(core, mindId)).toEqual(["1@0", "1@0", "2@2"]);
  });

  // protects=a Note cited before the change keeps its whole-file Citations once the file is read again: found at their place, numbered apart from a new paragraph Citation, and exported as before; fails_when=the old Citation is not found, takes the new one's number, or its footnote names a paragraph
  it("keeps a Note cited before: checked at the whole file, numbered apart from a new one, exported as it was", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir);
    const sources = await createSourceFolder();
    const [interview] = await addAndProcess(before, [
      await writeSourceFile(sources, "Harbour interview.md", TRANSCRIPT),
    ]);
    if (!interview) throw new Error("The interview wasn't added.");
    const [passage] = queryDatabase<{ id: string }>(
      dataDir,
      "SELECT id FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position",
      [interview.id],
    );
    // A Citation as the reader before this change made one: its place the whole file.
    const wholeFile: CitationLocation = { kind: "section", heading: null };
    const old = {
      passageId: passage?.id ?? "",
      documentId: interview.id,
      documentName: interview.name,
      contentHash: interview.contentHash,
      pageFrom: 1,
      pageTo: 1,
      quote: FLEET,
      check: "found" as const,
      checkReason: null,
      location: wholeFile,
    };
    const mind = await before.createMind({ title: "Harbour" });
    const writing = await connectToMind(before, mind.id);
    writeMind(writing, [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "The fleet doubled." },
          { type: CITATION_NODE, attrs: old },
        ],
      },
    ]);
    await writing.settled();
    await before.close();

    // As the reader before left the file: Units that number no paragraph, read by version 30.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.transaction(() => {
        db.run("UPDATE documents SET processing_version = 30 WHERE id = ?", [interview.id]);
        db.run(
          "UPDATE document_pages SET anchors = '[]' WHERE document_id = ? AND deleted_at IS NULL",
          [interview.id],
        );
      });
    } finally {
      db.close();
    }

    const core = startCore(dataDir, { agents: await agentsAdapter(dataDir) });
    await waitForProcessing(core, [interview.id]);
    expect(
      queryDatabase(dataDir, "SELECT processing_version FROM documents WHERE id = ?", [
        interview.id,
      ]),
    ).toEqual([{ processing_version: PROCESSING_VERSION }]);
    // Read again, the file's Passages are the ones the old Citation names.
    expect(
      queryDatabase<{ id: string }>(
        dataDir,
        "SELECT id FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position",
        [interview.id],
      )[0]?.id,
    ).toBe(passage?.id);

    // The old Citation is found where it says it is, the whole file, as before.
    const again = await core.recheckCitation({
      documentId: interview.id,
      quote: FLEET,
      pageFrom: 1,
      pageTo: 1,
      contentHash: interview.contentHash,
      location: wholeFile,
      mindId: mind.id,
    });
    expect(again).toMatchObject({ check: "found", contentHash: interview.contentHash });
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate("en", key, params);
    // Its card names the Document only; a new Citation's names its paragraph.
    expect(citedLocation(old, t)).toBeNull();

    // A new Citation of the same words, as the viewer makes one, names paragraph 3.
    const fresh = await core.citeSelection({
      documentId: interview.id,
      parts: [{ unit: 1, text: FLEET }],
      mindId: mind.id,
    });
    expect(fresh).toMatchObject({ check: "found", quote: FLEET });
    expect(
      citedLocation(
        { location: fresh.location, pageFrom: fresh.pageFrom, pageTo: fresh.pageTo },
        t,
      ),
    ).toBe(PARAGRAPH(3));
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "The fleet doubled." },
          { type: CITATION_NODE, attrs: old },
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "It doubled within ten years." },
          {
            type: CITATION_NODE,
            attrs: {
              ...old,
              passageId: fresh.passageId,
              pageFrom: fresh.pageFrom,
              pageTo: fresh.pageTo,
              location: fresh.location,
            },
          },
        ],
      },
    ]);
    await client.settled();
    // Their places differ, so they are two notes: each keeps its own number.
    expect(await chipsOf(core, mind.id)).toEqual(["1@0", "2@1"]);

    // Word writes the old one's note as before, the Document's name alone, and the new one's with its paragraph.
    const exported = await core.exportMind(mind.id, { format: "docx" });
    expect(exported.footnotes).toBe(2);
    expect(Object.values(footnotesOf(part(unzip(exported.data), "word/footnotes.xml")))).toEqual([
      expect.stringMatching(/^Harbour interview\.?$/),
      expect.stringContaining(PARAGRAPH(3)),
    ]);
  });
});
