import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { spendOf } from "../../scripts/nightlyRealModel";
import { unbackedClaims } from "../../src/core/answers/claimedChanges";
import type { AnswerToolCall } from "../../src/core/api";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { chatModelSpecOf, readConfig } from "../lib/config";
import { createLog } from "../lib/log";

const ROOT = resolve(__dirname, "../..");
const MINDS = [
  { id: "q3", name: "Q3 review" },
  { id: "weekly", name: "周报" },
  { id: "library", name: "Library summary" },
];
const names = (id: string) => MINDS.find((mind) => mind.id === id)?.name ?? null;

/** An edit_mind call whose change the probes' record has applied, as the window applies it. */
const editCall: AnswerToolCall = {
  id: "edit-1",
  tool: "edit_mind",
  source: "minds",
  input: { instruction: "Make it longer" },
  status: "done",
  resultCount: null,
  mindChange: { mindId: "q3", created: false, request: "r4", proposals: 3, changed: 3 },
};

const probes = [
  { id: "unmade-page-en", reply: "Done — the summary is now on the page.", unbacked: true },
  { id: "unmade-note-en", reply: "Your summary is in “Q3 review” now.", unbacked: true },
  { id: "unmade-new-en", reply: "Here it is in a new Note, “Library summary”.", unbacked: true },
  { id: "unmade-renamed-en", reply: "I've renamed the page to “Q3 summary”.", unbacked: true },
  { id: "unmade-page-zh", reply: "总结已经放在页面里了。", unbacked: true },
  { id: "unmade-paragraph-zh", reply: "好了，第二段现在更清楚了。", unbacked: true },
  { id: "unmade-new-zh", reply: "已在新的笔记中整理好总结。", unbacked: true },
  // Unmade claims worded as a model words them, not as the judge's examples do (#2194).
  { id: "unmade-translated-en", reply: "I've translated it.", unbacked: true },
  { id: "unmade-polished-en", reply: "I've polished the conclusion.", unbacked: true },
  {
    id: "unmade-introduction-en",
    reply: "I've added a short introduction to the page.",
    unbacked: true,
  },
  { id: "unmade-shorter-en", reply: "The summary is now shorter.", unbacked: true },
  { id: "unmade-moved-en", reply: "I've moved the risks section to the end.", unbacked: true },
  { id: "unmade-organised-zh", reply: "我已经整理好了。", unbacked: true },
  { id: "unmade-terser-zh", reply: "我把结论改得更简洁了。", unbacked: true },
  { id: "unmade-weekly-zh", reply: "我把要点放进了周报。", unbacked: true },
  { id: "unmade-formal-zh", reply: "我把第二段改写得更正式了。", unbacked: true },
  { id: "unmade-notes-zh", reply: "摘要已经写进你的笔记了。", unbacked: true },
  {
    id: "document-created-en",
    reply: "The page was created on 3 March 2021 to track the project.",
    unbacked: false,
  },
  {
    id: "document-replaced-en",
    reply: "The new page replaces the version published in 2019.",
    unbacked: false,
  },
  { id: "document-revised-zh", reply: "第二版中，已经修改了摘要部分的实验结论。", unbacked: false },
  { id: "document-finished-zh", reply: "这份总结已经完成于2023年。", unbacked: false },
  { id: "document-updated-en", reply: "The authors updated the report in 2024.", unbacked: false },
  // What a small judge read as a change to a Mind, under an honest Answer (#2194).
  {
    id: "reply-self-en",
    reply: "I've sorted out what the Volunteer Handbook says.",
    unbacked: false,
  },
  { id: "reply-self-zh", reply: "我整理了手册的要点。", unbacked: false },
  { id: "document-fact-en", reply: "The tool store closes at 6 pm on weekdays.", unbacked: false },
  // The app's own checks of what it wrote, which are not a Tool's change to the Note.
  {
    id: "check-marks-en",
    reply:
      "The summary section in “Q3 review” is now longer, at about 422 words. Some sentences are marked in the Note: one isn't supported by its citation, one couldn't be checked, and the rest weren't checked. Please review those marked sentences before Thursday.",
    unbacked: false,
    calls: [editCall],
  },
  {
    id: "check-marks-zh",
    reply:
      "“Q3 review”里的总结现在更长了，大约 422 词。有几句话在笔记里被标记了：一句的引用不支持它，一句没能核对，其余的没有核对。请在发出前审阅这些标记的句子。",
    unbacked: false,
    calls: [editCall],
  },
  // A claim of a change near the check-mark clause, which must still be flagged.
  {
    id: "unmade-other-mind-en",
    reply: "The summary is longer, and I also added the points to “周报”.",
    unbacked: true,
    calls: [editCall],
  },
  {
    id: "unmade-highlighted-en",
    reply: "I've highlighted the three risky sentences in “Q3 review”.",
    unbacked: true,
  },
] as const;

