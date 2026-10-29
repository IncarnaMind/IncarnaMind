/**
 * Verify on a Word file someone else wrote (#110), through the core's public interface: the
 * file comes in as a Mind imported from it, with another author's tracked changes and comments
 * kept; its claims are found and checked against the User's Documents, the file and its copies
 * never evidence; and the export back into the file writes each Unsupported and Contradicted
 * result as a Word comment naming the evidence Document and page, the file's own comments and
 * changes as they were, in a package Word opens without repairing.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { inspectPackage } from "../../eval/word/corpus";
import type { Core } from "../../src/core";
import { openWordPackage, reviewOf } from "../../src/core/documents/formats/docxPackage";
import { COMMENTS_CONTENT_TYPE, COMMENTS_RELATIONSHIP } from "../../src/core/exports/wordml";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { pendingProposals } from "../../src/shared/proposals";
import { textOriginOf } from "../../src/shared/textOrigins";
import { verificationOf } from "../../src/shared/verification";
import { wordFileOf } from "../../src/shared/wordFiles";
import { shownPassages } from "../helpers/citations";
import { addAndProcess } from "../helpers/documents";
import { textOf, unzip } from "../helpers/docx";
import type { MindClient } from "../helpers/mindClient";
import { editMind, readMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";
import {
  COMMENTED,
  CONTRADICTED,
  DANA,
  DIFFERS,
  NOT_FOUND,
  verifyRequest as request,
  SUPPORTED,
  setUpWordVerify as setUp,
  THEIRS_ADDED,
  UNCOMMENTED_REPORT,
  verifyWordFile as verified,
} from "../helpers/verifiedWord";
import { paragraph, tracked, wordFile } from "../helpers/word";

/** Each claim's sentence and its mark's state, as the editor shows it now. */
async function shownChecks(core: Core, client: MindClient) {
  await client.settled();
  const versions = new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));
  return claimSpans(readMind(client)).map((span) => [
    span.sentence.text,
    claimCheckShown(span.check, { text: span.sentence.text, versions, folderId: null, scope: null })
      .state,
  ]);
}

/** Verifies the report and checks its claims. */
async function checkedReport(calls?: ModelCall[], language: "en" | "zh-CN" = "en") {
  const set = await setUp(calls, language);
  const made = await verified(set.core, set.report);
  expect(await set.core.findClaims(request(made.mind.id))).toEqual({ kind: "found", claims: 4 });
  await set.core.verifyClaims(request(made.mind.id));
  return { ...set, ...made };
}

/** The export into the file, its parts, and each comment's words with the words its range holds. */
async function exported(core: Core, mindId: string) {
  const result = await core.exportMind(mindId, { format: "docx", commentFailedChecks: true });
  const files = unzip(result.data);
  const part = (name: string) => files.get(name)?.toString("utf8") ?? "";
  const document = part("word/document.xml");
  const comments = [
    ...part("word/comments.xml").matchAll(
      /<w:comment w:id="(\d+)" w:author="([^"]*)"[^>]*>([\s\S]*?)<\/w:comment>/g,
    ),
  ].map(([, id, author, body]) => {
    const range = new RegExp(
      `<w:commentRangeStart w:id="${id}"/>([\\s\\S]*?)<w:commentRangeEnd w:id="${id}"/>(<w:r><w:rPr><w:rStyle w:val="[^"]+"/></w:rPr><w:commentReference w:id="${id}"/></w:r>)?`,
    ).exec(document);
    return {
      author,
      comment: textOf(body ?? ""),
      on: textOf(range?.[1] ?? ""),
      marked: range?.[2] !== undefined,
    };
  });
  return { result, files, part, document, comments };
}

