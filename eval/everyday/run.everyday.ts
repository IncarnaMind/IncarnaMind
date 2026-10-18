/**
 * `npm run eval:everyday` (README.md): asks every everyday request
 * (./cases) of a real chat model through the core's public interface, as
 * the assistant does, and holds each Answer to the guards in ./checks. It
 * writes a report and fails when a request fails one.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test, vi } from "vitest";
import * as Y from "yjs";
import {
  type AnswerUsage,
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  type ConversationAnswer,
  type Core,
  MIND_CONTENT_FIELD,
  type MindFocus,
  messageReference,
} from "../../src/core";
import { toolRecordLines } from "../../src/core/answers/toolRecord";
import { plainText } from "../../src/core/mindText";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { answerBlocks } from "../../src/shared/answerBlocks";
import { namesOneOf, sourcesAsText } from "../../src/shared/namedSources";
import { withoutFraming } from "../../src/shared/noteBlocks";
import { resolveProposals } from "../../src/shared/proposals";
import { connectToMind } from "../../tests/helpers/mindClient";
import { heading, note, writeMind } from "../../tests/helpers/minds";
import { paragraph, wordFile } from "../../tests/helpers/word";
import { importWordBytes } from "../../tests/helpers/wordMinds";
import { type ChatSettings, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import type { EvalDocument } from "../lib/evaluationSet";
import { type Library, openLibrary } from "../lib/library";
import { createLog, type Log } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { CASES, type EverydayCase, floorOf, type LibraryName } from "./cases";
import { failureLine, type RequestFailure, requestFailures } from "./checks";
import { judgeClaims } from "./judge";
import { languageRates, type RequestRun, rowRates } from "./rates";

const ROOT = resolve(__dirname, "../..");

/** The two arXiv papers of the owner's own conversation, fetched once into the cache and checked. */
const PAPERS = [
  {
    key: "graphst",
    url: "https://arxiv.org/pdf/2306.10683v1",
    file: "2306.10683v1.pdf",
    sha256: "295ffa4d0840a1956ea4094473978b01d4e2fb00299eb7fde9e45a300d4958db",
  },
  {
    key: "tutorial",
    url: "https://arxiv.org/pdf/1609.04846v1",
    file: "A Tutorial about Random Neural Networks in Supervised Learning.pdf",
    sha256: "41799311b54eb75bee7011f6d6210cd14a8e3517bf79686dd9acd40569598cfa",
  },
];

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A request whose Answer takes longer is stopped and counted as failed. */
const ANSWER_TIMEOUT_MS = 5 * 60_000;

