/**
 * `INCARNAMIND_EVAL_SPEED_REPLY_NOW=1 npm run eval:speed -- eval/speed/replyNow.speed.ts` (#2830):
 * the assistant asked to write a piece into a Note (./replyNowCases), on real models, over the
 * sample reports. Each run gives, from the request:
 *
 * - the first change in the Note, the write's end, the reply's first words after the write, and
 *   the Answer's end, when the composer is free again;
 * - when no sentence of the write is being checked any more;
 * - the sentences the write holds that a check reads (each with a Citation, and each claim with
 *   none), and how many of them a check gave a verdict, marked Not checked, or left unmarked;
 * - whether the reply reports the check: says a sentence it wrote is checked, verified or
 *   supported, or counts what a check did, as a judge reads it (Claude Sonnet 5.5, never a
 *   model under test), with the words it read so.
 *
 * It reads only the core's public interface and the Note's own marks, so the same file times
 * `main` and a branch alike. INCARNAMIND_EVAL_SPEED_MODELS, the keys, _LANGUAGES, _ITEMS, _RUNS
 * (1 by default) and _STOP_USD (6 by default) work as in README.md. Writes
 * eval/results/speed-reply-now-<time>/report.md and report.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { generateText } from "ai";
import { test } from "vitest";
import * as Y from "yjs";
import { BLOCK_ID_ATTRIBUTE, type ConversationAnswer, type Core } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { connectToMind } from "../../tests/helpers/mindClient";
import { note, writeMind } from "../../tests/helpers/minds";
import { reports } from "../everyday/asking";
import { commitOf } from "../lib/commit";
import { readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { writtenSentences } from "../lib/writtenSentences";
import { EIGHT_PARAGRAPHS, REPLY_NOW_CASES, type ReplyNowCase } from "./replyNowCases";
import { env, list, modelNamed, modelsAsked, spentUsd } from "./settings";

const ROOT = resolve(__dirname, "../..");
const ANSWER_LIMIT_MS = 15 * 60_000;
const CHECK_LIMIT_MS = 20 * 60_000;
const POLL_MS = 500;
const MIND_TOOLS = new Set(["create_mind", "add_to_mind", "edit_mind"]);
const NOTE_LINE = { en: "Notes for Monday's meeting.", "zh-CN": "周一会议的笔记。" };
const NOTE_TITLE = { en: "Notes", "zh-CN": "笔记" };

interface Sentences {
  written: number;
  verdict: number;
  notChecked: number;
  checking: number;
  unmarked: number;
}

interface Run {
  id: string;
  language: ReplyNowCase["language"];
  model: string;
  /** Seconds from the request; null: it didn't happen. */
  firstChange: number | null;
  written: number | null;
  reply: number | null;
  free: number | null;
  checked: number | null;
  sentences: Sentences;
  calls: string[];
  replyText: string;
  bookkeeping: { verdict: "yes" | "no" | "unread"; words: string };
  load: number;
  error: string | null;
}

/** The write's sentences a check reads, and the state each one's mark says. */
function sentencesIn(blocks: Y.XmlFragment, ids: ReadonlySet<string>): Sentences {
  const counted: Sentences = { written: 0, verdict: 0, notChecked: 0, checking: 0, unmarked: 0 };
  for (const { state } of writtenSentences(blocks, ids)) {
    counted.written++;
    if (state === null) counted.unmarked++;
    else if (state === "checking") counted.checking++;
    else if (state === "not-checked") counted.notChecked++;
    else counted.verdict++;
  }
  return counted;
}

const topIds = (blocks: Y.XmlFragment) =>
  blocks
    .toArray()
    .flatMap((block) =>
      block instanceof Y.XmlElement && typeof block.getAttribute(BLOCK_ID_ATTRIBUTE) === "string"
        ? [String(block.getAttribute(BLOCK_ID_ATTRIBUTE))]
        : [],
    );

