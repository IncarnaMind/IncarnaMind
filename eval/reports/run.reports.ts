/**
 * `npm run eval:reports` (#1800): a cited Mind turned into a report by a real chat model, with the
 * built-in Skill "mind-to-report" forced as the slash picker forces it, through the core's
 * public interface. Each run counts the Mind's claims the report keeps with their own working
 * Citation (the same Document, version, Location and quote, found), the claims it keeps without
 * one (a model judges whether a claim with no Citation is still there), the sources or ids left
 * as text, and how often the app had to turn an id written as text into its Citation; then it
 * puts the report in a new Mind and exports it to Markdown, which must hold a footnote for each
 * Citation and no bracketed source. A run passes with no claim kept uncited and nothing as text.
 *
 * INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY name the model (setting them is the consent to
 * send it the requests and Passages); INCARNAMIND_EVAL_REPORTS lists case ids (./cases), all by
 * default; INCARNAMIND_EVAL_REPORTS_RUNS sets the runs of each (10 by default). The report goes
 * into eval/results/<start time>-reports/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateText } from "ai";
import { test } from "vitest";
import * as Y from "yjs";
import {
  type AnswerUsage,
  CITATION_NODE,
  type CitationAttributes,
  type Core,
  type CoreEvents,
  messageReference,
} from "../../src/core";
import { plainText } from "../../src/core/mindText";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { pageBlocks } from "../../src/shared/answerBlocks";
import { namesOneOf, sourcesAsText } from "../../src/shared/namedSources";
import { decideProposals } from "../../src/shared/proposals";
import { connectToMind } from "../../tests/helpers/mindClient";
import { heading, note, writeMind } from "../../tests/helpers/minds";
import { costUsd } from "../harness/harnesses";
import { chatModelSpecOf, chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { CASES, CLAIMS, LIMITATION, type ReportCase } from "./cases";

const ROOT = resolve(__dirname, "../..");
const ANSWER_TIMEOUT_MS = 5 * 60_000;

type Cited = Pick<
  CitationAttributes,
  | "passageId"
  | "documentId"
  | "documentName"
  | "contentHash"
  | "pageFrom"
  | "pageTo"
  | "location"
  | "quote"
>;

/** A working Citation that opens where the Mind's does: its Document and pages, found. */
const sameLocation = (a: Partial<Cited> & { check?: string }, b: Partial<Cited>) =>
  a.check === "found" &&
  a.documentId === b.documentId &&
  a.pageFrom === b.pageFrom &&
  a.pageTo === b.pageTo;

/** The Mind's own Citation, record for record. */
const sameCitation = (a: Partial<Cited> & { check?: string }, b: Partial<Cited>) =>
  sameLocation(a, b) &&
  a.contentHash === b.contentHash &&
  a.quote === b.quote &&
  JSON.stringify(a.location ?? null) === JSON.stringify(b.location ?? null);

/** An id left as text, in any bracket a model may use, square, full-width or round. */
const IDS = /[·・]\s*C\d+\s*[\]】］〕)）]|[[【［〔(（]\^?C\d+[\]】］〕)）]/g;

/** What the evaluation reads of an Answer's end; `idsAsText` is absent before #1800. */
type Finished = Pick<
  CoreEvents["answer.finished"],
  "droppedMarkers" | "droppedRecords" | "placedMarkers" | "rejectedRecords" | "usage"
> & { idsAsText?: number };

interface Run {
  id: string;
  model: string;
  claims: number;
  kept: number;
  /** Of `kept`, the Mind's own Citation record for record. */
  same: number;
  uncited: string[];
  asText: string[];
  idsAsText: number;
  footnotes: number;
  /** The report went into a Mind, as asked or not. */
  wroteMind: boolean;
  citations: number;
  passed: boolean;
  text: string;
  usage: AnswerUsage;
  error: string | null;
  /** For reading a failed run: the Answer's Tool calls, the marker counts at its end, its Citations. */
  steps: string[];
  droppedMarkers: number;
  droppedRecords: number;
  placedMarkers: number;
  rejected: unknown[];
  cited: string[];
}

