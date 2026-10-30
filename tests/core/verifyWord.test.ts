/**
 * Verify on a Word file someone else wrote (#110), through the core's public interface: the
 * file comes in as a Mind imported from it, with another author's tracked changes and comments
 * kept; its claims are found and checked against the User's Documents, the file and its copies
 * never evidence; and the export back into the file writes each Unsupported and Contradicted
 * result as a Word comment naming the evidence Document and page, the file's own comments and
 * changes as they were, in a package Word opens without repairing.
 */
import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { inspectPackage } from "../../eval/word/corpus";
import {
  type Core,
  DATABASE_FILE,
  MIND_SETTINGS_FIELD,
  type RewrittenMindExport,
} from "../../src/core";
import { openWordPackage, reviewOf } from "../../src/core/documents/formats/docxPackage";
import { COMMENTS_CONTENT_TYPE, COMMENTS_RELATIONSHIP } from "../../src/core/exports/wordml";
import { openDatabase } from "../../src/core/storage";
import { WORD_PACKAGES_FOLDER } from "../../src/core/wordImports";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { pendingProposals } from "../../src/shared/proposals";
import { NO_SCOPE } from "../../src/shared/searchScope";
import { textOriginOf } from "../../src/shared/textOrigins";
import { verificationOf } from "../../src/shared/verification";
import { wordFileOf } from "../../src/shared/wordFiles";
import { shownPassages } from "../helpers/citations";
import { addAndProcess, documentAt, linkAndProcess } from "../helpers/documents";
import { textOf, unzip } from "../helpers/docx";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, note, readMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";
import {
  COMMENTED,
  CONTRADICTED,
  DANA,
  DIFFERS,
  NOT_FOUND,
  REPORT,
  verifyRequest as request,
  SUPPORTED,
  setUpWordVerify as setUp,
  THEIRS_ADDED,
  UNCOMMENTED_REPORT,
  verifyWordFile as verified,
} from "../helpers/verifiedWord";
import { paragraph, table, tracked, wordFile } from "../helpers/word";

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

const WORD = { format: "docx", commentFailedChecks: true } as const;

/** The checked report saved as a Word file in an Exports folder, with what the file and its Note's choice hold now. */
async function exportedReport() {
  const set = await checkedReport();
  const out = join(set.sources, "Exports");
  await mkdir(out);
  await set.core.setOutputLocation(out);
  const first = await set.core.saveMindExport(set.mind.id, WORD);
  if (first.status !== "saved") throw new Error(first.status);
  const { path } = first.file;
  return {
    ...set,
    out,
    word: WORD,
    path,
    bytes: () => readFile(path),
    choice: async () => (await set.core.previewMindExport(set.mind.id, WORD)).othersComments,
  };
}

function saved(result: RewrittenMindExport) {
  if (result.status !== "saved")
    throw new Error(`The file wasn't written again: ${result.status}.`);
  return result;
}

