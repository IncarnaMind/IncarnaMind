/**
 * Sheets that hold an older and a current version of the same rows, against a real model (#1979),
 * through the core as the app asks, in English and Chinese: the held-out set of
 * ../helpers/supersededRowsHeldOut, in four sets each written before the run it measures; the
 * fourth's Answers may run an Analysis, in the app's Python helper (../helpers/pyodideAnalysis). Each Answer passes the checks
 * here when it cites the rows its case names, gives its figures and never the versions added up,
 * and for a what-if, works out the current figure from the current input; a person reads each one
 * for the rest (the case's `read`). It runs only when INCARNAMIND_LIVE_ANTHROPIC_KEY is set
 * (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default). INCARNAMIND_LIVE_RUNS asks each Question
 * that many times, INCARNAMIND_LIVE_REPORT keeps every Answer with its Citations, figures and
 * price, and INCARNAMIND_LIVE_MAX_USD stops asking once the set has cost that much.
 */
import { appendFile } from "node:fs/promises";
import { expect, onTestFinished, test } from "vitest";
import type { AnalysisRuntime, ConversationAnswer, Core } from "../../src/core";
import { costOf } from "../../src/core/cost/price";
import { catalogModel } from "../../src/core/providers/catalog";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { type ChatModelFactory, createAiSdkChatModel } from "../../src/core/providers/models";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { pyodideAnalysisRuntime } from "../helpers/pyodideAnalysis";
import {
  type HeldOutCase,
  SUPERSEDED_HELD_OUT,
  SUPERSEDED_HELD_OUT_ANALYSIS,
  SUPERSEDED_HELD_OUT_SECOND,
  SUPERSEDED_HELD_OUT_THIRD,
} from "../helpers/supersededRowsHeldOut";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  catalogProvider("anthropic")?.roles.quickTasks ??
  "claude-haiku-5-5";
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 1);
const PRICE = catalogModel("anthropic", MODEL)?.price;
const MAX_USD = Number(process.env.INCARNAMIND_LIVE_MAX_USD ?? Number.POSITIVE_INFINITY);
if (Number.isNaN(MAX_USD)) throw new Error("INCARNAMIND_LIVE_MAX_USD must be a number of dollars.");
if (!Number.isInteger(RUNS) || RUNS < 1)
  throw new Error("INCARNAMIND_LIVE_RUNS must be a whole number of at least 1.");
if (KEY !== undefined && Number.isFinite(MAX_USD) && !PRICE)
  throw new Error(`No price is known for ${MODEL}, so INCARNAMIND_LIVE_MAX_USD can't be kept to.`);

interface Billed {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface ReportedUsage {
  inputTokens?: { total?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens?: { total?: number };
}

const billedOf = (usage: ReportedUsage | undefined): Billed => ({
  input: usage?.inputTokens?.total ?? 0,
  cacheRead: usage?.inputTokens?.cacheRead ?? 0,
  cacheWrite: usage?.inputTokens?.cacheWrite ?? 0,
  output: usage?.outputTokens?.total ?? 0,
});

const priced = (each: Billed): number =>
  PRICE
    ? costOf(
        {
          inputTokens: each.input,
          cachedInputTokens: each.cacheRead,
          cacheWriteTokens: each.cacheWrite,
          outputTokens: each.output,
        },
        PRICE,
        new Date(),
        { cacheWrites: true },
      )
    : 0;

const billed: Billed[] = [];
const spent = () => billed.reduce((total, each) => total + priced(each), 0);

const counting: ChatModelFactory = (spec) => {
  const model = createAiSdkChatModel(spec);
  return new Proxy(model, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "doGenerate" && typeof value === "function")
        return async (...args: unknown[]) => {
          const result = (await value.apply(target, args)) as { usage?: ReportedUsage };
          billed.push(billedOf(result.usage));
          return result;
        };
      if (property === "doStream" && typeof value === "function")
        return async (...args: unknown[]) => {
          const result = (await value.apply(target, args)) as {
            stream: ReadableStream<{ type: string; usage?: ReportedUsage }>;
          };
          const [given, read] = result.stream.tee();
          const entry = billedOf(undefined);
          billed.push(entry);
          void (async () => {
            const reader = read.getReader();
            for (let part = await reader.read(); !part.done; part = await reader.read())
              if (part.value.type === "finish") Object.assign(entry, billedOf(part.value.usage));
          })().catch(() => {
            // A stream that failed or was stopped costs what its finish part said, if it came.
          });
          return { ...result, stream: given };
        };
      return value;
    },
  });
};

