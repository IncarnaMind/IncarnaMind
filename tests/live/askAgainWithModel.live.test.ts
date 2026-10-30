/**
 * A Question that failed on a model the service doesn't know (#1848), asked again with a working
 * one, against a real model: the Answer is written on the same Question with the new model, in
 * English and in Chinese. Each model runs only when its key (or, for a model on this computer, its
 * name) is in the environment, so `npx vitest run` makes no request without one:
 *
 *   INCARNAMIND_LIVE_ANTHROPIC_KEY   Claude (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default)
 *   INCARNAMIND_LIVE_OLLAMA_MODEL    a model on this computer, e.g. qwen3:0.6b, in local mode
 *
 * Set INCARNAMIND_LIVE_REPORT to a file to keep what each run gave back.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";

interface Live {
  name: string;
  kind: "anthropic" | "ollama";
  apiKey: string | undefined;
  model: string;
  /** A model the service doesn't know. */
  unknown: string;
}

const LIVE: Live[] = [
  {
    name: "Anthropic",
    kind: "anthropic",
    apiKey: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
    model:
      process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
      (catalogProvider("anthropic")?.roles.quickTasks as string),
    unknown: "claude-nonexistent-9-9",
  },
  {
    name: "Ollama",
    kind: "ollama",
    apiKey: process.env.INCARNAMIND_LIVE_OLLAMA_MODEL ? "" : undefined,
    model: process.env.INCARNAMIND_LIVE_OLLAMA_MODEL ?? "",
    unknown: "audit-missing-jade-20261025:latest",
  },
];

const QUESTIONS = [
  { language: "English", text: "In one sentence, what is a tide?" },
  { language: "Chinese", text: "请用一句话说明什么是潮汐。" },
] as const;

/** Waits for the Answer to end, whichever way it did. */
async function settled(core: Core, conversationId: string, answerId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const answer = (await core.getConversation(conversationId)).messages.find(
      (message) => message.id === answerId,
    );
    if (answer?.kind === "answer" && answer.status !== "streaming") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The Answer never ended.");
}

describe.each(LIVE)("Ask again with another model, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    "a Question that failed on an unknown model is written on the same Question with a working one",
    { timeout: 600_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 2);
      const report: string[] = [
        `## ${live.name} · ${live.model} (#1848, Ask again with another model)`,
      ];
      for (const question of QUESTIONS) {
        let failedAsExpected = 0;
        let written = 0;
        for (let run = 1; run <= runs; run++) {
          const core = startCore(await createTempDataFolder(), {
            createChatModel: createAiSdkChatModel,
          });
          core.on(
            "consent.requested",
            (asked) => void core.respondToConsent(asked.requestId, true),
          );
          const provider = await core.saveChatProvider({
            kind: live.kind,
            ...(live.apiKey && { apiKey: live.apiKey }),
            modelId: live.model,
          });
          if (live.kind === "ollama") await core.setLocalOnly(true);
          const first = await core.askInConversation({
            text: question.text,
            model: { providerId: provider.id, modelId: live.unknown },
          });
          if (!first.asked) throw new Error("The Question wasn't asked.");
          await settled(core, first.conversation.id, first.answerId);
          const failed = (await core.getConversation(first.conversation.id)).messages.find(
            (message) => message.id === first.answerId,
          );
          if (
            failed?.kind === "answer" &&
            failed.status === "failed" &&
            failed.errorKind === "model"
          ) {
            failedAsExpected++;
          }

          const again = await core.regenerateConversationAnswer({
            conversationId: first.conversation.id,
            answerId: first.answerId,
            model: { providerId: provider.id, modelId: live.model },
          });
          if (!again.asked) throw new Error("Asked again, it wasn't asked.");
          await settled(core, first.conversation.id, first.answerId);
          const content = await core.getConversation(first.conversation.id);
          const answer = content.messages.find((message) => message.id === first.answerId);
          const asked = content.messages[0];
          if (
            answer?.kind === "answer" &&
            answer.status === "done" &&
            answer.text.trim() !== "" &&
            answer.model?.modelId === live.model &&
            asked?.kind === "question" &&
            asked.text === question.text &&
            asked.model?.modelId === live.model &&
            content.messages.length === 2
          ) {
            written++;
          }
          report.push(
            `- ${question.language} run ${run}: failed ${failed?.kind === "answer" ? failed.errorKind : "?"}, then ${answer?.kind === "answer" ? `${answer.status}: ${answer.text.slice(0, 80)}` : "?"}`,
          );
          core.close();
        }
        report.push(
          `  ${question.language}: failed on the unknown model ${failedAsExpected}/${runs}, written again on the same Question with ${live.model} ${written}/${runs}`,
        );
        expect(failedAsExpected).toBe(runs);
        expect(written).toBe(runs);
      }
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
    },
  );
});
