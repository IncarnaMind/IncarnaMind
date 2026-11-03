/**
 * `npm run eval:skills` (#1938): each finance and law Skill forced as the slash
 * picker forces it, on a real chat model, over the invented Documents in
 * ./documents, in English and in Simplified Chinese. Every run must write a
 * note (not answer in the panel), the note must state the case's facts, every
 * Citation in it must be found by the app's own check, and a marker must not
 * stand without its Citation. Each run's note and verdicts go into
 * eval/results/<start time>-skills/.
 *
 * INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY name the model (setting them is
 * the consent to send it the requests and Passages);
 * INCARNAMIND_EVAL_SKILLS lists case ids (./cases), all by default. Retrieval
 * uses the deterministic stand-in reranker: the Skills and their Citations are
 * what this checks, not the ranking of 2 to 4 Documents.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { AnswerUsage, Core, CoreEvents } from "../../src/core";
import { namesOneOf, sourcesAsText } from "../../src/shared/namedSources";
import { costUsd } from "../harness/harnesses";
import { chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { acceptChanges, citationNodes } from "../lib/notes";
import { CASES, type SkillCase } from "./cases";

const ROOT = resolve(__dirname, "../..");
const ANSWER_TIMEOUT_MS = 5 * 60_000;
const DOCUMENTS = join(ROOT, "eval", "skills", "documents");
const BUILT_IN_SKILLS = join(ROOT, "resources", "skills");

/** An id left as text, in any bracket a model may use, square, full-width or round. */
const IDS = /[·・]\s*C\d+\s*[\]】］〕)）]|[[【［〔(（]\^?C\d+[\]】］〕)）]/g;
const MARKER = /\[\^\d+\]/g;
const HAN = /[一-鿿]/g;
const LATIN = /[A-Za-z]/g;

type Finished = Pick<CoreEvents["answer.finished"], "usage">;

interface CitationVerdict {
  document: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  quote: string | null;
  check: string | null;
}

interface FactVerdict {
  pattern: string;
  held: boolean;
}

interface Run {
  id: string;
  skill: string;
  language: string;
  model: string;
  wroteNote: boolean;
  note: string;
  citations: CitationVerdict[];
  found: number;
  notFound: number;
  markers: number;
  facts: FactVerdict[];
  languageOk: boolean;
  sourcesAsText: string[];
  steps: string[];
  usage: AnswerUsage;
  verdict: "pass" | "fail";
  failures: string[];
  error: string | null;
}

const emptyUsage = (): AnswerUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
});

/** Whether a note is written in the case's language, by the letters it uses. */
function inLanguage(text: string, language: SkillCase["language"]): boolean {
  const stripped = text.replace(MARKER, "");
  const han = (stripped.match(HAN) ?? []).length;
  const latin = (stripped.match(LATIN) ?? []).length;
  const total = han + latin;
  if (total === 0) return true;
  return language === "en" ? han / total < 0.2 : han / total >= 0.5;
}