async function fetchPapers(cacheDir: string, log: Log): Promise<EvalDocument[]> {
  const folder = join(cacheDir, "everyday");
  await mkdir(folder, { recursive: true });
  const documents: EvalDocument[] = [];
  for (const paper of PAPERS) {
    const path = join(folder, paper.file);
    if (!existsSync(path) || sha256(await readFile(path)) !== paper.sha256) {
      log(`Fetching ${paper.url}`);
      // arXiv asks for one request every three seconds.
      await new Promise((done) => setTimeout(done, 3_000));
      const response = await fetch(paper.url, {
        headers: { "User-Agent": "IncarnaMind document evaluation" },
      });
      if (!response.ok) throw new Error(`${paper.url} answered HTTP ${response.status}.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (sha256(bytes) !== paper.sha256) throw new Error(`${paper.url} isn't the file expected.`);
      await writeFile(`${path}.partial`, bytes);
      await rename(`${path}.partial`, path);
    }
    documents.push({ key: paper.key, path });
  }
  return documents;
}

async function reports(): Promise<EvalDocument[]> {
  const folder = join(ROOT, "data");
  return (await readdir(folder))
    .filter((name) => name.endsWith(".pdf"))
    .map((name) => ({ key: name, path: join(folder, name) }));
}

interface CaseResult {
  id: string;
  language: "en" | "zh-CN";
  request: string;
  model: string;
  failures: RequestFailure[];
  reply: string;
  calls: string[];
  /** The Mind's Blocks that changed, as they read before and once its changes are accepted. */
  changes: { block: number; before: string; after: string }[];
  seconds: number;
  error: string | null;
  /** The Answers' tokens, its earlier requests' included (not Edit with AI's or the judge's). */
  usage: AnswerUsage;
}

/** Asks in the assistant and resolves with the Answer as stored once it has ended. */
async function ask(
  core: Core,
  input: {
    text: string;
    mindId: string | null;
    conversationId: string | null;
    focus: MindFocus | null;
  },
): Promise<ConversationAnswer> {
  const asked = await core.askInConversation(input);
  if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
  const ended = await new Promise<boolean>((done) => {
    const timer = setTimeout(() => end(false), ANSWER_TIMEOUT_MS);
    const stops = [
      core.on("answer.finished", ({ answerId }) => answerId === asked.answerId && end(true)),
      core.on("answer.failed", ({ answerId }) => answerId === asked.answerId && end(true)),
    ];
    function end(inTime: boolean) {
      clearTimeout(timer);
      for (const stop of stops) stop();
      done(inTime);
    }
  });
  if (!ended) {
    await core.stopConversationAnswer({
      conversationId: asked.conversation.id,
      answerId: asked.answerId,
    });
    throw new Error(`No Answer within ${ANSWER_TIMEOUT_MS / 60_000} minutes.`);
  }
  const { messages } = await core.getConversation(asked.conversation.id);
  const answer = messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer was kept.");
  return answer;
}

async function askExample(core: Core, language: "en" | "zh-CN") {
  await core.updateSettings({ user: { language } });
  const { mindId } = await core.createExamples();
  const asked = await vi.waitFor(() => core.askReadyQuestion(), {
    timeout: 2 * 60_000,
    interval: 500,
  });
  return { conversationId: asked.conversationId, mindId };
}

async function importWord(library: Library, word: NonNullable<EverydayCase["word"]>) {
  const [title = "", ...body] = word.paragraphs;
  const folder = join(library.dataDir, "word");
  await mkdir(folder, { recursive: true });
  return importWordBytes(
    library.core,
    folder,
    wordFile({
      body: [paragraph(title, { style: "Title" }), ...body.map((each) => paragraph(each))].join(""),
    }),
    { name: word.name, origin: "own", addOriginal: true },
  );
}

/** The top-level Blocks, by id, as they read once these requests' changes are accepted. */
function acceptedTexts(doc: Y.Doc, requests: ReadonlySet<string>): Map<string, string> {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const blocks = copy.getXmlFragment(MIND_CONTENT_FIELD);
  copy.transact(() => resolveProposals(blocks, (ref) => requests.has(ref.request), "accept"));
  return new Map(
    blocks
      .toArray()
      .flatMap((block) =>
        block instanceof Y.XmlElement
          ? [[String(block.getAttribute(BLOCK_ID_ATTRIBUTE)), plainText(block)]]
          : [],
      ),
  );
}

function citedDocuments(doc: Y.Doc): string[] {
  const found: string[] = [];
  const visit = (element: Y.XmlElement | Y.XmlFragment) => {
    for (const child of element.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const id = child.getAttribute("documentId");
      if (child.nodeName === CITATION_NODE && typeof id === "string") found.push(id);
      visit(child);
    }
  };
  visit(doc.getXmlFragment(MIND_CONTENT_FIELD));
  return found;
}

async function runCase(
  library: Library,
  scoped: { id: string; name: string }[],
  judge: ReturnType<typeof createAiSdkChatModel>,
  model: string,
  each: EverydayCase,
): Promise<CaseResult> {
  const { core } = library;
  const started = Date.now();
  const usage: AnswerUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  };
  const counting = core.on("answer.finished", (event) => {
    usage.inputTokens += event.usage.inputTokens;
    usage.outputTokens += event.usage.outputTokens;
    usage.cachedInputTokens += event.usage.cachedInputTokens;
    usage.cacheWriteTokens += event.usage.cacheWriteTokens;
  });
  const example = each.afterExample ? await askExample(core, each.language) : null;
  const imported = each.word ? await importWord(library, each.word) : null;
  const mindId =
    imported?.mindId ??
    (each.inExample ? example?.mindId : null) ??
    (each.mind ? (await core.createMind({ title: each.mind.title })).id : null);
  const mind = mindId ? { id: mindId } : null;
  const client = imported?.client ?? (mind ? await connectToMind(core, mind.id) : null);
  if (client && each.mind) {
    writeMind(
      client,
      each.mind.blocks.map((line) =>
        line.startsWith("## ") ? heading(2, line.slice(3)) : note(line),
      ),
    );
    await client.settled();
  }
  const idsNow = () =>
    client
      ? client.blocks
          .toArray()
          .map((block) =>
            block instanceof Y.XmlElement ? String(block.getAttribute(BLOCK_ID_ATTRIBUTE)) : "",
          )
      : [];
  let ids = idsNow();
  let before = client ? acceptedTexts(client.doc, new Set()) : new Map<string, string>();
  const focus: MindFocus | null =
    each.selectAll && client
      ? { selection: [...before.values()].join("\n\n"), blockIds: ids }
      : null;
  let conversationId: string | null = example?.conversationId ?? null;
  const earlierCalls: ConversationAnswer["toolCalls"] = [];
  let last: ConversationAnswer | null = null;
  for (const earlier of each.before ?? []) {
    const answer = await ask(core, {
      text: earlier,
      mindId: mind?.id ?? null,
      conversationId,
      focus,
    });
    conversationId = answer.conversationId;
    earlierCalls.push(...answer.toolCalls);
    last = answer;
  }
  let addedBlocks: number[] | undefined;
  if (each.addToNote && last && mind && client) {
    const earlier = new Set(ids);
    await core.addToNote({
      mindId: mind.id,
      blocks: withoutFraming(answerBlocks({ ...last, status: "done" })),
      origin: {
        from: messageReference(last.conversationId, last.id),
        question: each.before?.at(-1) ?? "",
      },
      model: last.model,
    });
    await client.settled();
    ids = idsNow();
    addedBlocks = ids.flatMap((id, block) => (earlier.has(id) ? [] : [block]));
    before = acceptedTexts(client.doc, new Set());
  }
  const answer = await ask(core, {
    text: each.request,
    mindId: mind?.id ?? null,
    conversationId,
    focus,
  });
  counting();
  const minds = await core.listMinds();
  const names = (id: string) => minds.find((each) => each.id === id)?.title ?? null;
  const record = toolRecordLines(answer.toolCalls, names);
  const verdict = await judgeClaims(
    judge,
    answer.text,
    record,
    toolRecordLines(earlierCalls, names),
  );
  const changed = new Set(
    answer.toolCalls.flatMap((call) => (call.mindChange ? [call.mindChange.mindId] : [])),
  );
  const requests = new Set(
    answer.toolCalls.flatMap((call) => (call.mindChange ? [call.mindChange.request] : [])),
  );
  const citedInMinds: string[] = [];
  const sourcesAsTextIn: string[] = [];
  const documentNames = scoped.map((document) => document.name);
  for (const mindId of changed) {
    const written = await connectToMind(core, mindId);
    await written.settled();
    citedInMinds.push(...citedDocuments(written.doc));
    for (const text of acceptedTexts(written.doc, requests).values()) {
      sourcesAsTextIn.push(
        ...sourcesAsText(text, (source) => namesOneOf(source.name, documentNames)),
      );
    }
  }
  let changes: CaseResult["changes"] = [];
  if (client) {
    await client.settled();
    const after = acceptedTexts(client.doc, requests);
    changes = ids.flatMap((id, block) =>
      after.get(id) === before.get(id)
        ? []
        : [{ block, before: before.get(id) ?? "", after: after.get(id) ?? "(removed)" }],
    );
  }
  const changedBlocks = changes.map((change) => change.block);
  const failures = requestFailures({
    expected: each.expected,
    answer,
    verdict,
    citedInMinds,
    changedBlocks,
    addedBlocks,
    sourcesAsText: sourcesAsTextIn,
    scoped,
  });
  return {
    id: each.id,
    language: each.language,
    request: each.request,
    model,
    failures,
    reply: answer.text,
    calls: record,
    changes,
    seconds: (Date.now() - started) / 1000,
    error: answer.status === "failed" ? `${answer.errorKind}: ${answer.errorMessage}` : null,
    usage,
  };
}

