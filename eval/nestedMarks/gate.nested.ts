/**
 * The gate in ./README.md, through the app: each case's Answer is scripted (its search, its
 * record and its sentence), in the assistant, on a model listed for the ask; the ask about its
 * marks and the judging of its sentence go to the real model. `npm run eval:nested-marks`.
 *
 *   INCARNAMIND_EVAL_NESTED_KEY     the provider's key: without one, only the offline count runs
 *   INCARNAMIND_EVAL_NESTED_KIND    the provider, `deepseek` (the default) or `anthropic`
 *   INCARNAMIND_EVAL_NESTED_MODEL   the model, `deepseek-flash` by default
 *   INCARNAMIND_EVAL_NESTED_ONLY    case ids, comma-separated: the pilot
 *   INCARNAMIND_EVAL_NESTED_BUDGET  dollars, from the app's meter; it stops before the next case (5)
 *   INCARNAMIND_EVAL_NESTED_SET     `cases` (the default) or `heldout2`
 *   INCARNAMIND_EVAL_NESTED_SAVED   saved Answers, one JSON line each with its `text` and `page`,
 *                                   to count offline, with no model, where the ask would fire
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { test } from "vitest";
import type { Core, CoreEvents } from "../../src/core";
import { SENTENCE_BATCH_INSTRUCTIONS } from "../../src/core/answers/checks/sentenceBatch";
import { EXACT_MARKS_INSTRUCTIONS, exactMarks } from "../../src/core/answers/exactMarks";
import { markedSentence } from "../../src/core/answers/markerPlacement";
import { quotationsIn } from "../../src/core/answers/quotedWords";
import { CNY_PER_USD } from "../../src/core/providers/catalog/billing";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { findQuote } from "../../src/shared/quoteMatch";
import { shownPassages } from "../../tests/helpers/citations";
import { createTempDataFolder, startCore } from "../../tests/helpers/core";
import { addAndProcess, writeSourceFile } from "../../tests/helpers/documents";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../../tests/helpers/models";

interface Case {
  id: string;
  lang: "en" | "zh";
  kind: "nested" | "mismatch" | "plain";
  family: string;
  document: { name: string; text: string };
  record: string;
  sentence: string;
  claimTrue: boolean;
}

const HERE = join(__dirname);
const KEY = process.env.INCARNAMIND_EVAL_NESTED_KEY;
const KIND =
  process.env.INCARNAMIND_EVAL_NESTED_KIND?.trim() === "anthropic" ? "anthropic" : "deepseek";
const MODEL =
  process.env.INCARNAMIND_EVAL_NESTED_MODEL?.trim() ||
  (KIND === "anthropic" ? "claude-haiku-5-5" : "deepseek-flash");
const ONLY = process.env.INCARNAMIND_EVAL_NESTED_ONLY?.trim()
  ? process.env.INCARNAMIND_EVAL_NESTED_ONLY.split(",").map((each) => each.trim())
  : null;
const BUDGET = Number(process.env.INCARNAMIND_EVAL_NESTED_BUDGET ?? "5") || 5;
const SAVED = process.env.INCARNAMIND_EVAL_NESTED_SAVED;
/** Which frozen set: `cases` (the first, a development set since its blind judgment) or `heldout2`. */
const SET = process.env.INCARNAMIND_EVAL_NESTED_SET?.trim() || "cases";

const QUESTION = { en: "What does my Document say?", zh: "我的文档里写了什么？" };

/** The Answer's own turns, scripted: it searches for its record's quote, cites it, then writes its sentence. */
function answerTurn(call: ModelCall, each: Case): ScriptedReply {
  const searches = call.results.filter((result) => result.tool === "search_documents");
  if (searches.length === 0) {
    return { calls: [{ tool: "search_documents", input: { query: each.record } }] };
  }
  if (!call.results.some((result) => result.tool === "cite")) {
    const passage = searches
      .flatMap((search) => shownPassages(search.text))
      .find((shown) => findQuote(shown.text, each.record));
    const citations = passage ? [{ marker: 1, passage: passage.id, quote: each.record }] : [];
    return { calls: [{ tool: "cite", input: { citations } }] };
  }
  return { text: each.sentence };
}

