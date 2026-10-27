/**
 * What a Word export says for review (#107), through the core's public
 * interface: changes still waiting go in as IncarnaMind's tracked changes,
 * AI text and Citations whose check failed get IncarnaMind's comments, each
 * as its option says; and the tracked changes the writers share
 * (src/core/exports/wordReview.ts) mark runs, paragraphs and rows as Word does.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { Core, Document, ExportMindOptions, RecordCiteResult } from "../../src/core";
import { WordIds } from "../../src/core/exports/wordml";
import { trackBlocks, trackInline } from "../../src/core/exports/wordReview";
import { recordProposalRequest } from "../../src/shared/proposals";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { acceptedParagraphs, checkWellFormed, textOf, unzip } from "../helpers/docx";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { resolveChanges, writeMind } from "../helpers/minds";

const ASKED = "2026-10-12T14:30:00.000Z";

async function mindWith(
  core: Core,
  blocks: JSONContent[],
): Promise<{ id: string; client: MindClient }> {
  const mind = await core.createMind({ title: "" });
  const client = await connectToMind(core, mind.id);
  recordProposalRequest(client.doc, "r1", {
    source: "edit-with-ai",
    providerId: "anthropic",
    modelId: "claude",
    createdAt: ASKED,
  });
  writeMind(client, blocks);
  await client.settled();
  return { id: mind.id, client };
}

const text = (value: string, ...marks: JSONContent["marks"][]): JSONContent => {
  const all = marks.flat().filter((mark): mark is NonNullable<typeof mark> => mark !== undefined);
  return { type: "text", text: value, ...(all.length > 0 && { marks: all }) };
};
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const adds = (id: string) => [{ type: "proposalInsert", attrs: { id, request: "r1" } }];
const removes = (id: string) => [{ type: "proposalDelete", attrs: { id, request: "r1" } }];
const ai = [{ type: "generated" }];

async function word(core: Core, mindId: string, options: Partial<ExportMindOptions> = {}) {
  const result = await core.exportMind(mindId, { format: "docx", ...options });
  const files = unzip(result.data);
  const part = (name: string) => files.get(name)?.toString("utf8") ?? "";
  for (const [name, content] of files) {
    if (name.endsWith(".xml") || name.endsWith(".rels")) checkWellFormed(content.toString("utf8"));
  }
  return { files, document: part("word/document.xml"), part, checks: result.sentenceChecks };
}

async function tides(core: Core): Promise<Document> {
  const sources = await createTempDataFolder();
  const path = await writeSourceFile(sources, "Tides.txt", "Spring tides happen at new moon.");
  const [document] = await addAndProcess(core, [path]);
  return document as Document;
}

const citation = (document: Document, check: string, quote: string): JSONContent => ({
  type: "citation",
  attrs: {
    passageId: "p1",
    documentId: document.id,
    documentName: "Tides",
    contentHash: document.contentHash,
    pageFrom: 1,
    pageTo: 1,
    quote,
    check,
  },
});

describe("changes still waiting", () => {
  test("a replacement waiting to be accepted is IncarnaMind's deletion then insertion, dated when it was asked for", async () => {
    const core = startCore(await createTempDataFolder());
    const { id } = await mindWith(core, [
      paragraph(
        text("Rent is due "),
        text("monthly", removes("c1")),
        text("weekly", adds("c1")),
        text("."),
      ),
    ]);

    const { document } = await word(core, id);

    expect(document).toContain(
      '<w:del w:id="0" w:author="IncarnaMind" w:date="2026-10-12T14:30:00Z"><w:r><w:delText xml:space="preserve">monthly</w:delText></w:r></w:del><w:ins w:id="1" w:author="IncarnaMind" w:date="2026-10-12T14:30:00Z"><w:r><w:t xml:space="preserve">weekly</w:t></w:r></w:ins>',
    );
    expect(acceptedParagraphs(document)).toEqual(["Rent is due weekly."]);
  });

  test("a paragraph a change adds or removes is marked whole: its runs and its paragraph mark", async () => {
    const core = startCore(await createTempDataFolder());
    const added = {
      type: "paragraph",
      attrs: { proposal: { id: "c2", request: "r1", kind: "insert" } },
    };
    const removed = {
      type: "paragraph",
      attrs: { proposal: { id: "c3", request: "r1", kind: "delete" } },
    };
    const { id } = await mindWith(core, [
      paragraph(text("Kept.")),
      { ...removed, content: [text("Gone.")] },
      { ...added, content: [text("New.")] },
      paragraph(text("Last.")),
    ]);

    const { document } = await word(core, id);

    expect(document).toMatch(
      /<w:p><w:pPr><w:rPr><w:del w:id="\d+" w:author="IncarnaMind" w:date="2026-10-12T14:30:00Z"\/><\/w:rPr><\/w:pPr><w:del [^>]*><w:r><w:delText xml:space="preserve">Gone.<\/w:delText><\/w:r><\/w:del><\/w:p>/,
    );
    expect(document).toMatch(
      /<w:p><w:pPr><w:rPr><w:ins w:id="\d+" w:author="IncarnaMind"[^>]*\/><\/w:rPr><\/w:pPr><w:ins [^>]*><w:r><w:t xml:space="preserve">New.<\/w:t><\/w:r><\/w:ins><\/w:p>/,
    );
    expect(acceptedParagraphs(document)).toEqual(["Kept.", "New.", "Last."]);
  });

  test("accepting every change in Word gives the text accepting every change in IncarnaMind does", async () => {
    const core = startCore(await createTempDataFolder());
    const { id, client } = await mindWith(core, [
      paragraph(
        text("Spring tides are "),
        text("weakest", removes("c1")),
        text("strongest", adds("c1")),
        text(" at new moon."),
      ),
      {
        type: "paragraph",
        attrs: { proposal: { id: "c2", request: "r1", kind: "delete" } },
        content: [text("A sentence the change removes.")],
      },
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph(text("One"))] },
          {
            type: "listItem",
            attrs: { proposal: { id: "c3", request: "r1", kind: "insert" } },
            content: [paragraph(text("Two, added"))],
          },
        ],
      },
      paragraph(text("Neap tides come between."), text(" Twice a month.", adds("c4"))),
    ]);
    const shown = acceptedParagraphs((await word(core, id)).document);

    await resolveChanges(client, "accept");
    const accepted = acceptedParagraphs((await word(core, id)).document);

    expect(shown).toEqual(accepted);
    expect(accepted).toEqual([
      "Spring tides are strongest at new moon.",
      "One",
      "Two, added",
      "Neap tides come between. Twice a month.",
    ]);
  });

  test("a change out of date, which can only be rejected, goes in as the Mind reads it", async () => {
    const core = startCore(await createTempDataFolder());
    const stale = { id: "c9", request: "r1", target: "not the text it removes" };
    const { id } = await mindWith(core, [
      paragraph(
        text("Rent is due "),
        text("monthly", [{ type: "proposalDelete", attrs: stale }]),
        text("weekly", [{ type: "proposalInsert", attrs: stale }]),
        text("."),
      ),
    ]);

    const { document } = await word(core, id);

    expect(document).not.toMatch(/<w:(ins|del) /);
    expect(acceptedParagraphs(document)).toEqual(["Rent is due monthly."]);
  });
});

describe("IncarnaMind's comments", () => {
  test("AI text gets one comment a passage, across its paragraphs, when asked; none otherwise", async () => {
    const core = startCore(await createTempDataFolder());
    const { id } = await mindWith(core, [
      paragraph(text("My own line.")),
      paragraph(text("The AI's first paragraph.", ai)),
      paragraph(text("And its second.", ai)),
      paragraph(text("Mine again, "), text("with AI words", ai), text(" inside.")),
    ]);

    const marked = await word(core, id, { markAiText: true });
    const plain = await word(core, id, { markAiText: false });

    const comments = marked.part("word/comments.xml");
    expect([...comments.matchAll(/<w:comment /g)]).toHaveLength(2);
    expect(comments).toContain('w:author="IncarnaMind"');
    expect(comments).toContain("Written by IncarnaMind");
    // The first passage starts in one paragraph and ends in the next.
    const paragraphs = marked.document.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? [];
    expect(paragraphs[1]).toContain("<w:commentRangeStart w:id=");
    expect(paragraphs[1]).not.toContain("<w:commentRangeEnd");
    expect(paragraphs[2]).toContain("<w:commentRangeEnd w:id=");
    expect(paragraphs[2]).toContain(
      '<w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference',
    );
    expect(marked.part("word/_rels/document.xml.rels")).toContain('Target="comments.xml"');
    expect(marked.part("[Content_Types].xml")).toContain('PartName="/word/comments.xml"');
    expect(marked.part("word/styles.xml")).toContain('w:styleId="CommentText"');

    expect(plain.files.has("word/comments.xml")).toBe(false);
    expect(plain.document).not.toContain("commentRange");
    expect(plain.part("word/styles.xml")).not.toContain("CommentText");
  });

  test("a Citation whose check failed gets a comment saying what failed; one whose quote was found gets none", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await tides(core);
    const { id } = await mindWith(core, [
      paragraph(
        text("Spring tides happen at new moon."),
        citation(document, "found", "Spring tides happen at new moon."),
      ),
      paragraph(
        text("Neap tides are the highest."),
        citation(document, "not-found", "Neap tides are the highest."),
      ),
    ]);

    const commented = await word(core, id, { commentFailedChecks: true });
    const plain = await word(core, id, { commentFailedChecks: false });

    const comments = commented.part("word/comments.xml");
    expect([...comments.matchAll(/<w:comment /g)]).toHaveLength(1);
    expect(comments).toContain("Quote not found in Tides, p. 1: “Neap tides are the highest.”");
    const [, second] = commented.document.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? [];
    expect(second).toMatch(
      /<w:commentRangeStart w:id="(\d+)"\/><w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/><\/w:rPr><w:footnoteReference w:id="2"\/><\/w:r><w:commentRangeEnd w:id="\1"\/>/,
    );
    expect(plain.files.has("word/comments.xml")).toBe(false);
  });

  test("the quote a comment gives, cut at a PDF's line end, reads as words", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await tides(core);
    const { id } = await mindWith(core, [
      paragraph(
        text("The harbour office hired staff."),
        citation(
          document,
          "not-found",
          "The harbour office has em-\nployed more av-\nerage staff.",
        ),
      ),
    ]);

    const { part } = await word(core, id, { commentFailedChecks: true });

    expect(part("word/comments.xml")).toContain(
      "Quote not found in Tides, p. 1: “The harbour office has employed more average staff.”",
    );
  });

  test("a quote that is in its Document reads in the comment as it does on the card: a real hyphen the page writes elsewhere stays", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createTempDataFolder();
    const [harbour] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Harbour.txt",
        "The council will co-\noperate with the office. The two co-operate daily.",
      ),
    ]);
    if (!harbour) throw new Error("Harbour was not added.");
    const { id } = await mindWith(core, [
      paragraph(
        text("The council works with the office."),
        citation(harbour, "not-found", "council will co-\noperate with the office"),
      ),
    ]);

    const { part } = await word(core, id, { commentFailedChecks: true });

    expect(part("word/comments.xml")).toContain(
      "Quote not found in Harbour, p. 1: “council will co-operate with the office”",
    );
  });

  test("without any option, a Mind with no change waiting is the file it was before #107", async () => {
    const core = startCore(await createTempDataFolder());
    const { id } = await mindWith(core, [paragraph(text("AI words", ai)), paragraph(text("Mine"))]);

    const { files } = await word(core, id);

    expect(files.has("word/comments.xml")).toBe(false);
    expect([...files.keys()].sort()).toEqual(
      [
        "[Content_Types].xml",
        "_rels/.rels",
        "docProps/core.xml",
        "word/_rels/document.xml.rels",
        "word/document.xml",
        "word/footnotes.xml",
        "word/numbering.xml",
        "word/settings.xml",
        "word/styles.xml",
      ].sort(),
    );
  });
});

describe("sentences whose check isn't good", () => {
  const checkOf = (
    document: Document,
    id: string,
    state: "supported" | "unsupported" | "contradicted",
    asked: string,
    more: Record<string, unknown> = {},
  ) => ({
    type: "claimCheck",
    attrs: {
      id,
      request: "r1",
      action: "check-against-documents",
      state,
      reason: null,
      detail: null,
      text: asked,
      evidence: null,
      says: null,
      calculation: null,
      scope: { folderId: null, widened: false },
      versions: [{ documentId: document.id, contentHash: document.contentHash }],
      excluded: [],
      checkedAt: ASKED,
      ...more,
    },
  });

  const recordCites = (document: Document): RecordCiteResult[] => [
    {
      raw: "Smith Dep. 45:3–12",
      outcome: "supported",
      documentId: document.id,
      documentName: "Tides",
      contentHash: document.contentHash,
      location: {
        kind: "page",
        from: 4,
        to: 4,
        printed: { from: "45", to: "45" },
        lines: { from: 3, to: 12 },
      },
      pageFrom: 4,
      pageTo: 4,
      passage: "The deposition supports the sentence.",
    },
    {
      raw: "Ex. 7 at 3",
      outcome: "partly",
      documentId: document.id,
      documentName: "Tides",
      contentHash: document.contentHash,
      location: { kind: "page", from: 3, to: 3 },
      pageFrom: 3,
      pageTo: 3,
      passage: "The exhibit covers one part.",
      covered: "the delivery attempt",
      uncovered: "receipt by the defendant",
    },
    {
      raw: "ECF No. 41 at 5",
      outcome: "choose",
      candidates: [
        { id: document.id, name: "Tides" },
        { id: "other", name: "Other filing" },
      ],
    },
    {
      raw: "Dkt. 41 at 6",
      outcome: "not-found",
      documentId: document.id,
      documentName: "Tides",
      contentHash: document.contentHash,
      location: { kind: "page", from: 6, to: 6 },
      pageFrom: 6,
      pageTo: 6,
      passage: "The cited page concerns another event.",
      nearby: {
        location: { kind: "page", from: 7, to: 7, lines: { from: 5, to: 9 } },
        pageFrom: 7,
        pageTo: 7,
        passage: "The point appears nearby instead.",
      },
    },
  ];

  const RECORD_SENTENCE = "The record supports only part of this claim.";

  async function recordSentence(
    language: "en" | "zh-CN" = "en",
    state: "supported" | "unsupported" = "supported",
  ) {
    const core = startCore(await createTempDataFolder());
    await core.updateSettings({ user: { language } });
    const document = await tides(core);
    const { id } = await mindWith(core, [
      paragraph(
        text(RECORD_SENTENCE, [
          checkOf(document, "record-cites", state, RECORD_SENTENCE, {
            recordCites: recordCites(document),
          }),
        ]),
      ),
    ]);
    return { core, id };
  }

  async function sentences(language: "en" | "zh-CN" = "en") {
    const core = startCore(await createTempDataFolder());
    await core.updateSettings({ user: { language } });
    const document = await tides(core);
    const says = "The annual report (p. 69) says £182.9m, not £192.9m.";
    const { id } = await mindWith(core, [
      paragraph(
        text("Halden held cash of £192.9m.", [
          checkOf(document, "c1", "contradicted", "Halden held cash of £192.9m.", { says }),
        ]),
        text(" "),
        text("Net debt fell to £410.5m.", [
          checkOf(document, "c2", "supported", "Net debt fell to £410.5m."),
        ]),
      ),
      paragraph(
        text("Margins widened in 2026.", [
          checkOf(document, "c3", "unsupported", "Margins widened in 2026."),
        ]),
      ),
      paragraph(
        text("Headroom will widen in 2027.", [
          checkOf(document, "c4", "supported", "Headroom widens in 2027."),
        ]),
      ),
    ]);
    return { core, id, says };
  }

  /** Each comment's words, with the words of the text its range holds. */
  function commentsOn(exported: Awaited<ReturnType<typeof word>>) {
    const comments = exported.part("word/comments.xml");
    return [...comments.matchAll(/<w:comment w:id="(\d+)"[^>]*>([\s\S]*?)<\/w:comment>/g)].map(
      ([, id, body]) => {
        const range = new RegExp(
          `<w:commentRangeStart w:id="${id}"/>([\\s\\S]*?)<w:commentRangeEnd w:id="${id}"/>`,
        ).exec(exported.document);
        return { comment: textOf(body ?? ""), on: textOf(range?.[1] ?? "") };
      },
    );
  }

  test("a Contradicted, an Unsupported and a Needs re-check sentence each get a comment by the sentence; a supported one gets none", async () => {
    const { core, id, says } = await sentences();

    const exported = await word(core, id, { commentFailedChecks: true });

    expect(commentsOn(exported)).toEqual([
      { comment: `Contradicted: ${says}`, on: "Halden held cash of £192.9m." },
      {
        comment: "Not found: I didn’t find this in “All Documents”.",
        on: "Margins widened in 2026.",
      },
      {
        comment: "Needs re-check: changed since it was checked.",
        on: "Headroom will widen in 2027.",
      },
    ]);
    expect(exported.part("word/comments.xml")).toContain('w:author="IncarnaMind"');
  });

  test("the comments are in Chinese in a Chinese interface", async () => {
    const { core, id, says } = await sentences("zh-CN");

    const exported = await word(core, id, { commentFailedChecks: true });

    expect(commentsOn(exported).map((each) => each.comment)).toEqual([
      `与文档矛盾：${says}`,
      "未找到：未在“全部文档”中找到。",
      "需重新核对：核对后已修改。",
    ]);
  });

  test("the export counts them by result, as comments when asked for, else as sentences that went out unmarked", async () => {
    const { core, id } = await sentences();

    const commented = await core.exportMind(id, { format: "docx", commentFailedChecks: true });
    const plain = await core.exportMind(id, { format: "docx", commentFailedChecks: false });
    const markdown = await core.exportMind(id, { format: "markdown" });

    const counts = { contradicted: 1, notFound: 1, unsupported: 0, needsRecheck: 1 };
    expect(commented.sentenceChecks).toEqual({ ...counts, commented: true });
    expect(plain.sentenceChecks).toEqual({ ...counts, commented: false });
    expect(markdown.sentenceChecks).toEqual({ ...counts, commented: false });
  });

  test("with the option off no comment is written", async () => {
    const { core, id } = await sentences();

    const { files, document } = await word(core, id, { commentFailedChecks: false });

    expect(files.has("word/comments.xml")).toBe(false);
    expect(document).not.toContain("commentRange");
  });

  test("a check that is supported, or was made of the sentence as it reads now, has no comment", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await tides(core);
    const { id } = await mindWith(core, [
      paragraph(
        text("Spring tides happen at new moon.", [
          checkOf(document, "c1", "supported", "Spring tides happen at new moon."),
        ]),
      ),
    ]);

    const exported = await core.exportMind(id, { format: "docx", commentFailedChecks: true });

    expect(exported.sentenceChecks).toEqual({
      contradicted: 0,
      notFound: 0,
      unsupported: 0,
      needsRecheck: 0,
      commented: true,
    });
    expect(unzip(exported.data).has("word/comments.xml")).toBe(false);
  });

  test("a Supported sentence's comment lists every record cite and its passage without changing the counts", async () => {
    const { core, id } = await recordSentence();

    const exported = await word(core, id, { commentFailedChecks: true });

    const [entry] = commentsOn(exported);
    expect(entry?.on).toBe(RECORD_SENTENCE);
    const comment = entry?.comment ?? "";
    for (const words of [
      "Smith Dep. 45:3–12: Supported",
      "Tides, p. 45 · lines 3–12",
      "Passage: The deposition supports the sentence.",
      "Ex. 7 at 3: Partly",
      "Passage: The exhibit covers one part.",
      "Covers the delivery attempt; does not cover receipt by the defendant.",
      "ECF No. 41 at 5: Choose a Document",
      "Documents to choose from: Tides, Other filing",
      "Dkt. 41 at 6: Not found",
      "Passage: The cited page concerns another event.",
      "Nearby suggestion: Tides, p. 7 · lines 5–9",
      "The point appears nearby instead.",
    ]) {
      expect(comment).toContain(words);
    }
    const rawOrder = ["Smith Dep. 45:3–12", "Ex. 7 at 3", "ECF No. 41 at 5", "Dkt. 41 at 6"];
    const positions = rawOrder.map((raw) => comment.indexOf(raw));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(exported.checks).toEqual({
      contradicted: 0,
      notFound: 0,
      unsupported: 0,
      needsRecheck: 0,
      commented: true,
    });

    const plain = await word(core, id, { commentFailedChecks: false });
    expect(plain.files.has("word/comments.xml")).toBe(false);
    expect(plain.checks).toEqual({ ...exported.checks, commented: false });
  });

  test("record-cite comments use Chinese outcomes, labels and Locations", async () => {
    const { core, id } = await recordSentence("zh-CN");

    const exported = await word(core, id, { commentFailedChecks: true });

    const comment = commentsOn(exported)[0]?.comment ?? "";
    for (const words of [
      "Smith Dep. 45:3–12：有依据",
      "Tides，第 45 页 · 第 3–12 行",
      "段落：The deposition supports the sentence.",
      "Ex. 7 at 3：部分有依据",
      "ECF No. 41 at 5：选择文档",
      "可选文档：Tides，Other filing",
      "Dkt. 41 at 6：未找到",
      "附近段落建议：Tides，第 7 页 · 第 5–9 行",
    ]) {
      expect(comment).toContain(words);
    }
    expect(exported.checks).toEqual({
      contradicted: 0,
      notFound: 0,
      unsupported: 0,
      needsRecheck: 0,
      commented: true,
    });
  });

  test("record cites append to the sentence's existing result without changing it", async () => {
    const { core, id } = await recordSentence("en", "unsupported");

    const exported = await word(core, id, { commentFailedChecks: true });

    const comment = commentsOn(exported)[0]?.comment ?? "";
    expect(comment).toContain("Not found: I didn’t find this in “All Documents”.");
    expect(comment).toContain("Smith Dep. 45:3–12: Supported");
    expect(exported.checks).toEqual({
      contradicted: 0,
      notFound: 1,
      unsupported: 0,
      needsRecheck: 0,
      commented: true,
    });
  });

  test.each([
    ["en", "Cited case not checked: not in the Documents."],
    ["zh-CN", "所引判决尚未核对：不在文档中。"],
  ] as const)(
    "a Supported sentence whose cited case is in no Document gets a comment, one whose case is among them none (%s)",
    async (language, comment) => {
      const core = startCore(await createTempDataFolder());
      await core.updateSettings({ user: { language } });
      const document = await tides(core);
      const { id } = await mindWith(core, [
        paragraph(
          text("Spring tides happen at new moon, see Fake v. Case, 1 U.S. 1 (1800).", [
            checkOf(
              document,
              "c1",
              "supported",
              "Spring tides happen at new moon, see Fake v. Case, 1 U.S. 1 (1800).",
              {
                citedCaseUnchecked: true,
              },
            ),
          ]),
        ),
        paragraph(
          text("Spring tides happen at full moon, see Real v. Case, 2 U.S. 2 (1801).", [
            checkOf(
              document,
              "c2",
              "supported",
              "Spring tides happen at full moon, see Real v. Case, 2 U.S. 2 (1801).",
              {
                citedCaseFound: true,
              },
            ),
          ]),
        ),
      ]);

      const exported = await word(core, id, { commentFailedChecks: true });

      expect(commentsOn(exported)).toEqual([
        { comment, on: "Spring tides happen at new moon, see Fake v. Case, 1 U.S. 1 (1800)." },
      ]);
    },
  );

  test("an Unsupported sentence with a nearest line says what the Documents say instead, and where", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await tides(core);
    const nearest = {
      passageId: "p1",
      documentId: document.id,
      documentName: "Tides",
      contentHash: document.contentHash,
      pageFrom: 1,
      pageTo: 1,
      quote: "Spring tides happen at new moon.",
      check: "found",
    };
    const { id } = await mindWith(core, [
      paragraph(
        text("Spring tides happen at half moon.", [
          checkOf(document, "c1", "unsupported", "Spring tides happen at half moon.", {
            evidence: nearest,
          }),
        ]),
      ),
    ]);

    const exported = await word(core, id, { commentFailedChecks: true });

    expect(commentsOn(exported)).toEqual([
      {
        comment:
          "Unsupported: your Documents say something different (“Spring tides happen at new moon.”, Tides, p. 1)",
        on: "Spring tides happen at half moon.",
      },
    ]);
  });

  test("a Document with a new version since the check makes it need a re-check", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await tides(core);
    const { id } = await mindWith(core, [
      paragraph(
        text("Spring tides happen at new moon.", [
          checkOf(document, "c1", "supported", "Spring tides happen at new moon.", {
            versions: [{ documentId: document.id, contentHash: "an older version" }],
          }),
        ]),
      ),
    ]);

    const exported = await word(core, id, { commentFailedChecks: true });

    expect(commentsOn(exported)).toEqual([
      {
        comment: "Needs re-check: a Document it was checked against has a new version.",
        on: "Spring tides happen at new moon.",
      },
    ]);
  });
});