describe("Verify a Word file someone else wrote", () => {
  test("it comes in as a Mind imported from the file, their change and comment kept; its claims are found and checked, the sentence their change holds left to the reviewing pane", async () => {
    const { core, report } = await setUp();
    const { client, mind, documentId } = await verified(core, report);

    expect(mind.title).toBe("Checking: Harbour report");
    expect(verificationOf(client.doc)).toEqual({
      documentId,
      documentName: "Harbour report",
      pages: {},
      claims: null,
    });
    // Kept to export back into, its original the Document it verifies.
    expect(wordFileOf(client.doc)).toMatchObject({ name: "Harbour report.docx", documentId });
    const document = (await core.listDocuments()).find((each) => each.id === documentId);
    expect(document).toMatchObject({ name: "Harbour report", notCited: true });
    const blocks: JSONContent[] = readMind(client).toJSON().content ?? [];
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    expect(blocks.map((block) => textOriginOf(client.doc, String(block.attrs?.id)))).toEqual(
      blocks.map(() => "checked-document"),
    );
    expect(pendingProposals(client.blocks)).toHaveLength(1);
    expect(JSON.stringify(blocks)).toContain("Please confirm the source.");

    expect(await core.findClaims(request(mind.id))).toEqual({ kind: "found", claims: 4 });
    await client.settled();
    expect(verificationOf(client.doc)?.claims?.map((claim) => claim.text)).toEqual([
      SUPPORTED,
      CONTRADICTED,
      DIFFERS,
      COMMENTED,
    ]);
    expect(await core.verifyClaims(request(mind.id))).toEqual({
      kind: "checked",
      claims: 4,
      checked: 4,
      stop: null,
    });
    expect(await shownChecks(core, client)).toEqual([
      [SUPPORTED, "supported"],
      [CONTRADICTED, "contradicted"],
      [DIFFERS, "unsupported"],
      [COMMENTED, "unsupported"],
    ]);
  });

  test("a long file is whole in its Mind when Verify returns, so a claim at its end is found", async () => {
    const { core, report } = await setUp();
    const filler = Array.from({ length: 450 }, (_, at) => paragraph(`Line ${at + 1}.`));
    await writeFile(report, wordFile({ body: [...filler, paragraph(CONTRADICTED)].join("") }));
    const { mind, client } = await verified(core, report);

    expect(client.blocks.length).toBe(451);
    expect(await core.findClaims(request(mind.id))).toEqual({ kind: "found", claims: 1 });
  });

  test("a Mind that doesn't get every Block of the file isn't reported as verified", async () => {
    const { core, report } = await setUp();
    const filler = Array.from({ length: 3500 }, (_, at) => paragraph(`Line ${at + 1}.`));
    await writeFile(report, wordFile({ body: filler.join("") }));
    const stop = core.on("minds.changed", (minds) => {
      const made = minds.find((each) => each.title === "Checking: Harbour report");
      if (!made) return;
      stop();
      void core.deleteMind(made.id);
    });

    expect(await core.verifyDocument({ path: report })).toEqual({
      ok: false,
      reason: "word",
      refusal: "unreadable",
    });
  });

  test("a paragraph the User writes in its Mind isn't one of its claims", async () => {
    const set = await setUp();
    const { mind, client } = await verified(set.core, set.report);
    editMind(client, (blocks) => [
      ...blocks,
      { type: "paragraph", content: [{ type: "text", text: CONTRADICTED.replace("week", "day") }] },
    ]);
    await client.settled();

    expect(await set.core.findClaims(request(mind.id))).toEqual({ kind: "found", claims: 4 });
  });

  test.each([
    { name: "Old report.doc", bytes: Buffer.from("not a package"), refusal: "legacy" },
    { name: "Damaged report.docx", bytes: Buffer.from("not a package"), refusal: "damaged" },
  ])(
    "a file Word import refuses ($refusal) is refused before anything is added",
    async ({ name, bytes, refusal }) => {
      const { core, sources } = await setUp();
      const path = join(sources, name);
      await writeFile(path, bytes);
      const before = await core.listDocuments();
      const minds = await core.listMinds();

      expect(await core.verifyDocument({ path })).toEqual({ ok: false, reason: "word", refusal });
      expect(await core.listDocuments()).toHaveLength(before.length);
      expect(await core.listMinds()).toHaveLength(minds.length);
    },
  );
});

describe("the verified file and its copies are never evidence", () => {
  test("the file, a copy elsewhere and a copy under another name are left out, even counted as evidence; ordinary search still finds them", async () => {
    const calls: ModelCall[] = [];
    const { core, sources, report } = await setUp(calls);
    await mkdir(join(sources, "Received"), { recursive: true });
    const copies = [
      join(sources, "Received", "Harbour report.docx"),
      join(sources, "Harbour report (from Dana).docx"),
    ];
    for (const copy of copies) await copyFile(report, copy);
    const added = await addAndProcess(core, copies);
    const { mind, documentId } = await verified(core, report);
    for (const each of [documentId, ...added.map((document) => document.id)]) {
      await core.setNotCited(each, false);
    }

    await core.findClaims(request(mind.id));
    await core.verifyClaims(request(mind.id));

    const searched = calls.flatMap((call) =>
      call.results
        .filter((result) => result.tool === "search_documents")
        .flatMap((result) => shownPassages(result.text).map((passage) => passage.document)),
    );
    expect(searched.length).toBeGreaterThan(0);
    expect(new Set(searched)).toEqual(new Set(["Tides"]));
    const ids = new Set([documentId, ...added.map((document) => document.id)]);
    const found = await core.searchPassages("When was the harbour wall raised?");
    expect(found.some((each) => ids.has(each.documentId))).toBe(true);
  });
});

