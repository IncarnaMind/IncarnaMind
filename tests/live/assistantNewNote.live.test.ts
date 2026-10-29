/**
 * "Make the summary longer." over a Note the assistant made a moment ago from a Document (#1898),
 * against real models, in English and in Chinese: the second request is carried out (none of its
 * Tool calls is refused), the Note keeps its title heading, and it ends up longer. Each model runs
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
import { connectToMind } from "../helpers/mindClient";
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
    first: "Write a short summary of the job post as a new note, in plain paragraphs.",
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
    first: "把招聘启事写成一份简短的摘要，放进一个新笔记，用普通段落。",
    second: "把摘要写得更长一些。",
  },
] as const;

async function ask(core: Core, text: string, folderId: string, mindId?: string) {
  const result = await core.askInConversation({
    text,
    ...(mindId && { mindId }),
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

describe.each(LIVE)("Make the summary longer in a Note the assistant made, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: the second request is carried out in the same Note, whose title stays`,
    { timeout: 1_800_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 5);
      const report: string[] = [`## ${live.name} · ${live.model} (#1898, a new Note made longer)`];
      const checks: (() => void)[] = [];
      for (const each of CASES) {
        let made = 0;
        let carriedOut = 0;
        let titled = 0;
        let longer = 0;
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
          const first = await ask(core, each.first, folder.id);
          const noteId = first.toolCalls.flatMap((call) =>
            call.mindChange?.created ? [call.mindChange.mindId] : [],
          )[0];
          if (!noteId) {
            report.push(`- ${each.language} run ${run}: no Note made (${first.status})`);
            core.close();
            continue;
          }
          made++;
          const client = await connectToMind(core, noteId);
          await client.settled();
          const before = readMind(client).textContent.length;
          const second = await ask(core, each.second, folder.id, noteId);
          const calls = second.toolCalls.map((call) => `${call.tool}:${call.status}`).join(", ");
          const refused = second.toolCalls.some(
            (call) => call.source === "minds" && call.status === "failed",
          );
          await client.settled();
          await resolveChanges(client, "accept");
          await client.settled();
          const note = readMind(client);
          const heading = note.firstChild;
          const text = note.textContent;
          if (!refused) carriedOut++;
          if (heading?.type.name === "heading" && heading.textContent.trim() !== "") titled++;
          if (text.length > before) longer++;
          report.push(
            `- ${each.language} run ${run}: ${calls || "no tools"}; heading "${heading?.textContent ?? ""}"; ${before} → ${text.length} characters`,
          );
          core.close();
        }
        report.push(
          `  ${each.language}: Note made ${made}/${runs}, second request not refused ${carriedOut}/${runs}, title kept ${titled}/${runs}, longer ${longer}/${runs}`,
        );
        checks.push(() => {
          expect(made).toBe(runs);
          expect(carriedOut).toBe(runs);
          expect(titled).toBe(runs);
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
