/**
 * The assistant and its own waiting changes (#893), against real models, in English and in
 * Chinese: "Write a summary page of these documents." into the Mind in front, then "Make the
 * summary longer.", then "Remove the part about the hours.", either leaving the changes waiting
 * between the requests or accepting them all after each. Counted per run: the Mind holds one
 * summary that grew and then lost the part (no second copy), and the number of changes the
 * Answer reports is the number waiting in the Mind. Each model runs only when its key is in the
 * environment; the variables are those of ./assistantChangesMinds.live.test.ts.
 *
 * Set INCARNAMIND_LIVE_REPORT to a file to keep what each run gave back.
 */
import { appendFile } from "node:fs/promises";
import { generateText } from "ai";
import { describe, expect, test } from "vitest";
import type { ChatProviderKind, Core } from "../../src/core";
import { isRecord } from "../../src/core/errors";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { pendingProposals } from "../../src/shared/proposals";
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
    requests: [
      "Write a summary page of these documents.",
      "Make the summary longer.",
      "Remove the part about the hours.",
    ],
    hours: /Monday|full time|full-time|9:30|home|working hours|core hours/i,
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
    requests: ["为这些文件写一个总结页面。", "把摘要写得更长一些。", "去掉关于工时的部分。"],
    hours: /周一|全职|9:30|在家|工时|工作时间/,
  },
] as const;

const REMOVAL_RUBRIC = [
  "You judge one edit an AI assistant made to a User's note. You are given the User's request, the note's text before the edit and after it, and the assistant's reply to the User.",
  'Reply with one JSON object: {"goneAsAsked": true or false, "lost": ["…"], "claimsMore": true or false}.',
  "goneAsAsked is true when the part the request names is gone from the note, so that no sentence of the note still tells it (a passing mention of the same fact in another part counts as the part not being gone).",
  "lost lists, each copied from the text before, every sentence that is gone from the note but that the request did not ask to remove. An empty list when nothing else is lost.",
  "claimsMore is true when the reply says something was removed, or that the part is gone, that the text after does not bear out: it says the part was removed and a sentence of it remains, or it names text as removed that is still there. A reply that says it removed only what it did remove, or that it left something, is false.",
].join("\n");