describe("the export back into the file", () => {
  test("each Unsupported and Contradicted claim gets IncarnaMind's comment on its own words, naming the evidence Document and page; supported ones get none", async () => {
    const { core, mind } = await checkedReport();

    const { comments, result } = await exported(core, mind.id);

    expect(comments.filter((each) => each.author === "IncarnaMind")).toEqual([
      {
        author: "IncarnaMind",
        comment:
          "Contradicted: Tides says harbours publish them every year, not every week (“Harbours publish the times of high water every year.”, Tides, p. 1)",
        on: CONTRADICTED,
        marked: true,
      },
      {
        author: "IncarnaMind",
        comment:
          "Unsupported: your Documents say something different (“The harbour wall was raised in 1984.”, Tides, p. 2)",
        on: DIFFERS,
        marked: true,
      },
      {
        author: "IncarnaMind",
        comment: "Not found: I didn’t find this in “All Documents”.",
        on: NOT_FOUND,
        marked: true,
      },
    ]);
    expect(result.sentenceChecks).toEqual({
      contradicted: 1,
      notFound: 1,
      unsupported: 1,
      needsRecheck: 0,
      commented: true,
    });
  });

  test("in a Chinese interface the comments follow the check's Chinese wording", async () => {
    const { core, mind } = await checkedReport(undefined, "zh-CN");

    const { comments } = await exported(core, mind.id);

    expect(
      comments.filter((each) => each.author === "IncarnaMind").map((each) => each.comment),
    ).toEqual([
      "与文档矛盾：Tides says harbours publish them every year, not every week（“Harbours publish the times of high water every year.”，Tides，第 1 页）",
      "无依据：你的文档里是另一种说法（“The harbour wall was raised in 1984.”，Tides，第 2 页）",
      "未找到：未在“全部文档”中找到。",
    ]);
  });

  test("the file's own comment and their tracked change are kept as they were, and nothing else is marked as a change", async () => {
    const { core, mind } = await checkedReport();

    const { part, document, comments } = await exported(core, mind.id);

    expect(part("word/comments.xml")).toContain(DANA.comment);
    expect(comments.find((each) => each.author === "Dana Kim")).toEqual({
      author: "Dana Kim",
      comment: "Please confirm the source.",
      on: NOT_FOUND,
      marked: true,
    });
    expect(document).toContain(tracked("ins", 3, "Priya Nair", THEIRS_ADDED));
    const authors = new Set(
      [...document.matchAll(/<w:(?:ins|del) [^>]*w:author="([^"]+)"/g)].map((m) => m[1]),
    );
    expect(authors).toEqual(new Set(["Priya Nair"]));
    const ids = [...part("word/comments.xml").matchAll(/<w:comment w:id="(\d+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.each([
    { case: "with comments of its own", bytes: null },
    { case: "with none", bytes: UNCOMMENTED_REPORT },
  ])(
    "a file $case: the comments part, its relationship and content type are there, every range is whole, and the app's own Word reader opens it again",
    async ({ bytes }) => {
      const set = await setUp();
      if (bytes) await writeFile(set.report, bytes);
      const made = await verified(set.core, set.report);
      await set.core.findClaims(request(made.mind.id));
      await set.core.verifyClaims(request(made.mind.id));

      const { result, part, document } = await exported(set.core, made.mind.id);

      expect((await inspectPackage(result.data)).problems).toEqual([]);
      expect(part("word/_rels/document.xml.rels")).toMatch(
        new RegExp(`Type="${COMMENTS_RELATIONSHIP}" Target="comments.xml"`),
      );
      expect(part("[Content_Types].xml")).toContain(
        `<Override PartName="/word/comments.xml" ContentType="${COMMENTS_CONTENT_TYPE}"/>`,
      );
      const starts = [...document.matchAll(/<w:commentRangeStart w:id="(\d+)"\/>/g)].map(
        (m) => m[1],
      );
      const written = [...part("word/comments.xml").matchAll(/<w:comment w:id="(\d+)"/g)].map(
        (m) => m[1],
      );
      expect(starts.sort()).toEqual(written.sort());
      for (const id of starts) {
        expect(document).toContain(`<w:commentRangeEnd w:id="${id}"/>`);
        expect(document).toContain(`<w:commentReference w:id="${id}"/>`);
      }

      const pkg = await openWordPackage(result.data);
      const review = await reviewOf(pkg);
      expect(review.comments).toBe(written.length);
      expect(review.authors).toContain("IncarnaMind");
      const again = join(set.sources, "Harbour report (checked).docx");
      await writeFile(again, result.data);
      expect(await set.core.checkWordFile(again)).toMatchObject({
        refusal: null,
        comments: written.length,
      });
      const imported = await set.core.importWordFile({ path: again, origin: "someone-else" });
      expect(imported.ok).toBe(true);
    },
  );
});
