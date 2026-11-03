/**
 * Check this note's cost on a real model (#973): a one-page memo of 26
 * sentences checked against the three report examples, the estimate for the
 * claims the model named beside what the run then sent and cost. Runs only with
 * INCARNAMIND_LIVE_ANTHROPIC_KEY (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by
 * default). Set INCARNAMIND_LIVE_REPORT to a file to keep each call's tokens,
 * the source of tests/fixtures/cost/recorded-checks.json.
 */
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { expect, test } from "vitest";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? catalogProvider("anthropic")?.roles.quickTasks;

const REPORTS = join(import.meta.dirname, "../../resources/examples/reports/en");
const FILES = [
  "Africa Economic Update, April 2026 (executive summary).pdf",
  "Latin America and the Caribbean Economic Update, April 2026 (executive summary).pdf",
  "South Asia Economic Update, April 2026 (executive summary).pdf",
];

/** The memo, as tests/fixtures/cost/recorded-checks.json keeps it with the calls it took. */
const MEMO: readonly string[][] = JSON.parse(
  await readFile(join(import.meta.dirname, "../fixtures/cost/recorded-checks.json"), "utf8"),
).memo;

const text = (value: string): JSONContent => ({ type: "text", text: value });

test.skipIf(!KEY || !MODEL)(
  "Check this note on a one-page memo: the estimate beside what the run sent and cost",
  { timeout: 600_000 },
  async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    await core.saveChatProvider({ kind: "anthropic", apiKey: KEY, modelId: MODEL ?? "" });
    const sources = await createTempDataFolder();
    await addAndProcess(
      core,
      await Promise.all(
        FILES.map(async (name) =>
          writeSourceFile(sources, name, await readFile(join(REPORTS, name))),
        ),
      ),
    );
    const mind = await core.createMind({ title: "Regional outlook" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      { type: "heading", attrs: { level: 1 }, content: [text("Regional outlook memo")] },
      ...MEMO.map((sentences, index) => ({
        type: "paragraph",
        attrs: { id: `memo-${index}` },
        content: [text(sentences.join(" "))],
      })),
    ]);
    await client.settled();

    const plan = await core.planMindCheck(mind.id, "changed", false);
    if (plan.kind !== "ready") throw new Error(`Nothing to check: ${plan.kind}.`);
    const found = await core.findMindClaims({
      requestId: "sort",
      mindId: mind.id,
      mode: "changed",
    });
    if (found.kind !== "found") throw new Error(`No claims found: ${found.kind}.`);
    const estimate = await core.estimateRun({ items: found.claims, each: "check" });
    const result = await core.checkMind({ requestId: "memo", mindId: mind.id, mode: "changed" });
    const calls = queryDatabase<{
      flow: string;
      input: number;
      cached: number;
      written: number;
      output: number;
      cost: number;
    }>(
      dataDir,
      `SELECT flow, input_tokens AS input, coalesce(cached_input_tokens, 0) AS cached,
         coalesce(cache_write_tokens, 0) AS written, output_tokens AS output, cost
       FROM model_requests WHERE deleted_at IS NULL AND status = 'settled' ORDER BY created_at`,
    );
    const report = {
      model: MODEL,
      sentences: plan.sentences,
      claims: found.claims,
      checked: result.kind === "checked" ? result.sentences : null,
      estimate,
      cost: calls.reduce((sum, call) => sum + call.cost, 0),
      calls,
    };
    if (process.env.INCARNAMIND_LIVE_REPORT) {
      await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${JSON.stringify(report)}\n`);
    }
    expect(result).toMatchObject({ kind: "checked", sentences: found.claims });
  },
);
