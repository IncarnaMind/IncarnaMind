/**
 * `npm run eval:everyday` (README.md): asks every everyday request
 * (./cases) of a real chat model through the core's public interface, as
 * the assistant does, and holds each Answer to the guards in ./checks. It
 * writes a report and fails when a request fails one.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { AnswerUsage } from "../../src/core";
import { catalogFacts, modelsProviderOfKind } from "../../src/core/providers/catalog";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { markersIn } from "../../src/shared/answerBlocks";
import { evalOllamaModels } from "../lib/citations";
import { type ChatSettings, chatModelSpecOf, chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import type { EvalDocument } from "../lib/evaluationSet";
import { openLibrary } from "../lib/library";
import { createLog, type Log } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { tokenLine, watchTokens } from "../lib/tokens";
import { type CaseResult, fetchPapers, fetchReserves, judgeOf, reports, runCase } from "./asking";
import { CASES, type EverydayCase, floorOf, type LibraryName } from "./cases";
import { writeCedarDocuments } from "./cedar";
import { failureLine, pointsBack, type RequestFailure } from "./checks";
import { writeDatedDocuments } from "./dated";
import { type DecisionProvider, decide, forcing } from "./decisions";
import { writeFilingDocuments } from "./filings";
import { languageRates, type RequestRun, rowRates } from "./rates";
import { watchReasks } from "./reasks";
import { SUPPORTED_TARGET, supportedShare, supportRates } from "./support";

const ROOT = resolve(__dirname, "../..");

/** Every request the Answers and the judge make, for the report's count of their tokens. */
const answerTokens = watchTokens();
const judgeTokens = watchTokens();

/** Arm C (./decisions): INCARNAMIND_EVAL_EVERYDAY_DECIDE names the decision provider, and INCARNAMIND_EVAL_DECIDE_KEY is its key. */
function decidingOf(): { provider: DecisionProvider; key: string } | null {
  const provider = process.env.INCARNAMIND_EVAL_EVERYDAY_DECIDE?.trim();
  if (!provider) return null;
  if (provider !== "openai" && provider !== "jev") {
    throw new Error(`INCARNAMIND_EVAL_EVERYDAY_DECIDE must be openai or jev, not "${provider}".`);
  }
  const key = process.env.INCARNAMIND_EVAL_DECIDE_KEY?.trim();
  if (!key) throw new Error("Set INCARNAMIND_EVAL_DECIDE_KEY to the decision provider's key.");
  return { provider, key };
}