const JUDGE_INSTRUCTIONS = [
  "You read the reply an assistant gave after writing a piece into the User's note from their Documents.",
  "Answer yes when the reply reports on checking what it wrote: it says or implies that the sentences it wrote were checked, verified, fact-checked, confirmed or found supported by the Documents, or that some were flagged, unsupported, contradicted, marked or not checked, or it counts what such a check did or will do.",
  "Saying that the text cites the Documents, or which Documents it drew on, is not reporting a check: answer no then.",
  "Reply with yes or no on the first line, then quote the words that decided it, or nothing.",
].join("\n");

function judgeOf() {
  const named = modelNamed(env("JUDGE") ?? "anthropic/claude-sonnet-5-5", "JUDGE");
  const model = createAiSdkChatModel({
    kind: named.kind,
    modelId: named.modelId,
    apiKey: named.apiKey ?? null,
    baseUrl: null,
    endpoint: named.endpoint ?? null,
    thinking: "off",
  });
  return async (reply: string): Promise<Run["bookkeeping"]> => {
    if (reply.trim() === "") return { verdict: "no", words: "" };
    try {
      const { text } = await generateText({
        model,
        instructions: JUDGE_INSTRUCTIONS,
        prompt: `<reply>\n${reply}\n</reply>`,
        maxOutputTokens: 300,
        maxRetries: 2,
      });
      const [first = "", ...rest] = text.trim().split("\n");
      const said = first.toLowerCase();
      const verdict = said.startsWith("yes") ? "yes" : said.startsWith("no") ? "no" : "unread";
      return { verdict, words: rest.join(" ").trim() };
    } catch (error) {
      console.error("The judge couldn't read a reply:", error);
      return { verdict: "unread", words: "" };
    }
  };
}

