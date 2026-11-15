/**
 * `INCARNAMIND_EVAL_SPEED_DECISION_FIRST=dry|real|replay|replay-dry npm run eval:speed` (README.md › A
 * decision model in front of the check): Check this Note on one Note, with no decision model chosen and with one
 * (#3118), the arms taking turns in one run over one Library, with the built-in reranker on this
 * computer. Each run gives when the first and the last first reading showed, when the AI model's
 * first and last Mark landed, and each sentence's Mark.
 *
 * - `dry` costs nothing: the AI model is scripted (it searches for the sentence, then answers, each
 *   reply after INCARNAMIND_EVAL_SPEED_REPLY_MS, 3000 by default) and the decision model's host is
 *   a server on this computer that answers after INCARNAMIND_EVAL_SPEED_HOST_MS (350 by default)
 *   with a score that only leans, so every sentence still reaches the AI model. It measures what
 *   the readings' searches cost the AI model's Marks at worst. INCARNAMIND_EVAL_SPEED_HOST_SURE_EVERY
 *   (say 5) makes its score sure for every fifth sentence, so the decision model marks those it
 *   can quote and they never reach the AI model: set it to give the share a real model marks.
 * - `real` asks INCARNAMIND_EVAL_SPEED_MODELS' first model and the decision model on OpenRouter
 *   (INCARNAMIND_EVAL_SPEED_KEY_OPENROUTER), and stops before a run once
 *   INCARNAMIND_EVAL_SPEED_STOP_USD (1 by default) is spent, by the core's count. Each run counts
 *   the requests that weren't answered, the decision host's through a relay on this computer.
 * - `replay` checks each labelled Note of INCARNAMIND_EVAL_SPEED_NOTES (JSON files: blocks of
 *   sentences, each with the Mark a check should give and the place it cites) over the gating
 *   set's Documents (eval/retrieval), with the real decision model and an AI model that is scripted
 *   and never decides: what the decision model marks and reads in the app, counted against the
 *   labels. It prints counts only; each sentence's Mark goes to marks.json for a blind reading,
 *   and the run fails as void if the host refused a request, answered later or not.
 *   `replay-dry` is the same on the host on this computer, to try the run for nothing.
 *   INCARNAMIND_EVAL_SPEED_LIBRARY adds Documents to that Library, any of `mixed` (the mixed
 *   sample set), `checks` (the checks evaluation's Folder, for Notes labelled against it) and
 *   `repeats` (the English sets' Documents of eval/repeats) and `citations` (the citation
 *   benchmark's own PDFs, eval/citations/documents), and
 *   INCARNAMIND_EVAL_SPEED_EMBEDDINGS=off searches by keyword alone, as the app does until the
 *   User turns embeddings on. A Note that names Documents (`scope`, their keys) is checked in
 *   that Search scope, as a Note the User set to them. INCARNAMIND_EVAL_SPEED_LINES (the lines as
 *   JSON) reads with other lines than the measured model's, to measure where a line can sit:
 *   marks.json keeps what each sentence's Passage scored when asked about alone.
 * - `lines` takes such replays' marks.json (INCARNAMIND_EVAL_SPEED_MARKS, one or several) and
 *   prints the verdict lines their labelled sentences allow, each with the sentences that set it
 *   (./measuredLines). It makes no request.
 *
 * INCARNAMIND_EVAL_SPEED_ARMS (as `main,decision,decision,main`, the default) names each run's arm
 * in turn, INCARNAMIND_EVAL_SPEED_SENTENCES how many sentences the Note holds (33 by default, the
 * English sets of eval/repeats over their Documents), and INCARNAMIND_EVAL_SPEED_LIBRARY=mixed
 * adds the mixed sample set, so a search reranks as many Passages as in a real Library.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test, vi } from "vitest";
import {
  type ChatModelChoice,
  type CheckDecisionModel,
  type Core,
  MIND_CONTENT_FIELD,
} from "../../src/core";
import {
  type DecisionLines,
  decisionLinesFor,
  readingOf,
} from "../../src/core/answers/checks/decisionLines";
import { BUILT_IN_RERANKING_MODEL } from "../../src/core/reranking/model";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { setMindScope } from "../../src/shared/mindScope";
import { findQuote } from "../../src/shared/quoteMatch";
import { checkGenerate, checkReply, isCheckRun, type Plan } from "../../tests/helpers/checks";
import { queryDatabase } from "../../tests/helpers/core";
import { connectToMind } from "../../tests/helpers/mindClient";
import { heading, note, readMind, writeMind } from "../../tests/helpers/minds";
import { scriptedModel } from "../../tests/helpers/models";
import { readChecksSet } from "../checks/lib/set";
import { CITATION_DOCUMENTS, type CitationDocument } from "../citations/checkSet";
import { reports } from "../everyday/asking";
import { readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { type EvalDocument, loadEvaluationSet } from "../lib/evaluationSet";
import { type Library, openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { SETS, writeDocuments } from "../repeats/cases";
import {
  askedAlone,
  asLabelled,
  decisionUsd,
  type HostLater,
  hasDigit,
  heldBackBy,
  type ReplayRow,
  replayByLabel,
  replayOutcome,
  replayTally,
  shapesOf,
} from "./decisionFirstScore";
import { measuredLines, measuredLinesTable, type ScoredRow } from "./measuredLines";
import { env, list, modelsAsked, spentUsd } from "./settings";

/* A measurement of where a line can sit reads with other lines than the measured model's. */
vi.mock("../../src/core/answers/checks/decisionLines", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/answers/checks/decisionLines")>();
  const other = process.env.INCARNAMIND_EVAL_SPEED_LINES;
  if (!other) return real;
  const lines: DecisionLines = JSON.parse(other);
  return {
    ...real,
    decisionLinesFor: (...model: Parameters<typeof real.decisionLinesFor>) =>
      real.decisionLinesFor(...model) && lines,
  };
});

