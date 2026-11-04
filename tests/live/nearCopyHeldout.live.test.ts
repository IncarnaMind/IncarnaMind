/**
 * The held-out near copies (`nearCopyHeldout.cases.ts`) on the check's judge (#1765, #1766, #1708),
 * through Check this Note as the window uses it, one Note a language over its own Documents. The
 * sorter is scripted to give each sentence as one fact, so the judge alone decides it: a sorter that
 * reads "should" as advice would leave the sentence unchecked, which says nothing of the judge.
 * Everything else is the real model.
 *
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY; the model is INCARNAMIND_LIVE_ANTHROPIC_MODEL
 * (Claude Haiku 5.5 by default), INCARNAMIND_LIVE_RUNS the checks of each Note (1), and
 * INCARNAMIND_LIVE_LANGUAGES the languages (`en,zh-CN`). The report, every check's outcome with the
 * check's own words and what the run spent, is written to INCARNAMIND_LIVE_REPORT when it is set.
 */
import { writeFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { type RepeatResult, repeatChecks } from "../../eval/repeats/repeat";
import { type Core, createAiSdkChatModel } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { NEAR_COPY_SETS, type NearCopyCase, type NearCopySet } from "./nearCopyHeldout.cases";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 1) || 1;
const LANGUAGES = process.env.INCARNAMIND_LIVE_LANGUAGES?.split(",") ?? ["en", "zh-CN"];
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;

const SORT_SYSTEM = "You sort the sentences of the User's own draft";

/** The sort's sentences, from the request's own JSON: `{"sentences":[{"number":1,"text":"…"}]}`. */
function sortedSentences(prompt: unknown): { number: number; text: string }[] | null {
  for (const message of prompt as { role: string; content: unknown }[]) {
    if (message.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content as { type: string; text?: string }[])
            .map((part) => part.text ?? "")
            .join("");
    try {
      const value = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {
        sentences?: { number: number; text: string }[];
      };
      if (Array.isArray(value.sentences)) return value.sentences;
    } catch {
      // Not the sort's input: another message of the request.
    }
  }
  return null;
}

/** The real model, with its sort of the Note's sentences answered as one fact each. */
const createChatModel: NonNullable<Parameters<typeof startCore>[1]>["createChatModel"] = (spec) =>
  wrapLanguageModel({
    model: createAiSdkChatModel(spec),
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate, params }) => {
        const result = await doGenerate();
        if (!JSON.stringify(params.prompt).includes(SORT_SYSTEM)) return result;
        const sentences = sortedSentences(params.prompt);
        if (!sentences) return result;
        const sorted = sentences.map(({ number, text }) => ({
          number,
          parts: [{ kind: "fact", text }],
        }));
        return {
          ...result,
          content: [{ type: "text" as const, text: JSON.stringify({ sentences: sorted }) }],
        };
      },
    },
  });

const spentOf = async (core: Core) =>
  (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((total, each) => total + each.amount, 0);

interface Checked {
  case: NearCopyCase;
  results: RepeatResult[];
}

async function checkSet(set: NearCopySet): Promise<{ checked: Checked[]; spent: number }> {
  const core = startCore(await createTempDataFolder(), { createChatModel });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.updateSettings({
    user: { language: set.language, monthlyCap: { amount: 5, currency: "USD" } },
  });
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: KEY ?? "",
    modelId: MODEL,
  });
  const sources = await createTempDataFolder();
  const files = await Promise.all(
    set.documents.map((document) =>
      writeSourceFile(
        sources,
        document.file,
        `# ${document.title}\n\n${document.clauses.map((clause, index) => `${index + 1}. ${clause}`).join("\n")}\n`,
      ),
    ),
  );
  await addAndProcess(core, files);
  const results = await repeatChecks(core, {
    mind: set.language === "en" ? "Near copies" : "近似的句子",
    sentences: set.cases.map((each) => each.text),
    repeats: RUNS,
    model: { providerId: provider.id, modelId: MODEL },
    onRepeat: async (done) => {
      const supported = done.filter((result) => {
        const decoy = set.cases.find((each) => each.text === result.sentence)?.decoy;
        return decoy && result.outcome === "supported";
      }).length;
      console.log(
        `${MODEL} ${set.language} check ${done[0]?.repeat}: decoys Supported ${supported} · $${(await spentOf(core)).toFixed(3)}`,
      );
      return true;
    },
  });
  return {
    checked: set.cases.map((each) => ({
      case: each,
      results: results.filter((result) => result.sentence === each.text),
    })),
    spent: await spentOf(core),
  };
}

/** Each kind's checks: how many, and how many came back Supported. */
function tally(checked: readonly Checked[]) {
  const kinds = new Map<string, { checks: number; supported: number }>();
  for (const { case: each, results } of checked) {
    const name = `${each.decoy ? "decoy" : "positive"} ${each.kind}`;
    const row = kinds.get(name) ?? { checks: 0, supported: 0 };
    row.checks += results.length;
    row.supported += results.filter((result) => result.outcome === "supported").length;
    kinds.set(name, row);
  }
  return Object.fromEntries(kinds);
}

describe("held-out near copies on the judge", () => {
  test.skipIf(KEY === undefined)(
    "refuses a changed period, duty or dropped condition, and backs the true copies",
    { timeout: 3_600_000 },
    async () => {
      const report = [];
      for (const set of NEAR_COPY_SETS.filter((each) => LANGUAGES.includes(each.language))) {
        const { checked, spent } = await checkSet(set);
        const decoys = checked.filter((each) => each.case.decoy);
        const positives = checked.filter((each) => !each.case.decoy);
        const count = (rows: readonly Checked[], outcome: string) =>
          rows.flatMap((row) => row.results).filter((result) => result.outcome === outcome).length;
        const summary = {
          model: MODEL,
          language: set.language,
          runs: RUNS,
          decoyChecks: decoys.flatMap((row) => row.results).length,
          decoysSupported: count(decoys, "supported"),
          positiveChecks: positives.flatMap((row) => row.results).length,
          positivesSupported: count(positives, "supported"),
          notChecked: count(checked, "not-checked") + count(checked, "no-mark"),
          kinds: tally(checked),
          spent,
        };
        console.log(JSON.stringify(summary));
        report.push({
          ...summary,
          cases: checked.map(({ case: each, results }) => ({
            key: each.key,
            kind: each.kind,
            decoy: each.decoy,
            text: each.text,
            outcomes: results.map((result) => result.outcome),
            says: results.map((result) => result.says),
            quotes: results.map((result) => result.quote),
            failures: results.flatMap((result) => (result.failure ? [result.failure] : [])),
          })),
        });
        expect(checked.every((row) => row.results.length === RUNS)).toBe(true);
      }
      if (REPORT) await writeFile(REPORT, JSON.stringify(report, null, 2));
    },
  );
});
