/**
 * Sentences about a Document's file itself, checked against its own properties (#2458), on Claude
 * on the Anthropic key, with decoys: a sentence about the text that only mentions a date the file
 * also has, a body that names another author than the file does, and a file with no date of its
 * own. Runs only with the key in the environment (INCARNAMIND_LIVE_ANTHROPIC_KEY; the model is
 * INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku 5.5 by default), and makes no request without one.
 * INCARNAMIND_LIVE_REPORT keeps what each check said. These cases are held out: none is an example
 * in the check's instructions or its search Tool.
 */
import { appendFile, utimes } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { createAiSdkChatModel, type Document, type FilePropertyName } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { corePropertiesXml, docxOf, xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { para, pptxOf, sp, txBody } from "../helpers/pptx";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

const slide = (text: string, hidden = false) => ({
  shapes: sp({ body: txBody(para(`<a:r><a:t>${text}</a:t></a:r>`)) }),
  ...(hidden && { attrs: 'show="0"' }),
});

const FILES = [
  {
    name: "Lease renewal.docx",
    contents: docxOf(
      [
        { text: "Lease renewal terms", heading: 1 },
        { text: "The renewal was agreed on 14 September 2026." },
        { text: "Prepared by: Tom Becker" },
        { text: "The rent rises to £2,400 a month from 1 January 2027." },
      ],
      {
        coreXml: corePropertiesXml({
          created: "2026-08-01T07:00:00Z",
          modified: "2026-09-14T10:20:00Z",
          creator: "Priya Natarajan",
        }),
      },
    ),
  },
  {
    name: "Board pack Q3.pptx",
    contents: pptxOf({
      slides: [
        slide("Q3 board pack"),
        slide("Trading update: revenue up 6%"),
        slide("Appendix: old forecast", true),
        slide("Questions"),
      ],
    }),
  },
  {
    name: "Cash forecast.xlsx",
    contents: xlsxOf(
      [
        {
          name: "Forecast",
          rows: [
            ["Month", "Cash"],
            ["October", 182000],
            ["November", 176500],
          ],
        },
        { name: "Assumptions", rows: [] },
        { name: "Old model", rows: [["Draft", 1]], state: "hidden" },
      ],
      { coreXml: corePropertiesXml({ modified: "2026-10-20T08:00:00Z", creator: "陈思远" }) },
    ),
  },
  {
    name: "Audit memo.pdf",
    contents: buildPdf(
      [
        { lines: ["Audit memo", "Date of memo: 9 October 2026", "Author: J. Okafor"] },
        { lines: ["Findings: two controls need testing again."] },
        { lines: ["Next steps: retest by 30 November 2026."] },
      ],
      {
        info: {
          CreationDate: "D:20261010",
          ModDate: "D:20261012153000+08'00'",
          Author: "Marta Kowalska",
        },
      },
    ),
  },
  {
    name: "Site notes.md",
    contents: "# Site notes\n\nThe crane arrives on Monday. Access is from the north gate.\n",
    touched: "2026-10-28T12:00:00Z",
  },
];

type Verdict = "supported" | "unsupported" | "contradicted";

interface Case {
  sentence: string;
  expected: Verdict;
  /** For a Supported sentence a property decides: which one. */
  property?: FilePropertyName;
  /** The sentence is about a date of a file that records none: the computer's line is its reason. */
  computerOnly?: true;
}

const CASES: Record<"en" | "zh-CN", Case[]> = {
  en: [
    {
      sentence: "Lease renewal.docx was last modified on 14 September 2026.",
      expected: "supported",
      property: "modified",
    },
    {
      sentence: "The lease renewal file was last saved on 2 September 2026.",
      expected: "contradicted",
    },
    {
      sentence: "The file author recorded in Lease renewal.docx is Priya Natarajan.",
      expected: "supported",
      property: "author",
    },
    // Decoy: the file was created on 1 August, but the text says nothing of a signing.
    { sentence: "The lease renewal was signed on 1 August 2026.", expected: "unsupported" },
    // Decoy: the text says it, and the file's modified date is the same day.
    { sentence: "The renewal was agreed on 14 September 2026.", expected: "supported" },
    { sentence: "Board pack Q3.pptx has 4 slides.", expected: "supported", property: "slides" },
    { sentence: "The Q3 board pack runs to 6 slides.", expected: "contradicted" },
    { sentence: "Audit memo.pdf is 3 pages long.", expected: "supported", property: "pages" },
    {
      sentence: "The audit memo PDF was last modified on 12 October 2026.",
      expected: "supported",
      property: "modified",
    },
    // Decoy: the memo's text names J. Okafor; the file records Marta Kowalska.
    {
      sentence: "The audit memo's file records Marta Kowalska as its author.",
      expected: "supported",
      property: "author",
    },
    {
      sentence: "The audit memo's file records J. Okafor as its author.",
      expected: "contradicted",
    },
    { sentence: "Cash forecast.xlsx has 3 sheets.", expected: "supported", property: "sheets" },
    {
      sentence: "Site notes.md was last modified on 28 October 2026.",
      expected: "unsupported",
      computerOnly: true,
    },
  ],
  "zh-CN": [
    {
      sentence: "Cash forecast.xlsx 的文件作者是陈思远。",
      expected: "supported",
      property: "author",
    },
    { sentence: "Cash forecast.xlsx 共有 5 个工作表。", expected: "contradicted" },
    {
      sentence: "Lease renewal.docx 文件最后修改于 2026 年 9 月 14 日。",
      expected: "supported",
      property: "modified",
    },
    // Decoy: the memo's own date, in its text, is 9 October; its file was last modified on 12 October.
    { sentence: "审计备忘录的日期是 2026 年 10 月 12 日。", expected: "contradicted" },
    {
      sentence: "Board pack Q3.pptx 一共有 4 张幻灯片。",
      expected: "supported",
      property: "slides",
    },
    {
      sentence: "Site notes.md 最后修改于 2026 年 10 月 28 日。",
      expected: "unsupported",
      computerOnly: true,
    },
  ],
};

describe.each(["en", "zh-CN"] as const)(
  "sentences about files' own properties, live (%s)",
  (language) => {
    test.skipIf(KEY === undefined)(
      `${MODEL}: no false Supported, and each property decides only its own sentence`,
      { timeout: 1_800_000 },
      async () => {
        const core = startCore(await createTempDataFolder(), {
          createChatModel: createAiSdkChatModel,
        });
        core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
        await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
        await core.updateSettings({ user: { language } });
        const sources = await createTempDataFolder();
        const paths: string[] = [];
        for (const file of FILES) {
          const path = await writeSourceFile(sources, file.name, file.contents);
          if (file.touched) await utimes(path, new Date(file.touched), new Date(file.touched));
          paths.push(path);
        }
        const documents: Document[] = await addAndProcess(core, paths);
        const computerLine = translate(language, "claim.properties.computerOnly", {
          date: language === "en" ? "28 Oct 2026" : "2026年10月28日",
        });
        const lines = [`## ${MODEL} · ${language}`];
        const falseSupported: string[] = [];
        let right = 0;
        for (const each of CASES[language]) {
          const result = await core.checkClaim({ claim: each.sentence });
          const evidence = result.verdict === "not-checked" ? null : result.evidence;
          const location = evidence?.location;
          const decided = location?.kind === "properties" ? location.property : null;
          const reason = result.verdict === "unsupported" ? result.unsupported?.reason : null;
          const holds =
            result.verdict === each.expected &&
            (each.property === undefined || decided === each.property) &&
            (!each.computerOnly || reason === computerLine);
          if (holds) right++;
          if (result.verdict === "supported" && each.expected !== "supported") {
            falseSupported.push(each.sentence);
          }
          const file = documents.find((document) => document.id === evidence?.documentId)?.name;
          lines.push(
            `- ${holds ? "ok" : "MISS"} [${each.expected}${each.property ? ` · ${each.property}` : ""}] ${each.sentence} → ${result.verdict}${result.verdict === "not-checked" ? ` (${result.reason})` : ""}${decided ? ` · ${decided} of ${file}` : evidence ? ` · text of ${file}` : ""}${reason ? ` · “${reason}”` : ""}`,
          );
        }
        const { spent } = await core.getCostSummary();
        lines.push(
          `Right: ${right} of ${CASES[language].length}. False Supported: ${falseSupported.length}.`,
          `Spent: ${JSON.stringify(spent)}`,
          "",
        );
        if (process.env.INCARNAMIND_LIVE_REPORT) {
          await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${lines.join("\n")}\n`);
        }
        expect(falseSupported).toEqual([]);
      },
    );
  },
);
