/**
 * The calculator set (./cases.ts, #3393) on a real model, on the three paths a calculated figure
 * takes: an Answer that works it out (`answer`), the Note's check of a right and a wrong sentence
 * (`check`), and a connected agent checking a Note it wrote with IncarnaMind's instructions
 * (`agent`); and the everyday check requests (./checkRequests.ts, #3432), a connected agent asked
 * in the User's own words whether its Note is right (`requests`). Each path opens a core of its
 * own on a temporary data folder, set up as the app's: the Python runtime, the built-in reranker,
 * the chat model the User chose. One JSON line a case's figure or sentence, or a request, goes to
 * CALC_OUT, with every Tool call and result it made.
 *
 * vitest run --config eval/calculator/vitest.config.ts, with INCARNAMIND_EVAL_CHAT_KIND=anthropic,
 * INCARNAMIND_EVAL_CHAT_MODEL and INCARNAMIND_EVAL_CHAT_KEY (eval/README.md), and CALC_OUT,
 * CALC_ARM, CALC_ROUND, CALC_PATHS (answer,check,agent,requests), CALC_CASES (ids or their
 * starts, of either set), CALC_CAP_USD (a path stops past it). CALC_DRY=1 checks the sets only,
 * with no model.
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
  type ModelMessage,
  type StopCondition,
  stepCountIs,
  type ToolSet,
  tool,
  wrapLanguageModel,
} from "ai";
import { expect, test } from "vitest";
import type { AnalysisRuntime, ChatModelFactory, ConversationAnswer, Core } from "../../src/core";
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
import { CHECK_REQUESTS, type CheckRequest } from "./checkRequests";
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
/** CALC_NOTE_CHECK=1: an Answer whose figure leaves out its scale or unit is put in a Note and checked. */
const NOTE_CHECK = process.env.CALC_NOTE_CHECK === "1";
/** Requests at once: enough to finish a round in minutes, few enough to stay under the key's limit. */
const AT_ONCE = 4;
const AGENTS_AT_ONCE = 3;
const ANSWER_TIMEOUT_MS = 300_000;
const AGENT_REQUEST_TIMEOUT_MS = 180_000;

const chosen = <T extends { id: string }>(list: readonly T[]): T[] =>
  list.filter((each) => !CHOSEN || CHOSEN.some((start) => each.id.startsWith(start)));
const cases = chosen(CALCULATOR_CASES);
const requests = chosen(CHECK_REQUESTS);

/** The everyday requests' own consistency, before any request. */
function requestProblems(): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const each of CHECK_REQUESTS) {
    if (ids.has(each.id)) problems.push(`${each.id}: its id is another's`);
    ids.add(each.id);
    for (const document of each.documents) {
      if (names.has(document.name)) problems.push(`${each.id}: "${document.name}" is another's`);
      names.add(document.name);
    }
    if (each.wrong.some((at) => at < 0 || at >= each.note.sentences.length))
      problems.push(`${each.id}: a wrong sentence it names isn't in its Note`);
    if (each.asks === "question" && each.wrong.length > 0)
      problems.push(`${each.id}: a question with a wrong sentence`);
    if (
      each.asks === "check" &&
      each.written === "earlier" &&
      !each.request.includes(each.note.title)
    )
      problems.push(`${each.id}: a request from a later chat that doesn't name its Note`);
  }
  return problems;
}

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

/** A Document to add, by the key a path finds it with. */
interface Written {
  key: string;
  name: string;
  text: string;
}

const caseDocuments = (): Written[] => cases.map((each) => ({ key: each.id, ...each.document }));