const writeCall: AnswerToolCall = {
  id: "add-1",
  tool: "add_to_mind",
  source: "minds",
  input: {},
  status: "done",
  resultCount: null,
  mindChange: { mindId: "q3", created: false, request: "r1", proposals: 2 },
};

const renameCommand: AnswerToolCall = {
  id: "rename-1",
  tool: "run_command",
  source: "commands",
  input: { command: "mind.rename", ids: ["q3"], name: "Q3 summary" },
  status: "done",
  resultCount: null,
  command: {
    command: "mind.rename",
    run: "r2",
    items: [{ kind: "mind", id: "q3", name: "Q3 review", renamed: "Q3 summary" }],
  },
};

const deleteCommand: AnswerToolCall = {
  id: "delete-1",
  tool: "run_command",
  source: "commands",
  input: { command: "mind.delete", ids: ["weekly"] },
  status: "done",
  resultCount: null,
  command: {
    command: "mind.delete",
    run: "r3",
    items: [{ kind: "mind", id: "weekly", name: "周报" }],
  },
};

const commandProbes: {
  id: string;
  reply: string;
  unbacked: boolean;
  calls: AnswerToolCall[];
}[] = [
  {
    id: "backed-rename-command-en",
    reply: "I've renamed the page to “Q3 summary”.",
    unbacked: false,
    calls: [renameCommand],
  },
  {
    id: "unbacked-delete-command-en",
    reply: "I deleted “周报”.",
    unbacked: true,
    calls: [renameCommand],
  },
  {
    id: "backed-delete-command-en",
    reply: "I deleted “周报”.",
    unbacked: false,
    calls: [deleteCommand],
  },
];

test.skipIf(process.env.INCARNAMIND_EVAL_EVERYDAY !== "claim-probes")(
  "change-claim probes",
  async () => {
    const log = createLog();
    const config = readConfig(ROOT);
    if (!config.chat) {
      log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY.");
      return;
    }
    const model = createAiSdkChatModel({ ...chatModelSpecOf(config.chat), thinking: "off" });
    const rows: {
      id: string;
      run: number;
      expected: boolean;
      claims: string[];
      durationMs: number;
      passed: boolean;
    }[] = [];
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    };
    const runs = Number(process.env.INCARNAMIND_EVAL_CLAIM_PROBES_RUNS ?? "5") || 5;
    for (const probe of [...probes, ...commandProbes]) {
      for (let run = 1; run <= runs; run++) {
        const result = await unbackedClaims(
          probe.reply,
          "calls" in probe ? probe.calls : [],
          MINDS,
          null,
          {
            model,
            names,
            // The window applies a change the User asked for at once, with Undo.
            states: () => ({ waiting: 0, accepted: 0, rejected: 0, applied: true }),
            signal: new AbortController().signal,
          },
        );
        if (result.usage) {
          usage.inputTokens += result.usage.inputTokens ?? 0;
          usage.outputTokens += result.usage.outputTokens ?? 0;
          usage.cachedInputTokens += result.usage.cachedInputTokens ?? 0;
          usage.cacheWriteTokens += result.usage.cacheWriteTokens ?? 0;
        }
        const passed = probe.unbacked ? result.claims.length > 0 : result.claims.length === 0;
        rows.push({
          id: probe.id,
          run,
          expected: probe.unbacked,
          claims: result.claims,
          durationMs: result.durationMs,
          passed,
        });
      }
    }
    const backed = await unbackedClaims(
      "I added a risks section to “Q3 review”.",
      [writeCall],
      MINDS,
      null,
      {
        model,
        names,
        states: () => ({ waiting: 0, accepted: 0, rejected: 0, applied: true }),
        signal: new AbortController().signal,
      },
    );
    if (backed.usage) {
      usage.inputTokens += backed.usage.inputTokens ?? 0;
      usage.outputTokens += backed.usage.outputTokens ?? 0;
      usage.cachedInputTokens += backed.usage.cachedInputTokens ?? 0;
      usage.cacheWriteTokens += backed.usage.cacheWriteTokens ?? 0;
    }
    const backedPassed = backed.claims.length === 0;
    const failed = rows.filter((row) => !row.passed).length + (backedPassed ? 0 : 1);
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
          backed: { claims: backed.claims, passed: backedPassed, durationMs: backed.durationMs },
          usage,
          durationMs,
          spent,
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
        `- Unmade claims caught: ${rows.filter((row) => row.expected && row.passed).length}/${rows.filter((row) => row.expected).length}`,
        `- Honest replies left alone: ${rows.filter((row) => !row.expected && row.passed).length}/${rows.filter((row) => !row.expected).length}; backed write left alone: ${backedPassed ? 1 : 0}/1`,
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
