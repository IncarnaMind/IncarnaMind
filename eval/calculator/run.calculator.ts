/**
 * The calculator set (./cases.ts, #3393) on a real model, on the three paths a calculated figure
 * takes: an Answer that works it out (`answer`), the Note's check of a right and a wrong sentence
 * (`check`), and a connected agent checking a Note it wrote with IncarnaMind's instructions
 * (`agent`). Each path opens a core of its own on a temporary data folder, set up as the app's:
 * the Python runtime, the built-in reranker, the chat model the User chose. One JSON line a case's
 * figure or sentence goes to CALC_OUT, with every Tool call and result it made.
 *
 * vitest run --config eval/calculator/vitest.config.ts, with INCARNAMIND_EVAL_CHAT_KIND=anthropic,
 * INCARNAMIND_EVAL_CHAT_MODEL and INCARNAMIND_EVAL_CHAT_KEY (eval/README.md), and CALC_OUT,
 * CALC_ARM, CALC_ROUND, CALC_PATHS (answer,check,agent), CALC_CASES (ids or their starts),
 * CALC_CAP_USD (a path stops past it). CALC_DRY=1 checks the set only, with no model.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import {
  generateText,
  jsonSchema,
  type LanguageModelUsage,
  type StopCondition,
  stepCountIs,
  type ToolSet,
  tool,
  wrapLanguageModel,
} from "ai";
import { expect, test } from "vitest";
import type { AnalysisRuntime, ChatModelFactory, Core } from "../../src/core";
import { agentSocketPath } from "../../src/core/agents";
import { costOf, inCurrency } from "../../src/core/cost/price";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import { catalogModel, modelsProviderOfKind } from "../../src/core/providers/catalog";
import { withCacheBreakpoints } from "../../src/core/providers/promptCache";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { answerBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { readCalculatedFigureAttributes } from "../../src/shared/calculatedFigures";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { legacyAgentClient } from "../../tests/helpers/agentClients";
import { buildAgentShim } from "../../tests/helpers/agents";
import { connectToMind, type MindClient } from "../../tests/helpers/mindClient";
import { readMind, writeMind } from "../../tests/helpers/minds";
import { pyodideAnalysisRuntime } from "../../tests/helpers/pyodideAnalysis";
import { type ChatSettings, readConfig } from "../lib/config";
import { openLibrary } from "../lib/library";
import { createLog, type Log } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { CALCULATOR_CASES, type CalculatorCase } from "./cases";
import {
  figureIn,
  matches,
  readingsOf,
  type ShownFigure,
  scoreAnswer,
  scoreCheck,
  toolResults,
  wrongValueOf,
} from "./score";

const root = fileURLToPath(new URL("../..", import.meta.url));
const OUT = process.env.CALC_OUT ?? "";
const ARM = process.env.CALC_ARM ?? "unnamed";
const ROUND = Number(process.env.CALC_ROUND ?? "0");
const PATHS = (process.env.CALC_PATHS ?? "answer,check,agent")
  .split(",")
  .map((each) => each.trim());
const CHOSEN = process.env.CALC_CASES?.split(",").map((each) => each.trim());
const CAP_USD = Number(process.env.CALC_CAP_USD ?? "1");
const DRY = process.env.CALC_DRY === "1";
/** Requests at once: enough to finish a round in minutes, few enough to stay under the key's limit. */
const AT_ONCE = 4;
const AGENTS_AT_ONCE = 3;
const ANSWER_TIMEOUT_MS = 300_000;
const AGENT_REQUEST_TIMEOUT_MS = 180_000;

const cases = CALCULATOR_CASES.filter(
  (each) => !CHOSEN || CHOSEN.some((start) => each.id.startsWith(start)),
);

