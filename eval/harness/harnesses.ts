/**
 * One run of one request through one harness, scored (README.md):
 *
 * - **(a) ours:** asked through the core as `eval/everyday` asks it
 *   (`runCase`), its turns in one conversation, with no Mind open.
 * - **(b) Claude Code** and **(c) Codex:** a new pairing of IncarnaMind's MCP
 *   server for the run, over every Document of the library, then the
 *   harness started on the turns, in a temporary home of its own. Its reply
 *   is held to the same guards, judged by the same judge and checked by the
 *   same support check as ours.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_IN_A_FOLDER_ID } from "../../src/core";
import { costOf } from "../../src/core/cost/price";
import { catalogFacts, modelsProviderOfKind } from "../../src/core/providers/catalog";
import type { createAiSdkChatModel } from "../../src/core/providers/models";
import { markersIn } from "../../src/shared/answerBlocks";
import { runCase } from "../everyday/asking";
import { requestFailures } from "../everyday/checks";
import { DATED_TEXTS } from "../everyday/dated";
import { citedClaims } from "../everyday/dates";
import { judgeClaims } from "../everyday/judge";
import { checkCitedSentences } from "../everyday/support";
import type { ChatSettings } from "../lib/config";
import { caughtFigures, type HarnessCase, POINTS_BACK } from "./cases";
import { runClaudeCode } from "./claudeCode";
import { runCodex } from "./codex";
import type { HarnessLibraryHandle } from "./libraries";
import type { ModelProxy, ProxyRecord } from "./modelProxy";
import type { OutsideRunOptions, OutsideTurn } from "./outside";
import {
  type HarnessName,
  type HarnessRun,
  type MintedCitation,
  recordLines,
  type ShimCall,
  withMarkers,
} from "./score";
import { HARNESS_INSTRUCTIONS, HARNESS_SKILL, HARNESS_TOOLS } from "./wording";

type Judge = ReturnType<typeof createAiSdkChatModel>;

export interface HarnessSetup {
  chat: ChatSettings;
  judge: Judge;
  /** Reasoning effort for the outside harnesses, matched to ours (README.md). */
  effort: string;
  claudeBin: string;
  codexBin: string;
  /** Codex's model endpoint, for the run's model. */
  proxy: ModelProxy | null;
  eventsDir: string;
  timeoutMs: number;
  keep: boolean;
}

const usageOf = (usage: Partial<HarnessRun["usage"]>): HarnessRun["usage"] => ({
  inputTokens: usage.inputTokens ?? 0,
  cachedInputTokens: usage.cachedInputTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  outputTokens: usage.outputTokens ?? 0,
});

/** What tokens cost on the model under test, at its catalog price; null for a model the catalog has no price for. */
export function costUsd(chat: ChatSettings, usage: HarnessRun["usage"]): number | null {
  const price = catalogFacts(modelsProviderOfKind(chat.kind), chat.modelId)?.price;
  if (price?.currency !== "USD") return null;
  return costOf(usage, price, new Date(), { cacheWrites: chat.kind === "anthropic" });
}

function figuresOf(each: HarnessCase, reply: string): HarnessRun["figures"] {
  if (!each.wrongFigures) return null;
  const caught = caughtFigures(reply, each.wrongFigures);
  return each.wrongFigures.map((figure, index) => ({
    wrong: figure.wrong,
    right: figure.right,
    caught: caught[index] ?? false,
  }));
}

const turnsOf = (each: HarnessCase) => [...(each.before ?? []), each.request];

const pointsBack = (each: HarnessCase, reply: string) =>
  each.expected.noEarlier === true && POINTS_BACK.test(reply);

export async function runOurs(
  handle: HarnessLibraryHandle,
  setup: HarnessSetup,
  each: HarnessCase,
  run: number,
): Promise<HarnessRun> {
  const model = `${setup.chat.kind}/${setup.chat.modelId}`;
  const result = await runCase(handle.library, handle.scoped, setup.judge, model, each, {
    checkModel: handle.checkModel,
  });
  const usage = usageOf(result.usage);
  const dead = result.failures.flatMap((failure) =>
    failure.kind === "dead-markers" ? failure.markers : [],
  );
  return {
    harness: "incarnamind",
    model,
    id: each.id,
    run,
    language: each.language,
    library: each.library,
    group: each.group,
    persona: each.persona,
    turns: turnsOf(each),
    replies: [result.reply],
    failures: result.failures,
    error: result.error,
    support: result.support,
    claims: result.claims,
    figures: figuresOf(each, result.reply),
    pointsBack: pointsBack(each, result.reply),
    cited: new Set(markersIn(result.reply)).size - dead.length,
    unbacked: dead.length + result.droppedMarkers,
    usage,
    costUsd: costUsd(setup.chat, usage),
    reportedCostUsd: null,
    seconds: result.answeredSeconds,
    startupSeconds: 0,
    toolCalls: result.calls.length,
    otherCalls: [],
    toolsOffered: [],
    record: result.calls,
  };
}