async function documentsFolder(documents: readonly Written[]): Promise<{
  folder: string;
  paths: { key: string; path: string }[];
}> {
  const folder = await mkdtemp(join(tmpdir(), "calculator-documents-"));
  const paths: { key: string; path: string }[] = [];
  for (const each of documents) {
    const path = join(folder, `${each.name}.md`);
    await writeFile(path, each.text);
    paths.push({ key: each.key, path });
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
  documents: readonly Written[] = caseDocuments(),
) {
  const { folder, paths } = await documentsFolder(documents);
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
  const idOf = (key: string) => {
    const document = library.documents.get(key);
    if (!document) throw new Error(`${key}'s Document wasn't added.`);
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
        scope: { folderIds: [], tagIds: [], documentIds: [idOf(each.id)] },
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
      const leftOut =
        scored.figure.chars !== null &&
        (scored.figure.unitShown !== "right" ||
          scored.wrongWorkedOut.some((reason) => /left out|unit:/.test(reason)));
      const noteCheck =
        NOTE_CHECK && leftOut ? await checkedInNote(core, each, answer, text) : null;
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
        markdown: answer.text,
        noteCheck,
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

/**
 * The Answer in a Note of a Folder that holds only its case's Document, and IncarnaMind's own
 * check of it. Added as the User adds it (`added`), its sentences keep the Answer's own marks, so
 * the check sends only what is left; written as the reader sees it (`read`), every sentence is
 * judged. Each sentence's mark, the figure's first.
 */
async function checkedInNote(
  core: Core,
  each: CalculatorCase,
  answer: ConversationAnswer,
  read: string,
) {
  const folder = await core.createLibraryGroup({ name: `${each.id} ${ROUND}`, description: "" });
  const documentId = (await core.listDocuments()).find(
    (doc) => doc.name === each.document.name,
  )?.id;
  if (documentId) await core.moveToFolder({ documentIds: [documentId], folderId: folder.id });
  const shown = answer.figures[0]?.shown ?? "";
  const checked = async (blocks: NodeJSON[]) => {
    const mind = await core.createMind({ title: "Answer", folderId: folder.id });
    const client = await connectToMind(core, mind.id);
    try {
      writeMind(client, blocks);
      await client.settled();
      const run = await core.checkMind({
        requestId: `${ARM}-${ROUND}-note-${mind.id}`,
        mindId: mind.id,
        mode: "all",
      });
      const marks = [...(await marksOf(core, client, folder.id)).entries()]
        .map(([sentence, mark]) => ({ sentence, ...mark }))
        .sort((a, b) => Number(b.sentence.includes(shown)) - Number(a.sentence.includes(shown)));
      return { run: run.kind, marks };
    } finally {
      await core.deleteMind(mind.id);
    }
  };
  const paragraphs = read
    .split(/\n\s*\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((line, at) => ({
      type: "paragraph",
      attrs: { id: `line-${at}` },
      content: [{ type: "text", text: line }],
    }));
  return { added: await checked(answerBlocks(answer)), read: await checked(paragraphs) };
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
      await core.moveToFolder({ documentIds: [idOf(each.id)], folderId: folder.id });
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

interface AgentRequest {
  status: number | null;
  error: string | null;
  ms: number;
}

/** What a connected agent's requests cost, in US dollars, at the chat model's price. */
function agentUsd(setup: Setup): (usage: LanguageModelUsage) => number {
  const price = catalogModel(modelsProviderOfKind(setup.chat.kind), setup.chat.modelId)?.price;
  if (!price) throw new Error(`No price for ${setup.chat.modelId}.`);
  return (usage) =>
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
}

/** A library whose core serves connected agents, on a socket of its own. */
async function agentLibrary(path: string, setup: Setup, documents?: readonly Written[]) {
  // A short name: the socket's whole path must fit in 100 bytes, under any temporary folder.
  const socketDir = await mkdtemp(join(tmpdir(), "im-"));
  const opened = await libraryFor(
    path,
    setup,
    () => null,
    {
      agents: {
        socketPath: agentSocketPath(socketDir),
        launcher: { command: process.execPath, args: [await buildAgentShim()] },
        version: "0.0.0-test",
      },
    },
    documents,
  );
  await opened.library.core.setAgentsEnabled(true);
  return {
    ...opened,
    close: async () => {
      await opened.close();
      await rm(socketDir, { recursive: true, force: true });
    },
  };
}

/**
 * An agent connected to one Folder, on the chat model, as a terminal agent is: IncarnaMind's
 * instructions in its system prompt and its Tools over the connection. Each Tool call is kept.
 */
async function agentSession(
  core: Core,
  setup: Setup,
  usd: (usage: LanguageModelUsage) => number,
  name: string,
  folderId: string,
  firstRequest: string | null,
) {
  const requests: AgentRequest[] = [];
  let firstWritten = firstRequest === null;
  const watchedFetch: typeof fetch = async (input, init) => {
    if (!firstWritten && firstRequest && typeof init?.body === "string") {
      firstWritten = true;
      writeFileSync(firstRequest, init.body);
    }
    const started = Date.now();
    const timeout = AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const response = await fetch(input, { ...init, signal });
      requests.push({ status: response.status, error: null, ms: Date.now() - started });
      return response;
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      requests.push({ status: null, error: message.slice(0, 200), ms: Date.now() - started });
      throw error;
    }
  };
  const model = withCacheBreakpoints(
    createAnthropic({ apiKey: setup.chat.apiKey ?? "", fetch: watchedFetch })(setup.chat.modelId),
  );
  const { pairing, launch } = await core.connectAgent({
    name,
    folderIds: [folderId],
    propose: true,
  });
  const agent = await legacyAgentClient(launch);
  const calls: AgentCall[] = [];
  let step = 0;
  /** The agent's turn after `messages`, until it ends or passes US$0.25. */
  const converse = async (messages: ModelMessage[]) => {
    const listed = await agent.listTools();
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
    const done = await generateText({
      model,
      system: [
        "You are an assistant working for the user in a terminal. A connected app, IncarnaMind, gives you the tools below.",
        agent.getInstructions() ?? "",
      ].join("\n\n"),
      messages,
      tools,
      stopWhen: [stepCountIs(60), overCap],
      maxRetries: 0,
      onStepFinish: () => {
        step++;
      },
    });
    return {
      done,
      tools: listed.tools,
      cost: done.steps.reduce((total, each) => total + usd(each.usage), 0),
    };
  };
  return {
    agent,
    calls,
    requests,
    converse,
    refusals: () =>
      calls.filter((each) => each.refused !== null).map((each) => `${each.name}: ${each.refused}`),
    close: async () => {
      await agent.close();
      await core.disconnectAgent(pairing.id);
    },
  };
}

/** The agent's Note, written with `create_mind` as an agent writes one; its id and what it returned. */
async function writeNote(
  agent: Awaited<ReturnType<typeof legacyAgentClient>>,
  title: string,
  markdown: string,
  folderId: string,
) {
  const made = await agent.callTool({
    name: "create_mind",
    arguments: { title, markdown, folderId },
  });
  const mindId = (made.structuredContent as { mindId?: string } | undefined)?.mindId;
  if (made.isError === true || !mindId) throw new Error("create_mind was refused.");
  return { mindId, result: made.structuredContent };
}

async function agentPath(setup: Setup) {
  const usd = agentUsd(setup);
  const opened = await agentLibrary("agent", setup);
  const { library, idOf } = opened;
  const { core } = library;
  let spent = 0;
  let stopped = false;
  const failed: string[] = [];
  try {
    const notes = agentNotes();
    const folders = new Map<number, string>();
    for (const note of notes) {
      if (folders.has(note.group)) continue;
      const folder = await core.createLibraryGroup({
        name: note.language === "en" ? `Board papers ${note.group}` : `董事会材料 ${note.group}`,
        description: "",
      });
      for (const sentence of note.sentences)
        await core.moveToFolder({ documentIds: [idOf(sentence.each.id)], folderId: folder.id });
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
      const session = await agentSession(
        core,
        setup,
        usd,
        `Agent ${ARM} ${ROUND} ${run}`,
        folderId,
        run === 1 ? join(OUT, `${ARM}-r${ROUND}-agent-first-request.json`) : null,
      );
      const { calls, requests } = session;
      let mindId: string | undefined;
      const started = Date.now();
      try {
        const markdown = note.sentences.map((sentence) => sentence.text).join("\n\n");
        mindId = (await writeNote(session.agent, note.title, markdown, folderId)).mindId;
        const asked =
          note.language === "en"
            ? "Before I send it on, check it against my documents."
            : "发出去之前，帮我对照我的文件核对一下。";
        const wrote = note.language === "en" ? "Write me a short note" : "帮我写一份简短的笔记";
        const { done, tools, cost } = await session.converse([
          { role: "user", content: `${wrote} “${note.title}” from my documents in IncarnaMind.` },
          {
            role: "assistant",
            content: `I wrote the note “${note.title}” in IncarnaMind with create_mind (mindId ${mindId}):\n\n${markdown}`,
          },
          { role: "user", content: asked },
        ]);
        if (run === 1)
          writeFileSync(
            join(OUT, `${ARM}-r${ROUND}-agent-tools.json`),
            JSON.stringify(tools, null, 2),
          );
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
            started: calls.some((each) => each.name === "check_mind_yourself"),
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
        await session.close();
        if (mindId) await core.deleteMind(mindId);
        done();
      }
      if (spent > CAP_USD) stopped = true;
    });
    return { spent, stopped, failed };
  } finally {
    await opened.close();
  }
}

/** The chat a request ends: after the agent wrote its Note in it, or one of its own. */
function conversation(
  request: CheckRequest,
  written: { folderId: string; markdown: string; result: unknown },
): ModelMessage[] {
  if (request.written === "earlier") return [{ role: "user", content: request.request }];
  const en = request.language === "en";
  const { title } = request.note;
  const toolCallId = "toolu_note_written";
  return [
    {
      role: "user",
      content: en
        ? `Write me a short note “${title}” from my documents in IncarnaMind.`
        : `根据我在IncarnaMind里的文件，帮我写一份简短的笔记《${title}》。`,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: "create_mind",
          input: { title, markdown: written.markdown, folderId: written.folderId },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "create_mind",
          output: { type: "text", value: JSON.stringify(written.result) },
        },
      ],
    },
    {
      role: "assistant",
      content: en
        ? `I wrote the note “${title}” in IncarnaMind.`
        : `我已在IncarnaMind中写好笔记《${title}》。`,
    },
    { role: "user", content: request.request },
  ];
}

/**
 * Each everyday request, to an agent connected to a Folder of its own Documents that holds the
 * Note it wrote: whether it started its check (`check_mind_yourself`), whether its results were
 * taken (`report_check`), and the mark each of the Note's sentences ends with.
 */
async function requestsPath(setup: Setup) {
  const usd = agentUsd(setup);
  const opened = await agentLibrary(
    "requests",
    setup,
    requests.flatMap((request) =>
      request.documents.map((document, at) => ({ key: `${request.id}/${at}`, ...document })),
    ),
  );
  const { library, idOf } = opened;
  const { core } = library;
  let spent = 0;
  let stopped = false;
  const failed: string[] = [];
  try {
    let index = 0;
    await inTurn(requests, AGENTS_AT_ONCE, async (request) => {
      if (stopped) return;
      const run = ++index;
      const folder = await core.createLibraryGroup({
        name: request.language === "en" ? `Work files ${run}` : `工作资料 ${run}`,
        description: "",
      });
      await core.moveToFolder({
        documentIds: request.documents.map((_, at) => idOf(`${request.id}/${at}`)),
        folderId: folder.id,
      });
      const session = await agentSession(
        core,
        setup,
        usd,
        `Agent ${ARM} ${ROUND} ${run}`,
        folder.id,
        run === 1 ? join(OUT, `${ARM}-r${ROUND}-requests-first-request.json`) : null,
      );
      const { calls, requests: sent } = session;
      let mindId: string | undefined;
      const started = Date.now();
      try {
        const markdown = request.note.sentences.join("\n\n");
        const note = await writeNote(session.agent, request.note.title, markdown, folder.id);
        mindId = note.mindId;
        const { done, cost } = await session.converse(
          conversation(request, { folderId: folder.id, markdown, result: note.result }),
        );
        spent += cost;
        const marks = await marksOf(core, await connectToMind(core, mindId), folder.id);
        const sentences = request.note.sentences.map((text, at) => {
          const mark = marks.get(text);
          return {
            text,
            wrong: request.wrong.includes(at),
            shown: mark?.shown ?? null,
            reason: mark?.reason ?? null,
          };
        });
        out("requests", {
          arm: ARM,
          round: ROUND,
          path: "requests",
          id: request.id,
          language: request.language,
          asks: request.asks,
          written: request.written,
          run,
          started: calls.some((each) => each.name === "check_mind_yourself"),
          reported: calls.some((each) => each.name === "report_check" && each.refused === null),
          // Every mark the Note ends with, also on sentences the agent changed before its check.
          marked: [...marks.values()].filter((mark) => mark.shown !== "checking").length,
          marks: [...marks.entries()].map(([sentence, mark]) => ({ sentence, shown: mark.shown })),
          sentences,
          seconds: (Date.now() - started) / 1000,
          requests: sent.length,
          failedRequests: sent.filter((each) => each.status !== 200),
          usd: cost,
          steps: done.steps.length,
          finishReason: done.finishReason,
          refusals: session.refusals(),
          calls,
          finalText: done.text,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push(`${run}: ${message.slice(0, 300)}`);
        out("requests", {
          arm: ARM,
          round: ROUND,
          path: "requests",
          id: request.id,
          run,
          failed: message.slice(0, 500),
          failedRequests: sent,
          calls,
        });
      } finally {
        await session.close();
        if (mindId) await core.deleteMind(mindId);
      }
      if (spent > CAP_USD) stopped = true;
    });
    return { spent, stopped, failed };
  } finally {
    await opened.close();
  }
}

test(
  "the calculator set",
  async () => {
    expect([...setProblems(), ...requestProblems()]).toEqual([]);
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
      requests: requests.length,
    };
    for (const path of PATHS) {
      const started = Date.now();
      log(`${path}: ${path === "requests" ? requests.length : cases.length} cases`);
      const result =
        path === "answer"
          ? await answerPath(setup)
          : path === "check"
            ? await checkPath(setup)
            : path === "agent"
              ? await agentPath(setup)
              : path === "requests"
                ? await requestsPath(setup)
                : null;
      if (!result) throw new Error(`No path "${path}".`);
      summary[path] = { ...result, seconds: (Date.now() - started) / 1000 };
      log(`${path}: done, US$${result.spent.toFixed(4)}`);
    }
    appendFileSync(join(OUT, "runs.jsonl"), `${JSON.stringify(summary)}\n`);
  },
  4 * 60 * 60_000,
);