// Never the model under test, which would judge its own claims.
const JUDGE_MODEL = "claude-sonnet-5-5";
const JUDGE_OF_SONNET = "claude-opus-5-5";

/**
 * The model that judges claims: INCARNAMIND_EVAL_JUDGE_*, else, on an
 * Anthropic key, Claude Sonnet 5.5, or Opus 5.5 when Sonnet is under test.
 */
function judgeOf(config: ReturnType<typeof readConfig>, chat: ChatSettings): ChatSettings {
  if (config.judge) return config.judge;
  if (chat.kind !== "anthropic") {
    throw new Error(
      "Set INCARNAMIND_EVAL_JUDGE_KIND, _MODEL and _KEY: the claims are judged by another model than the one asked.",
    );
  }
  return { ...chat, modelId: chat.modelId === JUDGE_MODEL ? JUDGE_OF_SONNET : JUDGE_MODEL };
}

async function runModel(
  chat: ChatSettings,
  judging: ChatSettings,
  cases: readonly EverydayCase[],
  runs: number,
  log: Log,
) {
  const config = readConfig(ROOT);
  const sets: Record<LibraryName, EvalDocument[]> = {
    papers: await fetchPapers(config.cacheDir, log),
    reports: await reports(),
  };
  const judge = createAiSdkChatModel({
    kind: judging.kind,
    modelId: judging.modelId,
    apiKey: judging.apiKey,
    baseUrl: judging.baseUrl,
    thinking: "off",
  });
  const model = `${chat.kind}/${chat.modelId}`;
  const results: CaseResult[] = [];
  for (const name of ["papers", "reports"] as const) {
    const wanted = cases.filter((each) => each.library === name);
    if (wanted.length === 0) continue;
    const library = await openLibrary({
      name: `everyday-${name}`,
      embedder: createWorkerEmbedder(),
      modelCache: join(config.cacheDir, "models"),
      reranker: createWorkerCrossEncoder(config.rerankOnCpu),
      documents: sets[name],
      examples: join(ROOT, "resources", "examples"),
      keep: config.keepData,
      embeddings: false,
      log,
    });
    try {
      const { core } = library;
      // Setting the variables is the consent to send the requests and Passages to the model.
      core.on("consent.requested", (request) => {
        void core.respondToConsent(request.requestId, request.flow.id === "chat");
      });
      await core.saveChatProvider({
        kind: chat.kind,
        modelId: chat.modelId,
        ...(chat.apiKey !== null && { apiKey: chat.apiKey }),
        ...(chat.baseUrl !== null && { baseUrl: chat.baseUrl }),
      });
      const scoped = [...library.documents.values()].map((document) => ({
        id: document.id,
        name: document.name,
      }));
      for (const each of wanted.flatMap((each) => Array.from({ length: runs }, () => each))) {
        log(`${model} · ${each.id}: ${each.request}`);
        let result: CaseResult;
        try {
          result = await runCase(library, scoped, judge, model, each);
        } catch (error) {
          result = {
            id: each.id,
            language: each.language,
            request: each.request,
            model,
            failures: [],
            reply: "",
            calls: [],
            changes: [],
            seconds: 0,
            error: error instanceof Error ? error.message : String(error),
            usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
          };
        }
        log(
          result.error
            ? `  failed to run: ${result.error}`
            : result.failures.length === 0
              ? "  passed"
              : `  ${result.failures.map(failureLine).join("; ")}`,
        );
        results.push(result);
        if (each.afterExample) await core.updateSettings({ user: { language: "system" } });
      }
    } finally {
      await library.close();
    }
  }
  return results;
}

