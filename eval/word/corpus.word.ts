/**
 * `npm run eval:word` (eval/word/README.md): for each file of the Word corpus, its checks, each a
 * step in `STEPS`: the package, the import as a Mind (#104), opening in LibreOffice, the
 * round-trip back into the file (#105), the export for review (#107), and someone's changes
 * accepted and rejected (#108), and the Citations in a list at the end (#1600), each export opened in LibreOffice too. Last, a file exported for review has every change accepted in LibreOffice,
 * which must show the text accepting every change in IncarnaMind does, and a file someone else
 * wrote, verified (#110), exports with its claims' results as comments and opens there.
 *
 * INCARNAMIND_WORD_SET picks the files: "core" (the committed files, the default), "extended"
 * (the cache that `npm run eval:word:fetch` fills) or "all".
 * INCARNAMIND_WORD_REQUIRE_LIBREOFFICE=1 (CI sets it) fails the run when LibreOffice is missing,
 * instead of skipping that step.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { readWordDocument } from "../../src/core/documents/formats/docxImport";
import { openWordPackage, reviewOf } from "../../src/core/documents/formats/docxPackage";
import { child, descendants, textOf } from "../../src/core/documents/formats/xml";
import type { NodeJSON } from "../../src/shared/blockJson";
import { createTempDataFolder, manualClock, startCore } from "../../tests/helpers/core";
import { connectToMind } from "../../tests/helpers/mindClient";
import { writeMind } from "../../tests/helpers/minds";
import { setUpWordVerify, verifyRequest, verifyWordFile } from "../../tests/helpers/verifiedWord";
import { paragraph, run, table, wordFile } from "../../tests/helpers/word";
import {
  type CorpusEntry,
  type CorpusOutcome,
  checkInputPackage,
  corpusFailure,
  extendedCache,
  inspectPackage,
  readExtended,
  readManifest,
  WORD_DIR,
} from "./corpus";
import { checkExport, checkListExport, checkReview, checkTheirChanges } from "./exports";
import { type Features, featureKinds } from "./features";
import { checkImport } from "./imports";
import { acceptAllChanges, convertToPdf, findLibreOffice } from "./libreoffice";

/** A file to check, wherever it lives. */
interface Subject {
  name: string;
  path: string;
  features: Features;
  known?: string;
}

interface Step {
  name: string;
  /** Its detail is printed when it passes too: the counts a step reports. */
  reports?: true;
  run(subject: Subject, bytes: Uint8Array): Promise<CorpusOutcome>;
}

const soffice = findLibreOffice();
/** Where to keep a PDF of each edited export, for a person to look at (CI uploads them). */
const keepPdfs = process.env.INCARNAMIND_WORD_PDFS;
const required = process.env.INCARNAMIND_WORD_REQUIRE_LIBREOFFICE === "1";
const wanted = process.env.INCARNAMIND_WORD_SET ?? "core";

/** Each file's export with the scripted edit, for review, and with someone's changes resolved, for LibreOffice to open. */
const exported = new Map<string, Uint8Array>();
const reviewed = new Map<string, Uint8Array>();
const resolved = new Map<string, Uint8Array>();
const listed = new Map<string, Uint8Array>();

