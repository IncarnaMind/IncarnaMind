/**
 * `npm run eval:harness` (README.md): the same requests through IncarnaMind's
 * Run engine and two outside agent harnesses, on one model, with the same
 * Document and Citation Tools, and one results table for the model.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "vitest";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { judgeOf } from "../everyday/asking";
import { chatSettings, readConfig } from "../lib/config";
import { createLog } from "../lib/log";
import { HARNESS_CASES, type HarnessCase, type HarnessLibrary } from "./cases";
import { claudeMcpConfig } from "./claudeCode";
import { CODEX_OFF, codexSettings } from "./codex";
import { type HarnessSetup, type OutsideRecord, runOurs, runOutside } from "./harnesses";
import { documentsOf, openHarnessLibrary, SHIM } from "./libraries";
import { startModelProxy } from "./modelProxy";
import type { OutsideRunOptions } from "./outside";
import { adapterCheck, type HarnessConfiguration, harnessReport } from "./report";
import type { HarnessName, HarnessRun } from "./score";
import { HARNESS_INSTRUCTIONS, HARNESS_SKILL, HARNESS_TOOLS } from "./wording";

const ROOT = resolve(__dirname, "../..");
const PREFIX = "INCARNAMIND_EVAL_HARNESS";
const LIBRARIES: readonly HarnessLibrary[] = ["papers", "reports", "dated", "credit"];
const HARNESSES: readonly HarnessName[] = ["incarnamind", "claude-code", "codex"];

const setting = (name: string) => process.env[`${PREFIX}${name}`]?.trim() || null;

/** A small seeded generator (mulberry32), so a seed gives the same order every time. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

/** A command on the PATH, as the file it runs. */
function binary(name: string): string {
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(folder, name);
    if (existsSync(path)) return realpathSync(path);
  }
  throw new Error(`${name} isn't on the PATH: set ${PREFIX}_${name.toUpperCase()}.`);
}

/** A harness's version, asked with a temporary home so nothing of anyone's own setup is read. */
async function versionOf(bin: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "incarnamind-harness-version-"));
  try {
    return execFileSync(bin, ["--version"], {
      env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home },
      encoding: "utf8",
    }).trim();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

type Line = { run: HarnessRun } & Partial<Pick<OutsideRecord, "shim" | "proxy">>;

const keyOf = (run: Pick<HarnessRun, "harness" | "id" | "run">) =>
  `${run.harness} ${run.id} ${run.run}`;