async function citationsOf(core: Core, documents: ReadonlyMap<string, string>) {
  return Promise.all(
    CLAIMS.map(async (claim) => {
      const documentId = documents.get(claim.paper);
      if (!documentId) throw new Error(`No Document “${claim.paper}”.`);
      const cited = await core.citeSelection({
        documentId,
        parts: [{ unit: claim.page, text: claim.quote }],
      });
      if (cited.check !== "found") throw new Error(`“${claim.quote}” isn't on p. ${claim.page}.`);
      return {
        passageId: cited.passageId,
        documentId,
        documentName: claim.paper,
        contentHash: cited.contentHash,
        pageFrom: cited.pageFrom,
        pageTo: cited.pageTo,
        location: cited.location,
        quote: cited.quote,
        check: cited.check,
        checkReason: cited.checkReason,
      };
    }),
  );
}

/** Whether the report still states each claim, as a model judges it: what a claim kept without its Citation is. */
async function stillStated(
  judge: ReturnType<typeof createAiSdkChatModel>,
  report: string,
  claims: readonly string[],
): Promise<boolean[]> {
  if (claims.length === 0) return [];
  const { text } = await generateText({
    model: judge,
    instructions:
      'You compare a report with claims. For each numbered claim, say whether the report states that same fact, in any wording or language. Reply with one JSON object: {"stated": [true, false, …]}, one value per claim, in order.',
    prompt: `<report>\n${report}\n</report>\n\n${claims.map((claim, index) => `${index + 1}. ${claim}`).join("\n")}`,
    maxOutputTokens: 512,
    maxRetries: 1,
  });
  let stated: unknown = null;
  try {
    stated = (JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? "{}") as { stated?: unknown }).stated;
  } catch {
    // Read as every claim still stated, so a judge's broken reply fails the run rather than passing it.
  }
  return Array.isArray(stated)
    ? claims.map((_, index) => stated[index] === true)
    : claims.map(() => true);
}

async function ask(core: Core, text: string, mindId: string) {
  const asked = await core.askInConversation({
    text,
    mindId,
    conversationId: null,
    forcedSkill: "mind-to-report",
  });
  if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
  const finished = await new Promise<Finished | null>((done) => {
    const timer = setTimeout(() => end(null), ANSWER_TIMEOUT_MS);
    const stops = [
      core.on("answer.finished", (event) => event.answerId === asked.answerId && end(event)),
      core.on("answer.failed", (event) => event.answerId === asked.answerId && end(null)),
    ];
    function end(event: Finished | null) {
      clearTimeout(timer);
      for (const stop of stops) stop();
      done(event);
    }
  });
  if (!finished) throw new Error("The Answer failed or took too long.");
  const { messages } = await core.getConversation(asked.conversation.id);
  const answer = messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer was kept.");
  return { answer, finished };
}

/** The Citations a Mind holds, and its text, as the model's report wrote it there. */
async function citationNodes(core: Core, mindId: string) {
  const { blocks } = await connectToMind(core, mindId);
  const citations: (Partial<Cited> & { check?: string })[] = [];
  const visit = (element: Y.XmlElement | Y.XmlFragment) => {
    for (const child of element.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === CITATION_NODE) citations.push(child.getAttributes());
      visit(child);
    }
  };
  visit(blocks);
  const text = blocks
    .toArray()
    .map((block) => (block instanceof Y.XmlElement ? plainText(block) : ""))
    .join("\n");
  return { citations, text };
}

