/**
 * The `run_code` Tool (ADR-0025): an Analysis run in the OS sandbox, on
 * copies of whole Documents, in IncarnaMind's own Python or in bash. At
 * level "os" it is "sandboxed code" (ADR-0023's scope): it reads only copies
 * of Documents the Run was given, writes only its own folder and has no
 * network, so it runs without asking, also after third-party text (#78).
 * It is offered only at that level: a shell outside a sandbox fails closed
 * (ADR-0013). Its runs are Analyses: the same step line, figure markers,
 * tables, pictures and record as an Analysis in Pyodide, counted with them.
 */
import { type AnalysisEnd, noAnalysisOutput } from "../../shared/analysis";
import { sha256 } from "../analysis";
import { type AnalysisRecorder, noMarkers } from "../analysis/recorder";
import { analysisReport } from "../analysis/report";
import { analysesAtTheLimit } from "../analysis/tool";
import type { AnalysisFile, AnswerAnalysis, EmbeddingModelError } from "../api";
import type { Language } from "../language";
import { RUN_CODE_TOOL, type Tool, type ToolProviderInfo } from "../tools";
import { type CodeDocument, type CodeLanguage, type CodeRunner, tableSha256 } from ".";

const PROVIDER: ToolProviderInfo = { kind: "analysis", id: "run-code", name: "Analysis" };

export interface RunCodeToolOptions {
  runner: CodeRunner;
  /** A Passage the model was given, by its id ("P3"): its source, and its Document's file. */
  document(passageId: string): Promise<CodeDocument | null>;
  recorder: AnalysisRecorder;
  language: Language;
  now(): Date;
  ran(toolCallId: string, analysis: AnswerAnalysis): void;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** What the model reads when Python can't be had: plainly why, and to analyse in Pyodide instead. */
function noPython(error: EmbeddingModelError | null): string {
  const why = !error
    ? "this copy of IncarnaMind has no Python of its own"
    : error.kind === "network"
      ? "it couldn't be downloaded: the computer may be offline"
      : error.kind === "integrity"
        ? "the download didn't match what this version of IncarnaMind expects, so it was thrown away"
        : error.kind === "storage"
          ? "it couldn't be saved to IncarnaMind's data folder"
          : "it couldn't start on this computer";
  return `Python didn't run: ${why}. Run this analysis with run_analysis instead, on ranges of the sheets you found; it needs no download. bash still runs here.`;
}

export function runCodeTool(options: RunCodeToolOptions): Tool {
  const { runner, recorder } = options;
  return {
    name: RUN_CODE_TOOL,
    provider: PROVIDER,
    providerTool: RUN_CODE_TOOL,
    description:
      'Run Python or bash on this computer, in a sandbox with no network, on copies of whole Documents you found: for what run_analysis can\'t do, such as more rows than it reads, logs and other text files, a workbook\'s own file (its formulas, with openpyxl) or shell tools (grep, awk, sort). Give title, language ("python" or "bash"), documents (the ids of Passages of each file, e.g. ["P3"]) and code. The files are in ../inputs, read-only. In Python, read_table("sales.csv", sheet) gives a sheet\'s rows as IncarnaMind read them, indexed by row number; give figures with figure() and result() as in run_analysis. Files written to out/ come back.',
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: 'What it works out: "Errors per hour in server.log".',
        },
        language: { type: "string", enum: ["python", "bash"] },
        documents: { type: "array", items: { type: "string" } },
        code: { type: "string" },
      },
      required: ["title", "language", "documents", "code"],
    },
    shownInput: ({ title, language }) => ({
      title: text(title),
      language: language === "bash" ? "bash" : "python",
    }),
    effects: () => [
      { action: "read", scope: { kind: "documents" } },
      { action: "execute", scope: { kind: "sandbox" } },
    ],
    // What the code prints and gives comes from the User's Documents.
    untrustedResult: true,
    async call(input, { toolCallId, signal, readThirdParty }) {
      if (recorder.full()) return analysesAtTheLimit();
      const language: CodeLanguage = input.language === "bash" ? "bash" : "python";
      const code = typeof input.code === "string" ? input.code : "";
      if (!code.trim()) return "Give the code to run.";
      const title = text(input.title) || "Analysis";
      const ids = Array.isArray(input.documents) ? input.documents.map(text) : [];
      const documents: CodeDocument[] = [];
      for (const id of ids) {
        const found = await options.document(id);
        if (!found) return `Nothing ran: ${id || "a document"} isn't a Passage you were given.`;
        if (!documents.some((each) => each.source.documentId === found.source.documentId)) {
          documents.push(found);
        }
      }
      // A saved web page's copy is someone else's text, whatever the code makes of it (#78).
      if (documents.some((each) => each.source.documentKind === "web"))
        readThirdParty?.("web-page");
      const run = await runner.run({ language, code, documents, signal });
      if (run.kind === "refused") return run.reason;
      const number = recorder.next();
      const ranAt = options.now().toISOString();
      const codeSha256 = await sha256(code);
      if (run.kind === "no-python") {
        const end: AnalysisEnd = run.error
          ? {
              kind: "unavailable",
              reason: "python",
              detail: run.error.message,
              python: run.error.kind,
            }
          : {
              kind: "unavailable",
              reason: "missing",
              detail: "This copy of IncarnaMind has no Python of its own.",
            };
        options.ran(toolCallId, {
          number,
          title,
          language,
          code,
          inputs: [],
          versions: null,
          codeSha256,
          outputSha256: await sha256(JSON.stringify({ end, output: noAnalysisOutput() })),
          end,
          output: noAnalysisOutput(),
          ms: 0,
          ranAt,
          markers: noMarkers(),
        });
        return noPython(run.error);
      }
      const read = new Set(run.read);
      const used = run.tables.filter((table) => read.has(table.job.name));
      const marked =
        run.end.kind === "done"
          ? recorder.mark(
              number,
              run.output,
              run.tables.map((table) => table.job),
            )
          : { markers: noMarkers() };
      const files: AnalysisFile[] = run.files;
      const analysis: AnswerAnalysis = {
        number,
        title,
        language,
        code,
        inputs: await Promise.all(
          used.map(async (table) => ({ ...table.record, sha256: await tableSha256(table) })),
        ),
        versions: run.versions,
        codeSha256,
        outputSha256: await sha256(JSON.stringify({ end: run.end, output: run.output })),
        end: run.end,
        output: run.output,
        ms: run.ms,
        ranAt,
        ...marked,
        files,
        outFiles: { files: run.out, left: run.outLeft },
      };
      options.ran(toolCallId, analysis);
      return analysisReport(analysis, options.language);
    },
  };
}