/** A model whose Answer is scripted, and whose ask about its marks and judging are the real model's. */
function routed(real: LanguageModelV4, each: Case, judged: string[]): LanguageModelV4 {
  const scripted = scriptedModel((call) => answerTurn(call, each));
  const toReal = (prompt: Parameters<LanguageModelV4["doGenerate"]>[0]["prompt"]) =>
    prompt.some(
      (message) =>
        message.role === "system" &&
        (message.content === EXACT_MARKS_INSTRUCTIONS ||
          message.content === SENTENCE_BATCH_INSTRUCTIONS),
    );
  return {
    specificationVersion: real.specificationVersion,
    provider: real.provider,
    modelId: real.modelId,
    supportedUrls: real.supportedUrls,
    doGenerate: async (options) => {
      if (!toReal(options.prompt)) return scripted.doGenerate(options);
      const result = await real.doGenerate(options);
      const text = result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      judged.push(text);
      return result;
    },
    doStream: (options) => (toReal(options.prompt) ? real : scripted).doStream(options),
  };
}

/** What the app's meter says was spent, in dollars: DeepSeek is priced in yuan, at the app's own fixed rate. */
const spentOf = async (core: Core) =>
  (await core.getCostSummary()).spent.reduce(
    (total, each) =>
      total +
      (each.currency === "USD"
        ? each.amount
        : each.currency === "CNY"
          ? each.amount / CNY_PER_USD
          : 0),
    0,
  );

interface Row {
  id: string;
  lang: string;
  kind: string;
  family: string;
  claimTrue: boolean;
  check: string;
  checkReason: string | null;
  verdict: string | null;
  quoteMarksChanged: boolean;
  /** The judge's replies, raw: a \"supported\" one that ends Not checked is counted. */
  judged: string[];
  ask: CoreEvents["answer.finished"]["exactMarks"];
  oldSentence: string;
  newText: string;
  page: string;
  seconds: number;
  dollars: number;
}

async function runCase(each: Case): Promise<Row> {
  /** The judge's replies to this case's sentence, as the model gave them. */
  const judged: string[] = [];
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: (spec) => routed(createAiSdkChatModel(spec) as LanguageModelV4, each, judged),
    answerPaths: { asksForExactMarks: () => true },
  });
  // Setting the key is the consent to send the case's sentence and page to the model.
  core.on("consent.requested", (request) => {
    void core.respondToConsent(request.requestId, true);
  });
  const provider = await core.saveChatProvider({ kind: KIND, apiKey: KEY, modelId: MODEL });
  await addAndProcess(core, [
    await writeSourceFile(sources, each.document.name, each.document.text),
  ]);
  let finished: CoreEvents["answer.finished"] | null = null;
  core.on("answer.finished", (event) => {
    finished = event;
  });
  const before = await spentOf(core);
  const started = Date.now();
  const asked = await core.askInConversation({
    text: QUESTION[each.lang],
    model: { providerId: provider.id, modelId: MODEL },
  });
  if (!asked.asked) throw new Error(`${each.id}: not asked: ${JSON.stringify(asked)}`);
  const answer = await new Promise<
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
      reject(new Error(`${each.id}: the Answer didn't end in 5 minutes.`));
    }, 5 * 60_000);
  });
  const citation = answer.citations.find((each) => each.marker === 1);
  const ended = finished as CoreEvents["answer.finished"] | null;
  const row: Row = {
    id: each.id,
    lang: each.lang,
    kind: each.kind,
    family: each.family,
    claimTrue: each.claimTrue,
    check: citation?.check ?? "none",
    checkReason: citation?.checkReason ?? null,
    verdict: citation?.verdict ?? null,
    quoteMarksChanged: citation?.quoteMarksChanged === true,
    judged,
    ask: ended?.exactMarks ?? null,
    oldSentence: each.sentence,
    newText: answer.text,
    page: each.document.text,
    seconds: (Date.now() - started) / 1000,
    dollars: (await spentOf(core)) - before,
  };
  await core.close();
  return row;
}

const p95 = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : (sorted[Math.ceil(sorted.length * 0.95) - 1] as number);
};
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)] as number);
};

function summary(rows: readonly Row[]) {
  return (["en", "zh"] as const).map((lang) => {
    const of = rows.filter((row) => row.lang === lang);
    const sum = (key: keyof NonNullable<Row["ask"]>) =>
      of.reduce((total, row) => total + ((row.ask?.[key] as number | undefined) ?? 0), 0);
    const fired = of.filter((row) => (row.ask?.asked ?? 0) > 0);
    const waits = fired.map((row) => (row.ask?.durationMs ?? 0) / 1000);
    return {
      lang,
      answers: of.length,
      unfound: sum("unfound"),
      secondReadings: sum("secondReadings"),
      otherMarks: sum("otherMarks"),
      asksFired: fired.length,
      asked: sum("asked"),
      accepted: sum("accepted"),
      declined: sum("declined"),
      failed: sum("failed"),
      rejected: sum("rejected"),
      invalidated: sum("invalidated"),
      recoveredNested: of.filter((row) => row.kind === "nested" && row.quoteMarksChanged).length,
      nested: of.filter((row) => row.kind === "nested").length,
      falseSupported: of.filter((row) => !row.claimTrue && row.check === "found").length,
      firedOnPlain: of.filter((row) => row.kind === "plain" && (row.ask?.asked ?? 0) > 0).length,
      supportedButNotChecked: of
        .filter(
          (row) =>
            row.check === "not-checked" &&
            row.judged.some((reply) => /"verdict"\s*:\s*"supported"/u.test(reply)),
        )
        .map((row) => row.id),
      waitMedian: median(waits),
      waitP95: p95(waits),
      dollars: of.reduce((total, row) => total + row.dollars, 0),
    };
  });
}

