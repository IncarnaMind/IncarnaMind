/**
 * Held-out live evaluation for Issue #2525 Box 3 ("A sentence the Library facts don't settle is
 * Not checked with its reason, never Not found with Cut"). Checks all 52 EN & ZH cases in a fresh
 * synthetic Library through `checkMind`, recording outcome, `reason`, `saysNotFound`, evidence,
 * model request count, elapsed seconds, and spend. Runs only when the live Anthropic key is set.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { type AnalysisRuntime, type Core, createAiSdkChatModel } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { saysNotFound } from "../../src/shared/claimChecks";
import { readOpinionSentences } from "../../src/shared/opinions";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { docxOf, xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { pyodideAnalysisRuntime } from "../helpers/pyodideAnalysis";
import {
  LIBRARY_UNSETTLED_CASES as CASES,
  type LibraryUnsettledCase as Case,
  type Outcome,
} from "./libraryUnsettled.cases";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);
const REPLIES = process.env.INCARNAMIND_LIVE_REPLIES;

const OPEN: readonly { name: string; contents: string | Uint8Array }[] = [
  {
    name: "Aurora lease.pdf",
    contents: buildPdf([{ lines: ["Aurora lease: monthly rent is £4,500 for five years."] }]),
  },
  {
    name: "Aurora lease.docx",
    contents: docxOf([{ text: "Aurora lease draft: subject to final landlord sign-off." }]),
  },
  {
    name: "Meadow inspection.txt",
    contents: "Meadow inspection: roof gutters were cleared in March.",
  },
  {
    name: "Pump log.csv",
    contents: "Month,Hours\nJan,120\nFeb,135\n",
  },
  {
    name: "Q2 forecast.xlsx",
    contents: xlsxOf([
      {
        name: "Forecast",
        rows: [
          ["Region", "Amount"],
          ["East", 24000],
        ],
      },
    ]),
  },
  {
    name: "Vendor memo.md",
    contents: "# Vendor memo\n\nVendor memo: steel delivery moved to 14 May.\n",
  },
];

const FOLDERS: Readonly<Record<string, readonly string[]>> = {
  Contracts: ["Aurora lease"],
  Site: ["Meadow inspection", "Pump log"],
  Finance: ["Q2 forecast"],
};

const TAGS: Readonly<Record<string, readonly string[]>> = {
  signed: ["Aurora lease.pdf", "Q2 forecast.xlsx"],
  draft: ["Aurora lease.docx"],
  "2026": ["Meadow inspection.txt", "Pump log.csv"],
};

const NOTES = ["Renewal checklist", "Quarterly notes"];

const WALLED: readonly { name: string; contents: string | Uint8Array }[] = [
  {
    name: "Board minutes.txt",
    contents: "The board approved £2m capital spend.",
  },
  {
    name: "CEO review.pdf",
    contents: buildPdf([{ lines: ["Annual CEO review for 2026."] }]),
  },
];

const heard = (prompt: unknown, text: string, calls: unknown[]) => {
  if (!REPLIES || (text === "" && calls.length === 0)) return;
  const results = (Array.isArray(prompt) ? prompt : [])
    .filter((message: { role?: string }) => message.role === "tool")
    .at(-1);
  appendFileSync(REPLIES, `${JSON.stringify({ text, calls, results })}\n`);
};

function countedModel(onRequest: () => void): typeof createAiSdkChatModel {
  return (spec) =>
    wrapLanguageModel({
      model: createAiSdkChatModel(spec),
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate, params }) => {
          onRequest();
          const result = await doGenerate();
          heard(
            params.prompt,
            result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
            result.content.filter((part) => part.type === "tool-call"),
          );
          return result;
        },
        wrapStream: async ({ doStream, params }) => {
          onRequest();
          const result = await doStream();
          let text = "";
          const calls: unknown[] = [];
          const stream = result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (part.type === "text-delta") text += part.delta;
                if (part.type === "tool-call") calls.push(part);
                controller.enqueue(part);
              },
              flush() {
                heard(params.prompt, text, calls);
              },
            }),
          );
          return { ...result, stream };
        },
      },
    });
}

interface Checked {
  outcome: Outcome | "no mark";
  reason: string | null;
  notFound: boolean;
  evidence: string[];
  requests: number;
  elapsedMs: number;
}

async function libraryFor(
  library: Case["library"],
  language: "en" | "zh-CN",
  analysisRuntime: AnalysisRuntime,
  onRequest: () => void,
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: countedModel(onRequest),
    analysisRuntime,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
  await core.updateSettings({ user: { language } });

  const sources = await createTempDataFolder();
  const files = library === "open" ? OPEN : [...OPEN, ...WALLED];
  const paths = await Promise.all(
    files.map((file) => writeSourceFile(sources, file.name, file.contents)),
  );
  const documents = await addAndProcess(core, paths);

  for (const [folderName, names] of Object.entries(FOLDERS)) {
    const group = await core.createLibraryGroup({ name: folderName, description: "" });
    for (const document of documents.filter((each) => names.includes(each.name))) {
      await core.assignDocumentGroup(document.id, group.id);
    }
  }
  const byFileName = new Map(files.map((file, index) => [file.name, documents[index]] as const));
  for (const [tagName, fileNames] of Object.entries(TAGS)) {
    const tag = await core.createTag({ name: tagName });
    for (const fileName of fileNames) {
      const document = byFileName.get(fileName);
      if (document) await core.addDocumentTag(document.id, tag.id);
    }
  }
  for (const title of NOTES) await core.createMind({ title, folderId: null });

  let folderId: string | null = null;
  if (library !== "open") {
    const board = await core.createLibraryGroup({ name: "Board", description: "" });
    for (const file of WALLED) {
      const document = byFileName.get(file.name);
      if (document) await core.assignDocumentGroup(document.id, board.id);
    }
    await core.updateLibraryGroup(board.id, { name: "Board", description: "", keepInside: true });
    if (library === "walled-inside") folderId = board.id;
  }
  return { core, folderId };
}

async function checkedAsNote(
  core: Core,
  folderId: string | null,
  sentence: string,
  resetRequests: () => number,
): Promise<Checked> {
  const note = await core.createMind({ title: "Library check", folderId });
  const mind = await connectToMind(core, note.id);
  writeMind(mind, [
    { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: sentence }] },
  ]);
  await mind.settled();
  resetRequests();
  const started = Date.now();
  await core.checkMind({ requestId: `check-${randomUUID()}`, mindId: note.id, mode: "all" });
  await mind.settled();
  const elapsedMs = Date.now() - started;
  const requests = resetRequests();

  const check = claimSpans(readMind(mind))[0]?.check;
  const opinions = readOpinionSentences(mind.doc);
  const evidence = [
    check?.evidence ?? null,
    ...(check?.parts ?? []).flatMap((part) => part.evidence),
  ]
    .filter((each) => each !== null)
    .map((each) => {
      const location = each.location as { kind?: string } | null;
      return location?.kind === "library"
        ? `library ${JSON.stringify((location as { fact?: unknown }).fact)}`
        : `text of ${each.documentName}: “${each.quote}”`;
    });
  const state = check?.state;
  const outcome: Checked["outcome"] =
    state === "supported" ||
    state === "unsupported" ||
    state === "contradicted" ||
    state === "not-checked"
      ? state
      : check === undefined && opinions.length > 0
        ? "left-out"
        : "no mark";
  const shown =
    state === "not-checked"
      ? ({ state: "not-checked", reason: check?.reason ?? "failed" } as const)
      : state === "unsupported" && check?.unsupported?.word === "own-view"
        ? ({ state: "own-view" } as const)
        : state === "supported" || state === "unsupported" || state === "contradicted"
          ? ({ state } as const)
          : null;
  const notFound = check !== undefined && shown !== null && saysNotFound(shown, check, 0);

  return {
    outcome,
    reason:
      state === "not-checked" ? (check?.reason ?? null) : (check?.unsupported?.reason ?? null),
    notFound,
    evidence: [...new Set(evidence)],
    requests,
    elapsedMs,
  };
}

const median = (values: readonly number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
};

describe.each(["en", "zh-CN"] as const)(
  "unsettled Library sentences, held-out live (%s)",
  (language) => {
    test.skipIf(KEY === undefined)(
      `${MODEL}: no false Supported, unsettled Library sentences Not checked with reason`,
      { timeout: 3_600_000 },
      async () => {
        const lines = [`## ${MODEL} · ${language}`];
        const falseSupported: string[] = [];
        const wrongNotFound: string[] = [];
        let right = 0;
        let totalRequests = 0;
        const timesMs: number[] = [];
        const spent: unknown[] = [];

        const analysisRuntime = await pyodideAnalysisRuntime();
        const only = process.env.INCARNAMIND_LIVE_CASES?.split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        const cases = CASES[language].filter(
          (each) => only?.some((word) => each.id === word || each.sentence.includes(word)) ?? true,
        );

        for (const each of cases) {
          let requests = 0;
          const resetRequests = () => {
            const count = requests;
            requests = 0;
            return count;
          };
          const { core, folderId } = await libraryFor(
            each.library,
            language,
            analysisRuntime,
            () => {
              requests++;
            },
          );
          try {
            const result = await checkedAsNote(core, folderId, each.sentence, resetRequests);
            const byLibrary = result.evidence.some((line) => line.startsWith("library "));
            const holds =
              (each.expected as readonly string[]).includes(result.outcome) &&
              (each.reason === undefined || result.reason === each.reason) &&
              (result.outcome !== "supported" || !each.aboutLibrary || byLibrary) &&
              (!each.mustNotBeNotFound || !result.notFound);
            if (holds) right++;
            totalRequests += result.requests;
            timesMs.push(result.elapsedMs);
            if (
              result.outcome === "supported" &&
              (!each.expected.includes("supported") || (each.aboutLibrary && !byLibrary))
            ) {
              falseSupported.push(`${each.id}: ${each.sentence}`);
            }
            if (each.mustNotBeNotFound && result.notFound) {
              wrongNotFound.push(`${each.id}: ${each.sentence}`);
            }
            lines.push(
              `- ${holds ? "ok" : "MISS"} [${each.id} · ${each.group}/${each.category} · ${each.library}] ${each.sentence} → ${result.outcome}${result.reason ? ` (${result.reason})` : ""}${result.notFound ? " [NOT-FOUND+CUT]" : ""} · ${result.requests} req · ${(result.elapsedMs / 1000).toFixed(1)}s${result.evidence.length ? ` · ${result.evidence.join("; ")}` : ""}`,
            );
            spent.push((await core.getCostSummary()).spent);
          } finally {
            core.close();
          }
        }
        lines.push(
          `Right: ${right} of ${cases.length}. False Supported: ${falseSupported.length}. Wrong Not-found+Cut: ${wrongNotFound.length}. Requests: ${totalRequests}. Median seconds: ${(median(timesMs) / 1000).toFixed(2)}s.`,
          `Spent, each case: ${JSON.stringify(spent)}`,
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