test("harness bake-off", async () => {
  const log = createLog();
  const startedAt = new Date().toISOString();
  const config = readConfig(ROOT);
  const chat = config.chat;
  if (!chat) {
    log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY (README.md).");
    return;
  }
  if (chat.kind !== "anthropic" && chat.kind !== "openai") {
    throw new Error(
      "The bake-off runs on Anthropic or OpenAI models: the outside harnesses take no others.",
    );
  }
  if (!chat.apiKey) throw new Error("Set INCARNAMIND_EVAL_CHAT_KEY.");
  const asked = (setting("") ?? HARNESSES.join(",")).split(",").map((each) => each.trim());
  const harnesses = HARNESSES.filter((harness) => asked.includes(harness));
  // Claude Code speaks only Anthropic's Messages API.
  const skipped: HarnessName[] =
    chat.kind === "anthropic" ? [] : harnesses.filter((harness) => harness === "claude-code");
  const running = harnesses.filter((harness) => !skipped.includes(harness));
  for (const harness of skipped)
    log(`${harness} can't run ${chat.modelId}: it speaks only Anthropic's API.`);
  const only = setting("_REQUESTS")
    ?.split(",")
    .map((each) => each.trim());
  const cases = HARNESS_CASES.filter((each) => !only || only.includes(each.id));
  const runsPerRequest = Number(setting("_RUNS") ?? "2") || 2;
  const seed = Number(setting("_SEED") ?? "1208") || 1208;
  const effort = setting("_EFFORT") ?? (chat.kind === "anthropic" ? "low" : "medium");
  const timeoutMs = (Number(setting("_TIMEOUT_S") ?? "300") || 300) * 1000;
  const judging = judgeOf(config, chat);
  const checker = chatSettings(process.env, "HARNESS_CHECK");
  const judge = createAiSdkChatModel({
    kind: judging.kind,
    modelId: judging.modelId,
    apiKey: judging.apiKey,
    baseUrl: judging.baseUrl,
    thinking: "off",
  });
  const claudeBin = running.includes("claude-code") ? (setting("_CLAUDE") ?? binary("claude")) : "";
  const codexBin = running.includes("codex") ? (setting("_CODEX") ?? binary("codex")) : "";
  const proxy = running.includes("codex")
    ? await startModelProxy({
        upstream: chat.kind,
        apiKey: chat.apiKey,
        keepRequests: setting("_KEEP_REQUESTS") === "1",
      })
    : null;

  const resume = setting("_RESUME");
  const folder =
    resume ??
    join(
      config.resultsDir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-harness-${chat.modelId}`,
    );
  const eventsDir = join(folder, "events");
  await mkdir(eventsDir, { recursive: true });
  const linesFile = join(folder, "runs.jsonl");
  const lines: Line[] = existsSync(linesFile)
    ? readFileSync(linesFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Line)
    : [];
  const done = new Set(lines.map((line) => keyOf(line.run)));
  if (done.size > 0) log(`Going on from ${done.size} runs already in ${folder}`);

  const setup: HarnessSetup = {
    chat,
    judge,
    effort,
    claudeBin,
    codexBin,
    proxy,
    eventsDir,
    timeoutMs,
    keep: config.keepData,
  };
  const random = seeded(seed);
  const datedFolder = await mkdtemp(join(tmpdir(), "incarnamind-harness-dated-"));
  try {
    for (const name of LIBRARIES) {
      const wanted = cases.filter((each) => each.library === name);
      const order = shuffled(
        wanted.flatMap((each) =>
          Array.from({ length: runsPerRequest }, (_, index) =>
            running.map((harness) => ({ harness, each, run: index + 1 })),
          ).flat(),
        ),
        random,
      ).filter((job) => !done.has(keyOf({ harness: job.harness, id: job.each.id, run: job.run })));
      if (order.length === 0) continue;
      const handle = await openHarnessLibrary({
        name,
        documents: await documentsOf(name, config, datedFolder, log),
        chat,
        checker,
        config,
        log,
      });
      try {
        for (const job of order) {
          log(`${job.harness} · ${job.each.id} · run ${job.run}`);
          const line = await runJob(handle, setup, job);
          lines.push(line);
          await appendFile(linesFile, `${JSON.stringify(line)}\n`);
          const { run } = line;
          log(
            `  ${run.error ? `didn't run: ${run.error}` : run.failures.length === 0 ? "passed the guards" : `${run.failures.length} failures`}, ${run.seconds.toFixed(0)} s`,
          );
        }
      } finally {
        await handle.close();
      }
    }
  } finally {
    await rm(datedFolder, { recursive: true, force: true });
    await proxy?.close();
  }

  const runs = lines.map((line) => line.run).filter((run) => running.includes(run.harness));
  const codexRecords = lines.flatMap((line) =>
    line.run.harness === "codex" && line.shim && line.proxy
      ? [{ run: line.run, shim: line.shim, proxy: line.proxy, turns: [] }]
      : [],
  );
  const configurations = await Promise.all(
    running.map((harness) =>
      configurationOf(harness, { chat, effort, claudeBin, codexBin, lines }),
    ),
  );
  const report = harnessReport({
    model: `${chat.kind}/${chat.modelId}`,
    judge: `${judging.kind}/${judging.modelId}`,
    checker: checker ? `${checker.kind}/${checker.modelId}` : null,
    startedAt,
    seed,
    runsPerRequest,
    requests: cases.map((each) => each.id),
    configurations,
    runs,
    adapter:
      chat.kind === "anthropic" && codexRecords.length > 0 ? adapterCheck(codexRecords) : null,
  });
  await writeFile(join(folder, "report.md"), report);
  await writeFile(
    join(folder, "report.json"),
    JSON.stringify(
      {
        model: `${chat.kind}/${chat.modelId}`,
        judge: `${judging.kind}/${judging.modelId}`,
        checker: checker ? `${checker.kind}/${checker.modelId}` : `${chat.kind}/${chat.modelId}`,
        seed,
        configurations,
        skipped,
        runs,
      },
      null,
      2,
    ),
  );
  log(`Report in ${folder}`);
});

async function runJob(
  handle: Awaited<ReturnType<typeof openHarnessLibrary>>,
  setup: HarnessSetup,
  job: { harness: HarnessName; each: HarnessCase; run: number },
): Promise<Line> {
  try {
    if (job.harness === "incarnamind")
      return { run: await runOurs(handle, setup, job.each, job.run) };
    const record = await runOutside(handle, setup, job.harness, job.each, job.run);
    return { run: record.run, shim: record.shim, proxy: record.proxy };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      run: {
        harness: job.harness,
        model: `${setup.chat.kind}/${setup.chat.modelId}`,
        id: job.each.id,
        run: job.run,
        language: job.each.language,
        library: job.each.library,
        group: job.each.group,
        persona: job.each.persona,
        turns: [...(job.each.before ?? []), job.each.request],
        replies: [],
        failures: [],
        error: message,
        support: null,
        claims: null,
        figures: null,
        pointsBack: false,
        cited: 0,
        unbacked: 0,
        usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        costUsd: null,
        reportedCostUsd: null,
        seconds: 0,
        startupSeconds: 0,
        toolCalls: 0,
        otherCalls: [],
        toolsOffered: [],
        record: [],
      },
    };
  }
}

/** How a harness was set up, for the report: its version, its MCP config and the Tools it offered. */
async function configurationOf(
  harness: HarnessName,
  context: {
    chat: NonNullable<ReturnType<typeof readConfig>["chat"]>;
    effort: string;
    claudeBin: string;
    codexBin: string;
    lines: readonly Line[];
  },
): Promise<HarnessConfiguration> {
  const { chat } = context;
  const model = `${chat.kind}/${chat.modelId}`;
  if (harness === "incarnamind") {
    return {
      harness,
      version: "this checkout",
      model,
      effort:
        "the app's own: low for an Answer, high for a careful one (Anthropic); the provider's default (OpenAI)",
      tools: "Its own assistant's Tools, as in eval/everyday",
      mcpConfig: null,
      toolsOffered: [],
    };
  }
  const sample: OutsideRunOptions = {
    turns: [],
    model: chat.modelId,
    effort: context.effort,
    instructions: HARNESS_SKILL,
    server: {
      command: SHIM.command,
      args: SHIM.args,
      env: {
        INCARNAMIND_AGENT_SOCKET: "<the library's socket>",
        INCARNAMIND_HARNESS_TOOLS: HARNESS_TOOLS.join(","),
        INCARNAMIND_HARNESS_INSTRUCTIONS: HARNESS_INSTRUCTIONS,
        INCARNAMIND_HARNESS_LOG: "<the run's log>",
      },
      secretEnv: { INCARNAMIND_AGENT_TOKEN: "" },
    },
    tools: HARNESS_TOOLS,
    home: "<a temporary folder>",
    configDir: "<a temporary folder>",
    workDir: "<a temporary folder>",
    eventsFile: "",
    timeoutMs: 0,
  };
  const offered = new Set(
    context.lines.flatMap((line) => (line.run.harness === harness ? line.run.toolsOffered : [])),
  );
  if (harness === "claude-code") {
    return {
      harness,
      version: await versionOf(context.claudeBin),
      model,
      effort: context.effort,
      tools: `IncarnaMind's MCP server only (${HARNESS_TOOLS.join(", ")}); --tools "" (no built-in Tool), --strict-mcp-config, --bare`,
      mcpConfig: claudeMcpConfig(sample),
      toolsOffered: [...offered],
    };
  }
  return {
    harness,
    version: await versionOf(context.codexBin),
    model,
    effort: context.effort,
    tools: `IncarnaMind's MCP server only (${HARNESS_TOOLS.join(", ")}); off: ${CODEX_OFF.join(", ")}; read-only sandbox; model through the bake-off's proxy (${chat.kind === "anthropic" ? "Responses-to-Messages adapter; Claude has no Code Mode, so the Tools are offered to it directly" : "passed through as it is; the model takes Codex's Code Mode, calling the same Tools from a JavaScript cell (exec)"})`,
    mcpConfig: codexSettings(sample, "http://127.0.0.1:<port>/v1"),
    toolsOffered: [...offered],
  };
}
