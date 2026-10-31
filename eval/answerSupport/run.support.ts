/**
 * `npm run eval:support` (README.md): each sentence an Answer might write, checked against the
 * quote it cites (#2311), on a real chat model: one at a time as Check this Note checks it, or in
 * batches as an Answer judges its own. The cases
 * (./cases) are the walk's two fixtures, held-out sentences of the same mistakes and controls;
 * the supported set is Find support's supported sentences that state a date or year
 * (eval/checks/labels.json), each citing its labelled quote.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { test } from "vitest";
import type {
  ChatModelFactory,
  CitedQuote,
  ClaimCheckResult,
  Core,
  Document,
} from "../../src/core";
import { SENTENCE_BATCH_INSTRUCTIONS } from "../../src/core/answers/checks/sentenceBatch";
import { findQuote } from "../../src/shared/quoteMatch";
import { shownPassages } from "../../tests/helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../../tests/helpers/models";
import { readChecksSet } from "../checks/lib/set";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog, type Log } from "../lib/log";
import { type RequestWatch, watchRequests } from "../repeats/requests";
import { CASES, DOCUMENTS } from "./cases";

const ROOT = resolve(__dirname, "../..");
const DATED =
  /(?:19|20)\d\d|年|月|January|February|March|April|May|June|July|August|September|October|November|December/;

interface Row {
  id: string;
  set: string;
  language: string;
  sentence: string;
  /** Whether its quote supports it. */
  supported: boolean;
  verdict: ClaimCheckResult["verdict"];
  /** What the check said, for reading the misses. */
  said: string | null;
  /** Each part the check named, with its words and its result. */
  parts: { kind: string; words: string; verdict: string | null; said: string | null }[];
  seconds: number;
  dollars: number;
  /** The model requests the check made, and their tokens, as the provider reported them. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

const spentOf = async (core: Core) =>
  (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((total, each) => total + each.amount, 0);

/** The Passage of `document` that holds `quote`, as an Answer's Citation names it. */
async function citedQuote(
  core: Core,
  documents: Iterable<Document>,
  name: string,
  quote: string,
): Promise<CitedQuote> {
  const document = [...documents].find((each) => each.name === name);
  if (!document) throw new Error(`${name} wasn't added.`);
  const found = (await core.searchPassages(quote)).filter(
    (each) => each.documentId === document.id,
  );
  // Found as the Citation check finds a quote: a sheet's cells and a PDF's line breaks don't count.
  const passage = found.find((each) => findQuote(each.text, quote, { numbers: "if-needed" }));
  if (!passage) throw new Error(`No Passage of ${name} holds “${quote}”.`);
  return {
    documentName: document.name,
    documentId: document.id,
    contentHash: document.contentHash,
    passageId: passage.passageId,
    quote,
  };
}

async function checkEach(
  core: Core,
  items: readonly {
    id: string;
    set: string;
    language: string;
    sentence: string;
    supported: boolean;
    cited: () => Promise<CitedQuote>;
  }[],
  /** Null: a dry run, which finds each cited Passage and checks nothing. */
  model: { providerId: string; modelId: string } | null,
  spend: { total: number; cap: number },
  log: Log,
  skipped: { id: string; why: string }[],
  watch: RequestWatch,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const item of items) {
    let cited: CitedQuote;
    try {
      cited = await item.cited();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      skipped.push({ id: item.id, why });
      log(`  ${item.id}: ${why}`);
      continue;
    }
    if (!model) continue;
    if (spend.total >= spend.cap) {
      log(`Stopped before ${item.id}: $${spend.total.toFixed(4)} spent, the budget's reached.`);
      break;
    }
    const before = await spentOf(core);
    const started = Date.now();
    let result: ClaimCheckResult;
    try {
      watch.take();
      result = await core.checkClaim({ claim: item.sentence, cited: [cited], model });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      skipped.push({ id: item.id, why });
      log(`  ${item.id}: ${why}`);
      continue;
    }
    const said =
      result.verdict === "unsupported"
        ? (result.unsupported?.reason ?? null)
        : result.verdict === "not-checked"
          ? `${result.reason}${result.detail ? `: ${result.detail}` : ""}`
          : result.says;
    const row: Row = {
      id: item.id,
      set: item.set,
      language: item.language,
      sentence: item.sentence,
      supported: item.supported,
      verdict: result.verdict,
      said,
      parts: (result.parts ?? []).map((part) => ({
        kind: part.kind,
        words: item.sentence.slice(part.span.start, part.span.end),
        verdict: part.verdict,
        said: part.says ?? part.unsupported?.reason ?? null,
      })),
      seconds: (Date.now() - started) / 1000,
      dollars: (await spentOf(core)) - before,
      ...(() => {
        const requests = [...watch.take().values()].flat();
        return {
          requests: requests.length,
          inputTokens: requests.reduce((total, each) => total + each.inputTokens, 0),
          outputTokens: requests.reduce((total, each) => total + each.outputTokens, 0),
        };
      })(),
    };
    rows.push(row);
    spend.total += row.dollars;
    log(
      `  ${row.id}: ${row.verdict}${row.supported === (row.verdict === "supported") ? "" : " ✗"}`,
    );
  }
  return rows;
}