const ROOT = resolve(__dirname, "../..");
const DECIDER: CheckDecisionModel = { host: "openrouter", modelId: "perplexity/pplx-decider-v1.2" };
const mode = env("DECISION_FIRST");
type Arm = "main" | "decision";

/** The English sets' sentences, each once, and the Documents their Libraries hold between them. */
async function noteOf(folder: string, count: number) {
  const sets = SETS.filter((set) => set.language === "en");
  const byText = new Map(sets.flatMap((set) => set.sentences).map((each) => [each.text, each]));
  const documents = new Map<string, EvalDocument>();
  for (const set of sets)
    for (const document of await writeDocuments(folder, set)) documents.set(document.key, document);
  return { sentences: [...byText.values()].slice(0, count), documents: [...documents.values()] };
}

/**
 * A decision host on this computer: the first Passage, or line, of every request about several
 * leans to stating the sentence and no other does; for a sentence in `sure` its score is clear of
 * the verdict's line, and so is its Passage's when asked about alone.
 */
async function startHost(answerMs: number, sure: ReadonlySet<string> = new Set()) {
  const read = new Map<string, HostPassage[]>();
  const scores: HostScore[] = [];
  const later: HostLater[] = [];
  let asked = 0;
  let characters = 0;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    characters += text.length;
    const send = (payload: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET") return send({ data: [] });
    const body = JSON.parse(text) as { model: unknown; state: HostState; questions: object };
    asked++;
    await sleep(answerMs);
    const { sentence } = body.state;
    const top = sure.has(sentence) ? 0.995 : 0.9;
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((question) => {
        const [kind, name] = question.split("_");
        const noul = kind === "C" ? 0.01 : name === undefined || name === "p1" ? top : 0.02;
        return [question, { type: "noul", noul }];
      }),
    );
    if (body.state.passages && !read.has(sentence)) {
      read.set(sentence, Object.values(body.state.passages));
      scores.push(...scoresOfEach(sentence, answers));
    } else later.push(laterOf(body.state, answers));
    send({ model: body.model, answers, usage: { input_tokens: 10, output_tokens: 0 } });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked: () => asked,
    characters: () => characters,
    inputTokens: () => 0,
    scores: () => scores,
    later: () => later,
    passagesRead: (sentence: string) => read.get(sentence) ?? null,
    refused: (): number[] => [],
    forget: () => {
      read.clear();
      scores.length = 0;
      later.length = 0;
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

type DecisionHost = Awaited<ReturnType<typeof startHost>> | Awaited<ReturnType<typeof startRelay>>;

/** One Passage's two scores in a sentence's first request, the one about all its Passages. */
interface HostScore {
  sentence: string;
  states: number;
  opposes: number;
}

interface HostPassage {
  document: string;
  text: string;
}

interface HostState {
  sentence: string;
  passages?: Record<string, HostPassage>;
}

/** A request about a sentence after its first, with each question's answer. */
const laterOf = (
  { sentence, passages }: HostState,
  answers: Record<string, { noul?: number }>,
): HostLater => ({
  sentence,
  several: passages ? Object.keys(passages).length : 0,
  answers: Object.fromEntries(
    Object.entries(answers).flatMap(([question, { noul }]) =>
      noul === undefined ? [] : [[question, noul]],
    ),
  ),
});

/** Each Passage's scores in the answers to one request about several, in the order asked. */
function scoresOfEach(sentence: string, answers: Record<string, { noul?: number }>): HostScore[] {
  const scores: HostScore[] = [];
  for (let at = 1; ; at++) {
    const states = answers[`B_p${at}`]?.noul;
    const opposes = answers[`C_p${at}`]?.noul;
    if (states === undefined || opposes === undefined) return scores;
    scores.push({ sentence, states, opposes });
  }
}

const OPENROUTER = "https://openrouter.ai";

/**
 * A relay on this computer to the decision model's own host, which counts what the app can't see:
 * a refused request the app asks again and gets answered still makes a paid run void.
 */
async function startRelay(origin: string) {
  let asked = 0;
  let characters = 0;
  let inputTokens = 0;
  const read = new Map<string, HostPassage[]>();
  const scores: HostScore[] = [];
  const later: HostLater[] = [];
  const refused: number[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const asks = request.method === "POST";
    const headers = Object.fromEntries(
      ["authorization", "content-type", "accept"].flatMap((name) => {
        const value = request.headers[name];
        return typeof value === "string" ? [[name, value]] : [];
      }),
    );
    // 0 stands for a request the app gave up on before its answer came.
    response.on("close", () => {
      if (asks && !response.writableEnded) refused.push(0);
    });
    const answered = await fetch(`${origin}${request.url ?? ""}`, {
      method: request.method ?? "GET",
      headers,
      ...(asks && { body: Buffer.concat(chunks) }),
    })
      .then(async (reply) => ({ reply, text: await reply.text() }))
      .catch(() => null);
    // The host couldn't be reached, or its answer broke off: the app is told at once, and the run is void.
    if (!answered) {
      if (asks) refused.push(502);
      response.writeHead(502, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const { reply, text } = answered;
    if (asks) {
      asked++;
      characters += Buffer.concat(chunks).toString("utf8").length;
      if (reply.ok) {
        const { usage, answers } = JSON.parse(text) as {
          usage?: { input_tokens?: number };
          answers?: Record<string, { noul?: number }>;
        };
        inputTokens += usage?.input_tokens ?? 0;
        const { state } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          state?: Partial<HostState>;
        };
        // A later request about several is about the lines of the verdict's Passage.
        if (state?.sentence && state.passages && answers && !read.has(state.sentence)) {
          read.set(state.sentence, Object.values(state.passages));
          scores.push(...scoresOfEach(state.sentence, answers));
        } else if (state?.sentence && answers)
          later.push(laterOf({ ...state, sentence: state.sentence }, answers));
      } else refused.push(reply.status);
    }
    const retryAfter = reply.headers.get("retry-after");
    response.writeHead(reply.status, {
      "content-type": reply.headers.get("content-type") ?? "application/json",
      ...(retryAfter && { "retry-after": retryAfter }),
    });
    response.end(text);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked: () => asked,
    characters: () => characters,
    inputTokens: () => inputTokens,
    scores: () => scores,
    later: () => later,
    passagesRead: (sentence: string) => read.get(sentence) ?? null,
    refused: () => refused,
    forget: () => {
      read.clear();
      scores.length = 0;
      later.length = 0;
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** A model that checks each of `sentences` in two replies, a search and its answer, each after `replyMs`. */
function scriptedCheck(sentences: readonly string[], replyMs: number) {
  const plans: Record<string, Plan> = Object.fromEntries(
    sentences.map((each) => [each, { verdict: "unsupported" }]),
  );
  return scriptedModel(
    (call) => {
      const reply = checkReply(call, plans);
      return isCheckRun(call) ? { ...reply, pause: { after: 0, until: sleep(replyMs) } } : reply;
    },
    { generate: checkGenerate(plans) },
  );
}

interface RunTimes {
  arm: Arm;
  sentences: number;
  readings: number;
  firstReadingMs: number | null;
  lastReadingMs: number | null;
  /** When the AI model's first Mark landed, and the last Mark of all. */
  firstMarkMs: number | null;
  lastMarkMs: number | null;
  doneMs: number;
  reranks: number;
  rerankMs: number;
  hostRequests: number;
  /** Requests the AI model's provider or the decision host didn't answer: one makes a paid run void. */
  unanswered: number;
  /** Marks that are the verdict the Documents give their sentence, whoever gave them. */
  asLabelled: number;
  /** Marks the decision model gave, and those of them that aren't as labelled. */
  decisionMarks: number;
  decisionWrong: number;
  usd: number;
  /** What the decision host's own count of input tokens costs at its listed price. */
  decisionUsd: number;
  load: number;
  marks: {
    sentence: string;
    state: string;
    by: string | null;
    quote: string | null;
    /** The Document the quote is from, for a blind reading of the quotes. */
    document: string | null;
    /** Whether the quote is shown: false where the Mark rests on its Passage and says none. */
    quoteShown: boolean;
    firstReading: string | null;
    /** When its first reading showed and its Mark landed, from the User's action. */
    readMs: number | null;
    landedMs: number | null;
  }[];
}

/** One Check this Note of a new Note of `sentences`, timed from the User's action. */
async function checkNote(
  core: Core,
  sentences: readonly string[],
  choice: ChatModelChoice,
  title: string,
) {
  const { id: mindId } = await core.createMind({ title });
  const client = await connectToMind(core, mindId);
  writeMind(
    client,
    sentences.map((sentence) => note(sentence)),
  );
  await client.settled();
  const spans = () =>
    claimSpans(readMind({ blocks: client.doc.getXmlFragment(MIND_CONTENT_FIELD) }));
  const read = new Map<string, number>();
  const landed = new Map<string, number>();
  const started = performance.now();
  const watch = () => {
    const ms = performance.now() - started;
    for (const { sentence, check } of spans()) {
      const key = sentence.text.trim();
      if (check.parts?.some((part) => part.firstReading) && !read.has(key)) read.set(key, ms);
      if (check.state && check.state !== "checking" && !landed.has(key)) landed.set(key, ms);
    }
  };
  client.doc.on("update", watch);
  await core.checkMind({ requestId: `${title}-${Date.now()}`, mindId, mode: "all", model: choice });
  const doneMs = performance.now() - started;
  client.doc.off("update", watch);
  const times = (each: Iterable<number>) => [...each].sort((a, b) => a - b);
  const marks = spans().map(({ sentence, check }) => {
    const part = check.parts?.[0];
    return {
      sentence: sentence.text.trim(),
      state: check.state ?? "none",
      by: part?.modelId ?? check.modelId ?? null,
      quote: part?.evidence?.[0]?.quote ?? null,
      document: part?.evidence?.[0]?.documentName ?? null,
      quoteShown: part?.restsOnPassage !== true,
      firstReading: part?.firstReading?.verdict ?? null,
      readMs: read.get(sentence.text.trim()) ?? null,
      landedMs: landed.get(sentence.text.trim()) ?? null,
    };
  });
  const byAiModel = marks.flatMap((mark) =>
    mark.by !== DECIDER.modelId && mark.landedMs !== null ? [mark.landedMs] : [],
  );
  return {
    sentences: landed.size,
    readings: read.size,
    firstReadingMs: times(read.values())[0] ?? null,
    lastReadingMs: times(read.values()).at(-1) ?? null,
    firstMarkMs: times(byAiModel)[0] ?? null,
    lastMarkMs: times(landed.values()).at(-1) ?? null,
    doneMs,
    marks,
  };
}

const seconds = (ms: number | null) => (ms === null ? "none" : `${(ms / 1000).toFixed(1)} s`);

function report(runs: readonly RunTimes[], heading: string) {
  const rows = runs.map(
    (run, at) =>
      `| ${at + 1} | ${run.arm} | ${run.sentences} | ${run.readings} | ${seconds(run.firstReadingMs)} | ${seconds(run.lastReadingMs)} | ${seconds(run.firstMarkMs)} | ${seconds(run.lastMarkMs)} | ${seconds(run.doneMs)} | ${run.reranks} | ${seconds(run.rerankMs)} | ${run.hostRequests} | ${run.unanswered} | ${run.asLabelled} | ${run.decisionMarks} | ${run.decisionWrong} | $${run.usd.toFixed(3)} | $${run.decisionUsd.toFixed(4)} | $${(run.usd + run.decisionUsd).toFixed(3)} | ${run.load.toFixed(1)} |`,
  );
  return [
    `# ${heading}`,
    "",
    "| Run | Arm | Marks landed | First readings | First reading at | Last reading at | AI model's first Mark | Last Mark | Done | Reranks | Reranking | Requests to the decision host | Requests not answered | Marks as labelled | Decision model's Marks | Of them not as labelled | The AI model's cost | The decision model's cost | Both | Load |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

test.skipIf(mode !== "dry" && mode !== "real")(
  "Check this Note with a decision model in front, beside the check alone",
  async () => {
    const config = readConfig(ROOT);
    const log = createLog();
    const arms = (list("ARMS") ?? ["main", "decision", "decision", "main"]).map((arm): Arm => {
      if (arm !== "main" && arm !== "decision")
        throw new Error(`INCARNAMIND_EVAL_SPEED_ARMS: "${arm}" isn't main or decision.`);
      return arm;
    });
    const folder = await mkdtemp(join(tmpdir(), "incarnamind-decision-first-"));
    const { sentences, documents } = await noteOf(folder, Number(env("SENTENCES") ?? "33"));
    const texts = sentences.map((each) => each.text);
    if (env("LIBRARY") === "mixed") documents.push(...(await reports()));
    const every = Number(env("HOST_SURE_EVERY") ?? "0");
    const sure = every > 0 ? texts.filter((_, at) => at % every === every - 1) : [];
    const host: DecisionHost =
      mode === "dry"
        ? await startHost(Number(env("HOST_MS") ?? "350"), new Set(sure))
        : await startRelay(OPENROUTER);
    const scripted =
      mode === "dry" ? scriptedCheck(texts, Number(env("REPLY_MS") ?? "3000")) : null;
    const [asked] = modelsAsked();
    const key = env("KEY_OPENROUTER");
    if (mode === "real" && (!asked || !key))
      throw new Error("A real run needs INCARNAMIND_EVAL_SPEED_MODELS and _KEY_OPENROUTER.");
    const library = await openLibrary({
      name: "decision-first",
      embedder: createWorkerEmbedder(),
      modelCache: join(config.cacheDir, "models"),
      reranker: createWorkerCrossEncoder(config.rerankOnCpu),
      documents,
      embeddings: false,
      keep: config.keepData,
      log,
      ...(scripted && { chatModels: () => () => scripted }),
      decisionOrigins: { openrouter: host.url },
    });
    const runs: RunTimes[] = [];
    let stopped: string | null = null;
    try {
      const { core, dataDir } = library;
      core.on(
        "consent.requested",
        (request) => void core.respondToConsent(request.requestId, true),
      );
      // The decision host's key is the OpenRouter provider's, as in the app.
      const openRouter = await core.saveChatProvider({
        kind: "openrouter",
        apiKey: key ?? "sk-or-dry-run",
        modelId: "anthropic/claude-haiku-5.5",
      });
      const saved = asked && mode === "real" ? await core.saveChatProvider(asked) : openRouter;
      const choice: ChatModelChoice = {
        providerId: saved.id,
        modelId: asked && mode === "real" ? asked.modelId : "anthropic/claude-haiku-5.5",
      };
      const stopUsd = Number(env("STOP_USD") ?? "1");
      for (const [at, arm] of arms.entries()) {
        const before = await spentUsd(core);
        if (before >= stopUsd) {
          stopped = `Stopped at $${before.toFixed(2)}, before run ${at + 1} (${arm}).`;
          log(stopped);
          break;
        }
        await core.updateSettings({
          device: { checkDecisionModel: arm === "decision" ? DECIDER : null },
        });
        host.forget();
        const hostBefore = host.asked();
        const refusedBefore = host.refused().length;
        const tokensBefore = host.inputTokens();
        const load = loadavg()[0] ?? 0;
        log(
          `run ${at + 1}/${arms.length} · ${arm} · ${texts.length} sentences · load ${load.toFixed(1)}`,
        );
        const startedAt = new Date().toISOString();
        const times = await checkNote(core, texts, choice, `Decision first ${at + 1} ${arm}`);
        const labelled = times.marks.flatMap((mark) => {
          const expected = sentences.find((each) => each.text.trim() === mark.sentence)?.expected;
          return expected
            ? [{ right: asLabelled(expected, mark.state), decided: mark.by === DECIDER.modelId }]
            : [];
        });
        const reranks = queryDatabase<{ end_ms: number }>(
          dataDir,
          "SELECT end_ms FROM ai_timings WHERE kind = 'local' AND model_id = ? AND started_at >= ?",
          [BUILT_IN_RERANKING_MODEL.name, startedAt],
        );
        const [failed] = queryDatabase<{ count: number }>(
          dataDir,
          "SELECT COUNT(*) AS count FROM ai_timings WHERE outcome = 'failed' AND started_at >= ?",
          [startedAt],
        );
        const run: RunTimes = {
          arm,
          ...times,
          reranks: reranks.length,
          rerankMs: reranks.reduce((sum, each) => sum + each.end_ms, 0),
          hostRequests: host.asked() - hostBefore,
          unanswered: (failed?.count ?? 0) + host.refused().length - refusedBefore,
          asLabelled: labelled.filter((each) => each.right).length,
          decisionMarks: labelled.filter((each) => each.decided).length,
          decisionWrong: labelled.filter((each) => each.decided && !each.right).length,
          usd: (await spentUsd(core)) - before,
          decisionUsd: decisionUsd(host.inputTokens() - tokensBefore),
          load,
        };
        runs.push(run);
        log(
          `  readings ${run.readings} (${seconds(run.firstReadingMs)} to ${seconds(run.lastReadingMs)}), AI model's first Mark ${seconds(run.firstMarkMs)}, last Mark ${seconds(run.lastMarkMs)}, done ${seconds(run.doneMs)}, ${run.reranks} reranks in ${seconds(run.rerankMs)}`,
        );
      }
    } finally {
      await library.close();
      await host.close();
    }
    const out = join(
      config.resultsDir,
      `decision-first-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
    );
    await mkdir(out, { recursive: true });
    const heading = `Check this Note with a decision model in front (${mode}, ${texts.length} sentences${env("LIBRARY") === "mixed" ? ", mixed Library" : ""})`;
    const tokens = `The decision host read ${host.inputTokens()} input tokens in ${host.asked()} requests, US$${decisionUsd(host.inputTokens()).toFixed(4)} at its listed price.`;
    const text = `${report(runs, heading)}\n${tokens}\n${stopped ? `\n${stopped}\n` : ""}`;
    await writeFile(join(out, "report.md"), text);
    await writeFile(
      join(out, "report.json"),
      JSON.stringify({ mode, expected: sentences, runs }, null, 2),
    );
    log(`\n${text}\nWritten to ${out}`);
  },
);

interface LabelledSentence {
  id: string;
  text: string;
  expected: "supported" | "contradicted" | "unsupported" | "no-mark" | "unknown";
  kind?: string;
  citation: { file: string; quote: string } | null;
  /** Where its Documents settle it, when the label says. */
  evidence?: { file: string; quote: string }[];
}

interface LabelledNote {
  id: string;
  language: "en" | "zh";
  /** The keys of the Documents its check searches, as the Note's own Search scope. Left out: every Document. */
  scope?: string[];
  blocks: { heading: string | null; sentences: LabelledSentence[] }[];
}

const bareName = (name: string) => name.replace(/\.[A-Za-z0-9]{2,5}$/u, "").normalize("NFC");

/** The Note as the app holds it: a block a paragraph, a sentence's Citation right after it. */
async function writeLabelled(library: Library, labelled: LabelledNote) {
  const { core } = library;
  const documents = new Map((await core.listDocuments()).map((each) => [each.id, each]));
  const passages = library.passages();
  const citation = ({ file, quote }: NonNullable<LabelledSentence["citation"]>) => {
    const passage = passages.find(
      (each) =>
        bareName(each.documentName) === bareName(file) &&
        findQuote(each.text, quote, { numbers: "if-needed", lostLigatures: true }) !== null,
    );
    const document = passage && documents.get(passage.documentId);
    if (!passage || !document) return [];
    return [
      {
        type: "citation",
        attrs: {
          passageId: passage.passageId,
          documentId: document.id,
          documentName: passage.documentName,
          contentHash: document.contentHash,
          pageFrom: passage.pageFrom,
          pageTo: passage.pageTo,
          quote,
          check: "found",
          checkReason: null,
        },
      },
    ];
  };
  const gap = labelled.language === "zh" ? "" : " ";
  const { id: mindId } = await core.createMind({ title: `Replay ${labelled.id}` });
  const client = await connectToMind(core, mindId);
  writeMind(
    client,
    labelled.blocks.flatMap((block) => [
      ...(block.heading ? [heading(2, block.heading)] : []),
      {
        type: "paragraph",
        attrs: { id: randomUUID() },
        content: block.sentences.flatMap((each, at) => [
          { type: "text", text: at === 0 ? each.text : `${gap}${each.text}` },
          ...(each.citation ? citation(each.citation) : []),
        ]),
      },
    ]),
  );
  if (labelled.scope)
    setMindScope(client.doc, {
      folderIds: [],
      tagIds: [],
      documentIds: labelled.scope.map((key) => {
        const document = library.documents.get(key);
        if (!document) throw new Error(`${labelled.id}: the Library holds no Document "${key}".`);
        return document.id;
      }),
    });
  await client.settled();
  return { mindId, client };
}

/** The citation benchmark's own PDFs, by their keys there: those no other set holds. */
const ownDocuments = (root: string): EvalDocument[] =>
  (
    JSON.parse(readFileSync(join(root, CITATION_DOCUMENTS), "utf8")) as {
      documents: CitationDocument[];
    }
  ).documents
    .filter((each) => each.path.startsWith("eval/citations/documents/"))
    .map(({ key, path }) => ({ key, path: join(root, path) }));

const AI_MODEL = "anthropic/claude-haiku-5.5";

test.skipIf(mode !== "replay" && mode !== "replay-dry" && mode !== "replay-main")(
  "Labelled Notes checked in the app, counted against their labels",
  async () => {
    const config = readConfig(ROOT);
    const log = createLog();
    const paths = list("NOTES");
    const key = env("KEY_OPENROUTER");
    const alone = mode === "replay-main";
    const stopUsd = Number(env("STOP_USD") ?? "0.15");
    if (!paths) throw new Error("A replay needs INCARNAMIND_EVAL_SPEED_NOTES.");
    if (mode !== "replay-dry" && !key)
      throw new Error("A replay on a real model needs INCARNAMIND_EVAL_SPEED_KEY_OPENROUTER.");
    const notes = paths.map(
      (path) => JSON.parse(readFileSync(resolve(path), "utf8")) as LabelledNote,
    );
    const claims = notes
      .flatMap((each) => each.blocks.flatMap((block) => block.sentences))
      .filter((each) => each.expected !== "no-mark")
      .map((each) => each.text);
    const added = list("LIBRARY") ?? [];
    const checks = added.includes("checks")
      ? (await readChecksSet(ROOT)).folder.map((each) => ({ ...each, path: join(ROOT, each.path) }))
      : [];
    const host: DecisionHost =
      mode === "replay"
        ? await startRelay(OPENROUTER)
        : await startHost(0, new Set(env("HOST_SURE_EVERY") === "1" ? claims : []));
    const scripted = alone ? null : scriptedCheck(claims, 0);
    const library = await openLibrary({
      name: "decision-first-replay",
      embedder: createWorkerEmbedder(),
      modelCache: join(config.cacheDir, "models"),
      reranker: createWorkerCrossEncoder(config.rerankOnCpu),
      documents: [
        ...loadEvaluationSet(ROOT).documents,
        ...(added.includes("mixed") ? await reports() : []),
        ...(added.includes("repeats")
          ? (await noteOf(await mkdtemp(join(tmpdir(), "incarnamind-decision-first-")), 0))
              .documents
          : []),
        ...checks.filter((each) => !each.address).map(({ name, path }) => ({ key: name, path })),
        ...(added.includes("citations") ? ownDocuments(ROOT) : []),
      ],
      webPages: checks.flatMap(({ name, path, address }) =>
        address ? [{ key: name, address, html: readFileSync(path, "utf8") }] : [],
      ),
      ...(env("EMBEDDINGS") === "off" && { embeddings: false }),
      keep: config.keepData,
      log,
      ...(scripted && { chatModels: () => () => scripted }),
      decisionOrigins: { openrouter: host.url },
    });
    const lines: string[] = [];
    const marks: unknown[] = [];
    const rows: ReplayRow[] = [];
    let usd = 0;
    let unanswered = 0;
    let stopped: string | null = null;
    try {
      const { core, dataDir } = library;
      const startedAt = new Date().toISOString();
      core.on(
        "consent.requested",
        (request) => void core.respondToConsent(request.requestId, true),
      );
      const provider = await core.saveChatProvider({
        kind: "openrouter",
        apiKey: key ?? "sk-or-dry-run",
        modelId: AI_MODEL,
      });
      await core.updateSettings({ device: { checkDecisionModel: alone ? "off" : DECIDER } });
      const decisionLines = decisionLinesFor(DECIDER.host, DECIDER.modelId);
      for (const labelled of notes) {
        const spent = alone ? await spentUsd(core) : decisionUsd(host.inputTokens());
        if (spent >= stopUsd) {
          stopped = `Stopped at $${spent.toFixed(3)}, before ${labelled.id}.`;
          log(stopped);
          break;
        }
        const { mindId, client } = await writeLabelled(library, labelled);
        host.forget();
        const started = performance.now();
        await core.checkMind({
          requestId: `replay-${labelled.id}-${Date.now()}`,
          mindId,
          mode: "all",
          model: { providerId: provider.id, modelId: AI_MODEL },
        });
        const checkedMs = performance.now() - started;
        const spans = claimSpans(
          readMind({ blocks: client.doc.getXmlFragment(MIND_CONTENT_FIELD) }),
        );
        const sentences = labelled.blocks.flatMap((block) => block.sentences);
        const scored = sentences
          .filter((each) => each.expected !== "no-mark" && each.expected !== "unknown")
          .map((sentence) => {
            const span = spans.find((each) => each.sentence.text.trim() === sentence.text.trim());
            const part = span?.check.parts?.[0];
            const byDecision = part?.modelId === DECIDER.modelId;
            const evidence = byDecision ? part?.evidence?.[0] : undefined;
            const scores = host
              .scores()
              .filter((each) => each.sentence.trim() === sentence.text.trim());
            const reading =
              decisionLines &&
              readingOf(
                scores.map((each, at) => ({ ...each, passageId: String(at) })),
                decisionLines,
              );
            const read = host.passagesRead(sentence.text.trim());
            const alone = askedAlone(
              host.later().filter((each) => each.sentence.trim() === sentence.text.trim()),
            );
            return {
              note: labelled.id,
              // The highest score any Passage got on each question, in the sentence's first request.
              top:
                scores.length > 0
                  ? {
                      states: Math.max(...scores.map((each) => each.states)),
                      opposes: Math.max(...scores.map((each) => each.opposes)),
                    }
                  : null,
              // Whether a Passage the label rests on was among those the decision model read.
              inReach:
                read && sentence.evidence?.length
                  ? sentence.evidence.some(({ file, quote }) =>
                      read.some(
                        (each) =>
                          bareName(each.document) === bareName(file) &&
                          findQuote(each.text, quote, {
                            numbers: "if-needed",
                            lostLigatures: true,
                          }) !== null,
                      ),
                    )
                  : null,
              sure:
                reading && reading.verdict !== "unsupported" && reading.final
                  ? reading.verdict
                  : null,
              // Why a sure score gave no Mark of the decision model's.
              heldBack:
                decisionLines &&
                reading &&
                reading.verdict !== "unsupported" &&
                reading.final &&
                !byDecision
                  ? heldBackBy(reading.verdict, alone, decisionLines)
                  : null,
              // Its Passage asked about alone, whatever Mark followed.
              alone,
              kind: sentence.kind ?? null,
              id: sentence.id,
              text: sentence.text,
              expected: sentence.expected,
              cited: sentence.citation !== null,
              shown: span
                ? {
                    byDecision,
                    state: span.check.state,
                    firstReading: part?.firstReading?.verdict ?? null,
                  }
                : null,
              quote: evidence?.quote ?? null,
              // Whether the card shows the quote: false where the Mark rests on its Passage.
              quoteShown: byDecision ? part?.restsOnPassage !== true : null,
              document: evidence?.documentName ?? null,
            };
          });
        rows.push(...scored);
        for (const each of scored)
          marks.push({
            ...each,
            figure: hasDigit(each.text),
            outcome: replayOutcome(each.expected, each.shown),
          });
        const labelledPassage = scored.filter((each) => each.inReach !== null);
        lines.push(
          `## ${labelled.id}`,
          "",
          `${scored.length} sentences checked in ${seconds(checkedMs)}. A Passage the label rests on was among those read for ${labelledPassage.filter((each) => each.inReach).length} of ${labelledPassage.length}.`,
          "",
          `${sentences.length} sentences, ${scored.length} labelled with a Mark.`,
          "",
          ...(alone ? markLines(scored) : readingLines(scored)),
        );
      }
      lines.push("## All the Notes", "", ...(alone ? markLines(rows) : readingLines(rows)));
      usd = alone ? await spentUsd(core) : decisionUsd(host.inputTokens());
      const [failed] = queryDatabase<{ count: number }>(
        dataDir,
        "SELECT COUNT(*) AS count FROM ai_timings WHERE outcome = 'failed' AND started_at >= ?",
        [startedAt],
      );
      unanswered = (failed?.count ?? 0) + host.refused().length;
    } finally {
      await library.close();
      await host.close();
    }
    const out = join(
      config.resultsDir,
      `decision-first-replay-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
    );
    await mkdir(out, { recursive: true });
    const text = [
      `# Labelled Notes checked in the app (${mode})`,
      "",
      alone
        ? `The AI model (${AI_MODEL}) cost $${usd.toFixed(3)} by the app's count.`
        : `The decision host answered ${host.asked()} requests of ${host.characters()} characters, ${host.inputTokens()} input tokens, $${usd.toFixed(4)} at its listed price.`,
      unanswered > 0
        ? `**Void: ${unanswered} requests were refused, failed or timed out.**`
        : "Every request was answered.",
      ...(stopped ? [stopped] : []),
      "",
      ...lines,
    ].join("\n");
    await writeFile(join(out, "report.md"), text);
    await writeFile(join(out, "marks.json"), JSON.stringify(marks, null, 2));
    log(`\n${text}\nWritten to ${out}`);
  },
);

const verdictOf = (label: string) => label[0]?.toUpperCase() + label.slice(1);

/** The decision model's part of a replay, as counts. */
function readingLines(rows: readonly ReplayRow[]): string[] {
  const tally = replayTally(rows);
  const { counts, heldBack } = replayByLabel(rows);
  return [
    "| What the decision model did | Sentences |",
    "|---|---|",
    ...Object.entries(tally.outcomes).map(([name, count]) => `| ${name} | ${count} |`),
    `| marked, on a sentence with a digit | ${tally.markedWithDigit} |`,
    `| marked, on a sentence with a Citation | ${tally.markedWithCitation} |`,
    "",
    "| Label | A figure | Sentences | Marked | First reading the label's way | The other way | None |",
    "|---|---|---|---|---|---|---|",
    ...counts.map(
      (each) =>
        `| ${verdictOf(each.label)} | ${each.figure ? "yes" : "no"} | ${each.sentences} | ${each.marked} | ${each.readingRight} | ${each.readingWrong} | ${each.none} |`,
    ),
    "",
    "| A sure score a rule held back | Sentences | Of them as labelled |",
    "|---|---|---|",
    ...heldBack.map((each) => `| ${each.rule} | ${each.sentences} | ${each.asLabelled} |`),
    "",
  ];
}

/** The AI model's Marks of a replay with no decision model, as counts. */
function markLines(rows: readonly ReplayRow[]): string[] {
  const [alone] = shapesOf(rows, rows);
  if (!alone) return [];
  return [
    "| The AI model's Marks | Sentences |",
    "|---|---|",
    `| as labelled | ${alone.right} |`,
    `| Supported, wrong | ${alone.wrongSupported} |`,
    `| Contradicted, wrong | ${alone.wrongContradicted} |`,
    `| Unsupported, wrong | ${alone.wrongUnsupported} |`,
    `| no Mark with a verdict | ${alone.nothing} |`,
    "",
  ];
}

test.skipIf(mode !== "shapes")("The three shapes of the check, from two replays", async () => {
  const [decisionPath, mainPath] = list("SHAPES") ?? [];
  if (!decisionPath || !mainPath)
    throw new Error(
      "INCARNAMIND_EVAL_SPEED_SHAPES needs two marks.json: the replay's, the main replay's.",
    );
  const read = (path: string) => JSON.parse(readFileSync(resolve(path), "utf8")) as ReplayRow[];
  const main = read(mainPath);
  const keys = new Set(main.map((each) => `${each.note} ${each.id}`));
  const decision = read(decisionPath).filter((each) => keys.has(`${each.note} ${each.id}`));
  const text = [
    `# The three shapes on the same ${decision.length} sentences`,
    "",
    "| Shape | Right | Supported, wrong | Contradicted, wrong | Unsupported, wrong | Nothing shown | Sentences to the AI model |",
    "|---|---|---|---|---|---|---|",
    ...shapesOf(decision, main).map(
      (each) =>
        `| ${each.shape} | ${each.right} | ${each.wrongSupported} | ${each.wrongContradicted} | ${each.wrongUnsupported} | ${each.nothing} | ${each.toAiModel} |`,
    ),
    "",
    ...readingLines(decision),
  ].join("\n");
  createLog()(`\n${text}`);
});

test.skipIf(mode !== "lines")("The verdict lines a replay's labelled sentences allow", () => {
  const paths = list("MARKS");
  const lines = decisionLinesFor(DECIDER.host, DECIDER.modelId);
  if (!paths || !lines?.verdict)
    throw new Error(
      "INCARNAMIND_EVAL_SPEED_MARKS names no marks.json, or the decision model has no verdict lines to measure within.",
    );
  const rows = paths.flatMap(
    (path) => JSON.parse(readFileSync(resolve(path), "utf8")) as ScoredRow[],
  );
  const within = {
    firstReading: lines.firstReading,
    band: lines.verdict.band,
    joinedUnder: lines.verdict.unsupported,
  };
  createLog()(
    `\n${[`# The lines ${rows.length} labelled sentences allow`, "", ...measuredLinesTable(measuredLines(rows, within))].join("\n")}`,
  );
});