async function ask(core: Core, each: SkillCase, mindId: string) {
  const asked = await core.askInConversation({
    text: each.request,
    mindId,
    conversationId: null,
    forcedSkill: each.skill,
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

async function runCase(
  each: SkillCase,
  chat: NonNullable<ReturnType<typeof readConfig>["chat"]>,
  embedder: ReturnType<typeof createWorkerEmbedder>,
  log: ReturnType<typeof createLog>,
): Promise<Run> {
  const model = `${chat.kind}/${chat.modelId}`;
  const run: Run = {
    id: each.id,
    skill: each.skill,
    language: each.language,
    model,
    wroteNote: false,
    note: "",
    citations: [],
    found: 0,
    notFound: 0,
    markers: 0,
    facts: [],
    languageOk: false,
    sourcesAsText: [],
    steps: [],
    usage: emptyUsage(),
    verdict: "fail",
    failures: [],
    error: null,
  };
  const library = await openLibrary({
    name: `skills-${each.id}`,
    embedder,
    documents: each.documents.map((file) => ({
      key: file,
      path: join(DOCUMENTS, each.language, file),
    })),
    builtInSkills: BUILT_IN_SKILLS,
    embeddings: false,
    keep: false,
    log,
  });
  try {
    const { core } = library;
    core.on("consent.requested", (request) => {
      void core.respondToConsent(request.requestId, true);
    });
    await core.saveChatProvider(chatProviderOf(chat));
    const names = [
      ...library.documents.keys(),
      ...[...library.documents.values()].map((document) => document.name),
    ];
    const known = (source: { name: string }) => namesOneOf(source.name, names);

    const mind = await core.createMind({ title: each.title });
    const { answer, finished } = await ask(core, each, mind.id);
    run.usage = finished.usage;
    run.steps = answer.toolCalls.map(
      (call) => `${call.tool} ${JSON.stringify(call.input).slice(0, 80)}`,
    );
    const written = answer.toolCalls.flatMap((call) => call.mindChange ?? []).at(-1);
    if (!written) {
      run.failures.push("The Skill answered in the panel instead of writing a note.");
      return run;
    }
    run.wroteNote = true;
    await acceptChanges(core, written.mindId);
    const note = await citationNodes(core, written.mindId);
    run.note = note.text;
    run.citations = note.citations.map((citation) => ({
      document: citation.documentName ?? null,
      pageFrom: citation.pageFrom ?? null,
      pageTo: citation.pageTo ?? null,
      quote: citation.quote ?? null,
      check: citation.check ?? null,
    }));
    run.found = run.citations.filter((citation) => citation.check === "found").length;
    run.notFound = run.citations.length - run.found;
    run.markers = (run.note.match(MARKER) ?? []).length;
    run.facts = each.facts.map((group) => ({
      pattern: group.map(String).join(" | "),
      held: group.some((pattern) => pattern.test(run.note)),
    }));
    run.languageOk = inLanguage(run.note, each.language);
    run.sourcesAsText = [...sourcesAsText(run.note, known), ...(run.note.match(IDS) ?? [])];

    if (run.note.trim() === "") run.failures.push("The note is empty.");
    if (run.citations.length < each.citationsAtLeast) {
      run.failures.push(
        `The note holds ${run.citations.length} Citations, fewer than the ${each.citationsAtLeast} the case needs.`,
      );
    }
    if (run.notFound > 0) {
      run.failures.push(`${run.notFound} Citation(s) were not found by the check.`);
    }
    if (run.markers > run.citations.length) {
      run.failures.push(`${run.markers} marker(s) stand for ${run.citations.length} Citation(s).`);
    }
    for (const fact of run.facts) {
      if (!fact.held) run.failures.push(`The note does not state ${fact.pattern}.`);
    }
    if (!run.languageOk) {
      run.failures.push(`The note is not written in ${each.language}.`);
    }
    if (run.sourcesAsText.length > 0) {
      run.failures.push(`A source is written as text: ${run.sourcesAsText.join(", ")}.`);
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  } finally {
    await library.close();
  }
  run.verdict = run.failures.length === 0 && run.error === null ? "pass" : "fail";
  return run;
}

function reportMarkdown(model: string, runs: readonly Run[], cost: number | null): string {
  const lines = [`# The finance and law Skills on ${model}`, ""];
  lines.push(
    "| Case | Skill | Language | Note | Citations | Found | Facts | Language | Verdict |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const run of runs) {
    const facts = `${run.facts.filter((fact) => fact.held).length}/${run.facts.length}`;
    lines.push(
      `| ${run.id} | ${run.skill} | ${run.language} | ${run.wroteNote ? "yes" : "no"} | ${run.citations.length} | ${run.found} | ${facts} | ${run.languageOk ? "yes" : "no"} | ${run.verdict} |`,
    );
  }
  lines.push("", `Spend: about $${(cost ?? 0).toFixed(3)}.`, "");
  for (const run of runs) {
    lines.push(`## ${run.id}`, "", `Verdict: ${run.verdict}`);
    if (run.error) lines.push("", `Error: ${run.error}`);
    for (const failure of run.failures) lines.push("", `- ${failure}`);
    lines.push("", "Steps:", "", ...run.steps.map((step) => `- ${step}`), "");
    lines.push(run.note || "(no note)", "", "### Citations", "");
    if (run.citations.length === 0) lines.push("None.");
    for (const citation of run.citations) {
      const place =
        citation.pageFrom === null
          ? ""
          : citation.pageTo !== null && citation.pageTo !== citation.pageFrom
            ? `pp. ${citation.pageFrom}–${citation.pageTo}`
            : `p. ${citation.pageFrom}`;
      lines.push(
        `- ${citation.document ?? "?"}${place ? ` · ${place}` : ""} · ${citation.check ?? "?"} · ${String(citation.quote ?? "").slice(0, 120)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

test("each Skill writes a cited note in each language", async () => {
  const config = readConfig(ROOT);
  const chat = config.chat;
  if (!chat) throw new Error("Set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY.");
  const wanted = process.env.INCARNAMIND_EVAL_SKILLS?.split(",").map((each) => each.trim());
  const cases = CASES.filter((each) => !wanted || wanted.includes(each.id));
  if (cases.length === 0) throw new Error("No case matches INCARNAMIND_EVAL_SKILLS.");
  const log = createLog();
  // Embeddings are off in these runs: the worker behind this adapter never starts.
  const embedder = createWorkerEmbedder();
  const runs: Run[] = [];
  for (const each of cases) {
    log(`${chat.kind}/${chat.modelId} · ${each.id}`);
    const run = await runCase(each, chat, embedder, log);
    runs.push(run);
    log(
      `  ${run.verdict}: note ${run.wroteNote ? "yes" : "no"}, ${run.citations.length} Citations (${run.found} found), facts ${run.facts.filter((fact) => fact.held).length}/${run.facts.length}${run.error ? `, error: ${run.error}` : ""}`,
    );
  }
  const usage = runs.reduce(
    (sum, run) => ({
      inputTokens: sum.inputTokens + run.usage.inputTokens,
      outputTokens: sum.outputTokens + run.usage.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + run.usage.cachedInputTokens,
      cacheWriteTokens: sum.cacheWriteTokens + run.usage.cacheWriteTokens,
    }),
    emptyUsage(),
  );
  const cost = costUsd(chat, usage);
  const folder = join(
    config.resultsDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-skills`,
  );
  await mkdir(folder, { recursive: true });
  const model = `${chat.kind}/${chat.modelId}`;
  await writeFile(
    join(folder, "report.json"),
    JSON.stringify({ model, usage, costUsd: cost, runs }, null, 2),
  );
  await writeFile(join(folder, "report.md"), reportMarkdown(model, runs, cost));
  const passed = runs.filter((run) => run.verdict === "pass").length;
  log(`${model}: ${passed}/${runs.length} passed; about $${(cost ?? 0).toFixed(3)}. ${folder}`);
});
