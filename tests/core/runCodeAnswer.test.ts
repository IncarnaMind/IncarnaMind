/**
 * `run_code` in an Answer (ADR-0025): offered only where code runs in the OS sandbox, an
 * Analysis like one in Pyodide, numbered with them, and told plainly when Python can't be had.
 * The Executor here runs bash on this computer and only says it is the OS sandbox's: what the
 * sandbox keeps the code from is tested against the real one (tests/main/runCode.test.ts).
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import type { Executor } from "../../src/core/adapters";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import { createLocalExecutor } from "../../src/core/execution";
import { createProcessLauncher } from "../../src/main/processes";
import { programMeter } from "../../src/main/programMeter";
import { createCodeHost } from "../../src/main/runCode/host";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { answerRequests, codeToolOn, scriptedModel, scriptedModels } from "../helpers/models";

const LOG = ["GET /a 200", "GET /b 500", "GET /c 500", "POST /d 201", ""].join("\n");

async function executorAt(level: "os" | "none"): Promise<Executor> {
  const local = createLocalExecutor({
    processes: createProcessLauncher(async () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" })),
    tempDir: await createTempDataFolder(),
    reportError: (error) => {
      throw error;
    },
    meter: programMeter,
  });
  return { level, run: (request) => local.run(request) };
}

function told(model: MockLanguageModelV4, tool: string): string[] {
  const texts: string[] = [];
  for (const message of answerRequests(model).at(-1)?.prompt ?? []) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === tool && part.output.type === "text") {
        texts.push(part.output.value);
      }
    }
  }
  return texts;
}

type Passages = (name: string) => string;

/** A model that searches, then makes `calls` with the Passages it found, then answers. */
function codingModel(calls: ((passage: Passages) => { tool: string; input: unknown })[]) {
  const offered: string[][] = [];
  const systems: string[] = [];
  const model = scriptedModel((call) => {
    offered.push(call.tools);
    systems.push(call.system);
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0)
      return {
        calls: [
          { tool: "search_documents", input: { query: "errors" } },
          { tool: "search_documents", input: { query: "revenue" } },
        ],
      };
    const done = call.results.filter((result) => result.tool !== "search_documents").length;
    const next = calls[done];
    const shown = searches.flatMap((each) => shownPassages(each.text));
    const passage: Passages = (name) =>
      shown.find((each) => each.document.startsWith(name))?.id ?? "P1";
    return next ? { calls: [next(passage)] } : { text: "Done." };
  });
  return { model, offered, systems };
}

/** The folder the last `setUp` wrote its Documents' files to. */
let lastSources = "";

