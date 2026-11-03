/**
 * "Make the summary longer." over a summary with bold labels that the assistant wrote and that
 * still waits (#1897), against real models, in English and in Chinese: the Mind ends with a
 * longer summary, the labels it first wrote still bold, and no asterisks in its words. Each model runs
 * only when its key is in the environment; the variables are those of
 * ./assistantChangesMinds.live.test.ts.
 *
 * Set INCARNAMIND_LIVE_REPORT to a file to keep what each run gave back.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { ChatProviderKind, Core } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, resolveChanges } from "../helpers/minds";

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
  ];

const CASES = [
  {
    language: "English",
    file: "Job post.md",
    contents: [
      "# Senior analyst, finance team",
      "The post is a senior analyst position in the finance team, reporting to the head of finance. The postholder prepares the monthly forecast and the budget reports.",
      "Work is full time, from Monday to Friday, with core hours between 9:30 and 15:30. Up to two days a week may be worked from home.",
      "The salary is set by grade 7 and paid monthly, with a pension contribution of eight percent from the employer.",
    ].join("\n\n"),
    first:
      "Write a short summary of the job post into this note, as three short paragraphs, each starting with a bold label: Role. Hours. Pay.",
    second: "Make the summary longer.",
  },
  {
    language: "Chinese",
    file: "招聘启事.md",
    contents: [
      "# 财务团队高级分析师",
      "该岗位是财务团队的高级分析岗位，向财务负责人汇报。任职者负责编制月度预测和预算报告。",
      "全职，周一至周五上班，核心工作时间为9:30至15:30。每周最多可以在家办公两天。",
      "薪酬按7级确定，按月发放，雇主另按百分之八缴纳养老金。",
    ].join("\n\n"),
    first:
      "把招聘启事写成一份简短摘要放进这个笔记，分三段，每段以加粗的标签开头：职位、工时、薪酬。",
    second: "把摘要写得更长一些。",
  },
] as const;

async function ask(core: Core, text: string, mindId: string, folderId: string) {
  const result = await core.askInConversation({
    text,
    mindId,
    scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
  });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await new Promise<void>((resolve) => {
    const stops = [
      core.on("answer.finished", ({ answerId }) => answerId === result.answerId && done()),
      core.on("answer.failed", ({ answerId }) => answerId === result.answerId && done()),
    ];
    function done() {
      for (const stop of stops) stop();
      resolve();
    }
  });
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

/** The words of the Mind that are bold, whatever waits in it. */
function boldWords(client: MindClient): string[] {
  const found: string[] = [];
  readMind(client).descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === "bold")) {
      const word = (node.text ?? "").replace(/[\s:：.。]+$/u, "").trim();
      if (word !== "" && !found.includes(word)) found.push(word);
    }
    return true;
  });
  return found;
}

/** The Mind's words as they stand once its changes are accepted, and which of them are bold. */
async function wordsOf(client: MindClient) {
  await client.settled();
  await resolveChanges(client, "accept");
  let text = "";
  let bold = "";
  readMind(client).descendants((node) => {
    if (!node.isText) return true;
    text += `${node.text}\n`;
    if (node.marks.some((mark) => mark.type.name === "bold")) bold += `${node.text}|`;
    return false;
  });
  return { text, bold };
}

describe.each(LIVE)("Make the summary longer, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: the assistant's waiting summary is made longer in place, labels bold, no asterisks`,
    { timeout: 1_800_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 3);
      const report: string[] = [`## ${live.name} · ${live.model} (#1897, make it longer)`];
      const checks: (() => void)[] = [];
      for (const each of CASES) {
        let clean = 0;
        let bolded = 0;
        let longer = 0;
        let keptLabels = 0;
        let firstLabels = 0;
        for (let run = 1; run <= runs; run++) {
          const core = startCore(await createTempDataFolder(), {
            createChatModel: createAiSdkChatModel,
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
          const sources = await createSourceFolder();
          const folder = await core.createLibraryGroup({ name: each.language, description: "" });
          const added = await core.addDocuments(
            [await writeSourceFile(sources, each.file, each.contents)],
            { groupId: folder.id },
          );
          await waitForProcessing(
            core,
            added.documents.map((document) => document.id),
          );
          const mind = await core.createMind({ title: each.language, folderId: folder.id });
          const client = await connectToMind(core, mind.id);
          await client.settled();
          const first = await ask(core, each.first, mind.id, folder.id);
          const writtenText = readMind(client).textContent;
          const written = writtenText.length;
          await client.settled();
          const labels = boldWords(client);
          firstLabels += labels.length;
          const second = await ask(core, each.second, mind.id, folder.id);
          const { text, bold } = await wordsOf(client);
          const tools = second.toolCalls.map((call) => call.tool).join(", ");
          if (!text.includes("*")) clean++;
          const kept = labels.filter((label) => text.includes(label));
          keptLabels += kept.length;
          if (labels.length >= 2 && kept.every((label) => bold.includes(label))) bolded++;
          if (text.length > written) longer++;
          report.push(
            `- ${each.language} run ${run}: first ${first.status}, then ${second.status} (${tools || "no tools"}); bold: ${bold}`,
            `  ${text.replace(/\n/g, " ⏎ ").slice(0, 900)}`,
          );
          core.close();
        }
        report.push(
          `  ${each.language}: no asterisks ${clean}/${runs}, labels still there are bold ${bolded}/${runs} (${keptLabels} of ${firstLabels} labels still there), longer ${longer}/${runs}`,
        );
        checks.push(() => {
          expect(clean).toBe(runs);
          expect(bolded).toBe(runs);
          expect(longer).toBe(runs);
        });
      }
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      for (const check of checks) check();
    },
  );
});
