/**
 * `npm run eval:speed` (eval/speed/README.md): the speed baseline of #1624. Each flow in ./flows,
 * on each model, in each language, a few times, over the mixed sample set in data/ and data/real/,
 * with the built-in reranker on this computer as Users have it. Prints the tables of ./report and
 * writes them to eval/results/speed-<time>/.
 *
 * INCARNAMIND_EVAL_SPEED_MODELS: the models, "<kind>/<model id>" comma-separated, for example
 *   "anthropic/claude-haiku-5-5,kimi/kimi-k2.6". Each kind's key is INCARNAMIND_EVAL_SPEED_KEY_<KIND>
 *   (INCARNAMIND_EVAL_SPEED_KEY_ANTHROPIC…), and its endpoint INCARNAMIND_EVAL_SPEED_ENDPOINT_<KIND>.
 * INCARNAMIND_EVAL_SPEED_FLOWS: flow ids to run, comma-separated (default: all).
 * INCARNAMIND_EVAL_SPEED_LANGUAGES: "en", "zh-CN" or both (default: both).
 * INCARNAMIND_EVAL_SPEED_RUNS: how many times each flow runs per model and language (default: 3).
 * INCARNAMIND_EVAL_SPEED_STOP_USD: stops before the next run once this much is spent (default: 12).
 * INCARNAMIND_EVAL_SPEED_AUDIT: "1" adds the token audit (#1634, ./tokens): what each part of each
 *   request carries, with the cached share, in the report and in tokens.json.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { createOnnxTextRecognizer } from "../../src/core/documents/scan/onnx";
import { queryDatabase } from "../../tests/helpers/core";
import { buildPdf } from "../../tests/helpers/pdf";
import { reports } from "../everyday/asking";
import { readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { FLOWS, type Language } from "./flows";
import { type FlowRun, flowTable, percentile, requestTable, type TimingRecord } from "./report";
import { env, list, modelsAsked, spentUsd } from "./settings";
import { createTokenAuditor, type TokenAuditRun, tokenReport } from "./tokens";

const ROOT = resolve(__dirname, "../..");

// The scan set's pictures as one scanned PDF, read as a Document, for the text recognition step.
async function readScans(cacheDir: string, log: ReturnType<typeof createLog>) {
  const folder = join(ROOT, "tests", "fixtures", "scans");
  const pictures = (await readdir(folder)).filter((name) => name.endsWith(".jpg"));
  const scanned = join(await mkdtemp(join(tmpdir(), "incarnamind-speed-scans-")), "Scans.pdf");
  await writeFile(
    scanned,
    buildPdf(
      await Promise.all(
        pictures.map(async (name) => ({
          scan: new Uint8Array(await readFile(join(folder, name))),
        })),
      ),
    ),
  );
  const library = await openLibrary({
    name: "speed-scans",
    embedder: createWorkerEmbedder(),
    modelCache: join(cacheDir, "models"),
    textRecognizer: createOnnxTextRecognizer(),
    documents: [{ key: "scans", path: scanned }],
    embeddings: false,
    keep: false,
    log,
  });
  try {
    return queryDatabase<TimingRecord>(
      library.dataDir,
      "SELECT * FROM ai_timings WHERE kind = 'local' ORDER BY started_at, rowid",
    );
  } finally {
    await library.close();
  }
}

const NOT_MEASURED = [
  "- DeepSeek: no key for this run.",
  "- The ChatGPT plan: its sign-in is in a browser, which a run can't do; it is timed by hand in the app.",
  "- Call help and the meeting notes after Stop: they need a Meeting's audio and transcription, which this runner doesn't record.",
  "- Organize and Automatic Tags run in the background as Documents are added: their requests made during a run show under `tagging` and `classification` in the requests table.",
  "- The first sign of the flows that aren't Answers is the first one the core sends; the window's own pending state, shown at once, isn't seen here.",
];

// A paired run (./paired.speed) times its own items instead.
const baseline = env("PAIRED") === null ? test : test.skip;

baseline("the speed of every AI flow, on each model and language", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const models = modelsAsked();
  if (models.length === 0) throw new Error("Set INCARNAMIND_EVAL_SPEED_MODELS.");
  const wanted = list("FLOWS");
  const flows = wanted ? FLOWS.filter((flow) => wanted.includes(flow.id)) : FLOWS;
  const languages = (list("LANGUAGES") ?? ["en", "zh-CN"]) as Language[];
  const runs = Number(env("RUNS") ?? "3");
  const stopUsd = Number(env("STOP_USD") ?? "12");
  const audit = env("AUDIT") === "1" ? createTokenAuditor() : null;
  const tokenRuns: TokenAuditRun[] = [];
  const results: FlowRun[] = [];
  const loads: number[] = [];
  let stopped: string | null = null;
  let indexing: TimingRecord[] = [];
  let spent = 0;
  const library = await openLibrary({
    name: "speed",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(config.rerankOnCpu),
    documents: await reports(),
    embeddings: false,
    keep: config.keepData,
    log,
    ...(audit && { chatModels: audit.chatModels }),
  });
  try {
    const { core, dataDir, documents } = library;
    indexing = queryDatabase<TimingRecord>(
      dataDir,
      "SELECT * FROM ai_timings WHERE kind = 'local' ORDER BY started_at, rowid",
    );
    // Setting the variables is the consent to send the requests and Passages to each model.
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    matrix: for (const model of models) {
      const name = `${model.kind}/${model.modelId}`;
      await core.saveChatProvider(model);
      await core.updateSettings({ user: { suggestWhileWriting: true } });
      for (const flow of flows) {
        for (const language of languages) {
          await core.updateSettings({ user: { language } });
          for (let run = 1; run <= runs; run++) {
            spent = await spentUsd(core);
            if (spent >= stopUsd) {
              stopped = `Stopped at $${spent.toFixed(2)}, before ${name} · ${flow.id} · ${language} · ${run}.`;
              log(stopped);
              break matrix;
            }
            const since = new Date().toISOString();
            const load = loadavg()[0] ?? 0;
            loads.push(load);
            log(`${name} · ${flow.id} · ${language} · ${run}/${runs} · load ${load.toFixed(1)}`);
            let signs: FlowRun["signs"] = null;
            let error: string | null = null;
            audit?.begin({ flow: flow.id, model: name, language });
            try {
              signs = await flow.run({ core, language, documents });
            } catch (thrown) {
              error = thrown instanceof Error ? thrown.message : String(thrown);
              log(`  failed: ${error}`);
            } finally {
              tokenRuns.push({
                flow: flow.id,
                model: name,
                language,
                requests: audit?.end() ?? [],
              });
            }
            // From the User's action: what a flow set up first (an earlier Answer) isn't its.
            const records = queryDatabase<TimingRecord>(
              dataDir,
              "SELECT * FROM ai_timings WHERE started_at >= ? ORDER BY started_at, rowid",
              [signs?.startedAt ?? since],
            );
            results.push({ flow: flow.id, model: name, language, signs, error, records });
          }
        }
      }
    }
    spent = await spentUsd(core);
  } finally {
    await library.close();
  }
  const scanned = await readScans(config.cacheDir, log);
  const cpu = cpus()[0]?.model ?? "unknown CPU";
  const loadLine = `one-minute load ${Math.min(...loads).toFixed(1)} to ${Math.max(...loads).toFixed(1)}, median ${(percentile(loads, 0.5) ?? 0).toFixed(1)}`;
  const report = [
    "# Speed baseline",
    "",
    `${new Date().toISOString()} · ${runs} runs a flow, model and language · times are median / 90th percentile.`,
    "",
    `This computer: ${cpu}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB; ${loadLine}. Spent: $${spent.toFixed(2)}.${stopped ? ` ${stopped}` : ""}`,
    "",
    "## Flows",
    "",
    flowTable(results),
    "",
    "## Requests and local steps",
    "",
    requestTable(results),
    "",
    "## Indexing the sample Documents on this computer",
    "",
    requestTable([
      {
        flow: "index",
        model: "local",
        language: "en",
        signs: null,
        error: null,
        records: indexing,
      },
    ]),
    "",
    "## Reading scans on this computer",
    "",
    "The scan set's pictures (tests/fixtures/scans), as one scanned PDF, read with the built-in text recognition model as the app reads them.",
    "",
    requestTable([
      { flow: "scans", model: "local", language: "en", signs: null, error: null, records: scanned },
    ]),
    "",
    "## Not measured here",
    "",
    ...NOT_MEASURED,
    "",
    ...(audit
      ? [
          "## Tokens",
          "",
          tokenReport(tokenRuns),
          "",
          "### Call help",
          "",
          "Call help has no flow: it needs a Meeting's audio and live transcript, which this runner doesn't record (see Not measured here). Its calls are not in the tables above.",
          "",
        ]
      : []),
  ].join("\n");
  console.log(report);
  const out = join(config.resultsDir, `speed-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.md"), report);
  await writeFile(join(out, "report.json"), JSON.stringify(results, null, 2));
  if (audit) await writeFile(join(out, "tokens.json"), JSON.stringify(tokenRuns, null, 2));
  log(`Report in ${out}`);
  if (!stopped) expect(results.length).toBe(models.length * flows.length * languages.length * runs);
});