/** Opens an export in LibreOffice, keeping its PDF as `suffix` says for a person to look at. */
async function openExport(subject: Subject, data: Uint8Array | undefined, suffix: string) {
  if (!soffice) return { ok: true, detail: "skipped: LibreOffice not found" };
  if (!data) return { ok: true, detail: "nothing exported" };
  const folder = mkdtempSync(join(tmpdir(), "incarnamind-word-export-"));
  try {
    const path = join(folder, basename(subject.path));
    writeFileSync(path, data);
    const keep = keepPdfs
      ? join(keepPdfs, subject.name.replace(/\.docx$/i, `${suffix}.pdf`))
      : undefined;
    const result = await convertToPdf(soffice, path, keep);
    return result.opened
      ? { ok: true, detail: `${result.pdfBytes} bytes of PDF` }
      : { ok: false, detail: result.problem ?? "did not open" };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const STEPS: Step[] = [
  {
    name: "package",
    run: (subject, bytes) => checkInputPackage(bytes, subject.features),
  },
  {
    name: "imports as a Mind",
    reports: true,
    run: async (_subject, bytes) => checkImport(bytes),
  },
  {
    name: "opens in LibreOffice",
    async run(subject) {
      if (!soffice) return { ok: true, detail: "skipped: LibreOffice not found" };
      const result = await convertToPdf(soffice, subject.path);
      return result.opened
        ? { ok: true, detail: `${result.pdfBytes} bytes of PDF` }
        : { ok: false, detail: result.problem ?? "did not open" };
    },
  },
  {
    name: "exports back",
    reports: true,
    async run(subject, bytes) {
      const outcome = await checkExport(bytes);
      if (outcome.exported) exported.set(subject.name, outcome.exported);
      return outcome;
    },
  },
  {
    name: "export opens in LibreOffice",
    async run(subject) {
      const outcome = await openExport(subject, exported.get(subject.name), "");
      exported.delete(subject.name);
      return outcome;
    },
  },
  {
    name: "exports for review",
    reports: true,
    async run(subject, bytes) {
      const outcome = await checkReview(bytes);
      if (outcome.exported) reviewed.set(subject.name, outcome.exported);
      return outcome;
    },
  },
  {
    name: "review export opens in LibreOffice",
    async run(subject) {
      const outcome = await openExport(subject, reviewed.get(subject.name), "-review");
      reviewed.delete(subject.name);
      return outcome;
    },
  },
  {
    name: "resolves someone's changes",
    reports: true,
    async run(subject, bytes) {
      const outcome = await checkTheirChanges(bytes);
      if (outcome.exported) resolved.set(subject.name, outcome.exported);
      return outcome;
    },
  },
  {
    name: "that export opens in LibreOffice",
    async run(subject) {
      const outcome = await openExport(subject, resolved.get(subject.name), "-resolved");
      resolved.delete(subject.name);
      return outcome;
    },
  },
  {
    name: "exports with the Citations in a list",
    reports: true,
    async run(subject, bytes) {
      const outcome = await checkListExport(bytes);
      if (outcome.exported) listed.set(subject.name, outcome.exported);
      return outcome;
    },
  },
  {
    name: "list export opens in LibreOffice",
    async run(subject) {
      const outcome = await openExport(subject, listed.get(subject.name), "-list");
      listed.delete(subject.name);
      return outcome;
    },
  },
];

/** A line's words, for comparing text LibreOffice saved with the Mind's: no numbers, marks or bullets. */
const wordsOf = (lines: readonly string[]) =>
  lines
    .map((line) =>
      line
        .replace(/\[\*\]/g, "")
        .replace(/[^\p{L}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line !== "");

function paragraphLines(blocks: readonly NodeJSON[]): string[] {
  const lines: string[] = [];
  const visit = (node: NodeJSON) => {
    if (node.type === "paragraph")
      lines.push((node.content ?? []).map((each) => each.text ?? "").join(""));
    for (const each of node.content ?? []) visit(each);
  };
  for (const block of blocks) visit(block);
  return lines;
}

/** The file LibreOffice accepts every change in: headings, paragraphs and a table, edited every way. */
const ACCEPT_FIXTURE = wordFile({
  body:
    paragraph("Lease terms", { style: "Heading1" }) +
    paragraph("The tenant pays rent every month, in advance.") +
    paragraph("The landlord repairs the roof and the walls.") +
    paragraph(run("Either party may end the lease with notice.", { font: "Georgia" })) +
    table([
      ["Item", "Amount"],
      ["Rent", "Monthly"],
    ]) +
    paragraph("Signed by both parties."),
});

function subjects(): Subject[] {
  const found: Subject[] = [];
  if (wanted === "core" || wanted === "all") {
    for (const entry of readManifest()) {
      found.push({
        name: entry.file,
        path: join(WORD_DIR, entry.file),
        features: entry.features,
        known: entry.known,
      });
    }
  }
  if (wanted === "extended" || wanted === "all") {
    const cache = extendedCache();
    for (const entry of readExtended()) {
      found.push({
        name: `extended/${entry.name}`,
        path: join(cache, entry.name),
        features: entry.features,
        known: entry.known,
      });
    }
  }
  return found;
}

describe("the Word corpus", () => {
  const manifest = readManifest();

  it("lists 32 documents, 20 files with tracked changes and at most 6 saved by hand, each once", () => {
    expect(manifest.filter((entry) => entry.set === "documents")).toHaveLength(32);
    expect(manifest.filter((entry) => entry.set === "tracked-changes")).toHaveLength(20);
    expect(manifest.filter((entry) => entry.set === "saved").length).toBeLessThanOrEqual(6);
    expect(new Set(manifest.map((entry) => entry.file)).size).toBe(manifest.length);
  });

  it("keeps the committed files small", () => {
    const bytes = manifest.reduce(
      (sum, entry: CorpusEntry) => sum + readFileSync(join(WORD_DIR, entry.file)).byteLength,
      0,
    );
    expect(bytes).toBeLessThan(25_000_000);
  });

  it.skipIf(!required)("has LibreOffice when CI asks for it", () => {
    expect(soffice).toBeDefined();
  });

  it.skipIf(!soffice)(
    "accepting every change in LibreOffice gives the text accepting every change in IncarnaMind does",
    async () => {
      const outcome = await checkReview(ACCEPT_FIXTURE);
      expect(outcome.ok, outcome.detail).toBe(true);
      const folder = mkdtempSync(join(tmpdir(), "incarnamind-word-fixture-"));
      try {
        const path = join(folder, "lease.docx");
        writeFileSync(path, outcome.exported ?? new Uint8Array());
        const accepted = await acceptAllChanges(soffice as string, path);
        if ("problem" in accepted) throw new Error(`LibreOffice: ${accepted.problem}`);
        expect(wordsOf(accepted.text.split("\n"))).toEqual(wordsOf(outcome.accepted ?? []));
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    5 * 60_000,
  );

  it.skipIf(!soffice)(
    "a file someone else wrote, with their change and comment, verified and exported with each claim's problem as a comment, opens in LibreOffice",
    async () => {
      const { core, report } = await setUpWordVerify();
      const { mind } = await verifyWordFile(core, report);
      await core.findClaims(verifyRequest(mind.id));
      await core.verifyClaims(verifyRequest(mind.id));
      const exported = await core.exportMind(mind.id, {
        format: "docx",
        commentOthersFiles: true,
      });
      expect((await inspectPackage(exported.data)).problems).toEqual([]);
      expect(exported.sentenceChecks).toMatchObject({ contradicted: 1, commented: true });

      const folder = mkdtempSync(join(tmpdir(), "incarnamind-word-verified-"));
      try {
        const path = join(folder, "Harbour report (checked).docx");
        writeFileSync(path, exported.data);
        const keep = keepPdfs ? join(keepPdfs, "verified-report.pdf") : undefined;
        const opened = await convertToPdf(soffice as string, path, keep);
        expect(opened.opened, opened.problem).toBe(true);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    5 * 60_000,
  );

  /**
   * Word has no to-do: a to-do is a paragraph starting with ☐ or ☒ and a tab, and its nesting is
   * only its indent, so a box is text a User can't tick. The export opens in LibreOffice and
   * imports again with every box and its text.
   */
  it.skipIf(!soffice)(
    "a Mind of to-dos exports to Word, opens in LibreOffice, and imports again with its boxes and text",
    async () => {
      const prose = (text?: string): JSONContent => ({
        type: "paragraph",
        content: text === undefined ? [] : [{ type: "text", text }],
      });
      const task = (checked: boolean, ...content: JSONContent[]): JSONContent => ({
        type: "taskItem",
        attrs: { checked },
        content,
      });
      const item = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });

      const core = startCore(await createTempDataFolder(), { now: manualClock().now });
      const mind = await core.createMind({ title: "To-dos" });
      const client = await connectToMind(core, mind.id);
      writeMind(client, [
        prose("Before."),
        {
          type: "taskList",
          content: [
            task(
              false,
              prose("核查清单项"),
              {
                type: "taskList",
                content: [
                  task(true, prose("已核对"), {
                    type: "taskList",
                    content: [task(false, prose("Deeper"))],
                  }),
                ],
              },
              { type: "bulletList", content: [item(prose("Supporting note"))] },
            ),
            task(true, prose()),
          ],
        },
        {
          type: "bulletList",
          content: [
            item(prose("Ordinary bullet"), {
              type: "taskList",
              content: [task(false, prose("Under bullet"))],
            }),
          ],
        },
      ]);
      await client.settled();
      const exported = await core.exportMind(mind.id, { format: "docx" });

      const folder = mkdtempSync(join(tmpdir(), "incarnamind-word-todos-"));
      try {
        const path = join(folder, exported.fileName);
        writeFileSync(path, exported.data);
        const opened = await convertToPdf(soffice as string, path);
        expect(opened.opened, opened.problem).toBe(true);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }

      const pkg = await openWordPackage(exported.data);
      const document = await readWordDocument(pkg, await reviewOf(pkg));
      const boxes = descendants(document.root, "w:p")
        .map((each) => ({
          text: textOf(each),
          indent: child(child(each, "w:pPr") ?? each, "w:ind")?.attrs["w:left"],
        }))
        .filter((each) => /^[☐☒]/u.test(each.text));
      expect(boxes.map((each) => each.indent)).toEqual(["420", "780", "1140", "420", "1140"]);
      expect(
        paragraphLines(document.structure.blocks).filter((line) => /^[☐☒]/u.test(line)),
      ).toEqual(["☐\t核查清单项", "☒\t已核对", "☐\tDeeper", "☒\t", "☐\tUnder bullet"]);
      // A box is text in Word: the import makes a paragraph of it, not a to-do the User can tick.
      expect(JSON.stringify(document.structure.blocks)).not.toContain('"taskList"');
    },
    5 * 60_000,
  );

  it(`opens every file of the "${wanted}" set, and reports each step`, async () => {
    const all = subjects();
    const missing = all.filter((subject) => !existsSync(subject.path));
    expect(
      missing.map((subject) => subject.name),
      "fetch the extended set first: npm run eval:word:fetch",
    ).toEqual([]);

    const failures: string[] = [];
    const lines: string[] = [];
    for (const subject of all) {
      const bytes = readFileSync(subject.path);
      const cells: string[] = [];
      for (const step of STEPS) {
        const outcome = await step.run(subject, bytes);
        const reported = outcome.ok && step.reports && outcome.detail ? ` (${outcome.detail})` : "";
        cells.push(`${outcome.ok ? "ok" : "FAIL"} ${step.name}${reported}`);
        if (!outcome.ok) {
          const { known, failure } = corpusFailure(subject, step.name, outcome);
          if (known) lines.push(known);
          if (failure) failures.push(failure);
        }
      }
      lines.push(`${subject.name}  ${featureKinds(subject.features)} kinds  ${cells.join(", ")}`);
    }
    console.log(
      `${lines.join("\n")}\n${all.length} files; ${failures.length} failed${soffice ? "" : "; LibreOffice not found, so no file was opened in it"}`,
    );
    expect(failures).toEqual([]);
  });
});