const passedRun = (result: CaseResult) => !result.error && result.failures.length === 0;

function report(
  results: readonly CaseResult[],
  rows: ReturnType<typeof rowRates>,
  judge: string,
): string {
  const runs: RequestRun[] = results.map((each) => ({
    id: each.id,
    language: each.language,
    model: each.model,
    passed: passedRun(each),
  }));
  const percent = (passed: number, total: number) => `${Math.round((100 * passed) / total)}%`;
  const under = rows.filter((row) => row.under);
  const sum = (key: keyof AnswerUsage) =>
    results.reduce((total, each) => total + each.usage[key], 0).toLocaleString("en");
  return [
    "# Everyday requests",
    "",
    `${rows.length - under.length} of ${rows.length} requests at or above their floor; ${runs.filter((run) => run.passed).length} of ${runs.length} runs passed. Claims judged by ${judge}.`,
    "",
    `The Answers' tokens: ${sum("inputTokens")} in (${sum("cachedInputTokens")} of them from the cache), ${sum("outputTokens")} out. Edit with AI's and the judge's aren't counted.`,
    "",
    "## By language",
    "",
    "| Model | Language | Passed |",
    "|---|---|---|",
    ...languageRates(runs).map(
      (group) =>
        `| ${group.model} | ${group.language} | ${group.passed} of ${group.runs} (${percent(group.passed, group.runs)}) |`,
    ),
    "",
    "## By request",
    "",
    "| Request | Language | Model | Passed | Floor |",
    "|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.id} | ${row.language} | ${row.model} | ${row.passed} of ${row.runs}${row.under ? " **under its floor**" : ""} | ${percent(row.floor * 100, 100)} |`,
    ),
    "",
    "## Each run",
    "",
    "| Request | Model | Result |",
    "|---|---|---|",
    ...results.map(
      (each) =>
        `| ${each.id}: ${each.request.replace(/\|/g, "\\|")} | ${each.model} | ${
          each.error
            ? `didn't run: ${each.error}`
            : each.failures.length === 0
              ? "passed"
              : each.failures.map(failureLine).join("; ").replace(/\|/g, "\\|")
        } |`,
    ),
    "",
    "## Replies",
    "",
    ...results.flatMap((each) => [
      `### ${each.id} (${each.model}, ${each.seconds.toFixed(0)} s)`,
      "",
      `> ${each.request}`,
      "",
      ...(each.calls.length > 0 ? ["What its Tools did:", "", ...each.calls, ""] : []),
      ...each.changes.flatMap((change) => [
        `Block ${change.block + 1} before: ${change.before}`,
        `Block ${change.block + 1} after: ${change.after}`,
        "",
      ]),
      each.reply || "(no reply)",
      "",
    ]),
  ].join("\n");
}