async function runCase(
  core: Core,
  item: ReplyNowCase,
  model: string,
  judge: ReturnType<typeof judgeOf>,
): Promise<Run> {
  const run: Run = {
    id: item.id,
    language: item.language,
    model,
    firstChange: null,
    written: null,
    reply: null,
    free: null,
    checked: null,
    sentences: { written: 0, verdict: 0, notChecked: 0, checking: 0, unmarked: 0 },
    calls: [],
    replyText: "",
    bookkeeping: { verdict: "unread", words: "" },
    load: loadavg()[0] ?? 0,
    error: null,
  };
  const mind = await core.createMind({ title: NOTE_TITLE[item.language] });
  const asked = await connectToMind(core, mind.id);
  writeMind(asked, [note(NOTE_LINE[item.language])]);
  await asked.settled();
  const before = new Set(topIds(asked.blocks));
  let answerId: string | null = null;
  const started = performance.now();
  const since = () => (performance.now() - started) / 1000;
  const changed = new Map<string, number>();
  let wroteAt: number | null = null;
  let ended: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const listening = [
    core.on("mind.update", (event) => {
      if (!changed.has(event.mindId)) changed.set(event.mindId, since());
    }),
    core.on("answer.toolCallFinished", (event) => {
      if (event.answerId !== answerId || !MIND_TOOLS.has(event.call.tool)) return;
      wroteAt = since();
      run.written = wroteAt;
    }),
    core.on("answer.delta", (event) => {
      if (event.answerId !== answerId || wroteAt === null || run.reply !== null) return;
      if (event.text.trim() !== "") run.reply = since();
    }),
    core.on("answer.finished", (event) => {
      if (event.answerId === answerId) ended?.();
    }),
    core.on("answer.failed", (event) => {
      if (event.answerId === answerId) ended?.();
    }),
    // A question to the User has no one to answer it here: the Answer is stopped.
    core.on("question.asked", (request) => {
      if (request.answerId !== answerId || !request.conversationId) return;
      run.error = "asked the User a question";
      void core.stopConversationAnswer({ conversationId: request.conversationId, answerId });
    }),
  ];
  try {
    const result = await core.askInConversation({
      text: item.text,
      mindId: mind.id,
      conversationId: null,
      focus: null,
    });
    if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
    answerId = result.answerId;
    const conversationId = result.conversation.id;
    const inTime = await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ANSWER_LIMIT_MS)),
    ]);
    if (!inTime) {
      await core.stopConversationAnswer({ conversationId, answerId });
      throw new Error(`No Answer within ${ANSWER_LIMIT_MS / 60_000} minutes.`);
    }
    run.free = since();
    const { messages } = await core.getConversation(conversationId);
    const answer = messages.find(
      (message): message is ConversationAnswer => message.id === answerId,
    );
    if (answer?.kind !== "answer") throw new Error("No Answer was kept.");
    run.replyText = answer.text;
    run.calls = answer.toolCalls.map((call) => `${call.tool}:${call.status}`);
    // A failed Answer, or one that wrote nothing, has no write to time: it is no run of this case.
    if (answer.status === "failed")
      throw new Error(
        `The Answer failed: ${answer.errorMessage ?? answer.errorKind ?? "no reason"}`,
      );
    const written = [
      ...new Set(
        answer.toolCalls.flatMap((call) => (call.mindChange ? [call.mindChange.mindId] : [])),
      ),
    ];
    if (written.length === 0) throw new Error("The assistant wrote nothing into a Note.");
    const firsts = written.flatMap((mindId) => changed.get(mindId) ?? []);
    run.firstChange = firsts.length > 0 ? Math.min(...firsts) : null;
    const clients = await Promise.all(
      written.map(async (mindId) => ({
        client: mindId === mind.id ? asked : await connectToMind(core, mindId),
        mindId,
      })),
    );
    const count = () => {
      const total: Sentences = { written: 0, verdict: 0, notChecked: 0, checking: 0, unmarked: 0 };
      for (const { client, mindId } of clients) {
        const ids = new Set(
          topIds(client.blocks).filter((id) => mindId !== mind.id || !before.has(id)),
        );
        const each = sentencesIn(client.blocks, ids);
        for (const key of Object.keys(total) as (keyof Sentences)[]) total[key] += each[key];
      }
      return total;
    };
    const waitFrom = performance.now();
    run.sentences = count();
    while (run.sentences.checking > 0 && performance.now() - waitFrom < CHECK_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      run.sentences = count();
    }
    run.checked = run.sentences.checking === 0 ? since() : null;
    run.bookkeeping = await judge(answer.text);
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  } finally {
    for (const stop of listening) stop();
  }
  return run;
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const shown = (value: number | null) => (value === null ? "–" : value.toFixed(1));

