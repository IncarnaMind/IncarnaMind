/**
 * The earlier-call set's saved replies judged again (`gates/call-help-earlier-calls.md`, #3005):
 * each reply of a paired run's `report.json`, as it was shown, with both calls' lines and its
 * Citations, sent to the judge alone. No model under test is asked. Every judge request is counted,
 * a refused or failed attempt included, and the spend goes on the gate's one ledger.
 *
 * INCARNAMIND_EVAL_SPEED_REJUDGE=<report.json> INCARNAMIND_EVAL_SPEED_JUDGE=anthropic/claude-sonnet-5-5
 * INCARNAMIND_EVAL_SPEED_LEDGER=<ledger> INCARNAMIND_EVAL_SPEED_STOP_USD=1.50
 * npm run eval:speed -- eval/speed/earlierCallsRejudge.speed.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { test } from "vitest";
import { EARLIER_CALL_CASES } from "./callHelpEarlierCalls";
import { judge } from "./earlierCalls";
import { citedOfPlaces, earlierStartedOf } from "./earlierCallsReport";
import { judgeOf } from "./judge";
import { openLedger } from "./ledger";
import type { PairedRow } from "./pairedReport";
import { env } from "./settings";

const ROOT = resolve(__dirname, "../..");

test.skipIf(env("REJUDGE") === null)(
  "the earlier-call set's saved replies, judged again",
  async () => {
    const path = env("REJUDGE") ?? "";
    const read: { rows: PairedRow[] } = JSON.parse(await readFile(path, "utf8"));
    const rows = read.rows.filter((row) => row.set === "call-help-earlier-calls");
    const stopUsd = Number(env("STOP_USD") ?? "1.50");
    const startedAt = new Date().toISOString();
    const ledger = await openLedger(env("LEDGER"), `${startedAt} re-judge of ${path}`);
    const judged = judgeOf([]);
    let attempts = 0;
    const refused: string[] = [];
    const counting: LanguageModelMiddleware = {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        attempts++;
        try {
          return await doGenerate();
        } catch (error) {
          refused.push(error instanceof Error ? error.message.slice(0, 120) : String(error));
          throw error;
        }
      },
    };
    const model = wrapLanguageModel({ model: judged.model, middleware: counting });
    const lines: string[] = [];
    const results: unknown[] = [];
    let number = 0;
    for (const row of rows) {
      const caseId = row.id.replace(/-(say|answer|check|last-time)$/, "");
      const each = EARLIER_CALL_CASES.find((known) => known.id === caseId);
      if (!each) throw new Error(`No case ${caseId}.`);
      for (const [arm, run] of [
        ["first", row.baseline],
        ["second", row.candidate],
      ] as const) {
        number++;
        if (ledger.before + judged.spent() >= stopUsd) {
          lines.push(`#${number} not judged: the stop of $${stopUsd} is reached`);
          continue;
        }
        const before = run.callReading?.earlierAsThis ?? null;
        try {
          const reading = await judge(
            model,
            each,
            row.kind === "last-time" ? "last-time" : "button",
            earlierStartedOf(rows, caseId),
            run.text,
            citedOfPlaces(run.places ?? []),
          );
          results.push({ number, id: row.id, arm, before, after: reading });
          lines.push(
            `#${number} ${row.id} ${arm}: earlierAsThis ${before} -> ${reading.earlierAsThis}${before !== reading.earlierAsThis ? "  CHANGED" : ""}`,
          );
        } catch (error) {
          results.push({ number, id: row.id, arm, before, failed: String(error) });
          lines.push(`#${number} ${row.id} ${arm}: the judge failed`);
        }
      }
    }
    await ledger.record(judged.spent());
    const out = join(
      ROOT,
      "eval",
      "results",
      `earlier-calls-rejudge-${startedAt.replace(/[:.]/g, "-")}`,
    );
    await mkdir(out, { recursive: true });
    const changed = lines.filter((line) => line.endsWith("CHANGED")).length;
    const summary = [
      `# The earlier-call set's replies judged again`,
      "",
      `${startedAt} · ${path} · judge ${judged.name}. ${number} replies; ${attempts} judge requests, ${refused.length} refused or failed${refused.length ? ` (${refused.join("; ")})` : ""}: the re-judging ${refused.length === 0 ? "counts" : "is void"}. Changed: ${changed}. Spent $${judged.spent().toFixed(3)}; with the runs before it $${(ledger.before + judged.spent()).toFixed(3)} of $${stopUsd}.`,
      "",
      ...lines,
    ].join("\n");
    await writeFile(join(out, "rejudge.md"), `${summary}\n`);
    await writeFile(
      join(out, "rejudge.json"),
      `${JSON.stringify({ attempts, refused, results }, null, 2)}\n`,
    );
    console.log(summary);
  },
);
