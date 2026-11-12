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
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import type { ChatProviderKind, EditAction } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { pageBlocks } from "../../src/shared/answerBlocks";
import { readFigures } from "../../src/shared/figures";
import { answerEnded, answerJudged } from "../helpers/citations";
import { createTempDataFolder, queryDatabase, spentBy, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
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

/**
 * A later Answer asked to work the missing figure out and put it in (#2577): it may land a
 * calculated figure where the mark is, or keep the mark, but never a number typed as text. A
 * change that takes the mark out without a calculated figure is refused, and the model is told so.
 */
const TRY_AGAIN = {
  en: {
    document: [
      "# Harbour branch loans",
      "",
      "Harbour branch made 1,000 loans in January 2026 and 1,080 loans in February 2026.",
    ].join("\n"),
    sentence: "Harbour's loans grew by [=1] last month.",
    key: "Harbour",
    question: "Work out the growth this note is missing from the loans document and put it in.",
  },
  "zh-CN": {
    document: [
      "# 港湾分馆借阅",
      "",
      "港湾分馆 2026 年 1 月借阅 1,000 次，2026 年 2 月借阅 1,080 次。",
    ].join("\n"),
    sentence: "港湾分馆的借阅量上月增长了 [=1]。",
    key: "港湾",
    question: "根据借阅文档算出这篇笔记缺少的增长率，并写进去。",
  },
} as const;

type TryOutcome = "calculated figure" | "mark kept" | "number as text" | "other";

describe.each(LIVE)("A later Answer and the mark, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: the mark gives way only to a calculated figure`,
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 1);
      const cap = Number(process.env.INCARNAMIND_LIVE_MAX_USD ?? 0.5);
      const report: string[] = [`## ${live.name} · ${live.model} (#2577, a later Answer)`];
      const counts = new Map<string, number>();
      const requestsFailed: string[] = [];
      let answersFailed = 0;
      const afterRefusal = { runs: 0, ended: 0 };
      let spent = 0;
      for (const language of ["en", "zh-CN"] as const) {
        const only = process.env.INCARNAMIND_LIVE_ONLY?.split("|");
        if (only && !only.includes(`${language} try-again`)) continue;
        const words = TRY_AGAIN[language];
        for (let run = 1; run <= runs; run++) {
          if (spent >= cap) break;
          const dataDir = await createTempDataFolder();
          const failing = (part: unknown) => requestsFailed.push(String(part).slice(0, 200));
          const core = startCore(dataDir, {
            createChatModel: (spec) =>
              wrapLanguageModel({
                model: createAiSdkChatModel(spec),
                middleware: {
                  specificationVersion: "v4",
                  wrapGenerate: async ({ doGenerate }) => {
                    try {
                      return await doGenerate();
                    } catch (error) {
                      failing(error);
                      throw error;
                    }
                  },
                  wrapStream: async ({ doStream }) => {
                    try {
                      const result = await doStream();
                      return {
                        ...result,
                        stream: result.stream.pipeThrough(
                          new TransformStream({
                            transform(part, controller) {
                              if (part.type === "error") failing(part.error);
                              controller.enqueue(part);
                            },
                          }),
                        ),
                      };
                    } catch (error) {
                      failing(error);
                      throw error;
                    }
                  },
                },
              }),
          });
          core.on(
            "consent.requested",
            (asked) => void core.respondToConsent(asked.requestId, true),
          );
          await core.saveChatProvider({
            kind: live.kind,
            ...(live.apiKey && { apiKey: live.apiKey }),
            modelId: live.model,
          });
          await core.updateSettings({ user: { language } });
          await addAndProcess(core, [
            await writeSourceFile(await createTempDataFolder(), "Loans.md", words.document),
          ]);
          const mind = await core.createMind({ title: language === "en" ? "Growth" : "增长" });
          await core.addToNote({
            mindId: mind.id,
            blocks: pageBlocks(
              { id: "earlier", text: words.sentence, citations: [], figures: [], status: "done" },
              "",
            ),
            origin: null,
            model: null,
          });
          const asked = await core.askInConversation({ text: words.question, mindId: mind.id });
          if (!asked.asked) throw new Error("The Question wasn't asked.");
          const ended = await answerEnded(core, asked.answerId);
          const answer = await answerJudged(core, asked.conversation.id, asked.answerId);
          if (ended.event !== "finished") answersFailed++;
          const client = await connectToMind(core, mind.id);
          await client.settled();
          await resolveChanges(client, "accept");
          await client.settled();
          /** Each paragraph's marks, calculated figures and words, and the Note as it reads. */
          const paragraphs: { marks: number; figures: number; said: string }[] = [];
          let shown = "";
          readMind(client).descendants((block) => {
            if (!block.isTextblock) return true;
            const read = { marks: 0, figures: 0, said: "" };
            block.forEach((node) => {
              if (node.type.name === "missingNumber") {
                read.marks++;
                shown += "[mark]";
              } else if (node.type.name === "calculatedFigure") {
                read.figures++;
                shown += `{${String((node.attrs.figure as { shown?: string } | null)?.shown ?? "")}}`;
              } else if (node.isText) {
                read.said += node.text ?? "";
                shown += node.text ?? "";
              }
            });
            shown += " / ";
            paragraphs.push(read);
            return false;
          });
          // The sentence that held the mark, by its words; else the Note as a whole.
          const kept = paragraphs.find((each) => each.said.includes(words.key));
          const { marks, figures, said } = kept ?? {
            marks: paragraphs.reduce((sum, each) => sum + each.marks, 0),
            figures: paragraphs.reduce((sum, each) => sum + each.figures, 0),
            said: paragraphs.map((each) => each.said).join(" "),
          };
          const refused = answer.toolCalls.filter(
            (call) => call.mindProblem?.kind === "missing-number",
          ).length;
          // Digits beside a figure that landed are the sentence's other numbers, such as the two
          // the figure was worked out from; only digits with neither figure nor mark took its place.
          const outcome: TryOutcome =
            figures > 0 && marks === 0
              ? "calculated figure"
              : marks > 0 && figures === 0
                ? "mark kept"
                : figures === 0 && marks === 0 && /\d/.test(said)
                  ? "number as text"
                  : "other";
          if (refused > 0) {
            afterRefusal.runs++;
            if (outcome === "calculated figure" || outcome === "mark kept") afterRefusal.ended++;
          }
          const key = `${language}: ${outcome}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
          const calls = answer.toolCalls
            .filter((call) => call.source === "minds")
            .map(
              (call) =>
                `${call.tool}:${call.status}${call.mindProblem ? `(${call.mindProblem.kind})` : ""}`,
            )
            .join(", ");
          report.push(
            `- ${language} ${run}: ${outcome}; refused ${refused}; calls ${calls}; answer ${ended.event} · ${shown.replace(/\n/g, " ")}`,
          );
          const cost =
            queryDatabase<{ cost: number | null }>(
              dataDir,
              "SELECT SUM(cost) AS cost FROM model_requests WHERE deleted_at IS NULL",
            )[0]?.cost ?? 0;
          spent += cost;
          report.push(`  ${spentBy(dataDir).join("; ")}`);
          core.close();
        }
      }
      report.push(
        "",
        ...[...counts].map(([key, count]) => `- ${key}: ${count}`),
        `- after a refusal, ended with a calculated figure or the mark: ${afterRefusal.ended} of ${afterRefusal.runs}`,
        `- failed or refused requests: ${requestsFailed.length}; Answers not finished: ${answersFailed}`,
        ...requestsFailed.map((each) => `  - ${each}`),
        `- spent: ${spent.toFixed(4)} USD`,
      );
      if (process.env.INCARNAMIND_LIVE_REPORT)
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      console.log(report.join("\n"));
      expect(requestsFailed).toEqual([]);
      expect([...counts.keys()].some((key) => key.endsWith("number as text"))).toBe(false);
    },
  );
});