function report(runs: readonly Run[], commit: string, spent: number): string {
  const lines = [
    `# The assistant's write, reply and check (#2830)`,
    "",
    `Commit ${commit}. Spent $${spent.toFixed(2)} on the core's models (the judge's not counted).`,
    "",
    "| Model | Runs | Reply (s, median) | Composer free (s, median) | Checked (s, median) | Sentences checked / written | Not checked | Unmarked | Reports the check |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const model of [...new Set(runs.map((run) => run.model))]) {
    const mine = runs.filter((run) => run.model === model && run.error === null);
    const times = (key: "reply" | "free" | "checked") =>
      median(mine.flatMap((run) => (run[key] === null ? [] : [run[key]])));
    const sum = (key: keyof Sentences) =>
      mine.reduce((total, run) => total + run.sentences[key], 0);
    const told = mine.filter((run) => run.bookkeeping.verdict === "yes").length;
    lines.push(
      `| ${model} | ${mine.length} of ${runs.filter((run) => run.model === model).length} | ${shown(times("reply"))} | ${shown(times("free"))} | ${shown(times("checked"))} | ${sum("verdict")} / ${sum("written")} | ${sum("notChecked")} | ${sum("unmarked")} | ${told} of ${mine.length} |`,
    );
  }
  lines.push(
    "",
    "| Model | Request | First change | Write ends | Reply | Free | Checked | Verdicts / written | Reports the check | Calls | Error |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const run of runs) {
    const told =
      run.bookkeeping.verdict === "yes" ? `yes: ${run.bookkeeping.words}` : run.bookkeeping.verdict;
    lines.push(
      `| ${run.model} | ${run.id} | ${shown(run.firstChange)} | ${shown(run.written)} | ${shown(run.reply)} | ${shown(run.free)} | ${shown(run.checked)} | ${run.sentences.verdict} / ${run.sentences.written} | ${told.replaceAll("|", "/")} | ${run.calls.join(", ")} | ${run.error ?? ""} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

test.skipIf(env("REPLY_NOW") === null)(
  "the assistant's write: when the reply comes, when the composer is free, and what is checked",
  async () => {
    const log = createLog();
    const config = readConfig(ROOT);
    const models = modelsAsked();
    if (models.length === 0) throw new Error("Set INCARNAMIND_EVAL_SPEED_MODELS.");
    const languages = list("LANGUAGES") ?? ["en", "zh-CN"];
    const items = list("ITEMS");
    const cases = (items ? [...REPLY_NOW_CASES, EIGHT_PARAGRAPHS] : REPLY_NOW_CASES).filter(
      (item) => languages.includes(item.language) && (!items || items.includes(item.id)),
    );
    const repeats = Number(env("RUNS") ?? "1");
    const stopUsd = Number(env("STOP_USD") ?? "6");
    if (!Number.isInteger(repeats) || repeats < 1)
      throw new Error("INCARNAMIND_EVAL_SPEED_RUNS is a whole number of runs, 1 or more.");
    if (!Number.isFinite(stopUsd) || stopUsd <= 0)
      throw new Error("INCARNAMIND_EVAL_SPEED_STOP_USD is a number of dollars above 0, like 6.");
    const judge = judgeOf();
    const folder = join(
      ROOT,
      "eval",
      "results",
      `speed-reply-now-${new Date().toISOString().replaceAll(":", "-")}`,
    );
    const commit = commitOf(ROOT, [join(ROOT, "eval", "results")]);
    const runs: Run[] = [];
    const library = await openLibrary({
      name: "speed-reply-now",
      embedder: createWorkerEmbedder(),
      modelCache: join(config.cacheDir, "models"),
      reranker: createWorkerCrossEncoder(config.rerankOnCpu),
      documents: await reports(),
      embeddings: false,
      keep: config.keepData,
      log,
    });
    const { core } = library;
    // Setting the variables is the consent to send the requests and Passages to each model.
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    let spent = 0;
    try {
      matrix: for (const model of models) {
        const name = `${model.kind}/${model.modelId}`;
        await core.saveChatProvider(model);
        for (let repeat = 1; repeat <= repeats; repeat++) {
          for (const item of cases) {
            spent = await spentUsd(core);
            if (spent >= stopUsd) {
              log(`Stopped at $${spent.toFixed(2)}, before ${name} · ${item.id}.`);
              break matrix;
            }
            await core.updateSettings({ user: { language: item.language } });
            log(`${name} · ${item.id} · run ${repeat}`);
            const run = await runCase(core, item, name, judge);
            runs.push(run);
            log(
              `  reply ${shown(run.reply)} s, free ${shown(run.free)} s, checked ${shown(run.checked)} s, ${run.sentences.verdict} of ${run.sentences.written} sentences, reports the check: ${run.bookkeeping.verdict}${run.error ? `, ${run.error}` : ""}`,
            );
            if (run.error?.match(/credit|balance|401|403/i)) break matrix;
          }
        }
      }
    } finally {
      spent = await spentUsd(core);
      await mkdir(folder, { recursive: true });
      await writeFile(
        join(folder, "report.json"),
        JSON.stringify({ commit, spent, runs }, null, 2),
      );
      await writeFile(join(folder, "report.md"), report(runs, commit, spent));
      log(`Wrote ${folder}`);
      await library.close();
    }
  },
);
