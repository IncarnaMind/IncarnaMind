/**
 * Edit with AI on a paragraph that holds the mark where a figure couldn't be calculated, against
 * real models (#2577): the model reads the mark as "[number missing]" (in Chinese, "[缺少数字]"),
 * and the words it writes back are the mark again. One paragraph with the mark and two other
 * numbers, in English and in Chinese, made shorter and translated into the other language, a few
 * times each. Each run is counted as one of: the mark kept; the gap kept in other words; the mark
 * dropped; a number in its place; and beside it, whether the two other numbers came back as they
 * were. A run counts only when its request neither failed nor was refused.
 *
 *   INCARNAMIND_LIVE_ANTHROPIC_KEY   Claude (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default)
 *   INCARNAMIND_LIVE_DEEPSEEK_KEY    DeepSeek (INCARNAMIND_LIVE_DEEPSEEK_MODEL, deepseek-flash by default)
 *   INCARNAMIND_LIVE_RUNS            runs of each language and instruction (1)
 *   INCARNAMIND_LIVE_ONLY            only these, e.g. "en shorter|zh-CN translate"
 *   INCARNAMIND_LIVE_MAX_USD         stops before the next run once the spend reaches it (0.5)
 *   INCARNAMIND_LIVE_REPORT          a file to keep each run's line and the totals
 *
 * Names of their own, so a key a shell has for other tools never starts paid requests here.
 */
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { ChatProviderKind, EditAction } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { readFigures } from "../../src/shared/figures";
import { createTempDataFolder, queryDatabase, spentBy, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { readMind, resolveChanges, writeMind } from "../helpers/minds";

const LIVE: { name: string; kind: ChatProviderKind; apiKey: string | undefined; model: string }[] =
  [
    {
      name: "Anthropic",
      kind: "anthropic",
      apiKey: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
      model:
        process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
        (catalogProvider("anthropic")?.roles.quickTasks as string),
    },
    {
      name: "DeepSeek",
      kind: "deepseek",
      apiKey: process.env.INCARNAMIND_LIVE_DEEPSEEK_KEY,
      model: process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ?? "deepseek-flash",
    },
  ];

const text = (value: string): JSONContent => ({ type: "text", text: value });

/** The paragraph, the mark between `before` and `after`, with two other numbers: 6.5% and 4,120. */
const PARAGRAPHS = {
  en: {
    before: "Harbour's average monthly loan growth was ",
    after: ", after 6.5% the year before, on 4,120 loans.",
    other: "Simplified Chinese (简体中文)",
  },
  "zh-CN": {
    before: "港湾分馆的月均借阅增长率为 ",
    after: "，上一年为 6.5%，借阅 4,120 次。",
    other: "English",
  },
} as const;

type Language = keyof typeof PARAGRAPHS;

const TASKS: { name: string; action: EditAction; instruction: (language: Language) => string }[] = [
  { name: "shorter", action: "shorten", instruction: () => "" },
  {
    name: "translate",
    action: "translate",
    instruction: (language) => PARAGRAPHS[language].other,
  },
];

/** Words that say a number is missing, in either language, as a model may write the gap itself. */
const GAP_WORDS =
  /missing|not available|unavailable|unknown|not calculated|n\/a|缺少|缺失|未知|不详|未能|无法/i;

type Outcome = "mark kept" | "gap in other words" | "mark dropped" | "number in its place";

/** What the run left: the mark, the gap in words, nothing, or a number that isn't one of the two. */
function outcomeOf(marks: number, words: string): { outcome: Outcome; othersKept: boolean } {
  const values = readFigures(words).map((figure) => figure.value);
  const near = (wanted: number) => values.some((value) => Math.abs(value - wanted) < 1e-9);
  const othersKept = near(0.065) && near(4120);
  const extra = values.filter((value) => Math.abs(value - 0.065) >= 1e-9 && value !== 4120);
  const outcome: Outcome =
    extra.length > 0
      ? "number in its place"
      : marks > 0
        ? "mark kept"
        : GAP_WORDS.test(words)
          ? "gap in other words"
          : "mark dropped";
  return { outcome, othersKept };
}

describe.each(LIVE)("The mark through Edit with AI, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: the mark comes back a mark, never a number`,
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 1);
      const cap = Number(process.env.INCARNAMIND_LIVE_MAX_USD ?? 0.5);
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({
        kind: live.kind,
        ...(live.apiKey && { apiKey: live.apiKey }),
        modelId: live.model,
      });
      const spent = () =>
        queryDatabase<{ cost: number | null }>(
          dataDir,
          "SELECT SUM(cost) AS cost FROM model_requests WHERE deleted_at IS NULL",
        )[0]?.cost ?? 0;
      const report: string[] = [`## ${live.name} · ${live.model} (#2577, the mark)`];
      const counts = new Map<string, number>();
      let failed = 0;
      let stopped = false;
      for (const language of ["en", "zh-CN"] as const) {
        await core.updateSettings({ user: { language } });
        const paragraph = PARAGRAPHS[language];
        for (const task of TASKS) {
          const only = process.env.INCARNAMIND_LIVE_ONLY?.split("|");
          if (only && !only.includes(`${language} ${task.name}`)) continue;
          for (let run = 1; run <= runs; run++) {
            if (spent() >= cap) {
              stopped = true;
              break;
            }
            const mind = await core.createMind({ title: `${language} ${task.name} ${run}` });
            const client = await connectToMind(core, mind.id);
            await client.settled();
            writeMind(client, [
              {
                type: "paragraph",
                attrs: { id: "growth" },
                content: [text(paragraph.before), { type: "missingNumber" }, text(paragraph.after)],
              },
            ]);
            await client.settled();
            const plain = `${paragraph.before}￼${paragraph.after}`;
            const instruction = task.instruction(language);
            const result = await core.editWithAi({
              requestId: crypto.randomUUID(),
              mindId: mind.id,
              from: { blockId: "growth", offset: 0 },
              to: { blockId: "growth", offset: plain.length },
              text: plain,
              action: task.action,
              ...(instruction && { instruction }),
            });
            await client.settled();
            if (result.kind === "failed") {
              failed++;
              report.push(
                `- ${language} ${task.name} ${run}: failed, ${result.error.kind} ${result.error.status ?? ""} (void)`,
              );
              continue;
            }
            // A reply that changed nothing, or a change the app refused, leaves the paragraph as it was.
            const note = result.kind === "proposed" ? "" : ` (${result.kind}: nothing written)`;
            if (result.kind === "proposed") await resolveChanges(client, "accept");
            await client.settled();
            let marks = 0;
            let words = "";
            readMind(client).descendants((node) => {
              if (node.type.name === "missingNumber") marks++;
              if (node.isText) words += node.text ?? "";
              return true;
            });
            const { outcome, othersKept } = outcomeOf(marks, words);
            const key = `${language} ${task.name}: ${outcome}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
            report.push(
              `- ${language} ${task.name} ${run}: ${outcome}${note}; other numbers ${othersKept ? "kept" : "changed"}; ${marks} mark(s) · ${words.replace(/\n/g, " ")}`,
            );
          }
        }
      }
      core.close();
      report.push(
        "",
        ...[...counts].map(([key, count]) => `- ${key}: ${count}`),
        `- failed: ${failed}${stopped ? "; stopped at the spending cap" : ""}`,
        ...spentBy(dataDir),
      );
      if (process.env.INCARNAMIND_LIVE_REPORT)
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      console.log(report.join("\n"));
      expect(failed).toBe(0);
      expect([...counts.keys()].some((key) => key.endsWith("number in its place"))).toBe(false);
    },
  );
});