/** The sentences the next Answer writes, each with the quote it cites. */
interface AnswerScript {
  sentences: { sentence: string; quote: string }[];
}

/** The most sentences one Answer of the eval writes: a long Answer's, two batches. */
const SENTENCES_PER_ANSWER = 16;

/** A sentence with its Citation marker before its closing stop. */
const marked = (sentence: string, marker: number) =>
  /[.。!?！？]$/u.test(sentence)
    ? `${sentence.slice(0, -1)}[^${marker}]${sentence.slice(-1)}`
    : `${sentence}[^${marker}]`;

/** The Answer's own turns, scripted: it searches for each quote, cites it, then writes the sentences. */
function answerTurn(call: ModelCall, script: AnswerScript): ScriptedReply {
  const searches = call.results.filter((result) => result.tool === "search_documents");
  if (searches.length === 0) {
    return {
      calls: [...new Set(script.sentences.map((each) => each.quote))].map((quote) => ({
        tool: "search_documents",
        input: { query: quote },
      })),
    };
  }
  if (!call.results.some((result) => result.tool === "cite")) {
    const passages = searches.flatMap((search) => shownPassages(search.text));
    const citations = script.sentences.flatMap(({ quote }, index) => {
      const passage = passages.find((each) =>
        findQuote(each.text, quote, { numbers: "if-needed" }),
      );
      return passage ? [{ marker: index + 1, passage: passage.id, quote }] : [];
    });
    return { calls: [{ tool: "cite", input: { citations } }] };
  }
  return {
    text: script.sentences.map(({ sentence }, index) => marked(sentence, index + 1)).join(" "),
  };
}

/**
 * A model whose Answers are scripted and whose judgement of their sentences is the real model's
 * (#2311): what is measured is the app's own judgement, batches, limit and meter included.
 */
function judgingModel(real: LanguageModelV4, script: AnswerScript): LanguageModelV4 {
  const scripted = scriptedModel((call) => answerTurn(call, script));
  const judges = (prompt: Parameters<LanguageModelV4["doGenerate"]>[0]["prompt"]) =>
    prompt.some(
      (message) => message.role === "system" && message.content === SENTENCE_BATCH_INSTRUCTIONS,
    );
  return {
    specificationVersion: real.specificationVersion,
    provider: real.provider,
    modelId: real.modelId,
    supportedUrls: real.supportedUrls,
    doGenerate: (options) => (judges(options.prompt) ? real : scripted).doGenerate(options),
    doStream: (options) => scripted.doStream(options),
  };
}

/** Each batch request of the judgement: its tokens, as the provider reported them. */
function watchBatches() {
  const batches: { inputTokens: number; outputTokens: number }[] = [];
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      if (
        params.prompt.some(
          (message) => message.role === "system" && message.content === SENTENCE_BATCH_INSTRUCTIONS,
        )
      ) {
        batches.push({
          inputTokens: result.usage.inputTokens.total ?? 0,
          outputTokens: result.usage.outputTokens.total ?? 0,
        });
      }
      return result;
    },
  };
  return {
    batches,
    chatModels:
      (inner: ChatModelFactory): ChatModelFactory =>
      (spec) =>
        wrapLanguageModel({ model: inner(spec), middleware }),
  };
}

const VERDICT_OF = {
  found: "supported",
  unsupported: "unsupported",
  contradicted: "contradicted",
} as const;

/**
 * The sentences judged as an Answer judges its own (#2311): a few Answers of up to 16 sentences,
 * each citing its quote, grouped by the Document they cite; each sentence's row is its Citation's
 * result. A sentence its Answer couldn't cite is skipped.
 */