describe("tracked changes as Word writes them", () => {
  const by = (kind: "insert" | "delete") => ({ kind, author: "Priya Raman", date: ASKED });

  test("runs go inside the change; a link's go inside the link; marks between runs stay where they are", () => {
    const xml =
      '<w:r><w:t>One</w:t></w:r><w:bookmarkStart w:id="9" w:name="b"/><w:hyperlink r:id="rId3"><w:r><w:t>two</w:t></w:r></w:hyperlink>';

    expect(trackInline(xml, by("insert"), new WordIds())).toBe(
      '<w:ins w:id="0" w:author="Priya Raman" w:date="2026-10-12T14:30:00Z"><w:r><w:t>One</w:t></w:r></w:ins><w:bookmarkStart w:id="9" w:name="b"/><w:hyperlink r:id="rId3"><w:ins w:id="1" w:author="Priya Raman" w:date="2026-10-12T14:30:00Z"><w:r><w:t>two</w:t></w:r></w:ins></w:hyperlink>',
    );
  });

  test("deleted text is w:delText, a field's code w:delInstrText; deleting what someone inserted marks it inside their insertion", () => {
    const xml =
      '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:ins w:id="5" w:author="Lars"><w:r><w:t>theirs</w:t></w:r></w:ins><w:del w:id="6" w:author="Lars"><w:r><w:delText>gone</w:delText></w:r></w:del>';

    expect(trackInline(xml, by("delete"), new WordIds())).toBe(
      '<w:del w:id="0" w:author="Priya Raman" w:date="2026-10-12T14:30:00Z"><w:r><w:delInstrText xml:space="preserve"> PAGE </w:delInstrText></w:r></w:del><w:ins w:id="5" w:author="Lars"><w:del w:id="1" w:author="Priya Raman" w:date="2026-10-12T14:30:00Z"><w:r><w:delText>theirs</w:delText></w:r></w:del></w:ins><w:del w:id="6" w:author="Lars"><w:r><w:delText>gone</w:delText></w:r></w:del>',
    );
  });

  test("a paragraph's mark goes first in its run properties, and a row's change last in its properties", () => {
    const ids = new WordIds();
    const blocks =
      '<w:p><w:pPr><w:pStyle w:val="Body"/><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t>A</w:t></w:r></w:p>' +
      "<w:tbl><w:tblPr/><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:p/></w:tc></w:tr></w:tbl>";

    const deleted = trackBlocks(blocks, by("delete"), ids);

    expect(deleted).toBe(
      '<w:p><w:pPr><w:pStyle w:val="Body"/><w:rPr><w:del w:id="0" w:author="Priya Raman" w:date="2026-10-12T14:30:00Z"/><w:b/></w:rPr></w:pPr><w:del w:id="1" w:author="Priya Raman" w:date="2026-10-12T14:30:00Z"><w:r><w:delText>A</w:delText></w:r></w:del></w:p>' +
        '<w:tbl><w:tblPr/><w:tr><w:trPr><w:cantSplit/><w:del w:id="2" w:author="Priya Raman" w:date="2026-10-12T14:30:00Z"/></w:trPr><w:tc><w:p><w:pPr><w:rPr><w:del w:id="3" w:author="Priya Raman" w:date="2026-10-12T14:30:00Z"/></w:rPr></w:pPr></w:p></w:tc></w:tr></w:tbl>',
    );
  });
});
