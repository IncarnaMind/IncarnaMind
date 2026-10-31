/**
 * The run_code Tool (spike, docs/adr/0025). At level "os" it is "sandboxed
 * code" (ADR-0023's scope): it reads only copies of the Documents it names,
 * writes only its own folder and has no network, so it runs without asking.
 * At "none" it can do anything the User can, so every call asks, with no
 * "always".
 */
import type { Effect } from "../api";
import type { Tool, ToolProviderInfo } from "../tools";
import type { CodeDocument, CodeRun, createCodeRunner } from ".";

export const RUN_CODE_TOOL = "run_code";

const PROVIDER: ToolProviderInfo = { kind: "analysis", id: "run-code", name: "Run code" };

/** How long one call may run. */
const TIME_LIMIT_MS = 120_000;

export interface RunCodeToolOptions {
  runner: ReturnType<typeof createCodeRunner>;
  /** The file of the Document a Passage the model was given ("P3") is of, as its index last read it. */
  documentOf(passageId: string): CodeDocument | null;
  ran(toolCallId: string, run: CodeRun): void;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function report(run: CodeRun): string {
  if (run.refused) return run.refused;
  const exec = run.exec;
  const lines: string[] = [];
  if (exec?.timedOut) lines.push("It ran past its time limit and was stopped.");
  else if (exec?.limit) lines.push(`It went past its ${exec.limit} limit and was stopped.`);
  else lines.push(`It exited with code ${exec?.exitCode ?? "none"}.`);
  lines.push(
    "<stdout>",
    exec?.stdout ?? "",
    "</stdout>",
    "<stderr>",
    exec?.stderr ?? "",
    "</stderr>",
  );
  for (const file of run.files) lines.push(`File out/${file.name}: ${file.bytes} bytes`);
  run.figures.forEach((figure, index) => {
    const check =
      figure.check.kind === "recalculated"
        ? "inputs found · recalculated"
        : figure.check.kind === "differs"
          ? `the cells it names come to ${figure.check.value}, not this: don't use it`
          : `unchecked: ${figure.check.reason}`;
    lines.push(`Figure [=${index + 1}] ${figure.label}: ${figure.value} (${check})`);
  });
  return lines.join("\n");
}

export function runCodeTool(options: RunCodeToolOptions): Tool {
  const sandboxed = options.runner.level !== "none";
  return {
    name: RUN_CODE_TOOL,
    provider: PROVIDER,
    providerTool: RUN_CODE_TOOL,
    description:
      'Run Python (pandas, numpy, scipy, statsmodels, scikit-learn, matplotlib) or bash on copies of Documents you found, with no network. Give title, language, documents (Passage ids, e.g. ["P3"]) and code. Files are in the working folder\'s ../inputs, read-only. In Python, read_table("sales.csv") gives a DataFrame indexed by sheet row. figure(name, column, how, label, unit) gives a figure the app checks against the cells: column is a column of read_table rows after any filtering (df.loc[df.region == "North", "revenue"]), how is "sum", "mean", "min", "max" or "count", and it returns the value. result(name, value, label, unit) gives any other number, shown as unchecked. table(name, df) and files written to out/ come back.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        language: { type: "string", enum: ["python", "bash"] },
        documents: { type: "array", items: { type: "string" } },
        code: { type: "string" },
      },
      required: ["title", "language", "documents", "code"],
    },
    shownInput: ({ title }) => ({ title: text(title) }),
    effects: (): Effect[] => [
      { action: "read", scope: { kind: "documents" } },
      { action: "execute", scope: sandboxed ? { kind: "sandbox" } : { kind: "anywhere" } },
    ],
    untrustedResult: true,
    async call(input, { toolCallId, signal }) {
      const language = input.language === "bash" ? "bash" : "python";
      const code = typeof input.code === "string" ? input.code : "";
      if (!code.trim()) return "Give the code to run.";
      const ids = Array.isArray(input.documents) ? input.documents.map(text) : [];
      const documents: CodeDocument[] = [];
      for (const id of ids) {
        const file = options.documentOf(id);
        if (!file) return `Nothing ran: ${id || "a document"} isn't a Passage you were given.`;
        if (!documents.some((each) => each.documentId === file.documentId)) documents.push(file);
      }
      const run = await options.runner.run({
        language,
        code,
        documents,
        timeoutMs: TIME_LIMIT_MS,
        signal,
      });
      options.ran(toolCallId, run);
      return report(run);
    },
  };
}
