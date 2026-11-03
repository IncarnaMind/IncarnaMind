/**
 * `npm run eval:run-code` (#2351): where a real model sends each held-out request (./cases):
 * `run_code`, an Analysis in Pyodide (`run_analysis`), or neither, asked in the assistant as the
 * app asks it. `run_code` runs for real, in the OS sandbox and IncarnaMind's own Python, so its
 * figures, failed calls and times are counted too. `run_analysis` has no Pyodide outside the app
 * (a stand-in answers it), so an Answer stops at its first `run_analysis` call, which is all its
 * route needs; one that should reach `run_code` goes on, as a range `run_analysis` cut is to be
 * run again there, and `reached` says whether it did.
 *
 * Settings: INCARNAMIND_EVAL_CHAT_* as for `npm run eval`; INCARNAMIND_TEST_PYTHON_RUNTIME, the
 * folder `npm run python:native` wrote the archive to (without it, Python can't run and the
 * model is told so); INCARNAMIND_EVAL_RUNCODE_CASES, case ids to run. Run on `main` too, where no
 * `run_code` exists, for the baseline. The report goes to eval/results/.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import type { AnswerAnalysis, AnswerToolCall, ConversationAnswer, Core } from "../../src/core";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import { createPrintedNumbers } from "../../src/core/answers/printedNumbers";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import type { PythonRuntimeManifest } from "../../src/core/runCode";
import { createProcessLauncher } from "../../src/main/processes";
import { createCodeHost } from "../../src/main/runCode/host";
import { loadOsSandbox, readDeniedFolders } from "../../src/main/sandbox";
import { printedValues } from "../../src/shared/printedFigures";
import { queryDatabase } from "../../tests/helpers/core";
import { codeToolOn } from "../../tests/helpers/models";
import { createSweepGuard } from "../../tests/helpers/sweepGuard";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { FRESH_CASES, PRINTED_CASES, ROUTING_CASES, type Route, type RoutingCase } from "./cases";
import { writeRoutingDocuments } from "./documents";

const root = fileURLToPath(new URL("../..", import.meta.url));

interface Billed {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

const billedIn = (dataDir: string): Billed =>
  queryDatabase<Billed>(
    dataDir,
    `SELECT count(*) AS requests, coalesce(sum(input_tokens), 0) AS inputTokens,
       coalesce(sum(cached_input_tokens), 0) AS cacheReadTokens,
       coalesce(sum(cache_write_tokens), 0) AS cacheWriteTokens,
       coalesce(sum(output_tokens), 0) AS outputTokens
     FROM model_requests WHERE deleted_at IS NULL`,
  )[0] ?? { requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

interface Observed {
  id: string;
  expected: Route;
  /** The first Analysis Tool it called, or none. */
  routed: Route;
  /** Whether it called `run_code` at all, after `run_analysis` or not. */
  reached: boolean;
  /** What each `run_code` call that ran nothing was told, in short. */
  refused: string[];
  /**
   * Numbers the reply typed itself, outside its markers and Citations: a figure that reaches the
   * User unchecked. Dates, years, ordinals and list numbers count too; the report lists them.
   */
  typedNumbers: string[];
  /** Numbers code printed that reach the Answer as figures calculated by code (#2351). */
  printedMarked: string[];
  /**
   * Numbers the reply typed that equal one code printed, by the figure check's rule, and that its
   * Citations don't quote: what the marking would still mark in its text.
   */
  printedUnmarked: string[];
  /** A cross-check by digits alone: typed numbers whose digits stand as a number in what code printed. */
  typedAsPrinted: string[];
  codeCalls: number;
  /** `run_code` calls that didn't end done. */
  failedCalls: number;
  recalculated: number;
  differed: number;
  unchecked: number;
  seconds: number;
  usage: Billed;
  spent: number;
  error?: string;
}