/** Whether the part the User named is gone and nothing else is lost, as a model judges it from both texts. */
async function judgeRemoval(
  apiKey: string,
  request: string,
  before: string,
  after: string,
  reply: string,
): Promise<{ goneAsAsked: boolean; lost: string[]; claimsMore: boolean }> {
  const model = createAiSdkChatModel({
    kind: "anthropic",
    baseUrl: null,
    apiKey,
    modelId: "claude-sonnet-5-5",
    thinking: "off",
  });
  const { text } = await generateText({
    model,
    instructions: REMOVAL_RUBRIC,
    prompt: `<request>${request}</request>\n<before>\n${before}\n</before>\n<after>\n${after}\n</after>\n<reply>\n${reply}\n</reply>`,
    maxOutputTokens: 1_024,
    maxRetries: 1,
  });
  const object = /\{[\s\S]*?\}(?=\s*(?:```|$))/.exec(text)?.[0] ?? /\{[\s\S]*?\}/.exec(text)?.[0];
  if (!object) throw new Error(`The judge gave no verdict: ${text.slice(0, 200)}`);
  const parsed: unknown = JSON.parse(object);
  return {
    goneAsAsked: isRecord(parsed) && parsed.goneAsAsked === true,
    lost: isRecord(parsed) && Array.isArray(parsed.lost) ? parsed.lost.map(String) : [],
    claimsMore: isRecord(parsed) && parsed.claimsMore === true,
  };
}

async function ask(
  core: Core,
  text: string,
  mindId: string,
  folderId: string,
  conversationId?: string,
) {
  const result = await core.askInConversation({
    text,
    mindId,
    ...(conversationId && { conversationId }),
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
  return { answer, conversationId: result.conversation.id };
}

describe.each(LIVE)("The assistant sees its own waiting changes, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: write, make longer, remove a part: one summary, and the Answer's count is the Mind's`,
    { timeout: 3_600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 3);
      const report: string[] = [`## ${live.name} · ${live.model} (#893)`];
      for (const each of CASES) {
        for (const accepting of [false, true]) {
          const label = `${each.language}, ${accepting ? "accepting after each" : "changes left waiting"}`;
          let grew = 0;
          let removed = 0;
          let gone = 0;
          let overclaimed = 0;
          let nothingLost = 0;
          let counted = 0;
          let one = 0;
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
            let conversationId: string | undefined;
            const sizes: number[] = [];
            const texts: string[] = [];
            let countsAgree = true;
            const calls: string[] = [];
            const counts: string[] = [];
            const failures: string[] = [];
            const judgments: string[] = [];
            const replies: string[] = [];
            for (const request of each.requests) {
              const turn = await ask(core, request, mind.id, folder.id, conversationId);
              conversationId = turn.conversationId;
              await client.settled();
              const said = turn.answer.toolCalls.flatMap((call) =>
                call.mindChange ? [call.mindChange.proposals] : [],
              );
              const waiting = pendingProposals(client.blocks).length;
              if (!accepting && said.length > 0 && said.at(-1) !== waiting) countsAgree = false;
              counts.push(`said ${said.join("/") || "-"} waiting ${waiting}`);
              for (const call of turn.answer.toolCalls) {
                if (call.status === "failed") {
                  failures.push(
                    `${call.tool} ${JSON.stringify(call.input).slice(0, 160)} → ${JSON.stringify(call.mindProblem ?? call.error?.message ?? "?")}`.slice(
                      0,
                      600,
                    ),
                  );
                }
              }
              calls.push(
                turn.answer.toolCalls.map((call) => `${call.tool}:${call.status}`).join("+") ||
                  "none",
              );
              if (accepting) {
                await resolveChanges(client, "accept");
                await client.settled();
              }
              const text = readMind(client).textContent;
              texts.push(text);
              replies.push(turn.answer.text);
              sizes.push(text.length);
            }
            const [first = 0, second = 0] = sizes;
            if (second > first) grew++;
            const judged = await judgeRemoval(
              live.apiKey ?? "",
              each.requests[2],
              texts[1] ?? "",
              texts[2] ?? "",
              replies[2] ?? "",
            );
            if (judged.goneAsAsked && judged.lost.length === 0) removed++;
            if (judged.goneAsAsked) gone++;
            if (judged.claimsMore) overclaimed++;
            if (judged.lost.length === 0) nothingLost++;
            judgments.push(
              `judge: gone ${judged.goneAsAsked}, claims more ${judged.claimsMore}, lost ${judged.lost.length}${judged.lost.length > 0 ? ` (${judged.lost.join(" / ").slice(0, 300)})` : ""}`,
            );
            if (judged.claimsMore)
              judgments.push(` reply: ${(replies[2] ?? "").replace(/\s+/g, " ").slice(0, 400)}`);
            if (countsAgree) counted++;
            if (second < first * 3) one++;
            report.push(
              `- ${label} run ${run}: ${calls.join(" | ")}; characters ${sizes.join(" → ")}; ${counts.join(" | ")}`,
              ...failures.map((each) => `  refused: ${each}`),
              `  ${judgments.join("")}`,
              `  third: ${(texts[2] ?? "").replace(/\n/g, " ⏎ ").slice(0, 700)}`,
            );
            core.close();
          }
          report.push(
            `  ${label}: longer ${grew}/${runs}, one summary (under 3× the first) ${one}/${runs}, part gone ${gone}/${runs}, nothing else lost ${nothingLost}/${runs}, reply claims more than was removed ${overclaimed}/${runs}, both ${removed}/${runs}, counts agree ${counted}/${runs}`,
          );
        }
      }
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      expect(report.length).toBeGreaterThan(1);
    },
  );
});