async function setUp(
  model: MockLanguageModelV4,
  options: {
    level?: "os" | "none";
    codeRuntime?: boolean;
    /** Leave run_code to the shipped catalog, which offers it to no model yet. */
    catalogOnly?: boolean;
    manifestUrl?: string;
    /** sales.csv's rows below its heading; null: no sales.csv, so no sheet to run_analysis. */
    salesRows?: string[] | null;
  } = {},
) {
  const dataDir = await createTempDataFolder();
  const core: Core = startCore(dataDir, {
    ...(options.catalogOnly !== true && codeToolOn()),
    createChatModel: scriptedModels(model).createChatModel,
    analysisRuntime: createFakeAnalysisRuntime({
      answer: () => ({
        output: { results: [{ kind: "figure", name: "n", label: "Rows", unit: null, value: 4 }] },
      }),
    }),
    executor: await executorAt(options.level ?? "os"),
    ...(options.codeRuntime !== false && {
      codeRuntime: createCodeHost({
        python: options.manifestUrl
          ? {
              file: "python-runtime-test.tar.zst",
              url: options.manifestUrl,
              size: 1000,
              sha256: "b".repeat(64),
              platform: "test",
              python: "3.14.10",
              packages: {},
            }
          : null,
        font: null,
        appVersion: "0.0.0-test",
      }),
    }),
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createTempDataFolder();
  lastSources = sources;
  await addAndProcess(core, [
    await writeSourceFile(sources, "server.log.txt", LOG),
    ...(options.salesRows === null
      ? []
      : [
          await writeSourceFile(
            sources,
            "sales.csv",
            ["Region,Revenue", ...(options.salesRows ?? ["North,1", "South,2"]), ""].join("\n"),
          ),
        ]),
  ]);
  return core;
}

async function ask(core: Core, text: string) {
  const asked = await core.askInConversation({ text });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  const content = await core.getConversation(asked.conversation.id);
  const answer = content.messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

const bash = (code: string) => (passage: Passages) => ({
  tool: "run_code",
  input: { title: "Errors in the log", language: "bash", documents: [passage("server")], code },
});

describe.skipIf(process.platform === "win32")("run_code in an Answer", () => {
  test("with the shipped catalog alone it is offered to no model yet, even where code runs in the OS sandbox", async () => {
    const { model, offered } = codingModel([]);
    await ask(await setUp(model, { catalogOnly: true }), "How many errors are in the log?");
    expect(offered.at(-1)).toContain("run_analysis");
    expect(offered.at(-1)).not.toContain("run_code");
  });

  test("is offered, with when to use it, only where code runs in the OS sandbox", async () => {
    const sandboxed = codingModel([]);
    await ask(await setUp(sandboxed.model), "How many errors are in the log?");
    expect(sandboxed.offered.at(-1)).toContain("run_code");
    expect(sandboxed.systems.at(-1)).toContain(
      "run_code runs Python or bash on copies of whole files",
    );

    const unsandboxed = codingModel([]);
    await ask(await setUp(unsandboxed.model, { level: "none" }), "How many errors are in the log?");
    expect(unsandboxed.offered.at(-1)).not.toContain("run_code");
    expect(unsandboxed.offered.at(-1)).toContain("run_analysis");
    expect(unsandboxed.systems.at(-1)).not.toContain("run_code");

    const without = codingModel([]);
    await ask(
      await setUp(without.model, { codeRuntime: false }),
      "How many errors are in the log?",
    );
    expect(without.offered.at(-1)).not.toContain("run_code");
  });

  test("a sheet run_analysis read only in part is to be run again with run_code", async () => {
    const { model } = codingModel([
      (passage) => ({
        tool: "run_analysis",
        input: {
          title: "Revenue",
          inputs: [{ name: "sales", passage: passage("sales") }],
          code: 'result("n", len(inputs["sales"]), "Rows")',
        },
      }),
    ]);
    const rows = Array.from({ length: 20_050 }, (_, index) => `R${index % 7},${index}`);
    const core = await setUp(model, {
      salesRows: rows,
      manifestUrl: "http://127.0.0.1:9/python-runtime-test.tar.zst",
    });
    const answer = await ask(core, "What is the revenue over every row?");
    expect(answer.analyses[0]?.inputs[0]).toMatchObject({ kind: "range", cut: true });
    expect(told(model, "run_analysis")[0]).toContain(
      "the most run_analysis reads; run it again with run_code, which reads up to 200,000 rows",
    );

    // A copy with no Python of its own: run_code couldn't read the rows either.
    const without = codingModel([
      (passage) => ({
        tool: "run_analysis",
        input: {
          title: "Revenue",
          inputs: [{ name: "sales", passage: passage("sales") }],
          code: 'result("n", len(inputs["sales"]), "Rows")',
        },
      }),
    ]);
    await ask(
      await setUp(without.model, { salesRows: rows }),
      "What is the revenue over every row?",
    );
    expect(told(without.model, "run_analysis")[0]).toContain("say so in the Answer");
  }, 90_000);

  test("once run_code couldn't get Python, a range cut later is to be said so, not run again there", async () => {
    const revenue = (passage: Passages) => ({
      tool: "run_analysis",
      input: {
        title: "Revenue",
        inputs: [{ name: "sales", passage: passage("sales") }],
        code: 'result("n", len(inputs["sales"]), "Rows")',
      },
    });
    const { model } = codingModel([
      revenue,
      (passage) => ({
        tool: "run_code",
        input: {
          title: "Revenue",
          language: "python",
          documents: [passage("sales")],
          code: 'df = read_table("sales.csv")\nfigure("total", df["Revenue"], "sum", "Revenue")',
        },
      }),
      revenue,
    ]);
    const rows = Array.from({ length: 20_050 }, (_, index) => `R${index % 7},${index}`);
    // Nothing listens there: the first download fails, as it does offline.
    const core = await setUp(model, {
      salesRows: rows,
      manifestUrl: "http://127.0.0.1:9/python-runtime-test.tar.zst",
    });
    const answer = await ask(core, "What is the revenue over every row?");
    const [before, after] = told(model, "run_analysis");
    expect(before).toContain("run it again with run_code, which reads up to 200,000 rows");
    expect(told(model, "run_code")[0]).toContain("Python didn't run");
    expect(after).toContain("the most this Analysis can read; say so in the Answer");
    expect(after).not.toContain("run_code");
    expect(answer.analyses.map((each) => each.end.kind)).toEqual(["done", "unavailable", "done"]);
  }, 90_000);

  test("runs bash on a copy of the Document, as an Analysis numbered after one in Pyodide", async () => {
    const { model } = codingModel([
      (passage) => ({
        tool: "run_analysis",
        input: {
          title: "Rows",
          inputs: [{ name: "sales", passage: passage("sales") }],
          code: 'result("n", 4, "Rows")',
        },
      }),
      bash("grep -c ' 500' ../inputs/server.log.txt"),
    ]);
    const core = await setUp(model);
    const answer = await ask(core, "How many errors are in the log?");
    expect(answer.analyses.map((analysis) => [analysis.number, analysis.language])).toEqual([
      [1, "python"],
      [2, "bash"],
    ]);
    const run = answer.analyses[1];
    expect(run?.output.printed).toBe("2");
    expect(run?.files?.map((file) => [file.name, file.documentName])).toEqual([
      ["server.log.txt", "server.log"],
    ]);
    const step = answer.toolCalls.find((call) => call.tool === "run_code");
    expect(step?.analysis).toMatchObject({ number: 2, documents: ["server.log"], end: "done" });
    const report = told(model, "run_code")[0] ?? "";
    expect(report).toContain("Analysis 2: Errors in the log");
    expect(report).toContain("Files in ../inputs:\n- server.log.txt (server.log): ");
    expect(report).toContain(
      "bash is for looking around: no number it printed may be given in the Answer.",
    );
  });

  test("Python in a copy without its own: the model is told to analyse in Pyodide instead", async () => {
    const { model } = codingModel([
      (passage) => ({
        tool: "run_code",
        input: {
          title: "Count",
          language: "python",
          documents: [passage("server")],
          code: "print(1)",
        },
      }),
    ]);
    const answer = await ask(await setUp(model), "How many errors are in the log?");
    expect(told(model, "run_code")[0]).toBe(
      "Python didn't run: this copy of IncarnaMind has no Python of its own. Run this analysis with run_analysis instead, on ranges of the sheets you found; it needs no download. bash still runs here.",
    );
    expect(answer.analyses[0]?.end).toMatchObject({ kind: "unavailable", reason: "missing" });
  });

  test("Python in a copy without its own, with no sheet for run_analysis: the model is told to say so", async () => {
    const { model, offered } = codingModel([
      (passage) => ({
        tool: "run_code",
        input: {
          title: "Count",
          language: "python",
          documents: [passage("server")],
          code: "print(1)",
        },
      }),
    ]);
    await ask(await setUp(model, { salesRows: null }), "How many errors are in the log?");
    expect(offered.at(-1)).not.toContain("run_analysis");
    expect(offered.at(-1)).toContain("run_code");
    expect(told(model, "run_code")[0]).toBe(
      "Python didn't run: this copy of IncarnaMind has no Python of its own. Say in the Answer that the analysis couldn't run. bash still runs here.",
    );
  });

  test("Python that can't be downloaded: the step says why, and the model is told to analyse in Pyodide", async () => {
    const { model } = codingModel([
      (passage) => ({
        tool: "run_code",
        input: {
          title: "Count",
          language: "python",
          documents: [passage("server")],
          code: "print(1)",
        },
      }),
    ]);
    const core = await setUp(model, {
      manifestUrl: "http://127.0.0.1:9/python-runtime-test.tar.zst",
    });
    const answer = await ask(core, "How many errors are in the log?");
    expect(told(model, "run_code")[0]).toContain(
      "Python didn't run: it couldn't be downloaded: the computer may be offline. Run this analysis with run_analysis instead",
    );
    const step = answer.toolCalls.find((call) => call.tool === "run_code");
    expect(step?.analysis).toMatchObject({
      end: "unavailable",
      reason: "python",
      python: "network",
    });
    expect((await core.getPythonRuntime())?.state).toBe("failed");
  }, 60_000);

  test("a Document whose file has gone since it was read runs nothing, and the model is told so", async () => {
    const { model } = codingModel([bash("grep -c 500 ../inputs/server.log.txt")]);
    const core = await setUp(model);
    await rm(join(lastSources, "server.log.txt"));
    const answer = await ask(core, "How many errors are in the log?");
    expect(told(model, "run_code")[0]).toBe("Nothing ran: server.log's file can't be found.");
    expect(answer.analyses).toEqual([]);
  });

  test("a Passage the model wasn't given runs nothing", async () => {
    const { model } = codingModel([
      () => ({
        tool: "run_code",
        input: { title: "Probe", language: "bash", documents: ["P99"], code: "echo ran" },
      }),
    ]);
    const answer = await ask(await setUp(model), "How many errors are in the log?");
    expect(told(model, "run_code")[0]).toBe("Nothing ran: P99 isn't a Passage you were given.");
    expect(answer.analyses).toEqual([]);
  });
});