function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

function citationLookup(handle: HarnessLibraryHandle) {
  return (token: string): MintedCitation | null => {
    const row = handle.db.get<{
      token: string;
      pairing_id: string;
      document_id: string;
      document_name: string;
      content_hash: string;
      quote: string;
    }>(
      `SELECT token, pairing_id, document_id, document_name, content_hash, quote
       FROM agent_citations WHERE token = ? AND deleted_at IS NULL`,
      [token],
    );
    return row
      ? {
          token: row.token,
          pairingId: row.pairing_id,
          documentId: row.document_id,
          documentName: row.document_name,
          contentHash: row.content_hash,
          quote: row.quote,
        }
      : null;
  };
}

/** The harness's own Tool calls that aren't IncarnaMind's: none, if its built-in Tools are off. */
const otherCallsOf = (turns: readonly OutsideTurn[]) =>
  turns.flatMap((turn) => turn.calls.filter((call) => !/incarnamind/.test(call)));

export interface OutsideRecord {
  run: HarnessRun;
  /** The shim's log: each call IncarnaMind's server answered, with its arguments and result. */
  shim: ShimCall[];
  /** Codex's requests through the model proxy. */
  proxy: ProxyRecord[];
  turns: OutsideTurn[];
}

export async function runOutside(
  handle: HarnessLibraryHandle,
  setup: HarnessSetup,
  harness: Exclude<HarnessName, "incarnamind">,
  each: HarnessCase,
  run: number,
): Promise<OutsideRecord> {
  const { core } = handle;
  const model = `${setup.chat.kind}/${setup.chat.modelId}`;
  const runId = `${harness}-${each.id}-r${run}`;
  const runDir = await mkdtemp(join(tmpdir(), "incarnamind-harness-run-"));
  const home = join(runDir, "home");
  const configDir = join(runDir, "config");
  const workDir = join(runDir, "work");
  await Promise.all([home, configDir, workDir].map((dir) => mkdir(dir, { recursive: true })));
  const shimLog = join(runDir, "shim.jsonl");
  const proxyLog = join(setup.eventsDir, `${runId}.proxy.jsonl`);
  const connected = await core.connectAgent({ name: runId, folderIds: [NOT_IN_A_FOLDER_ID] });
  const { INCARNAMIND_AGENT_TOKEN: token, ...launchEnv } = connected.launch.env;
  const options: OutsideRunOptions = {
    turns: turnsOf(each),
    model: setup.chat.modelId,
    effort: setup.effort,
    instructions: HARNESS_SKILL,
    server: {
      command: connected.launch.command,
      args: connected.launch.args,
      env: {
        ...launchEnv,
        INCARNAMIND_HARNESS_TOOLS: HARNESS_TOOLS.join(","),
        INCARNAMIND_HARNESS_INSTRUCTIONS: HARNESS_INSTRUCTIONS,
        INCARNAMIND_HARNESS_LOG: shimLog,
      },
      secretEnv: { INCARNAMIND_AGENT_TOKEN: token ?? "" },
    },
    tools: HARNESS_TOOLS,
    home,
    configDir,
    workDir,
    eventsFile: join(setup.eventsDir, `${runId}.events.jsonl`),
    timeoutMs: setup.timeoutMs,
  };
  const started = Date.now();
  let turns: OutsideTurn[];
  try {
    if (harness === "claude-code") {
      if (!setup.chat.apiKey) throw new Error("Claude Code needs the evaluation's Anthropic key.");
      turns = await runClaudeCode(setup.claudeBin, setup.chat.apiKey, options);
    } else {
      if (!setup.proxy) throw new Error("Codex needs the model proxy.");
      const proxy = { baseUrl: setup.proxy.baseUrl, token: setup.proxy.tokenFor(proxyLog) };
      turns = await runCodex(setup.codexBin, proxy, options);
    }
  } finally {
    await core.disconnectAgent(connected.pairing.id).catch(() => undefined);
  }
  const shim = readLines<ShimCall>(shimLog);
  const proxy = readLines<ProxyRecord>(proxyLog);
  if (!setup.keep) await rm(runDir, { recursive: true, force: true });

  const last = turns.at(-1);
  const complete =
    turns.length === options.turns.length && turns.every((turn) => turn.status === "done");
  const reply = complete ? (last?.reply ?? "") : "";
  const error = !complete
    ? (turns.find((turn) => turn.error)?.error ?? "Not every turn ran.")
    : reply.trim() === ""
      ? "The harness gave no reply."
      : null;
  const marked = withMarkers(reply, connected.pairing.id, citationLookup(handle));
  // Each turn's calls, by when they were made: the request's own, and those of the turns before.
  const lastStarted = started + turns.slice(0, -1).reduce((total, turn) => total + turn.totalMs, 0);
  const own = shim.filter((call) => Date.parse(call.at) >= lastStarted);
  const before = shim.filter((call) => Date.parse(call.at) < lastStarted);
  const record = recordLines(own);
  const answer = {
    text: marked.text,
    toolCalls: [],
    steps: null,
    citations: marked.citations,
  };
  const verdict =
    reply === ""
      ? { unbacked: [] }
      : await judgeClaims(setup.judge, reply, record, recordLines(before));
  const failures =
    reply === ""
      ? []
      : requestFailures({
          expected: each.expected,
          answer,
          verdict,
          citedInMinds: [],
          changedBlocks: [],
          scoped: handle.scoped,
          texts: each.expected.textDates ? DATED_TEXTS : undefined,
        });
  const support =
    each.research && reply !== ""
      ? await checkCitedSentences(
          core,
          { text: marked.text, citations: marked.citations },
          handle.checkModel,
        )
      : each.research
        ? []
        : null;
  const usage =
    harness === "codex" && setup.chat.kind === "anthropic"
      ? usageOf(
          proxy.reduce(
            (total, request) => ({
              inputTokens: total.inputTokens + request.usage.inputTokens,
              cachedInputTokens: total.cachedInputTokens + request.usage.cachedInputTokens,
              cacheWriteTokens: total.cacheWriteTokens + request.usage.cacheWriteTokens,
              outputTokens: total.outputTokens + request.usage.outputTokens,
            }),
            usageOf({}),
          ),
        )
      : usageOf(
          turns.reduce(
            (total, turn) => ({
              inputTokens: total.inputTokens + turn.usage.inputTokens,
              cachedInputTokens: total.cachedInputTokens + turn.usage.cachedInputTokens,
              cacheWriteTokens: total.cacheWriteTokens + turn.usage.cacheWriteTokens,
              outputTokens: total.outputTokens + turn.usage.outputTokens,
            }),
            usageOf({}),
          ),
        );
  return {
    run: {
      harness,
      model,
      id: each.id,
      run,
      language: each.language,
      library: each.library,
      group: each.group,
      persona: each.persona,
      turns: options.turns.slice(),
      replies: turns.map((turn) => turn.reply),
      failures,
      error,
      support,
      claims: each.summary && reply !== "" ? citedClaims(marked.text) : null,
      figures: figuresOf(each, reply),
      pointsBack: pointsBack(each, reply),
      cited: marked.citations.length,
      unbacked: marked.invented.length,
      usage,
      costUsd: costUsd(setup.chat, usage),
      // Claude Code's cost on a resumed session counts the turns before it too.
      reportedCostUsd: last?.reportedCostUsd ?? null,
      seconds: turns.reduce((total, turn) => total + turn.totalMs, 0) / 1000,
      startupSeconds: turns.reduce((total, turn) => total + turn.startupMs, 0) / 1000,
      toolCalls: shim.filter((call) => !call.refused).length,
      otherCalls: otherCallsOf(turns),
      toolsOffered: [
        ...new Set([
          ...turns.flatMap((turn) => turn.toolsOffered ?? []),
          ...proxy.flatMap((request) => request.tools),
        ]),
      ],
      record,
    },
    shim,
    proxy,
    turns,
  };
}