/** The accepted splices, shuffled, with nothing that says which case, model or outcome. */
function blindFile(rows: readonly Row[]) {
  const items = rows
    .filter((row) => row.quoteMarksChanged)
    .map((row) => ({
      id: Math.random().toString(36).slice(2, 10),
      lang: row.lang,
      old: markedSentence(row.oldSentence, 1) ?? row.oldSentence,
      new: markedSentence(row.newText, 1) ?? row.newText,
      page: row.page.replace(/^# .*\n+/u, "").trim(),
    }));
  for (let at = items.length - 1; at > 0; at--) {
    const other = Math.floor(Math.random() * (at + 1));
    [items[at], items[other]] = [
      items[other] as (typeof items)[number],
      items[at] as (typeof items)[number],
    ];
  }
  return items;
}

test("Nested quotation marks, asked once: the gate", { timeout: 4 * 60 * 60_000 }, async () => {
  if (!KEY) {
    console.log("No INCARNAMIND_EVAL_NESTED_KEY: the gate's run is skipped.");
    return;
  }
  const cases = JSON.parse(await readFile(join(HERE, `${SET}.json`), "utf8")) as Case[];
  const wanted = ONLY ? cases.filter((each) => ONLY.includes(each.id)) : cases;
  const rows: Row[] = [];
  let spent = 0;
  for (const each of wanted) {
    if (spent >= BUDGET) {
      console.log(`Stopped: $${spent.toFixed(4)} spent, the budget's reached.`);
      break;
    }
    const row = await runCase(each);
    spent += row.dollars;
    rows.push(row);
    const flag =
      !row.claimTrue && row.check === "found"
        ? " FALSE SUPPORTED"
        : row.kind === "plain" && (row.ask?.asked ?? 0) > 0
          ? " FIRED ON PLAIN"
          : "";
    console.log(
      `${row.id}: ${row.check}${row.quoteMarksChanged ? ", marks changed" : ""}; ask ${JSON.stringify(row.ask)}; $${row.dollars.toFixed(4)}${flag}`,
    );
  }
  const out = join(
    HERE,
    "..",
    "results",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-nested-marks-${SET}-${MODEL}`,
  );
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "report.json"),
    `${JSON.stringify({ model: MODEL, spent, summary: summary(rows), rows }, null, 1)}\n`,
  );
  await writeFile(join(out, "blind.json"), `${JSON.stringify(blindFile(rows), null, 1)}\n`);
  console.log(JSON.stringify(summary(rows), null, 1));
  console.log(`Spent $${spent.toFixed(4)}. Report and blind file in ${out}`);
});

test("Where the ask would fire on saved Answers, counted offline", async () => {
  if (!SAVED) return;
  const lines = (await readFile(SAVED, "utf8")).trim().split("\n");
  let answers = 0;
  let fired = 0;
  const firedOn: string[] = [];
  for (const line of lines) {
    const { text, page } = JSON.parse(line) as { text: string; page: string };
    answers++;
    const result = await exactMarks({
      // Nothing is sent: the offline count only asks whether a request would be made.
      model: scriptedModel(() => ({ text: '{"quotes": []}' })),
      markdown: text,
      quotations: quotationsIn(text),
      unfound: (words) =>
        findQuote(page, words)
          ? null
          : [
              {
                marker: 1,
                units: [{ page: 1, text: page }],
                matching: {},
                quoteAt: null,
                version: "",
              },
            ],
      current: () => text,
      version: () => "",
      pages: () => ({ units: [{ page: 1, text: page }], matching: {} }),
      holds: () => true,
      changed: () => {},
      signal: new AbortController().signal,
    });
    if ((result?.ask.asked ?? 0) > 0) {
      fired++;
      firedOn.push(text.slice(0, 120));
    }
  }
  console.log(`Saved Answers: ${answers}; the ask would fire on ${fired}.`);
  for (const each of firedOn) console.log(`  fired: ${each}`);
});