async function spentUsd(core: Core): Promise<number> {
  return (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((sum, each) => sum + each.amount, 0);
}

/** The runtime's manifest, served from a stand-in release on this computer, when the run gives one. */
async function pythonRuntime(folder: string | undefined) {
  if (!folder) return { manifest: null, close: async () => {} };
  const given = JSON.parse(
    readFileSync(join(root, "resources", "python-native", "runtime.json"), "utf8"),
  ) as PythonRuntimeManifest;
  const archive = await readFile(join(folder, given.file));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": archive.byteLength });
    response.end(archive);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    manifest: { ...given, url: `http://127.0.0.1:${port}/${given.file}` },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("run_code routing", async () => {
  const started = new Date();
  const log = createLog(started.getTime());
  const config = readConfig(root);
  if (!config.chat) {
    log("run_code routing: skipped, it needs a real chat model (INCARNAMIND_EVAL_CHAT_*).");
    return;
  }
  const provider = chatProviderOf(config.chat);
  const ids = process.env.INCARNAMIND_EVAL_RUNCODE_CASES?.split(",").map((id) => id.trim());
  const sets = { fresh: FRESH_CASES, printed: PRINTED_CASES } as const;
  const named = process.env.INCARNAMIND_EVAL_RUNCODE_SET;
  const set = named === "fresh" || named === "printed" ? sets[named] : ROUTING_CASES;
  const cases = ids ? set.filter((each) => ids.includes(each.id)) : set;
  const sandbox = await loadOsSandbox();
  const sources = await mkdtemp(join(tmpdir(), "incarnamind-eval-run-code-sources-"));
  const runtime = await pythonRuntime(process.env.INCARNAMIND_TEST_PYTHON_RUNTIME);
  const home = await mkdtemp(join(tmpdir(), "incarnamind-eval-run-code-home-"));
  // Each pid a run's sweep signals is a member of one of this eval's own runs.
  const guard = createSweepGuard();
  const library = await openLibrary({
    name: "run-code",
    embedder: createFakeEmbedder(),
    documents: await writeRoutingDocuments(sources),
    embeddings: false,
    keep: config.keepData,
    log,
    analysisRuntime: createFakeAnalysisRuntime({ answer: () => ({}) }),
    // On, as on a `main` that offered run_code to no model yet (#2351): both arms are measured alike.
    ...codeToolOn(),
    ...(sandbox.available && {
      executor: sandbox.createExecutor({
        processes: createProcessLauncher(async () => ({
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        })),
        environment: async () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
        tempDir: tmpdir(),
        denyRead: readDeniedFolders({
          platform: process.platform,
          home,
          dataDir: home,
          temporaryFolder: tmpdir(),
        }),
        reportError: (error) => log(`The sandbox couldn't clean up: ${String(error)}`),
        runRecords: guard.records(join(home, "runs")),
        sweep: { stopper: guard.stopper },
      }),
      codeRuntime: createCodeHost({ python: runtime.manifest, font: null, appVersion: "eval" }),
    }),
  });
  const observed: Observed[] = [];
  try {
    const { core } = library;
    core.on("consent.requested", (request) => {
      void core.respondToConsent(request.requestId, true);
    });
    const saved = await core.saveChatProvider(provider);
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);
    for (const each of cases) observed.push(await ask(core, library.dataDir, each, log));
  } finally {
    await library.close();
    await runtime.close();
    await rm(sources, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
  if (guard.refused.length > 0) {
    throw new Error(
      `The sweep was refused pids no run of this eval's held: ${JSON.stringify(guard.refused)}`,
    );
  }
  const totals = (route: Route) => {
    const of = observed.filter((each) => each.expected === route);
    return `${of.filter((each) => each.routed === route).length} of ${of.length}`;
  };
  const toCode = observed.filter((each) => each.expected === "run_code");
  const sum = (key: keyof Billed) => observed.reduce((total, each) => total + each.usage[key], 0);
  const report = {
    run: {
      startedAt: started.toISOString(),
      commit: commitOf(root),
      model: `${provider.kind}/${provider.modelId}`,
      sandbox: sandbox.available ? "os" : sandbox.reason,
      python: runtime.manifest !== null,
      sweepSignals: guard.signalled.length,
    },
    routed: {
      run_code: totals("run_code"),
      run_analysis: totals("run_analysis"),
      none: totals("none"),
      reachedRunCode: `${toCode.filter((each) => each.reached).length} of ${toCode.length}`,
    },
    usage: {
      requests: sum("requests"),
      inputTokens: sum("inputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheWriteTokens: sum("cacheWriteTokens"),
      outputTokens: sum("outputTokens"),
      spentUsd: observed.reduce((total, each) => total + each.spent, 0),
    },
    cases: observed,
  };
  const out = join(
    root,
    "eval",
    "results",
    `${started.toISOString().replaceAll(":", "-")}-run-code${named ? `-${named}` : ""}.json`,
  );
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  log(
    `Routed as expected: run_code ${report.routed.run_code}, run_analysis ${report.routed.run_analysis}, neither ${report.routed.none}; run_code reached in the end ${report.routed.reachedRunCode}`,
  );
  log(
    `Spent $${report.usage.spentUsd.toFixed(4)} in ${report.usage.requests} requests. Report: ${out}`,
  );
});

/** The numbers a reply's text gives, with its markers ([=1], [=table 1]) and Citations ([1]) left out. */
const typedNumbersIn = (text: string): string[] =>
  text.replace(/\[[^\]]*\]/g, " ").match(/\d[\d,.]*/g) ?? [];

const printedText = (analysis: AnswerAnalysis): string =>
  [
    analysis.output.printed,
    ...(analysis.outFiles?.files ?? []).map((file) => file.text ?? ""),
  ].join("\n");

/** What a reply shows of the numbers its code printed: marked as figures, or typed. */
function printedIn(answer: ConversationAnswer | null, language: RoutingCase["language"]) {
  if (!answer) return { printedMarked: [], printedUnmarked: [], typedAsPrinted: [] };
  const printed = new Map(
    answer.analyses.map((analysis) => [
      analysis.number,
      new Set(printedValues(analysis).map((each) => each.value.name)),
    ]),
  );
  const printedMarked = answer.figures.flatMap((figure) =>
    figure.analysis && printed.get(figure.analysis.analysis)?.has(figure.analysis.result)
      ? [figure.shown]
      : [],
  );
  const figures = new Map(answer.figures.map((figure) => [figure.marker, figure]));
  const quotes = new Map(answer.citations.map((citation) => [citation.marker, citation.quote]));
  const printedUnmarked: string[] = [];
  const marked = createPrintedNumbers({
    language,
    record: (figure) => {
      printedUnmarked.push(figure.shown);
      return 9000 + printedUnmarked.length;
    },
  });
  marked(answer.text, {
    analyses: answer.analyses,
    quoteOf: (marker) => quotes.get(marker) ?? null,
    figureOf: (marker) => figures.get(marker) ?? null,
  });
  const tokens = new Set(
    answer.analyses.flatMap((analysis) => printedText(analysis).match(/\d[\d.]*/g) ?? []),
  );
  const typedAsPrinted = typedNumbersIn(answer.text).filter((typed) =>
    tokens.has(typed.replaceAll(",", "").replace(/\.$/, "")),
  );
  return { printedMarked, printedUnmarked, typedAsPrinted };
}

const isAnalysis = (call: AnswerToolCall) =>
  call.tool === "run_code" || call.tool === "run_analysis";

async function ask(core: Core, dataDir: string, each: RoutingCase, log: (line: string) => void) {
  const before = billedIn(dataDir);
  const spentBefore = await spentUsd(core);
  const started = performance.now();
  const asked = await core.askInConversation({ text: each.question });
  if (!asked.asked) throw new Error(`${each.id} wasn't asked: ${JSON.stringify(asked)}`);
  let first: Route = "none";
  const stopAt = core.on("answer.toolCallStarted", (event) => {
    if (event.answerId !== asked.answerId || first !== "none" || !isAnalysis(event.call)) return;
    first = event.call.tool === "run_code" ? "run_code" : "run_analysis";
    // No Pyodide runs here: its first call is all its route needs, and what follows would be noise.
    if (first === "run_analysis" && each.route !== "run_code") {
      void core.stopConversationAnswer({
        conversationId: asked.conversation.id,
        answerId: asked.answerId,
      });
    }
  });
  let error: string | undefined;
  await new Promise<void>((resolve) => {
    const stops = [
      core.on("answer.finished", (event) => {
        if (event.answerId !== asked.answerId) return;
        for (const stop of stops) stop();
        resolve();
      }),
      core.on("answer.failed", (event) => {
        if (event.answerId !== asked.answerId) return;
        error = JSON.stringify(event);
        for (const stop of stops) stop();
        resolve();
      }),
    ];
  });
  stopAt();
  const content = await core.getConversation(asked.conversation.id);
  const answer = content.messages.find((message) => message.id === asked.answerId);
  const analyses: AnswerAnalysis[] = answer?.kind === "answer" ? answer.analyses : [];
  const calls = answer?.kind === "answer" ? answer.toolCalls : [];
  const codeRuns = new Set(
    calls.flatMap((call) =>
      call.tool === "run_code" && call.analysis ? [call.analysis.number] : [],
    ),
  );
  const code = analyses.filter((analysis) => codeRuns.has(analysis.number));
  const refused = calls.flatMap((call) =>
    call.tool === "run_code" && !call.analysis
      ? [`${call.status}${call.error ? `: ${call.error.message}` : ""}`.slice(0, 160)]
      : [],
  );
  const checks = code.flatMap((analysis) => analysis.recalculations ?? []);
  const after = billedIn(dataDir);
  const observed: Observed = {
    id: each.id,
    expected: each.route,
    routed: first,
    reached: calls.some((call) => call.tool === "run_code"),
    typedNumbers: typedNumbersIn(answer?.kind === "answer" ? answer.text : ""),
    ...printedIn(answer?.kind === "answer" ? answer : null, each.language),
    refused,
    codeCalls: code.length,
    failedCalls: code.filter((analysis) => analysis.end.kind !== "done").length,
    recalculated: checks.filter((check) => check.check.kind === "same").length,
    differed: checks.filter((check) => check.check.kind === "differs").length,
    unchecked: checks.filter((check) => check.check.kind === "unchecked").length,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    usage: {
      requests: after.requests - before.requests,
      inputTokens: after.inputTokens - before.inputTokens,
      cacheReadTokens: after.cacheReadTokens - before.cacheReadTokens,
      cacheWriteTokens: after.cacheWriteTokens - before.cacheWriteTokens,
      outputTokens: after.outputTokens - before.outputTokens,
    },
    spent: (await spentUsd(core)) - spentBefore,
    ...(error && { error }),
  };
  log(
    `${each.id}: expected ${each.route}, routed ${first}${observed.routed !== "run_code" && observed.reached ? ", then run_code" : ""}${refused.length ? `, ${refused.length} refused` : ""}${observed.codeCalls ? `, ${observed.codeCalls} run_code call(s), ${observed.failedCalls} failed, ${observed.recalculated} recalculated, ${observed.unchecked} unchecked` : ""}${observed.typedNumbers.length ? `, typed ${observed.typedNumbers.join(" ")}` : ""}, printed numbers marked ${observed.printedMarked.length}, unmarked ${observed.printedUnmarked.length} (${observed.printedUnmarked.join(" ")}) (${observed.seconds} s, $${observed.spent.toFixed(4)})`,
  );
  return observed;
}
