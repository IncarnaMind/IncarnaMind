import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { wrapLanguageModel } from "ai";
import { test } from "vitest";
import { spendOf } from "../../scripts/nightlyRealModel";
import { unbackedClaims } from "../../src/core/answers/claimedChanges";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { chatModelSpecOf, readConfig } from "../lib/config";
import { createLog } from "../lib/log";
import {
  ALL_PROBES,
  BACKED_WRITE_REPLY,
  BACKED_WRITE_REQUEST,
  MINDS,
  names,
  parts,
  requestOf,
  writeCall,
} from "./claimProbes";

const ROOT = resolve(__dirname, "../..");

test.skipIf(process.env.INCARNAMIND_EVAL_EVERYDAY !== "claim-probes")(
  "change-claim probes",
  async () => {
    const log = createLog();
    const config = readConfig(ROOT);
    if (!config.chat) {
      log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY.");
      return;
    }
    // Every request the provider refused, failed or let time out, in its own words, so a run is
    // counted only when it has none: a check with one is never read as "nothing flagged".
    let refused: string[] = [];
    // Each question's requests and tokens, so the report gives what the second question costs and
    // how many checks sent it (#2878).
    let asked: string[] = [];
    const questions: Record<
      string,
      { requests: number; inputTokens: number; cachedInputTokens: number; outputTokens: number }
    > = {};
    const model = wrapLanguageModel({
      model: createAiSdkChatModel({ ...chatModelSpecOf(config.chat), thinking: "off" }),
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate, params }) => {
          const question = String(params.providerOptions?.incarnamind?.question ?? "other");
          asked.push(question);
          try {
            const result = await doGenerate();
            const tally = questions[question] ?? {
              requests: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
            };
            tally.requests += 1;
            tally.inputTokens += result.usage.inputTokens.total ?? 0;
            tally.cachedInputTokens += result.usage.inputTokens.cacheRead ?? 0;
            tally.outputTokens += result.usage.outputTokens.total ?? 0;
            questions[question] = tally;
            return result;
          } catch (error) {
            refused.push(error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
      },
    });
    const rows: {
      id: string;
      run: number;
      expected: boolean;
      claims: string[];
      commands: string[];
      durationMs: number;
      passed: boolean;
      unchecked?: true;
      refused?: string[];
      /** Which question flagged it: the claims the check named, or the reply read whole (#2878). */
      flaggedBy?: ("claims" | "request")[];
      /** The check also asked whether the reply says the request is done. */
      askedDone?: true;
    }[] = [];
    const allRefused: string[] = [];
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    };
    const runs = Number(process.env.INCARNAMIND_EVAL_CLAIM_PROBES_RUNS ?? "5") || 5;
    const only = process.env.INCARNAMIND_EVAL_CLAIM_PROBES_ONLY?.split(",");
    for (const each of ALL_PROBES) requestOf(each.id);
    for (const probe of ALL_PROBES.filter((each) => !only || only.includes(each.id))) {
      for (let run = 1; run <= runs; run++) {
        const check = () => {
          refused = [];
          asked = [];
          return unbackedClaims(probe.reply, probe.calls ?? [], MINDS, probe.focused ?? null, {
            model,
            request: requestOf(probe.id),
            names,
            parts,
            // The window applies a change the User asked for at once, with Undo, unless the probe
            // has it wait.
            states: (change) =>
              probe.waiting?.includes(change.request)
                ? null
                : { waiting: 0, accepted: 0, rejected: 0, applied: true },
            signal: new AbortController().signal,
          });
        };
        // A check the provider didn't answer gives no verdict, and reads as "nothing flagged": it is
        // asked again, and one never answered is counted apart rather than as a probe's result.
        const unanswered = (checked: Awaited<ReturnType<typeof check>>) =>
          refused.length > 0 || (checked.failed === true && !checked.usage);
        let result = await check();
        allRefused.push(...refused);
        for (let retry = 0; retry < 2 && unanswered(result); retry++) {
          result = await check();
          allRefused.push(...refused);
        }
        const unchecked = unanswered(result);
        if (result.usage) {
          usage.inputTokens += result.usage.inputTokens ?? 0;
          usage.outputTokens += result.usage.outputTokens ?? 0;
          usage.cachedInputTokens += result.usage.cachedInputTokens ?? 0;
          usage.cacheWriteTokens += result.usage.cacheWriteTokens ?? 0;
        }
        const flaggedBy = [
          ...(result.claims.length + result.commands.length > 0 ? ["claims" as const] : []),
          ...(result.unfinished ? ["request" as const] : []),
        ];
        const flagged = flaggedBy.length > 0;
        const passed = probe.unbacked ? flagged : !flagged;
        rows.push({
          id: probe.id,
          run,
          expected: probe.unbacked,
          claims: result.claims,
          commands: result.commands,
          durationMs: result.durationMs,
          passed: passed && !unchecked,
          ...(unchecked && { unchecked: true as const, refused }),
          ...(flagged && { flaggedBy }),
          ...(asked.includes("request-done") && { askedDone: true as const }),
        });
      }
    }
    const backed = await unbackedClaims(BACKED_WRITE_REPLY, [writeCall], MINDS, null, {
      model,
      request: BACKED_WRITE_REQUEST,
      names,
      parts,
      states: () => ({ waiting: 0, accepted: 0, rejected: 0, applied: true }),
      signal: new AbortController().signal,
    });
    if (backed.usage) {
      usage.inputTokens += backed.usage.inputTokens ?? 0;
      usage.outputTokens += backed.usage.outputTokens ?? 0;
      usage.cachedInputTokens += backed.usage.cachedInputTokens ?? 0;
      usage.cacheWriteTokens += backed.usage.cacheWriteTokens ?? 0;
    }
    const backedPassed =
      backed.claims.length + backed.commands.length === 0 && backed.unfinished !== true;
    const failed = rows.filter((row) => !row.passed).length + (backedPassed ? 0 : 1);
    const checked = rows.filter((row) => !row.unchecked);
    const spent = spendOf(
      [{ ...usage, model: config.chat.modelId }],
      config.chat.kind === "kimi" ? "kimi" : "anthropic",
    );
    const durationMs = rows.reduce((sum, row) => sum + row.durationMs, 0) + backed.durationMs;
    const folder = join(
      config.resultsDir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-claim-probes`,
    );
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "report.json"),
      JSON.stringify(
        {
          model: `${config.chat.kind}/${config.chat.modelId}`,
          runs,
          rows,
          backed: {
            claims: backed.claims,
            commands: backed.commands,
            passed: backedPassed,
            durationMs: backed.durationMs,
          },
          usage,
          durationMs,
          spent,
          refused: allRefused,
          questions,
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(folder, "report.md"),
      [
        `# Change-claim probes: ${config.chat.kind}/${config.chat.modelId}`,
        "",
        `- Unmade claims caught: ${checked.filter((row) => row.expected && row.passed).length}/${checked.filter((row) => row.expected).length}`,
        `- Honest replies left alone: ${checked.filter((row) => !row.expected && row.passed).length}/${checked.filter((row) => !row.expected).length}; backed write left alone: ${backedPassed ? 1 : 0}/1`,
        `- Checks the provider never answered, in three tries: ${rows.length - checked.length}`,
        `- Requests the provider refused, failed or let time out, every try counted: ${allRefused.length}`,
        `- Checks that also asked whether the reply says the request is done: ${rows.filter((row) => row.askedDone).length} of ${rows.length}; that question's requests: ${JSON.stringify(questions["request-done"] ?? null)}`,
        `- Judge time: ${durationMs} ms total, ${Math.round(durationMs / (rows.length + 1))} ms per check`,
        `- Spend: $${spent.dollars.toFixed(4)}; unpriced tokens: ${spent.unpricedTokens}`,
        `- Failed checks: ${failed}`,
        "",
        "Details are in report.json.",
      ].join("\n"),
    );
    log(
      `${rows.length - rows.filter((row) => !row.passed).length}/${rows.length} probes passed; report in ${folder}`,
    );
    if (failed > 0) throw new Error(`${failed} change-claim probes failed.`);
  },
);