async function runModel(
  chat: ChatSettings,
  judging: ChatSettings,
  cases: readonly EverydayCase[],
  runs: number,
  log: Log,
) {
  const decider = decidingOf();
  const config = readConfig(ROOT);
  const datedFolder = await mkdtemp(join(tmpdir(), "incarnamind-everyday-dated-"));
  const filingFolder = await mkdtemp(join(tmpdir(), "incarnamind-everyday-filings-"));
  const needed = new Set(cases.map((each) => each.library));
  const sets: Record<LibraryName, EvalDocument[]> = {
    papers: needed.has("papers") ? await fetchPapers(config.cacheDir, log) : [],
    reports: needed.has("reports") ? await reports() : [],
    dated: needed.has("dated") ? await writeDatedDocuments(datedFolder) : [],
    reserves: needed.has("reserves") ? await fetchReserves(config.cacheDir, log) : [],
    filings: needed.has("filings") ? await writeFilingDocuments(filingFolder) : [],
    cedar: needed.has("cedar") ? await writeCedarDocuments(datedFolder, "en") : [],
    "cedar-zh": needed.has("cedar-zh") ? await writeCedarDocuments(datedFolder, "zh-CN") : [],
  };
  const calculates =
    catalogFacts(modelsProviderOfKind(chat.kind, chat.endpoint), chat.modelId)?.calculates === true;
  const ollamaModels = evalOllamaModels(chat);
  const judge = judgeTokens.wrap(
    createAiSdkChatModel({ ...chatModelSpecOf(judging), thinking: "off" }),
  );
  const model = `${chat.kind}/${chat.modelId}${decider ? ` + ${decider.provider} decisions` : ""}`;
  const results: CaseResult[] = [];
  for (const name of [
    "papers",
    "reports",
    "dated",
    "reserves",
    "filings",
    "cedar",
    "cedar-zh",
  ] as const) {
    const wanted = cases.filter((each) => each.library === name);
    if (wanted.length === 0) continue;
    const watch = watchReasks();
    const forced = forcing();
    const deciding = decider && {
      decide: (text: string) => decide(decider.provider, decider.key, text),
      forcing: forced,
    };
    const library = await openLibrary({
      name: `everyday-${name}`,
      chatModels: decider
        ? (inner) => forced.chatModels(watch.chatModels(answerTokens.chatModels(inner)))
        : (inner) => watch.chatModels(answerTokens.chatModels(inner)),
      embedder: createWorkerEmbedder(),
      modelCache: join(config.cacheDir, "models"),
      reranker: createWorkerCrossEncoder(config.rerankOnCpu),
      documents: sets[name],
      examples: join(ROOT, "resources", "examples"),
      keep: config.keepData,
      embeddings: false,
      ...(ollamaModels && { ollamaModels }),
      log,
    });
    try {
      const { core } = library;
      // Setting the variables is the consent to send the requests and Passages to the model.
      core.on("consent.requested", (request) => {
        void core.respondToConsent(
          request.requestId,
          request.flow.id === "chat" || request.flow.id === "checks",
        );
      });
      await core.saveChatProvider(chatProviderOf(chat));
      const scoped = [...library.documents.values()].map((document) => ({
        id: document.id,
        name: document.name,
      }));
      for (const each of wanted.flatMap((each) => Array.from({ length: runs }, () => each))) {
        log(`${model} · ${each.id}: ${each.request}`);
        let result: CaseResult;
        try {
          result = await runCase(library, scoped, judge, model, each, {
            watch,
            calculates,
            ...(deciding && { deciding }),
          });
        } catch (error) {
          result = {
            id: each.id,
            language: each.language,
            request: each.request,
            model,
            failures: [],
            reply: "",
            page: "",
            removed: [],
            rewritten: [],
            copies: 0,
            pointersLeft: 0,
            calls: [],
            changes: [],
            seconds: 0,
            answeredSeconds: 0,
            error: error instanceof Error ? error.message : String(error),
            usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
            droppedMarkers: 0,
            asks: { again: 0, citations: 0 },
            support: null,
            claims: null,
          };
        }
        if (result.decision) {
          log(
            `  decided ${result.decision.choice} at ${result.decision.confidence.toFixed(2)}, ${result.decision.forced} requests forced`,
          );
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
  await rm(datedFolder, { recursive: true, force: true });
  await rm(filingFolder, { recursive: true, force: true });
  return results;
}

const passedRun = (result: CaseResult) => !result.error && result.failures.length === 0;

function asksByGroup(results: readonly CaseResult[]) {
  const groups = new Map<
    string,
    {
      model: string;
      language: string;
      answers: number;
      again: number;
      citations: number;
      unseen: number;
    }
  >();
  for (const each of results) {
    const key = `${each.model} ${each.language}`;
    const group = groups.get(key) ?? {
      model: each.model,
      language: each.language,
      answers: 0,
      again: 0,
      citations: 0,
      unseen: 0,
    };
    group.answers++;
    if (each.asks.again > 0) group.again++;
    if (each.asks.citations > 0) group.citations++;
    if (each.failures.some((failure) => failure.kind === "unseen-attempt")) group.unseen++;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function report(
  results: readonly CaseResult[],
  rows: ReturnType<typeof rowRates>,
  judge: string,
  tokens: { answers: string; judge: string },
): string {
  const runs: RequestRun[] = results.map((each) => ({
    id: each.id,
    language: each.language,
    model: each.model,
    passed: passedRun(each),
  }));
  const percent = (passed: number, total: number) => `${Math.round((100 * passed) / total)}%`;
  const under = rows.filter((row) => row.under);
  const failing = (kind: RequestFailure["kind"]) =>
    results.filter((each) => each.failures.some((failure) => failure.kind === kind)).length;
  const dead = failing("dead-markers");
  const shaped = failing("tool-text");
  const heldTo = (key: "standsAlone" | "noExample" | "noEarlier") =>
    results.filter(
      (each) => !each.error && CASES.find((one) => one.id === each.id)?.expected[key] === true,
    );
  const pointingInPanel = heldTo("standsAlone").filter((each) => pointsBack(each.reply)).length;
  const markersLeftOut = results.reduce(
    (total, each) => total + markersIn(each.reply).length - markersIn(each.page).length,
    0,
  );
  const pointersLeft = heldTo("standsAlone").reduce((total, each) => total + each.pointersLeft, 0);
  const lost = results.flatMap((each) =>
    each.failures.flatMap((failure) => (failure.kind === "content-lost" ? failure.sentences : [])),
  );
  const sum = (key: keyof AnswerUsage) =>
    results.reduce((total, each) => total + each.usage[key], 0).toLocaleString("en");
  const answered = results.filter((each) => !each.error && each.reply !== "");
  const researched = answered.filter((each) => each.support !== null);
  const averageLength = (some: readonly CaseResult[]) =>
    Math.round(some.reduce((total, each) => total + each.reply.length, 0) / (some.length || 1));
  const dated = answered.filter(
    (each) => CASES.find((request) => request.id === each.id)?.library === "dated",
  );
  const summaries = answered.flatMap((each) => (each.claims ? [each] : []));
  const covering = answered.filter((each) => each.covered !== undefined);
  const checked = researched.flatMap((each) =>
    (each.support ?? []).map((sentence) => ({ id: each.id, model: each.model, ...sentence })),
  );
  return [
    "# Everyday requests",
    "",
    `${rows.length - under.length} of ${rows.length} requests at or above their floor; ${runs.filter((run) => run.passed).length} of ${runs.length} runs passed. Claims judged by ${judge}, and the app's own change-claim check is asserted for every request.`,
    "",
    `The Answers' tokens: ${sum("inputTokens")} in (${sum("cachedInputTokens")} of them from the cache, ${sum("cacheWriteTokens")} written to it), ${sum("outputTokens")} out. Each request: the Answers' ${tokens.answers}; the judge's ${tokens.judge}. Edit with AI's and the cited sentences' checks aren't counted.`,
    "",
    `An Answer is ${averageLength(answered).toLocaleString("en")} characters long on average (${answered.length} Answers)${researched.length > 0 ? `, ${averageLength(researched).toLocaleString("en")} for the research questions (${researched.length})` : ""}.`,
    "",
    ...(researched.length > 0
      ? [
          "## Cited sentences",
          "",
          `The research questions' Answers, each cited sentence checked against the Documents by the app's own Check against Documents, run by the model asked. The target is ${percent(SUPPORTED_TARGET * 100, 100)} Supported.`,
          "",
          "| Model | Language | Supported | Not checked |",
          "|---|---|---|---|",
          ...supportRates(researched.map((each) => ({ ...each, support: each.support ?? [] }))).map(
            (group) =>
              `| ${group.model} | ${group.language} | ${group.supported} of ${group.judged}${group.judged > 0 ? ` (${percent(group.supported, group.judged)})` : ""} | ${group.notChecked} |`,
          ),
          "",
          ...(checked.some((each) => each.verdict !== "supported")
            ? [
                "Not Supported:",
                "",
                ...checked
                  .filter((each) => each.verdict !== "supported")
                  .map((each) => `- ${each.id} (${each.model}), ${each.verdict}: ${each.sentence}`),
                "",
              ]
            : []),
        ]
      : []),
    ...(dated.length > 0
      ? [
          "## Dates",
          "",
          "The contracts' and minutes' Answers: a date the Documents' text doesn't write, and isn't named as a file's, fails the request. Each file's own dates are none of its text's.",
          "",
          "| Model | Language | Answers that give a date not in the text |",
          "|---|---|---|",
          ...languageRates(
            dated.map((each) => ({
              id: each.id,
              language: each.language,
              model: each.model,
              passed: !each.failures.some((failure) => failure.kind === "date-not-in-text"),
            })),
          ).map((group) => {
            const wrong = group.runs - group.passed;
            return `| ${group.model} | ${group.language} | ${wrong} of ${group.runs} (${percent(wrong, group.runs)}) |`;
          }),
          "",
          ...(summaries.length > 0
            ? [
                `The summaries' sentences outside headings that make a claim: ${summaries.reduce((total, each) => total + (each.claims?.cited ?? 0), 0)} of ${summaries.reduce((total, each) => total + (each.claims?.claims ?? 0), 0)} carry a Citation (${summaries.length} summaries).`,
                "",
              ]
            : []),
        ]
      : []),
    ...(covering.length > 0
      ? [
          "## Each Document covered",
          "",
          "The requests about every Document in scope, summed over their runs: the Documents each Answer cited, those its reply named as not covered, those it left out without saying so, and the Documents outside its scope it cited (the example's).",
          "",
          "| Request | Model | Runs | Cited | Named as not covered | Left out unsaid | Outside its scope cited |",
          "|---|---|---|---|---|---|---|",
          ...[...new Set(covering.map((each) => `${each.id}\n${each.model}`))].map((key) => {
            const [id = "", model = ""] = key.split("\n");
            const some = covering.filter((each) => each.id === id && each.model === model);
            const total = (pick: (covered: NonNullable<CaseResult["covered"]>) => number) =>
              some.reduce((sum, each) => sum + (each.covered ? pick(each.covered) : 0), 0);
            const documents = total(
              (covered) => covered.cited.length + covered.named.length + covered.unsaid.length,
            );
            return `| ${id} | ${model} | ${some.length} | ${total((covered) => covered.cited.length)} of ${documents} | ${total((covered) => covered.named.length)} | ${total((covered) => covered.unsaid.length)} | ${total((covered) => covered.outside)} |`;
          }),
          "",
        ]
      : []),
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
    "## Markers and Tool calls written as text",
    "",
    `${dead} of ${results.length} Answers keep a Citation marker that no Citation backs in their text.`,
    "",
    `The app took out ${results.reduce((total, each) => total + each.droppedMarkers, 0)} markers that nothing backed, in ${results.filter((each) => each.droppedMarkers > 0).length} Answers.`,
    "",
    `${shaped} of ${results.length} Answers show a Tool's call written as text.`,
    "",
    "## Standing on its own",
    "",
    `Pointers left: ${pointersLeft} sentences that point to an earlier Answer stay in what goes into a page (the reply as Add to note puts it, or what was written into a Mind), in ${heldTo("standsAlone").filter((each) => each.pointersLeft > 0).length} of the ${heldTo("standsAlone").length} Answers held to it. Each is kept as written: only a paragraph that is nothing but a pointer goes. Counting the replies in the panel, where they stay as the model wrote them: ${pointingInPanel} point back.`,
    "",
    `${failing("earlier")} of ${heldTo("noEarlier").length} replies asked after the example's Answer talk about an earlier Answer. ${failing("example")} of ${heldTo("noExample").length} mention the example unasked.`,
    "",
    `The guard: it took out ${results.reduce((total, each) => total + each.removed.length, 0)} Blocks on the way into a page, over all ${results.length} Answers and the ${results.reduce((total, each) => total + each.copies, 0)} copies of the last Answer into a Mind, and content lost is ${lost.length}: what it took that says more than a pointer, and the Blocks it changed. Taking pointers out of the replies left out ${markersLeftOut} Citation markers. Each thing it took, to read by hand:`,
    "",
    ...results.flatMap((each) =>
      each.removed.map((taken) => `- ${each.id}, ${each.model}: “${taken}”`),
    ),
    "",
    `Rewritten after the guard, not by it: ${results.reduce((total, each) => total + each.rewritten.length, 0)} sentences of what the calls gave are no longer in the Mind as written, changed by the model's edit_mind or by the app's own check of the sentences written. ${results.reduce((total, each) => total + each.rewritten.filter(({ cut }) => cut).length, 0)} of them only have words taken out, as the check's cut does; the rest are reworded:`,
    "",
    ...results.flatMap((each) =>
      each.rewritten.map(
        ({ given, now, cut }) =>
          `- ${each.id}, ${each.model}, ${cut ? "words taken out" : "reworded"}: given “${given}”; the Mind holds “${now ?? "nothing like it"}”`,
      ),
    ),
    "",
    "## Asked again inside the turn",
    "",
    "The app asks the model again when a reply claims a change no Tool made or a request to write wrote nothing, and once for the Citations of an Answer. The User reads none of those tries: the Answer says nothing of an earlier try. The `reask-` requests put a reply of their own in place of the model's first, so each of them is asked again.",
    "",
    "| Model | Language | Answers | Asked again | Asked for Citations | Asked again, and say something of an earlier try |",
    "|---|---|---|---|---|---|",
    ...asksByGroup(results).map(
      (group) =>
        `| ${group.model} | ${group.language} | ${group.answers} | ${group.again} | ${group.citations} | ${group.unseen} |`,
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
  if (only === "claim-probes" || only === "filings-in-note") return;
  const cases = CASES.filter((each) => {
    if (!only) return true;
    if (only === "hard") return each.hard === true;
    if (only === "research") return each.research === true;
    if (only === "dates") return each.library === "dated";
    if (only === "chinese") return each.language === "zh-CN";
    if (only === "selected") return each.id.startsWith("selected-");
    return only.split(",").includes(each.id);
  });
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
    report(results, rows, `${judging.kind}/${judging.modelId}`, {
      answers: tokenLine(answerTokens.take()),
      judge: tokenLine(judgeTokens.take()),
    }),
  );
  await writeFile(join(folder, "report.json"), JSON.stringify({ rows, results }, null, 2));
  const under = rows.filter((row) => row.under);
  const supported = supportedShare(results.flatMap((each) => each.support ?? []));
  log(
    `${rows.length - under.length} of ${rows.length} requests at or above their floor; report in ${folder}`,
  );
  if (under.length > 0) {
    throw new Error(`Under their floor: ${under.map((row) => row.id).join(", ")}`);
  }
  if (supported < SUPPORTED_TARGET) {
    throw new Error(
      `${Math.round(supported * 100)}% of the cited sentences are Supported, under the target of ${SUPPORTED_TARGET * 100}%.`,
    );
  }
});