test("a cited Mind made a report keeps its Citations", async () => {
  const config = readConfig(ROOT);
  const chat = config.chat;
  if (!chat) throw new Error("Set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY.");
  const wanted = process.env.INCARNAMIND_EVAL_REPORTS?.split(",").map((each) => each.trim());
  const cases = CASES.filter((each) => !wanted || wanted.includes(each.id));
  const runs = Number(process.env.INCARNAMIND_EVAL_REPORTS_RUNS ?? 10);
  const log = createLog();
  const judging =
    config.judge ?? (chat.kind === "anthropic" ? { ...chat, modelId: "claude-haiku-5-5" } : null);
  if (!judging) {
    throw new Error(
      "Set INCARNAMIND_EVAL_JUDGE_KIND, _MODEL and _KEY: off Anthropic, the judge isn't the model asked.",
    );
  }
  const judge = createAiSdkChatModel({ ...chatModelSpecOf(judging), thinking: "off" });
  const library = await openLibrary({
    name: "reports",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(config.rerankOnCpu),
    documents: [...new Set(CLAIMS.map((claim) => claim.paper))].map((paper) => ({
      key: paper,
      path: join(ROOT, "data", `${paper}.pdf`),
    })),
    builtInSkills: join(ROOT, "resources", "skills"),
    embeddings: false,
    keep: config.keepData,
    log,
  });
  const model = `${chat.kind}/${chat.modelId}`;
  const results: Run[] = [];
  try {
    const { core } = library;
    core.on("consent.requested", (request) => {
      void core.respondToConsent(request.requestId, true);
    });
    await core.saveChatProvider(chatProviderOf(chat));
    const ids = new Map([...library.documents.values()].map((each) => [each.name, each.id]));
    const citations = await citationsOf(core, ids);
    const known = (source: { name: string }) => namesOneOf(source.name, [...ids.keys()]);
    for (const each of cases.flatMap((one) => Array.from({ length: runs }, () => one))) {
      log(`${model} · ${each.id}`);
      results.push(await runCase(core, each, citations, known, judge, model));
      const last = results.at(-1);
      log(
        `  kept ${last?.kept}/${last?.claims} (${last?.same} the same record), uncited ${last?.uncited.length}, as text ${last?.asText.length}, ids as text ${last?.idsAsText}, footnotes ${last?.footnotes}${last?.error ? `, error: ${last.error}` : ""}`,
      );
    }
  } finally {
    await library.close();
  }
  const folder = join(
    config.resultsDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-reports`,
  );
  await mkdir(folder, { recursive: true });
  const usage = results.reduce(
    (sum, run) => ({
      inputTokens: sum.inputTokens + run.usage.inputTokens,
      outputTokens: sum.outputTokens + run.usage.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + run.usage.cachedInputTokens,
      cacheWriteTokens: sum.cacheWriteTokens + run.usage.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
  );
  const summary = cases.map((each) => {
    const mine = results.filter((run) => run.id === each.id);
    return {
      id: each.id,
      passed: `${mine.filter((run) => run.passed).length}/${mine.length}`,
      kept: `${mine.reduce((sum, run) => sum + run.kept, 0)}/${mine.reduce((sum, run) => sum + run.claims, 0)}`,
      same: mine.reduce((sum, run) => sum + run.same, 0),
      uncited: mine.reduce((sum, run) => sum + run.uncited.length, 0),
      asText: mine.reduce((sum, run) => sum + run.asText.length, 0),
      idsAsTextRuns: mine.filter((run) => run.idsAsText > 0).length,
      wroteMindRuns: mine.filter((run) => run.wroteMind).length,
    };
  });
  const cost = costUsd(chat, usage);
  await writeFile(
    join(folder, "report.json"),
    JSON.stringify({ model, summary, usage, costUsd: cost, results }, null, 2),
  );
  log(
    `${model}: ${JSON.stringify(summary)}; about $${cost?.toFixed(2)} (the Answers' tokens). ${folder}`,
  );
});

async function runCase(
  core: Core,
  each: ReportCase,
  all: Awaited<ReturnType<typeof citationsOf>>,
  known: (source: { name: string }) => boolean,
  judge: ReturnType<typeof createAiSdkChatModel>,
  model: string,
): Promise<Run> {
  const empty = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  const run: Run = {
    id: each.id,
    model,
    claims: each.claims.length,
    kept: 0,
    same: 0,
    uncited: [],
    asText: [],
    idsAsText: 0,
    footnotes: 0,
    wroteMind: false,
    citations: 0,
    passed: false,
    text: "",
    usage: empty,
    error: null,
    steps: [],
    droppedMarkers: 0,
    droppedRecords: 0,
    placedMarkers: 0,
    rejected: [],
    cited: [],
  };
  try {
    const zh = each.language === "zh-CN";
    const mind = await core.createMind({ title: zh ? "主题综述" : "Thematic review" });
    const client = await connectToMind(core, mind.id);
    const claims = each.claims.map((index) => ({ claim: CLAIMS[index], citation: all[index] }));
    writeMind(client, [
      heading(1, zh ? "主题综述" : "Thematic review"),
      ...claims.map(({ claim, citation }) => {
        const block = note((zh ? claim?.zh : undefined) ?? claim?.en ?? "");
        block.content?.push(
          { type: "citation", attrs: citation ?? {} },
          { type: "text", text: zh ? "。" : "." },
        );
        return block;
      }),
      note(zh ? LIMITATION.zh : LIMITATION.en),
    ]);
    await client.settled();

    const { answer, finished } = await ask(core, each.request, mind.id);
    run.usage = finished.usage;
    run.idsAsText = finished.idsAsText ?? 0;
    run.droppedMarkers = finished.droppedMarkers;
    run.droppedRecords = finished.droppedRecords;
    run.placedMarkers = finished.placedMarkers;
    run.rejected = finished.rejectedRecords;
    run.steps = answer.toolCalls.map(
      (call) => `${call.tool} ${JSON.stringify(call.input).slice(0, 80)}`,
    );
    // Asked for in the Answer, a model may still write it into a Mind: the report is wherever it went.
    const written = answer.toolCalls.flatMap((call) => call.mindChange ?? []).at(-1);
    run.wroteMind = written !== undefined;
    if (written) {
      // What the assistant wrote waits as changes until the window applies them, as it does at once.
      const client = await connectToMind(core, written.mindId);
      client.doc.transact(() => decideProposals(client.blocks, () => true, "accept"));
      await client.settled();
    }
    const report = written
      ? await citationNodes(core, written.mindId)
      : { citations: answer.citations, text: answer.text };
    run.text = report.text;
    run.citations = report.citations.length;
    run.cited = report.citations.map(
      (each) => `${each.check} p.${each.pageFrom} ${String(each.quote ?? "").slice(0, 40)}`,
    );
    // One Citation of the report keeps one claim: its own record first, then one at its Location.
    const unused = [...report.citations];
    const take = (matches: (each: (typeof unused)[number]) => boolean) => {
      const at = unused.findIndex(matches);
      if (at >= 0) unused.splice(at, 1);
      return at >= 0;
    };
    const own = claims.map(({ citation }) => take((each) => sameCitation(each, citation ?? {})));
    const keptEach = claims.map(
      ({ citation }, index) => own[index] || take((each) => sameLocation(each, citation ?? {})),
    );
    run.kept = keptEach.filter(Boolean).length;
    run.same = own.filter(Boolean).length;
    const lost = claims.filter((_, index) => !keptEach[index]).map(({ claim }) => claim?.en ?? "");
    const stated = await stillStated(judge, report.text.replace(/\[\^\d+\]/g, ""), lost);
    run.uncited = lost.filter((_, index) => stated[index]);
    run.asText = [...sourcesAsText(report.text, known), ...(report.text.match(IDS) ?? [])];
    let saved = written?.mindId;
    if (!saved) {
      saved = (await core.createMind({ title: "Report" })).id;
      await core.addToNote({
        mindId: saved,
        blocks: pageBlocks(answer, each.request),
        origin: {
          from: messageReference(answer.conversationId, answer.id),
          question: each.request,
        },
        model: answer.model,
      });
    }
    const exported = new TextDecoder().decode(
      (await core.exportMind(saved, { format: "markdown" })).data,
    );
    run.footnotes = (exported.match(/^\[\^\d+\]: /gm) ?? []).length;
    run.asText.push(...sourcesAsText(exported, known), ...(exported.match(IDS) ?? []));
    run.passed = run.uncited.length === 0 && run.asText.length === 0 && run.footnotes >= run.kept;
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  }
  return run;
}