async function judgeInAnswers(
  core: Core,
  items: Parameters<typeof checkEach>[1],
  model: { providerId: string; modelId: string },
  spend: { total: number; cap: number },
  log: Log,
  skipped: { id: string; why: string }[],
  script: AnswerScript,
  batches: { inputTokens: number; outputTokens: number }[],
): Promise<Row[]> {
  const cited: { item: (typeof items)[number]; quote: CitedQuote }[] = [];
  for (const item of items) {
    try {
      cited.push({ item, quote: await item.cited() });
    } catch (error) {
      skipped.push({ id: item.id, why: error instanceof Error ? error.message : String(error) });
    }
  }
  const byDocument = new Map<string, typeof cited>();
  for (const each of cited) {
    const key = each.quote.documentId ?? each.quote.documentName;
    byDocument.set(key, [...(byDocument.get(key) ?? []), each]);
  }
  const answers = [...byDocument.values()].flatMap((group) =>
    Array.from({ length: Math.ceil(group.length / SENTENCES_PER_ANSWER) }, (_, index) =>
      group.slice(index * SENTENCES_PER_ANSWER, (index + 1) * SENTENCES_PER_ANSWER),
    ),
  );
  const rows: Row[] = [];
  for (const answer of answers) {
    if (spend.total >= spend.cap) {
      log(`Stopped: $${spend.total.toFixed(4)} spent, the budget's reached.`);
      break;
    }
    script.sentences = answer.map(({ item, quote }) => ({
      sentence: item.sentence,
      quote: quote.quote,
    }));
    const before = await spentOf(core);
    const requestsBefore = batches.length;
    const started = Date.now();
    const asked = await core.askInConversation({ text: "What do my Documents say?", model });
    if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
    const judged = await new Promise<
      Extract<Awaited<ReturnType<Core["getConversation"]>>["messages"][number], { kind: "answer" }>
    >((resolve, reject) => {
      const poll = setInterval(async () => {
        const { messages } = await core.getConversation(asked.conversation.id);
        const found = messages.find((message) => message.id === asked.answerId);
        if (found?.kind !== "answer" || found.status === "streaming") return;
        if (found.citations.some((citation) => citation.check === "checking")) return;
        clearInterval(poll);
        resolve(found);
      }, 200);
      setTimeout(() => {
        clearInterval(poll);
        reject(new Error("The judgement didn't end in 10 minutes."));
      }, 10 * 60_000);
    });
    const dollars = (await spentOf(core)) - before;
    spend.total += dollars;
    const used = batches.slice(requestsBefore);
    const share = (total: number) => total / answer.length;
    answer.forEach(({ item }, index) => {
      const citation = judged.citations.find((each) => each.marker === index + 1);
      if (!citation) {
        skipped.push({ id: item.id, why: "Its Answer couldn't cite its quote." });
        return;
      }
      const verdict =
        citation.check in VERDICT_OF
          ? VERDICT_OF[citation.check as keyof typeof VERDICT_OF]
          : "not-checked";
      rows.push({
        id: item.id,
        set: item.set,
        language: item.language,
        sentence: item.sentence,
        supported: item.supported,
        verdict,
        said: citation.verdict ?? citation.checkReason ?? null,
        parts: [],
        seconds: (Date.now() - started) / 1000 / answer.length,
        dollars: share(dollars),
        requests: share(used.length),
        inputTokens: share(used.reduce((total, each) => total + each.inputTokens, 0)),
        outputTokens: share(used.reduce((total, each) => total + each.outputTokens, 0)),
      });
      log(`  ${item.id}: ${verdict}${item.supported === (verdict === "supported") ? "" : " ✗"}`);
    });
  }
  return rows;
}

function summary(rows: readonly Row[]): string[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.set} · ${row.language}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([key, each]) => {
    const wrongGreen = each.filter((row) => !row.supported && row.verdict === "supported").length;
    const falseMarks = each.filter(
      (row) => row.supported && (row.verdict === "unsupported" || row.verdict === "contradicted"),
    ).length;
    const notChecked = each.filter((row) => row.verdict === "not-checked").length;
    const unsupported = each.filter((row) => !row.supported).length;
    return `${key}: ${each.length} sentences; ${unsupported - wrongGreen} of ${unsupported} unsupported ones refused; ${falseMarks} supported ones marked; ${notChecked} not checked`;
  });
}