/** The set's own consistency, before any request: a case that fails it is the set's fault. */
function setProblems(): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const each of CALCULATOR_CASES) {
    if (names.has(each.document.name))
      problems.push(`${each.id}: its Document's name is another's`);
    names.add(each.document.name);
    for (const input of each.inputs)
      if (!each.document.text.includes(input))
        problems.push(`${each.id}: "${input}" isn't in its Document`);
    const right = figureIn(each, each.right);
    if (!right.valueRight || right.unitShown !== "right")
      problems.push(
        `${each.id}: its right sentence reads ${right.chars ?? "no figure"} (${right.unit})`,
      );
    const wrong = figureIn(each, each.wrong.sentence);
    if (wrong.valueRight && wrong.unitShown === "right")
      problems.push(`${each.id}: its wrong sentence reads right`);
    const wrongValue = wrongValueOf(each);
    if (wrongValue === null)
      problems.push(`${each.id}: its wrong sentence has no figure of its own`);
    for (const trap of each.traps)
      if (Math.abs(trap.value - each.expected.value) <= 0.02 * Math.abs(each.expected.value))
        problems.push(`${each.id}: the trap "${trap.why}" is within 2% of the figure`);
  }
  return problems;
}

const out = (path: string, row: Record<string, unknown>) =>
  appendFileSync(join(OUT, `${ARM}-r${ROUND}-${path}.jsonl`), `${JSON.stringify(row)}\n`);

/** Runs `work` over `items`, `limit` at a time. */
async function inTurn<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item !== undefined) await work(item);
      }
    }),
  );
}

type Params = LanguageModelV4CallOptions;

/** The words of a request's messages: its system prompt alone, or the rest. */
function textOf(prompt: Params["prompt"], role?: "system"): string {
  return prompt
    .filter((message) => (role ? message.role === role : message.role !== "system"))
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) =>
              part.type === "text"
                ? part.text
                : part.type === "tool-result"
                  ? JSON.stringify(part.output)
                  : part.type === "tool-call"
                    ? JSON.stringify(part.input)
                    : "",
            )
            .join("\n"),
    )
    .join("\n");
}

/** Every Tool result the request carries, by Tool. */
const resultsIn = (prompt: Params["prompt"]): { tool: string; output: string }[] =>
  prompt.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result"
            ? [
                {
                  tool: part.toolName,
                  output:
                    part.output.type === "text" || part.output.type === "error-text"
                      ? part.output.value
                      : JSON.stringify(part.output),
                },
              ]
            : [],
        )
      : [],
  );

interface Heard {
  /** The case figure or sentence it was for; null for none known. */
  key: string | null;
  system: string;
  ms: number;
  failed: string | null;
  calls: { tool: string; input: unknown }[];
  results: { tool: string; output: string }[];
}

/** Every request a core sends, kept with the case it was for; the first of each kind kept whole. */
function recorder(firsts: string, keyOf: (prompt: string) => string | null) {
  const heard: Heard[] = [];
  const flight = { now: 0 };
  const seen = new Set<string>();
  const keep = (params: Params, started: number, failed: string | null, calls: Heard["calls"]) => {
    flight.now--;
    const system = textOf(params.prompt, "system").slice(0, 80);
    heard.push({
      key: keyOf(textOf(params.prompt)),
      system,
      ms: Date.now() - started,
      failed,
      calls,
      results: resultsIn(params.prompt),
    });
    const kind = system.slice(0, 40);
    if (!seen.has(kind)) {
      seen.add(kind);
      appendFileSync(
        firsts,
        `${JSON.stringify({ prompt: params.prompt, tools: params.tools ?? [] })}\n`,
      );
    }
  };
  const failure = (error: unknown) =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const wrap =
    (inner: ChatModelFactory): ChatModelFactory =>
    (spec) =>
      wrapLanguageModel({
        model: inner(spec),
        middleware: {
          specificationVersion: "v4",
          wrapGenerate: async ({ doGenerate, params }) => {
            const started = Date.now();
            flight.now++;
            try {
              const result = await doGenerate();
              keep(
                params,
                started,
                null,
                result.content.flatMap((part) =>
                  part.type === "tool-call" ? [{ tool: part.toolName, input: part.input }] : [],
                ),
              );
              return result;
            } catch (error) {
              keep(params, started, failure(error), []);
              throw error;
            }
          },
          wrapStream: async ({ doStream, params }) => {
            const started = Date.now();
            flight.now++;
            let result: Awaited<ReturnType<typeof doStream>>;
            try {
              result = await doStream();
            } catch (error) {
              keep(params, started, failure(error), []);
              throw error;
            }
            const calls: Heard["calls"] = [];
            let failed: string | null = null;
            const stream = result.stream.pipeThrough(
              new TransformStream({
                transform(part, controller) {
                  if (part.type === "tool-call")
                    calls.push({ tool: part.toolName, input: part.input });
                  if (part.type === "error") failed = failure(part.error);
                  controller.enqueue(part);
                },
                flush() {
                  keep(params, started, failed, calls);
                },
              }),
            );
            return { ...result, stream };
          },
        },
      }) as ReturnType<ChatModelFactory>;
  /** Waits until no request has been in flight for three seconds: an Answer's own check runs after it ends. */
  const settled = async () => {
    for (let quiet = 0, waited = 0; quiet < 3 && waited < 300; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      quiet = flight.now === 0 ? quiet + 1 : 0;
    }
  };
  return { heard, wrap, settled };
}