test("everyday requests", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  if (!config.chat) {
    log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY (README.md).");
    return;
  }
  const only = process.env.INCARNAMIND_EVAL_EVERYDAY?.trim();
  const cases = CASES.filter((each) =>
    !only ? true : only === "hard" ? each.hard === true : only.split(",").includes(each.id),
  );
  const runs = Number(process.env.INCARNAMIND_EVAL_EVERYDAY_RUNS ?? "3") || 3;
  const judging = judgeOf(config, config.chat);
  const results = await runModel(config.chat, judging, cases, runs, log);
  const rows = rowRates(
    results.map((each) => ({
      id: each.id,
      language: each.language,
      model: each.model,
      passed: passedRun(each),
    })),
    new Map(CASES.map((each) => [each.id, floorOf(each)])),
  );
  const folder = join(
    config.resultsDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-everyday`,
  );
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "report.md"),
    report(results, rows, `${judging.kind}/${judging.modelId}`),
  );
  await writeFile(join(folder, "report.json"), JSON.stringify({ rows, results }, null, 2));
  const under = rows.filter((row) => row.under);
  log(
    `${rows.length - under.length} of ${rows.length} requests at or above their floor; report in ${folder}`,
  );
  if (under.length > 0) {
    throw new Error(`Under their floor: ${under.map((row) => row.id).join(", ")}`);
  }
});