/** The export into the file, its parts, and each comment's words with the words its range holds. */
async function exported(core: Core, mindId: string) {
  await core.setCheckComments(mindId, true);
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
      comments: false,
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

  test("a Mind that doesn't get every Block of the file isn't reported as verified, and its claims are found only once the rest is in", async () => {
    const { core, report } = await setUp();
    const filler = Array.from({ length: 3500 }, (_, at) => paragraph(`Line ${at + 1}.`));
    await writeFile(report, wordFile({ body: [...filler, paragraph(CONTRADICTED)].join("") }));
    let mindId = "";
    const stop = core.on("minds.changed", (minds) => {
      const made = minds.find((each) => each.title === "Checking: Harbour report");
      if (!made) return;
      stop();
      mindId = made.id;
      void core.deleteMind(made.id);
    });

    expect(await core.verifyDocument({ path: report })).toEqual({
      ok: false,
      reason: "word",
      refusal: "unreadable",
    });

    // Restored, its import goes on; Find claims waits for it, and finds the claim at its end.
    await core.restore([{ kind: "mind", id: mindId }]);
    expect(await core.findClaims(request(mindId))).toEqual({ kind: "found", claims: 1 });
  });

  test.each([
    ["a full disk", "database or disk is full"],
    ["a busy disk", "database is locked"],
  ])(
    "an import that can't finish its Note (%s) leaves no Note and no kept file, twice, and a third try once it can goes through",
    async (_, failure) => {
      const { core, report, dataDir } = await setUp();
      const db = openDatabase(join(dataDir, DATABASE_FILE));
      db.exec(
        `CREATE TRIGGER refuse_finish BEFORE UPDATE OF completed_at ON word_packages BEGIN SELECT RAISE(ABORT, '${failure}'); END`,
      );
      const kept = () => readdir(join(dataDir, WORD_PACKAGES_FOLDER)).catch(() => []);
      for (const _try of [1, 2]) {
        expect(await core.verifyDocument({ path: report })).toEqual({
          ok: false,
          reason: "word",
          refusal: "unreadable",
        });
        expect((await core.listMinds()).map((each) => each.title)).not.toContain(
          "Checking: Harbour report",
        );
        expect((await core.listDeleted()).filter((each) => each.kind === "mind")).toEqual([]);
        expect(await kept()).toEqual([]);
      }

      db.exec("DROP TRIGGER refuse_finish");
      db.close();
      const { mind } = await verified(core, report);
      expect(await core.findClaims(request(mind.id))).toEqual({ kind: "found", claims: 4 });
      expect(await kept()).toHaveLength(1);
    },
  );

  test("a quit while the import goes on keeps its Note, which goes on at the next start and verifies", async () => {
    const { core, report, start } = await setUp();
    const filler = Array.from({ length: 3500 }, (_, at) => paragraph(`Line ${at + 1}.`));
    await writeFile(report, wordFile({ body: [...filler, paragraph(CONTRADICTED)].join("") }));
    const stop = core.on("minds.changed", (minds) => {
      if (!minds.some((each) => each.title === "Checking: Harbour report")) return;
      stop();
      setImmediate(() => core.close());
    });

    expect(await core.verifyDocument({ path: report })).toEqual({
      ok: false,
      reason: "word",
      refusal: "unreadable",
    });

    const again = start();
    const mind = (await again.listMinds()).find(
      (each) => each.title === "Checking: Harbour report",
    );
    if (!mind) throw new Error("The Note was taken back at the quit.");
    expect(await again.findClaims(request(mind.id))).toEqual({ kind: "found", claims: 1 });
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

describe("check comments in someone else's file", () => {
  test("are off by default, as the file goes back to them, and on for one Note only: the next file from someone else starts off; the User's own Notes keep theirs on", async () => {
    const { core, mind, sources } = await checkedReport();
    const word = { format: "docx", commentFailedChecks: true } as const;

    const plain = await core.exportMind(mind.id, word);
    expect(plain).toMatchObject({ othersFile: true, othersComments: false });
    expect(plain.sentenceChecks).toMatchObject({ commented: false, comments: 0, contradicted: 1 });
    const comments = unzip(plain.data).get("word/comments.xml")?.toString("utf8") ?? "";
    expect(comments).toContain(DANA.comment);
    expect(comments).not.toContain('w:author="IncarnaMind"');

    await core.setCheckComments(mind.id, true);
    const asked = await core.exportMind(mind.id, word);
    expect(asked).toMatchObject({ othersComments: true, sentenceChecks: { comments: 3 } });

    // A second file from someone else, verified after: its comments are off, as the first's were.
    const other = join(sources, "Second report.docx");
    await writeFile(other, REPORT);
    const second = await verified(core, other);
    await core.findClaims(request(second.mind.id));
    await core.verifyClaims(request(second.mind.id));
    expect(await core.exportMind(second.mind.id, word)).toMatchObject({
      othersComments: false,
      sentenceChecks: { commented: false, comments: 0 },
    });
    expect((await core.exportMind(mind.id, word)).sentenceChecks.comments).toBe(3);

    // The User's own Note keeps its own switch, and has no Note's choice to set.
    const own = await core.createMind({ title: "My memo" });
    expect(await core.exportMind(own.id, word)).toMatchObject({
      othersFile: false,
      sentenceChecks: { commented: true },
    });
    await expect(core.setCheckComments(own.id, true)).rejects.toThrow(
      "This note doesn’t verify a document.",
    );
  });

  test("its file is named after the original, and Comment writes that same file again, which Undo puts back byte for byte", async () => {
    const { core, mind, sources } = await checkedReport();
    const out = join(sources, "Exports");
    await mkdir(out);
    await core.setOutputLocation(out);
    const word = { format: "docx", commentFailedChecks: true } as const;

    const first = await core.saveMindExport(mind.id, word);
    if (first.status !== "saved") throw new Error(first.status);
    expect(first.file.name).toBe("Harbour report.docx");
    const plain = await readFile(first.file.path);

    const again = await core.rewriteMindExport(mind.id, word, first.file.path, true);
    if (again.status !== "saved") throw new Error(again.status);
    expect((await core.previewMindExport(mind.id, word)).othersComments).toBe(true);
    expect(again.file.path).toBe(first.file.path);
    expect(again.sentenceChecks).toMatchObject({ commented: true, comments: 3 });
    const commented = await readFile(first.file.path);
    expect(unzip(commented).get("word/comments.xml")?.toString("utf8")).toContain(
      'w:author="IncarnaMind"',
    );
    expect(await readdir(out)).toEqual(["Harbour report.docx"]);

    await core.restoreMindExport(first.file.path, again.step);
    expect(Buffer.compare(await readFile(first.file.path), plain)).toBe(0);
    expect((await core.previewMindExport(mind.id, word)).othersComments).toBe(false);

    await core.rewriteMindExport(mind.id, word, first.file.path, true);
    expect(
      unzip(await readFile(first.file.path))
        .get("word/comments.xml")
        ?.toString("utf8"),
    ).toContain('w:author="IncarnaMind"');
    expect(await readdir(out)).toEqual(["Harbour report.docx"]);

    // A fresh export takes the next free name; the original is never touched.
    const fresh = await core.saveMindExport(mind.id, word);
    expect(fresh.status === "saved" && fresh.file.name).toBe("Harbour report 2.docx");
    expect(Buffer.compare(await readFile(join(sources, "Harbour report.docx")), REPORT)).toBe(0);
    await expect(
      core.rewriteMindExport(mind.id, word, join(sources, "Harbour report.docx")),
    ).rejects.toThrow("That file wasn’t exported from this note");
  });

  test("a file the User changed since is never written over: the export goes beside it, the line says why, and Undo takes only that copy away", async () => {
    const { core, mind, sources } = await checkedReport();
    const out = join(sources, "Exports");
    await mkdir(out);
    await core.setOutputLocation(out);
    const word = { format: "docx", commentFailedChecks: true } as const;
    const first = await core.saveMindExport(mind.id, word);
    if (first.status !== "saved") throw new Error(first.status);
    const edited = Buffer.from("edited in Word");
    await writeFile(first.file.path, edited);

    const beside = await core.rewriteMindExport(mind.id, word, first.file.path, true);
    if (beside.status !== "saved") throw new Error(beside.status);
    expect(beside).toMatchObject({
      file: { name: "Harbour report 2.docx" },
      changedFile: "Harbour report.docx",
      sentenceChecks: { comments: 3 },
    });
    expect(Buffer.compare(await readFile(first.file.path), edited)).toBe(0);

    // A copy the User edited since is never taken away, and its step stays to try again.
    const copied = await readFile(beside.file.path);
    await writeFile(beside.file.path, edited);
    await expect(core.restoreMindExport(beside.file.path, beside.step)).rejects.toThrow(
      "“Harbour report 2.docx” was changed after it was written, so it wasn’t put back.",
    );
    expect(Buffer.compare(await readFile(beside.file.path), edited)).toBe(0);
    expect((await core.previewMindExport(mind.id, word)).othersComments).toBe(true);
    await writeFile(beside.file.path, copied);

    await core.restoreMindExport(beside.file.path, beside.step);
    expect(await readdir(out)).toEqual(["Harbour report.docx"]);
    expect(Buffer.compare(await readFile(first.file.path), edited)).toBe(0);
    expect((await core.previewMindExport(mind.id, word)).othersComments).toBe(false);

    // Undo never puts bytes back over a file changed after it was written either.
    const fresh = await core.saveMindExport(mind.id, word);
    if (fresh.status !== "saved") throw new Error(fresh.status);
    const off = await core.rewriteMindExport(mind.id, word, fresh.file.path, false);
    if (off.status !== "saved") throw new Error(off.status);
    await writeFile(fresh.file.path, edited);
    await expect(core.restoreMindExport(fresh.file.path, off.step)).rejects.toThrow(
      `“${fresh.file.name}” was changed after it was written, so it wasn’t put back.`,
    );
    expect(Buffer.compare(await readFile(fresh.file.path), edited)).toBe(0);
  });

  test("Change, Change, Undo, Undo, Redo and Undo each leave the file and the Note's choice as that step had them", async () => {
    const { core, mind, out, word, path, bytes, choice } = await exportedReport();
    const plain = await bytes();

    const on = saved(await core.rewriteMindExport(mind.id, word, path, true));
    const commented = await bytes();
    expect(unzip(commented).get("word/comments.xml")?.toString("utf8")).toContain(
      'w:author="IncarnaMind"',
    );
    const off = saved(await core.rewriteMindExport(mind.id, word, path, false));
    expect(
      unzip(await bytes())
        .get("word/comments.xml")
        ?.toString("utf8"),
    ).not.toContain('w:author="IncarnaMind"');

    await core.restoreMindExport(path, off.step);
    expect(Buffer.compare(await bytes(), commented)).toBe(0);
    expect(await choice()).toBe(true);
    await core.restoreMindExport(path, on.step);
    expect(Buffer.compare(await bytes(), plain)).toBe(0);
    expect(await choice()).toBe(false);
    await expect(core.restoreMindExport(path, on.step)).rejects.toThrow(
      "There is nothing to put back in “Harbour report.docx”.",
    );

    // Redo writes it again as a step of its own, which only its own Undo takes back. Its
    // comments are dated when it writes them, so its bytes can differ from the first Change's.
    const redone = saved(await core.rewriteMindExport(mind.id, word, path, true));
    expect(
      unzip(await bytes())
        .get("word/comments.xml")
        ?.toString("utf8"),
    ).toContain('w:author="IncarnaMind"');
    expect(await choice()).toBe(true);
    await expect(core.restoreMindExport(path, on.step)).rejects.toThrow(
      "There is nothing to put back in “Harbour report.docx”.",
    );
    await core.restoreMindExport(path, redone.step);
    expect(Buffer.compare(await bytes(), plain)).toBe(0);
    expect(await choice()).toBe(false);
    expect(await readdir(out)).toEqual(["Harbour report.docx"]);
  });

  test.skipIf(process.platform === "win32")(
    "an Undo refused while the folder is locked leaves the file, the Note's choice and its step as they were, and the Change before it waits for it",
    async () => {
      const { core, mind, out, word, path, bytes, choice } = await exportedReport();
      const plain = await bytes();
      const on = saved(await core.rewriteMindExport(mind.id, word, path, true));
      const commented = await bytes();
      const off = saved(await core.rewriteMindExport(mind.id, word, path, false));
      const uncommented = await bytes();

      await chmod(out, 0o555);
      try {
        const refused = core.restoreMindExport(path, off.step);
        await expect(refused).rejects.toThrow(
          "“Harbour report.docx” can’t be changed: it may be read-only or open in another app.",
        );
        await expect(refused).rejects.not.toThrow(out);
      } finally {
        await chmod(out, 0o755);
      }
      expect(Buffer.compare(await bytes(), uncommented)).toBe(0);
      expect(await choice()).toBe(false);

      await expect(core.restoreMindExport(path, on.step)).rejects.toThrow(
        "“Harbour report.docx” was changed after it was written, so it wasn’t put back.",
      );
      expect(Buffer.compare(await bytes(), uncommented)).toBe(0);
      expect(await choice()).toBe(false);

      await core.restoreMindExport(path, off.step);
      expect(Buffer.compare(await bytes(), commented)).toBe(0);
      expect(await choice()).toBe(true);
      await core.restoreMindExport(path, on.step);
      expect(Buffer.compare(await bytes(), plain)).toBe(0);
      expect(await choice()).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a read-only file is never written over or put back, and a read-only folder says so by the file's name",
    async () => {
      const { core, mind, out, word, path, bytes } = await exportedReport();
      const on = saved(await core.rewriteMindExport(mind.id, word, path, true));
      const commented = await bytes();
      await chmod(path, 0o444);

      await expect(core.restoreMindExport(path, on.step)).rejects.toThrow(
        "“Harbour report.docx” can’t be changed: it may be read-only or open in another app.",
      );
      expect(Buffer.compare(await bytes(), commented)).toBe(0);

      const copy = await core.rewriteMindExport(mind.id, word, path, false);
      expect(copy).toMatchObject({
        file: { name: "Harbour report 2.docx" },
        changedFile: "Harbour report.docx",
      });
      expect(Buffer.compare(await bytes(), commented)).toBe(0);

      await chmod(out, 0o555);
      try {
        const refused = core.rewriteMindExport(mind.id, word, path, true);
        await expect(refused).rejects.toThrow(
          "“Harbour report.docx” can’t be changed: it may be read-only or open in another app.",
        );
        await expect(refused).rejects.not.toThrow(out);
      } finally {
        await chmod(out, 0o755);
      }
    },
  );

  test("asking for check comments in a Note that verifies nothing, or another kind of file, writes nothing", async () => {
    const { core, mind, sources } = await checkedReport();
    const out = join(sources, "Exports");
    await mkdir(out);
    await core.setOutputLocation(out);
    const memo = await core.createMind({ title: "Memo" });
    const own = await core.saveMindExport(memo.id, { format: "docx" });
    if (own.status !== "saved") throw new Error(own.status);
    const before = await readFile(own.file.path);
    const client = await connectToMind(core, memo.id);
    editMind(client, (blocks) => [...blocks, note("Written after it was saved.")]);
    await client.settled();

    await expect(
      core.rewriteMindExport(memo.id, { format: "docx" }, own.file.path, true),
    ).rejects.toThrow("This note doesn’t verify a document.");
    expect(Buffer.compare(await readFile(own.file.path), before)).toBe(0);

    const word = await core.saveMindExport(mind.id, { format: "docx" });
    if (word.status !== "saved") throw new Error(word.status);
    await expect(
      core.rewriteMindExport(mind.id, { format: "markdown" }, word.file.path, true),
    ).rejects.toThrow("That file wasn’t exported from this note");
  });

  test("a file moved or deleted since says so by its name, and the Note's choice stays as the file is", async () => {
    const { core, mind, sources } = await checkedReport();
    const out = join(sources, "Exports");
    await mkdir(out);
    await core.setOutputLocation(out);
    const word = { format: "docx", commentFailedChecks: true } as const;
    const first = await core.saveMindExport(mind.id, word);
    if (first.status !== "saved") throw new Error(first.status);
    await rm(first.file.path);

    const failed = core.rewriteMindExport(mind.id, word, first.file.path, true);
    await expect(failed).rejects.toThrow(
      "“Harbour report.docx” is no longer where it was saved: it may have been moved or deleted. Export the note again to make a new file.",
    );
    await expect(failed).rejects.not.toThrow(out);
    expect((await core.previewMindExport(mind.id, word)).othersComments).toBe(false);
  });

  test("a Note only writes again the file it exported itself, never another Note's", async () => {
    const { core, mind, sources } = await checkedReport();
    const out = join(sources, "Exports");
    await mkdir(out);
    await core.setOutputLocation(out);
    const memo = await core.createMind({ title: "Memo" });
    const saved = await core.saveMindExport(memo.id, { format: "markdown" });
    if (saved.status !== "saved") throw new Error(saved.status);
    const before = await readFile(saved.file.path);

    await expect(
      core.rewriteMindExport(mind.id, { format: "docx" }, saved.file.path, true),
    ).rejects.toThrow(
      "That file wasn’t exported from this note, so this note can’t write it again.",
    );
    expect(Buffer.compare(await readFile(saved.file.path), before)).toBe(0);
    await expect(core.restoreMindExport(saved.file.path, "")).rejects.toThrow(
      "There is nothing to put back in “Memo.md”.",
    );
  });

  describe("a walled Note's commented file comes back as a Document behind that wall", () => {
    async function walledReport() {
      const set = await exportedReport();
      const folder = await set.core.createLibraryGroup({ name: "Client A", description: "" });
      const wall = (keepInside: boolean) =>
        set.core.updateLibraryGroup(folder.id, { name: "Client A", description: "", keepInside });
      await wall(true);
      await set.core.moveToFolder({ mindIds: [set.mind.id], folderId: folder.id });
      return { ...set, wall };
    }

    /** Links the Exports folder, so the file Change wrote is indexed, and looks for it from outside the wall. */
    async function cameBack(set: Awaited<ReturnType<typeof walledReport>>, written: string) {
      const document = documentAt(await linkAndProcess(set.core, set.out), written);
      expect(document.ownFile?.kind).toBe("export");
      const seen = () => set.core.countScopeDocuments({ ...NO_SCOPE, documentIds: [document.id] });
      expect(await seen()).toBe(0);
      await set.wall(false);
      expect(await seen()).toBe(1);
    }

    test("written in place", async () => {
      const set = await walledReport();
      const written = saved(
        await set.core.rewriteMindExport(set.mind.id, set.word, set.path, true),
      );
      expect(written.file.path).toBe(set.path);
      await cameBack(set, written.file.path);
    });

    test("put back by Undo, though first saved before the Note was behind it", async () => {
      const set = await walledReport();
      const plain = await set.bytes();
      const on = saved(await set.core.rewriteMindExport(set.mind.id, set.word, set.path, true));
      await set.core.restoreMindExport(set.path, on.step);
      expect(Buffer.compare(await set.bytes(), plain)).toBe(0);
      await cameBack(set, set.path);
    });

    test.skipIf(process.platform === "win32")(
      "written as a copy beside a read-only file",
      async () => {
        const set = await walledReport();
        await chmod(set.path, 0o444);
        const copy = saved(await set.core.rewriteMindExport(set.mind.id, set.word, set.path, true));
        expect(copy.changedFile).toBe("Harbour report.docx");
        await cameBack(set, copy.file.path);
      },
    );
  });

  test("a Note verified before the comment choice existed reads as off", async () => {
    const { core, mind, client } = await checkedReport();
    const settings = client.doc.getMap<unknown>(MIND_SETTINGS_FIELD);
    const { comments: _absent, ...older } = verificationOf(client.doc) ?? {};
    settings.set("verification", older);
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "docx", commentFailedChecks: true });
    expect(exported).toMatchObject({ othersComments: false, sentenceChecks: { commented: false } });
  });

  test("a table row checked as one claim gets one comment over the whole row", async () => {
    const ROW = "1990 — The harbour wall was raised";
    const calls: ModelCall[] = [];
    const { core, report } = await setUp(calls, "en", {
      [ROW]: { verdict: "unsupported", quote: "The harbour wall was raised in 1984." },
    });
    await writeFile(
      report,
      wordFile({
        body:
          paragraph("Harbour works", { style: "Heading1" }) +
          table([
            ["Year", "Event"],
            ["1990", "The harbour wall was raised"],
          ]),
      }),
    );
    const { mind } = await verified(core, report);
    expect(await core.findClaims(request(mind.id))).toEqual({ kind: "found", claims: 1 });
    await core.verifyClaims(request(mind.id));

    const { comments } = await exported(core, mind.id);

    expect(comments).toEqual([
      {
        author: "IncarnaMind",
        comment:
          "Unsupported: your Documents say something different (“The harbour wall was raised in 1984.”, Tides, p. 2)",
        on: "1990The harbour wall was raised",
        marked: true,
      },
    ]);
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
      comments: 3,
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