test("Answer sentences against the quotes they cite", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const chat = config.chat;
  const dry = process.env.INCARNAMIND_EVAL_SUPPORT_DRY === "1";
  if (!chat && !dry) {
    log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY (eval/README.md).");
    return;
  }
  const arm = process.env.INCARNAMIND_EVAL_SUPPORT_ARM?.trim() || "after";
  const sets = (process.env.INCARNAMIND_EVAL_SUPPORT_SETS?.trim() || "cases,supported").split(",");
  const only = process.env.INCARNAMIND_EVAL_SUPPORT_ONLY?.trim() || null;
  // A model's verdict on one sentence varies from request to request: each is checked this often.
  const repeats = Number(process.env.INCARNAMIND_EVAL_SUPPORT_REPEATS ?? "1") || 1;
  // "answer": judged as an Answer judges its own sentences, in batches (#2311); else as Check this Note checks one.
  const judge =
    process.env.INCARNAMIND_EVAL_SUPPORT_JUDGE?.trim() === "answer" ? "answer" : "check";
  const spend = { total: 0, cap: Number(process.env.INCARNAMIND_EVAL_SUPPORT_BUDGET ?? "1") || 1 };
  const rows: Row[] = [];
  const skipped: { id: string; why: string }[] = [];

  const run = async (
    name: string,
    documents: { key: string; path: string }[],
    webPages: { key: string; address: string; html: string }[],
    items: (documents: Iterable<Document>, core: Core) => Parameters<typeof checkEach>[1],
  ) => {
    const watch = watchRequests([]);
    const script: AnswerScript = { sentences: [] };
    const batchWatch = watchBatches();
    const library = await openLibrary({
      chatModels:
        judge === "answer"
          ? (inner) =>
              batchWatch.chatModels((spec) => judgingModel(inner(spec) as LanguageModelV4, script))
          : watch.chatModels,
      name: `support-${name}`,
      embedder: createWorkerEmbedder(),
      documents,
      webPages,
      keep: config.keepData,
      embeddings: false,
      log,
    });
    try {
      const { core } = library;
      // Setting the variables is the consent to send the sentences and Passages to the model.
      core.on("consent.requested", (request) => {
        void core.respondToConsent(
          request.requestId,
          request.flow.id === "checks" || (judge === "answer" && request.flow.id === "chat"),
        );
      });
      const provider = chat && !dry ? await core.saveChatProvider(chatProviderOf(chat)) : null;
      const model = chat && provider ? { providerId: provider.id, modelId: chat.modelId } : null;
      const wanted = items(library.documents.values(), core)
        .filter((each) => !only || only.split(",").includes(each.id))
        .flatMap((each) => Array.from({ length: repeats }, () => each));
      log(`${model?.modelId ?? "dry"} · ${arm} · ${name}: ${wanted.length} sentences`);
      rows.push(
        ...(judge === "answer" && model
          ? await judgeInAnswers(
              core,
              wanted,
              model,
              spend,
              log,
              skipped,
              script,
              batchWatch.batches,
            )
          : await checkEach(core, wanted, model, spend, log, skipped, watch)),
      );
    } finally {
      await library.close();
    }
  };

  if (sets.includes("cases")) {
    const folder = await mkdtemp(join(tmpdir(), "incarnamind-support-"));
    try {
      const documents = await Promise.all(
        DOCUMENTS.map(async ({ name, contents }) => {
          const path = join(folder, name);
          await writeFile(path, contents);
          return { key: name, path };
        }),
      );
      await run("cases", documents, [], (added, core) => {
        const all = [...added];
        return CASES.map((each) => ({
          ...each,
          cited: () => citedQuote(core, all, each.document, each.quote),
        }));
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  if (sets.includes("supported")) {
    const set = await readChecksSet(ROOT);
    const files = set.folder.filter((document) => !document.address);
    const webPages = await Promise.all(
      set.folder.flatMap(({ name, path, address }) =>
        address
          ? [readFile(join(ROOT, path), "utf8").then((html) => ({ key: name, address, html }))]
          : [],
      ),
    );
    await run(
      "supported",
      files.map((document) => ({ key: document.name, path: join(ROOT, document.path) })),
      webPages,
      (added, core) => {
        const all = [...added];
        const shownName = (labelled: string) =>
          all.find((each) => each.name === labelled || labelled.startsWith(`${each.name}.`))
            ?.name ?? labelled;
        return set.items.flatMap((item) =>
          item.set === "find-support" &&
          item.label === "supported" &&
          item.evidence &&
          DATED.test(item.sentence)
            ? [
                {
                  id: item.id,
                  set: "supported",
                  language: item.language === "zh" ? "zh-CN" : "en",
                  sentence: item.sentence,
                  supported: true,
                  cited: () => {
                    const evidence = item.evidence;
                    if (!evidence) throw new Error(`${item.id} has no evidence.`);
                    return citedQuote(core, all, shownName(evidence.document), evidence.quote);
                  },
                },
              ]
            : [],
        );
      },
    );
  }

  const out = join(
    config.resultsDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-support-${chat?.modelId ?? "dry"}-${arm}${judge === "answer" ? "-answer" : ""}`,
  );
  await mkdir(out, { recursive: true });
  const lines = summary(rows);
  await writeFile(
    join(out, "report.json"),
    JSON.stringify(
      {
        commit: commitOf(ROOT),
        model: chat?.modelId ?? null,
        arm,
        judge,
        spent: spend.total,
        lines,
        rows,
        skipped,
      },
      null,
      2,
    ),
  );
  for (const line of lines) log(line);
  log(`$${spend.total.toFixed(4)} spent; report in ${out}`);
});