async function ask(core: Core, text: string): Promise<ConversationAnswer> {
  const asked = await core.askInConversation({ text });
  if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
  await answerEnded(core, asked.answerId);
  const { messages } = await core.getConversation(asked.conversation.id);
  const answer = messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

/** The rows an Answer cites, its figures' inputs included. */
function citedRows(answer: ConversationAnswer): Set<number> {
  const rows = new Set<number>();
  const locations = [
    ...answer.citations.map((citation) => citation.location),
    ...answer.figures.flatMap((figure) => figure.inputs.map((input) => input.citation.location)),
  ];
  for (const location of locations)
    if (location?.kind === "rows")
      for (let row = location.from; row <= location.to; row++) rows.add(row);
  return rows;
}

/** What an Answer misses of its case's checks; empty when it passes them. */
function misses(answer: ConversationAnswer, held: HeldOutCase): string[] {
  const written = [answer.text, ...answer.figures.map((figure) => figure.shown)].join("\n");
  const rows = citedRows(answer);
  const missed: string[] = [];
  if (answer.status !== "done") missed.push(`status ${answer.status}`);
  for (const row of held.cites) if (!rows.has(row)) missed.push(`row ${row} not cited`);
  for (const forms of held.gives)
    if (!forms.some((form) => written.includes(form))) missed.push(`${forms[0]} not given`);
  for (const form of held.never) if (written.includes(form)) missed.push(`${form} given`);
  const change = held.whatIf;
  if (
    change &&
    !answer.figures.some((figure) => {
      const book = figure.workbook;
      const changed = book?.changes[0];
      const input = figure.inputs.find((each) => each.name === changed?.input);
      return (
        book !== undefined &&
        `${book.cell.sheet}!${book.cell.ref}` === change.cell &&
        `${input?.cell?.sheet}!${input?.cell?.ref}` === change.input &&
        changed?.value === change.value &&
        Math.abs((figure.value as number) - change.result) < 1e-9
      );
    })
  )
    missed.push(`no what-if of ${change.cell} with ${change.input} at ${change.value}`);
  return missed;
}

const located = (answer: ConversationAnswer) => [
  ...answer.citations.map(
    (citation) =>
      `- [^${citation.marker}] ${citation.location?.kind === "rows" ? `rows ${citation.location.from}–${citation.location.to}` : JSON.stringify(citation.location)}: ${citation.quote.replace(/\t/g, " | ")}`,
  ),
  ...answer.figures.map(
    (figure) =>
      `- [=${figure.marker}] ${figure.shown} ${figure.label}${figure.workbook ? ` (${figure.workbook.cell.sheet}!${figure.workbook.cell.ref}${figure.workbook.changes.length > 0 ? `, ${figure.workbook.changes.map((change) => `${change.input} → ${change.shown}`).join(", ")}` : ""})` : ` = ${figure.formula}`}; inputs ${figure.inputs.map((input) => `${input.name} ${input.cell ? input.cell.ref : "?"}`).join(", ")}`,
  ),
];

/** What an Answer's Analyses counted of the rows the file sets aside, for its report. */
function analysesLines(answer: ConversationAnswer): string[] {
  return answer.analyses.map((analysis) => {
    const aside = analysis.inputs.flatMap((input) =>
      input.kind === "range" && input.setAside
        ? [
            ...input.setAside.struck.map((row) => ({ input: input.name, row })),
            ...input.setAside.hidden.map((row) => ({ input: input.name, row })),
          ]
        : [],
    );
    const counted = analysis.output.results.flatMap((result) => {
      if (result.kind !== "figure" || !result.of) return [];
      const of = result.of;
      const rows = aside.filter(
        (each) =>
          each.input === of.input &&
          of.rows.some(([from, to]) => each.row >= from && each.row <= to),
      );
      return rows.length > 0 ? [`${result.label} counts ${rows.length} set-aside rows`] : [];
    });
    return `Analysis ${analysis.number} (${analysis.end.kind}): ${counted.join("; ") || "no figure counts a set-aside row"}`;
  });
}

/** Asks `held`'s Question `RUNS` times in a fresh core, and reports each Answer. */
async function askHeldOut(held: HeldOutCase, analysisRuntime?: AnalysisRuntime) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: counting,
    ...(analysisRuntime && { analysisRuntime }),
  });
  core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
  await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
  const path = await writeSourceFile(
    await createTempDataFolder(),
    held.file,
    new Uint8Array(held.workbook()),
  );
  await addAndProcess(core, [path]);
  const report = [`## ${held.name} (${held.language}) · ${MODEL}`, `Read for: ${held.read}`];
  onTestFinished(async () => {
    if (process.env.INCARNAMIND_LIVE_REPORT)
      await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
  });
  const missed: string[] = [];
  for (let run = 1; run <= RUNS; run++) {
    if (spent() > MAX_USD) {
      missed.push(`run ${run}: not asked, the spending limit was reached`);
      continue;
    }
    const before = spent();
    const answer = await ask(core, held.question);
    const these = misses(answer, held);
    if (these.length > 0) missed.push(`run ${run}: ${these.join("; ")}`);
    report.push(
      "",
      `### Run ${run}: ${these.length === 0 ? "passed" : `missed (${these.join("; ")})`}; $${(spent() - before).toFixed(4)}`,
      `Tools: ${answer.toolCalls.map((call) => call.tool).join(", ") || "none"}`,
      ...analysesLines(answer),
      "",
      answer.text,
      "",
      ...located(answer),
    );
  }
  report.push("", `Spent so far: $${spent().toFixed(4)}`);
  core.close();
  expect(missed).toEqual([]);
}

test
  .skipIf(KEY === undefined)
  .each(
    [...SUPERSEDED_HELD_OUT, ...SUPERSEDED_HELD_OUT_SECOND, ...SUPERSEDED_HELD_OUT_THIRD].map(
      (held) => ({ ...held }),
    ),
  )(
  "$name ($language): the Answer cites the current rows, or says the sheet doesn't say which",
  { timeout: 1_800_000 },
  (held) => askHeldOut(held),
);

let runtime: Promise<AnalysisRuntime> | undefined;

test.skipIf(KEY === undefined).each(SUPERSEDED_HELD_OUT_ANALYSIS.map((held) => ({ ...held })))(
  "$name ($language): an Analysis gives the current figure",
  { timeout: 1_800_000 },
  async (held) => {
    runtime ??= pyodideAnalysisRuntime();
    await askHeldOut(held, await runtime);
  },
);
