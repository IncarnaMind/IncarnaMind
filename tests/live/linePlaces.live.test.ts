/**
 * Whether the place rules of #2589 keep every line of the User's that a request doesn't change, and
 * still make the renames, removals and rewrites asked for, against a real model. Each held-out
 * request (`linePlaces.cases.ts`, frozen before any run) edits a Note of its own, through Edit with
 * AI (the whole Note selected) and through the assistant; every change is then accepted, as the
 * User would, and the Note read.
 *
 * INCARNAMIND_LIVE_RUNS sets how many times each request runs on each path (2 by default),
 * INCARNAMIND_LIVE_CONCURRENCY how many run at once (4), INCARNAMIND_LIVE_ARM names the code under
 * test in the report; INCARNAMIND_LIVE_REPORT names the file the rows go to, one JSON object a
 * line, each saved as its job finishes. INCARNAMIND_LIVE_ONLY runs only the requests it names
 * ("en-14, zh-14"). Each row keeps the rewriting model's replies and the assistant's calls, so a
 * run can be replayed with a scripted model. A run whose Answer failed or was stopped, or whose
 * edit failed, keeps `failed` with its kind and message and no kept or lost lines; the report's
 * last line is the run's model, job count and spend so far.
 */
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import type { ConversationAnswer, Core } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, spentBy, startCore } from "../helpers/core";
import { wholeMind } from "../helpers/editing";
import { connectToMind } from "../helpers/mindClient";
import { note, resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import {
  answerFailure,
  editFailure,
  liveSettings,
  type PlaceJob,
  placeJobs,
  ReportFile,
  type RunFailure,
  recordRun,
  runLiveJobs,
} from "./linePlaces.harness";

const API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ?? "deepseek-flash";

async function ask(core: Core, text: string, mindId: string): Promise<ConversationAnswer> {
  const result = await core.askInConversation({
    text,
    mindId,
    scope: { folderIds: [], tagIds: [], documentIds: [] },
  });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  const ended = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => done(false), 300_000);
    const stops = [
      core.on("answer.finished", ({ answerId }) => answerId === result.answerId && done(true)),
      core.on("answer.failed", ({ answerId }) => answerId === result.answerId && done(true)),
    ];
    function done(finished: boolean) {
      clearTimeout(timer);
      for (const stop of stops) stop();
      resolve(finished);
    }
  });
  if (!ended) throw new Error(`No end to the Answer of “${text}” in 5 minutes.`);
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer as ConversationAnswer;
}

describe("The place rules keep the User's lines and make the edits asked, live: DeepSeek", () => {
  test.skipIf(API_KEY === undefined)(
    `${MODEL}: no line lost that a request doesn't change, and every rename, removal and rewrite made`,
    { timeout: 7_200_000 },
    async () => {
      const settings = liveSettings(process.env);
      const jobs = placeJobs(settings.only, settings.runs);
      const report = new ReportFile(settings.report);
      await runLiveJobs(
        jobs,
        settings.concurrency,
        async () => {
          const dataDir = await createTempDataFolder();
          let replies: string[] = [];
          const core = startCore(dataDir, {
            createChatModel: (spec) =>
              wrapLanguageModel({
                model: createAiSdkChatModel(spec),
                middleware: {
                  specificationVersion: "v4",
                  wrapStream: async ({ doStream, params }) => {
                    const result = await doStream();
                    if (!JSON.stringify(params.prompt).includes("<passage>")) return result;
                    let text = "";
                    const stream = result.stream.pipeThrough(
                      new TransformStream({
                        transform(part, controller) {
                          if (part.type === "text-delta") text += part.delta;
                          if (part.type === "finish") replies.push(text);
                          controller.enqueue(part);
                        },
                      }),
                    );
                    return { ...result, stream };
                  },
                },
              }),
          });
          core.on(
            "consent.requested",
            (asked) => void core.respondToConsent(asked.requestId, true),
          );
          core.on(
            "approval.requested",
            (request) => void core.respondToApproval(request.requestId, "deny"),
          );
          await core.saveChatProvider({ kind: "deepseek", apiKey: API_KEY, modelId: MODEL });
          return {
            async run({ each, path, run }: PlaceJob) {
              replies = [];
              const row: Record<string, unknown> = {
                arm: settings.arm,
                id: each.id,
                language: each.language,
                kind: each.kind,
                path,
                run,
              };
              try {
                const mind = await core.createMind({ title: `${each.id} ${path} ${run}` });
                const client = await connectToMind(core, mind.id);
                writeMind(
                  client,
                  each.note.map((line) => note(line)),
                );
                await client.settled();
                let failure: RunFailure | null = null;
                if (path === "editWithAi") {
                  const result = await core.editWithAi(wholeMind(client, mind.id, each.ask));
                  row.result = result.kind;
                  failure = editFailure(result);
                } else {
                  const answer = await ask(core, each.ask, mind.id);
                  row.reply = answer.text;
                  row.calls = answer.toolCalls
                    .filter((call) => call.source === "minds")
                    .map((call) => ({ tool: call.tool, input: call.input }));
                  failure = answerFailure(answer);
                }
                if (!failure) {
                  await client.settled();
                  await resolveChanges(client, "accept");
                  await client.settled();
                }
                recordRun(row, each, failure, () => shownWithChanges(client));
              } catch (error) {
                row.error = String(error);
              }
              row.rewrites = replies;
              return row;
            },
            spend: () => spentBy(dataDir),
            close: () => core.close(),
          };
        },
        report,
        { arm: settings.arm, model: MODEL },
      );
      expect(report.rows).toBe(jobs.length);
    },
  );
});