async function spentUsd(core: Core): Promise<number> {
  const { spent } = await core.getCostSummary();
  return spent
    .filter((each) => each.currency === "USD")
    .reduce((sum, each) => sum + each.amount, 0);
}

async function documentsFolder(): Promise<{
  folder: string;
  paths: { key: string; path: string }[];
}> {
  const folder = await mkdtemp(join(tmpdir(), "calculator-documents-"));
  const paths: { key: string; path: string }[] = [];
  for (const each of cases) {
    const path = join(folder, `${each.document.name}.md`);
    await writeFile(path, each.document.text);
    paths.push({ key: each.id, path });
  }
  return { folder, paths };
}

interface Setup {
  chat: ChatSettings;
  log: Log;
  python: AnalysisRuntime;
  cacheDir: string;
  rerankOnCpu: boolean;
}

async function libraryFor(
  path: string,
  setup: Setup,
  keyOf: (prompt: string) => string | null,
  extra: Partial<Parameters<typeof openLibrary>[0]> = {},
) {
  const { folder, paths } = await documentsFolder();
  const recorded = recorder(join(OUT, `${ARM}-r${ROUND}-${path}-first-requests.jsonl`), keyOf);
  const library = await openLibrary({
    name: `calculator-${path}`,
    embedder: createFakeEmbedder(),
    modelCache: join(setup.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(setup.rerankOnCpu),
    documents: paths,
    embeddings: false,
    keep: false,
    log: setup.log,
    analysisRuntime: setup.python,
    chatModels: recorded.wrap,
    ...extra,
  });
  const { core } = library;
  // Setting the variables is the consent to send the Questions and Passages to the chat model.
  core.on("consent.requested", (request) => {
    void core.respondToConsent(request.requestId, true);
  });
  await core.updateSettings({ user: { monthlyCap: { amount: 20, currency: "USD" } } });
  const saved = await core.saveChatProvider({
    kind: setup.chat.kind,
    modelId: setup.chat.modelId,
    apiKey: setup.chat.apiKey ?? "",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const idOf = (each: CalculatorCase) => {
    const document = library.documents.get(each.id);
    if (!document) throw new Error(`${each.id}'s Document wasn't added.`);
    return document.id;
  };
  return {
    library,
    heard: recorded.heard,
    idOf,
    settled: recorded.settled,
    close: async () => {
      await recorded.settled();
      await library.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

const failedOf = (heard: readonly Heard[]) =>
  heard.flatMap((each) => (each.failed ? [each.failed.slice(0, 200)] : []));

/** An Answer's text as the User reads it, and where each calculated figure's words stand in it. */
function readAnswer(nodes: readonly NodeJSON[]): { text: string; figures: ShownFigure[] } {
  let text = "";
  const figures: ShownFigure[] = [];
  const walk = (list: readonly NodeJSON[]) => {
    for (const node of list) {
      if (node.type === "text") text += node.text ?? "";
      else if (node.type === "calculatedFigure") {
        const figure = readCalculatedFigureAttributes(node.attrs)?.figure;
        const shown = figure?.shown ?? "";
        figures.push({
          value: figure?.value ?? "",
          shown,
          start: text.length,
          end: text.length + shown.length,
        });
        text += shown;
      } else {
        walk(node.content ?? []);
        text += node.type === "paragraph" || node.type === "heading" ? "\n" : " ";
      }
    }
  };
  walk(nodes);
  return { text, figures };
}

async function answerPath(setup: Setup) {
  const byQuestion = new Map(cases.map((each) => [each.question, each.id]));
  const opened = await libraryFor("answer", setup, (prompt) => {
    for (const [question, id] of byQuestion) if (prompt.includes(question)) return id;
    return null;
  });
  const { library, heard, idOf } = opened;
  const { core } = library;
  try {
    let stopped = false;
    await inTurn(cases, AT_ONCE, async (each) => {
      if (stopped) return;
      const started = Date.now();
      const asked = await core.askInConversation({
        text: each.question,
        scope: { folderIds: [], tagIds: [], documentIds: [idOf(each)] },
      });
      if (!asked.asked) throw new Error(`${each.id} wasn't asked: ${JSON.stringify(asked)}`);
      const ended = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => done(false), ANSWER_TIMEOUT_MS);
        const stops = [
          core.on("answer.finished", ({ answerId }) => answerId === asked.answerId && done(true)),
          core.on("answer.failed", ({ answerId }) => answerId === asked.answerId && done(true)),
        ];
        function done(inTime: boolean) {
          clearTimeout(timer);
          for (const stop of stops) stop();
          resolve(inTime);
        }
      });
      const seconds = (Date.now() - started) / 1000;
      const { messages } = await core.getConversation(asked.conversation.id);
      const answer = messages.find((message) => message.id === asked.answerId);
      if (answer?.kind !== "answer") throw new Error(`${each.id}: no Answer.`);
      const { text, figures } = readAnswer(answerBlocks(answer));
      const mine = heard.filter((request) => request.key === each.id);
      const scored = scoreAnswer(each, text, figures);
      out("answer", {
        arm: ARM,
        round: ROUND,
        path: "answer",
        id: each.id,
        language: each.language,
        kind: each.kind,
        minorUnit: each.minorUnit === true,
        scaled: each.scaled,
        status: ended ? answer.status : "timed-out",
        error: answer.errorMessage ?? null,
        seconds,
        requests: mine.length,
        failedRequests: failedOf(mine),
        ...scored,
        text,
        shownFigures: figures,
        figures: answer.figures.map((figure) => ({
          marker: figure.marker,
          label: figure.label,
          formula: figure.formula,
          value: figure.value,
          unit: figure.unit,
          shown: figure.shown,
          inputs: figure.inputs.map((input) => ({
            name: input.name,
            chars: input.number.chars,
            quote: input.citation.quote,
          })),
        })),
        calls: mine.flatMap((request) => request.calls),
        calculated: [
          ...new Set(
            mine.flatMap((request) =>
              request.results
                .filter((result) => result.tool === "calculate")
                .map((result) => result.output),
            ),
          ),
        ],
      });
      if ((await spentUsd(core)) > CAP_USD) stopped = true;
    });
    await opened.settled();
    return {
      spent: await spentUsd(core),
      stopped,
      requests: heard.length,
      untagged: heard
        .filter((request) => request.key === null)
        .map((request) => request.system.slice(0, 40)),
      failed: failedOf(heard),
    };
  } finally {
    await opened.close();
  }
}

interface Sentence {
  each: CalculatorCase;
  which: "right" | "wrong";
  text: string;
}

const sentencesOf = (list: readonly CalculatorCase[]): Sentence[] =>
  list.flatMap((each) => [
    { each, which: "right" as const, text: each.right },
    { each, which: "wrong" as const, text: each.wrong.sentence },
  ]);

/** A mark as the User sees it, and what its card says. */
async function marksOf(core: Core, client: MindClient, folderId: string) {
  await client.settled();
  const versions = new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));
  return new Map(
    claimSpans(readMind(client)).map((span) => {
      const part = span.check.parts?.[0];
      return [
        span.sentence.text.trim(),
        {
          shown: claimCheckShown(span.check, {
            footing: "not-yet-known",
            text: span.sentence.text,
            versions,
            folderId,
            scope: null,
          }).state,
          state: span.check.state,
          reason: span.check.reason ?? null,
          workedOut: part?.workedOut ?? null,
          says: part?.says ?? span.check.says ?? null,
          evidence: [
            ...(span.check.evidence ? [span.check.evidence] : []),
            ...(part?.evidence ?? []),
          ].map((each) => ({ document: each.documentName, quote: each.quote })),
          figures: (span.check.figures ?? []).map((figure) => ({
            chars: figure.reading.chars,
            state: figure.state,
          })),
        },
      ] as const;
    }),
  );
}

async function checkPath(setup: Setup) {
  const sentences = sentencesOf(cases);
  const opened = await libraryFor("check", setup, (prompt) => {
    for (const sentence of sentences)
      if (prompt.includes(sentence.text)) return `${sentence.each.id}/${sentence.which}`;
    return null;
  });
  const { library, heard, idOf } = opened;
  const { core } = library;
  try {
    const folders = new Map<string, string>();
    for (const each of cases) {
      const folder = await core.createLibraryGroup({ name: each.document.name, description: "" });
      await core.moveToFolder({ documentIds: [idOf(each)], folderId: folder.id });
      folders.set(each.id, folder.id);
    }
    let stopped = false;
    await inTurn(sentences, AT_ONCE, async (sentence) => {
      if (stopped) return;
      const { each, which, text } = sentence;
      const folderId = folders.get(each.id) ?? "";
      const mind = await core.createMind({ title: "Notes", folderId });
      const client = await connectToMind(core, mind.id);
      try {
        writeMind(client, [
          { type: "paragraph", attrs: { id: "line-0" }, content: [{ type: "text", text }] },
        ]);
        await client.settled();
        const started = Date.now();
        const run = await core.checkMind({
          requestId: `${ARM}-${ROUND}-${mind.id}`,
          mindId: mind.id,
          mode: "all",
        });
        const seconds = (Date.now() - started) / 1000;
        const mark = (await marksOf(core, client, folderId)).get(text) ?? null;
        const key = `${each.id}/${which}`;
        const mine = heard.filter((request) => request.key === key);
        const told = [
          ...new Set(
            mine.flatMap((request) =>
              request.results
                .filter((result) => result.tool === "calculate")
                .map((result) => result.output),
            ),
          ),
        ];
        const shownResults = toolResults(told);
        out("check", {
          arm: ARM,
          round: ROUND,
          path: "check",
          id: each.id,
          which,
          language: each.language,
          kind: each.kind,
          minorUnit: each.minorUnit === true,
          scaled: each.scaled,
          sentence: text,
          run: run.kind,
          seconds,
          requests: mine.length,
          failedRequests: failedOf(mine),
          mark,
          ...scoreCheck(each, shownResults, [mark?.workedOut, mark?.says]),
          calculated: told,
          calls: mine.flatMap((request) => request.calls),
        });
      } finally {
        await core.deleteMind(mind.id);
      }
      if ((await spentUsd(core)) > CAP_USD) stopped = true;
    });
    await opened.settled();
    return {
      spent: await spentUsd(core),
      stopped,
      requests: heard.length,
      untagged: heard
        .filter((request) => request.key === null)
        .map((request) => request.system.slice(0, 40)),
      failed: failedOf(heard),
    };
  } finally {
    await opened.close();
  }
}

/** A Note an agent checks: sentences of several cases, right and wrong, each case once. */
interface AgentNote {
  title: string;
  language: CalculatorCase["language"];
  group: number;
  sentences: Sentence[];
}

/** Per language, groups of six cases, each written into two Notes: right, wrong, right… and its twin. */
function agentNotes(): AgentNote[] {
  const notes: AgentNote[] = [];
  let group = 0;
  for (const language of ["en", "zh-CN"] as const) {
    const mine = cases.filter((each) => each.language === language);
    for (let at = 0; at < mine.length; at += 6) {
      group++;
      const slice = mine.slice(at, at + 6);
      for (const start of [0, 1]) {
        notes.push({
          title: language === "en" ? "Figures for the finance meeting" : "财务会议数据要点",
          language,
          group,
          sentences: slice.map((each, index) =>
            (index + start) % 2 === 0
              ? { each, which: "right", text: each.right }
              : { each, which: "wrong", text: each.wrong.sentence },
          ),
        });
      }
    }
  }
  // A twin starts once its first is done, and its first's Note is deleted: one agent never sees the other's.
  return [...notes.filter((_, at) => at % 2 === 0), ...notes.filter((_, at) => at % 2 === 1)];
}

interface AgentCall {
  step: number;
  name: string;
  args: unknown;
  refused: string | null;
  result: unknown;
}

async function agentPath(setup: Setup) {
  const price = catalogModel(modelsProviderOfKind(setup.chat.kind), setup.chat.modelId)?.price;
  if (!price) throw new Error(`No price for ${setup.chat.modelId}.`);
  const usd = (usage: LanguageModelUsage) =>
    inCurrency(
      costOf(
        {
          inputTokens: usage.inputTokens ?? 0,
          cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        },
        price,
        new Date(),
        { cacheWrites: true },
      ),
      price.currency,
      "USD",
    );
  const socketDir = await mkdtemp(join(tmpdir(), "im-calc-"));
  const opened = await libraryFor("agent", setup, () => null, {
    agents: {
      socketPath: agentSocketPath(socketDir),
      launcher: { command: process.execPath, args: [await buildAgentShim()] },
      version: "0.0.0-test",
    },
  });
  const { library, idOf } = opened;
  const { core } = library;
  let spent = 0;
  let stopped = false;
  const failed: string[] = [];
  try {
    await core.setAgentsEnabled(true);
    const notes = agentNotes();
    const folders = new Map<number, string>();
    for (const note of notes) {
      if (folders.has(note.group)) continue;
      const folder = await core.createLibraryGroup({
        name: note.language === "en" ? `Board papers ${note.group}` : `董事会材料 ${note.group}`,
        description: "",
      });
      for (const sentence of note.sentences)
        await core.moveToFolder({ documentIds: [idOf(sentence.each)], folderId: folder.id });
      folders.set(note.group, folder.id);
    }
    let index = 0;
    const firsts = new Map<number, Promise<void>>();
    await inTurn(notes, AGENTS_AT_ONCE, async (note) => {
      if (stopped) return;
      const first = firsts.get(note.group);
      let done = () => {};
      if (first) await first;
      else firsts.set(note.group, new Promise((resolve) => (done = resolve)));
      const run = ++index;
      const folderId = folders.get(note.group) ?? "";
      const requests: { status: number | null; error: string | null; ms: number }[] = [];
      let firstWritten = false;
      const watchedFetch: typeof fetch = async (input, init) => {
        if (!firstWritten && run === 1 && typeof init?.body === "string") {
          firstWritten = true;
          writeFileSync(join(OUT, `${ARM}-r${ROUND}-agent-first-request.json`), init.body);
        }
        const started = Date.now();
        const timeout = AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        try {
          const response = await fetch(input, { ...init, signal });
          requests.push({ status: response.status, error: null, ms: Date.now() - started });
          return response;
        } catch (error) {
          const message =
            error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          requests.push({ status: null, error: message.slice(0, 200), ms: Date.now() - started });
          throw error;
        }
      };
      const model = withCacheBreakpoints(
        createAnthropic({ apiKey: setup.chat.apiKey ?? "", fetch: watchedFetch })(
          setup.chat.modelId,
        ),
      );
      const { pairing, launch } = await core.connectAgent({
        name: `Agent ${ARM} ${ROUND} ${run}`,
        folderIds: [folderId],
        propose: true,
      });
      const agent = await legacyAgentClient(launch);
      const calls: AgentCall[] = [];
      let step = 0;
      let mindId: string | undefined;
      const started = Date.now();
      try {
        const markdown = note.sentences.map((sentence) => sentence.text).join("\n\n");
        const made = await agent.callTool({
          name: "create_mind",
          arguments: { title: note.title, markdown, folderId },
        });
        mindId = (made.structuredContent as { mindId?: string } | undefined)?.mindId;
        if (made.isError === true || !mindId) throw new Error("create_mind was refused.");
        const listed = await agent.listTools();
        if (run === 1)
          writeFileSync(
            join(OUT, `${ARM}-r${ROUND}-agent-tools.json`),
            JSON.stringify(listed.tools, null, 2),
          );
        const tools = Object.fromEntries(
          listed.tools.map((each) => [
            each.name,
            tool({
              description: each.description ?? "",
              inputSchema: jsonSchema(each.inputSchema as Parameters<typeof jsonSchema>[0]),
              execute: async (args: unknown) => {
                const result = await agent.callTool({
                  name: each.name,
                  arguments: args as Record<string, unknown>,
                });
                if (result.isError !== true) {
                  calls.push({
                    step,
                    name: each.name,
                    args,
                    refused: null,
                    result: result.structuredContent,
                  });
                  return result.structuredContent;
                }
                const why = (result.content as { text?: string }[])[0]?.text ?? "";
                calls.push({ step, name: each.name, args, refused: why, result: null });
                return { refused: why };
              },
            }),
          ]),
        );
        const overCap: StopCondition<ToolSet> = ({ steps }) =>
          steps.reduce((total, each) => total + usd(each.usage), 0) > 0.25;
        const asked =
          note.language === "en"
            ? "Before I send it on, check it against my documents."
            : "发出去之前，帮我对照我的文件核对一下。";
        const wrote = note.language === "en" ? "Write me a short note" : "帮我写一份简短的笔记";
        const done = await generateText({
          model,
          system: [
            "You are an assistant working for the user in a terminal. A connected app, IncarnaMind, gives you the tools below.",
            agent.getInstructions() ?? "",
          ].join("\n\n"),
          messages: [
            { role: "user", content: `${wrote} “${note.title}” from my documents in IncarnaMind.` },
            {
              role: "assistant",
              content: `I wrote the note “${note.title}” in IncarnaMind with create_mind (mindId ${mindId}):\n\n${markdown}`,
            },
            { role: "user", content: asked },
          ],
          tools,
          stopWhen: [stepCountIs(60), overCap],
          maxRetries: 0,
          onStepFinish: () => {
            step++;
          },
        });
        const cost = done.steps.reduce((total, each) => total + usd(each.usage), 0);
        spent += cost;
        const client = await connectToMind(core, mindId);
        const marks = await marksOf(core, client, folderId);
        const tasks = new Map<string, { n: number; text: string }[]>();
        for (const each of calls) {
          if (each.name !== "check_mind_yourself" || !each.result) continue;
          const result = each.result as { task: string; sentences: { n: number; text: string }[] };
          tasks.set(result.task, result.sentences);
        }
        const reported = new Map<
          string,
          {
            verdict: string;
            cites: string[];
            run: string | null;
            working: { figure?: string } | null;
            explanation: string | null;
            answer: unknown;
          }[]
        >();
        for (const each of calls) {
          if (each.name !== "report_check") continue;
          const args = each.args as {
            task?: string;
            results?: {
              n: number;
              verdict: string;
              cites?: string[];
              run?: string;
              working?: { figure?: string };
              explanation?: string;
            }[];
          };
          const listedSentences = tasks.get(args.task ?? "") ?? [];
          for (const result of args.results ?? []) {
            const text =
              listedSentences.find((sentence) => sentence.n === result.n)?.text?.trim() ??
              `#${result.n}`;
            reported.set(text, [
              ...(reported.get(text) ?? []),
              {
                verdict: result.verdict,
                cites: result.cites ?? [],
                run: result.run ?? null,
                working: result.working ?? null,
                explanation: result.explanation ?? null,
                answer: each.refused ?? each.result,
              },
            ]);
          }
        }
        const figures = calls.flatMap((each) =>
          each.name === "calculate" && each.result
            ? ((
                each.result as {
                  figures?: { id: string; label: string; result: string; working: string }[];
                }
              ).figures ?? [])
            : [],
        );
        const seconds = (Date.now() - started) / 1000;
        const failedRequests = requests.filter((each) => each.status !== 200);
        for (const sentence of note.sentences) {
          const mark = marks.get(sentence.text) ?? null;
          const said = reported.get(sentence.text) ?? [];
          const last = said.at(-1);
          // The figure a verdict rests on: a calculation's (main), or the agent's own working's.
          const rests = last?.working?.figure
            ? { id: "working", label: "", result: last.working.figure, working: "" }
            : last?.run
              ? figures.find((figure) => figure.id === last.run)
              : undefined;
          const scored = scoreCheck(sentence.each, rests ? [rests.result] : [], [
            mark?.workedOut,
            mark?.says,
            last?.explanation,
          ]);
          out("agent", {
            arm: ARM,
            round: ROUND,
            path: "agent",
            id: sentence.each.id,
            which: sentence.which,
            language: sentence.each.language,
            kind: sentence.each.kind,
            minorUnit: sentence.each.minorUnit === true,
            scaled: sentence.each.scaled,
            sentence: sentence.text,
            run,
            note: {
              sentences: note.sentences.length,
              seconds,
              requests: requests.length,
              usd: cost,
              steps: done.steps.length,
              finishReason: done.finishReason,
            },
            seconds: seconds / note.sentences.length,
            requests: requests.length / note.sentences.length,
            failedRequests,
            mark,
            reported: said,
            restsOn: rests ?? null,
            ...scored,
            calculated: figures.filter((each) =>
              readingsOf(each.result, sentence.each.language).some((read) =>
                [
                  sentence.each.expected.value,
                  ...sentence.each.traps.map((trap) => trap.value),
                ].some((value) => matches(read.value, value)),
              ),
            ),
          });
        }
        out("agent-runs", {
          arm: ARM,
          round: ROUND,
          run,
          group: note.group,
          ids: note.sentences.map((sentence) => `${sentence.each.id}/${sentence.which}`),
          seconds,
          usd: cost,
          steps: done.steps.length,
          finishReason: done.finishReason,
          requests,
          refusals: calls
            .filter((each) => each.refused !== null)
            .map((each) => `${each.name}: ${each.refused}`),
          calls,
          finalText: done.text,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push(`${run}: ${message.slice(0, 300)}`);
        out("agent-runs", {
          arm: ARM,
          round: ROUND,
          run,
          failed: message.slice(0, 500),
          requests,
          calls,
        });
      } finally {
        await agent.close();
        await core.disconnectAgent(pairing.id);
        if (mindId) await core.deleteMind(mindId);
        done();
      }
      if (spent > CAP_USD) stopped = true;
    });
    return { spent, stopped, failed };
  } finally {
    await opened.close();
    await rm(socketDir, { recursive: true, force: true });
  }
}

test(
  "the calculator set",
  async () => {
    const problems = setProblems();
    expect(problems).toEqual([]);
    if (DRY) return;
    if (!OUT) throw new Error("No CALC_OUT.");
    const config = readConfig(root);
    if (!config.chat?.apiKey) throw new Error("No chat model: set INCARNAMIND_EVAL_CHAT_*.");
    const log = createLog(Date.now());
    const setup: Setup = {
      chat: config.chat,
      log,
      python: await pyodideAnalysisRuntime(),
      cacheDir: config.cacheDir,
      rerankOnCpu: config.rerankOnCpu,
    };
    const summary: Record<string, unknown> = {
      arm: ARM,
      round: ROUND,
      model: config.chat.modelId,
      cases: cases.length,
    };
    for (const path of PATHS) {
      const started = Date.now();
      log(`${path}: ${cases.length} cases`);
      const result =
        path === "answer"
          ? await answerPath(setup)
          : path === "check"
            ? await checkPath(setup)
            : path === "agent"
              ? await agentPath(setup)
              : null;
      if (!result) throw new Error(`No path "${path}".`);
      summary[path] = { ...result, seconds: (Date.now() - started) / 1000 };
      log(`${path}: done, US$${result.spent.toFixed(4)}`);
    }
    appendFileSync(join(OUT, "runs.jsonl"), `${JSON.stringify(summary)}\n`);
  },
  4 * 60 * 60_000,
);
