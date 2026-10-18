/**
 * Answers in the assistant (#201) against real models: a Question asked in a
 * conversation, in English and then in Chinese, answered with Citations, and
 * each Answer added to a Mind's note, its Citations checked again there,
 * through the core as the app uses it. Each model runs only when its key (or,
 * for Ollama, its name) is in the environment, and is skipped otherwise, so
 * `npx vitest run` makes no request without one.
 *
 *   INCARNAMIND_LIVE_ANTHROPIC_KEY   Claude (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default)
 *   INCARNAMIND_LIVE_OPENAI_KEY      OpenAI (INCARNAMIND_LIVE_OPENAI_MODEL, its quick-tasks model by default)
 *   INCARNAMIND_LIVE_OLLAMA_MODEL    a model in Ollama on this computer, e.g. qwen3.5:4b, in local mode
 *   INCARNAMIND_LIVE_OLLAMA_CLOUD_MODEL   an Ollama cloud model, e.g. gpt-oss:20b-cloud (sent to ollama.com)
 *
 * Ollama's models are looked at as the app does (a small one cites through
 * structured output), a local one with its context kept to 8,192 tokens.
 *
 * Names of their own, so a key a shell has for other tools never starts paid requests here.
 *
 * Set INCARNAMIND_LIVE_REPORT to a file to keep what each model wrote.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  type ChatProviderKind,
  CITATION_NODE,
  type ConversationAnswer,
  type Core,
  messageReference,
} from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import {
  createOllamaModels,
  type OllamaModels,
  outputTokensFor,
} from "../../src/core/providers/ollamaModels";
import { answerBlocks } from "../../src/shared/answerBlocks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, writeMind } from "../helpers/minds";

const TIDES = {
  name: "Tides.md",
  contents: [
    "# Tides",
    "",
    "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
    "",
    "Neap tides come at the first and last quarter moons, when they pull at right angles.",
  ].join("\n"),
};
const CHAOXI = {
  name: "潮汐.md",
  contents: "# 潮汐\n\n大潮出现在新月和满月前后，这时太阳和月亮的引力叠加在一起。",
};
const QUESTIONS = ["When do spring tides happen, and why?", "大潮在什么时候出现？为什么？"];

interface Live {
  name: string;
  kind: ChatProviderKind;
  apiKey: string | undefined;
  model: string;
  local: boolean;
}

const LIVE: Live[] = [
  {
    name: "Anthropic",
    kind: "anthropic",
    apiKey: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
    model:
      process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
      (catalogProvider("anthropic")?.roles.quickTasks as string),
    local: false,
  },
  {
    name: "OpenAI",
    kind: "openai",
    apiKey: process.env.INCARNAMIND_LIVE_OPENAI_KEY,
    model:
      process.env.INCARNAMIND_LIVE_OPENAI_MODEL ??
      (catalogProvider("openai")?.roles.quickTasks as string),
    local: false,
  },
  {
    name: "Ollama",
    kind: "ollama",
    apiKey: process.env.INCARNAMIND_LIVE_OLLAMA_MODEL ? "" : undefined,
    model: process.env.INCARNAMIND_LIVE_OLLAMA_MODEL ?? "",
    local: true,
  },
  {
    name: "Ollama cloud",
    kind: "ollama",
    apiKey: process.env.INCARNAMIND_LIVE_OLLAMA_CLOUD_MODEL ? "" : undefined,
    model: process.env.INCARNAMIND_LIVE_OLLAMA_CLOUD_MODEL ?? "",
    local: false,
  },
];

/** The app's own look at a model in Ollama, with its context kept to 8,192 tokens at most. */
function ollamaAsTheAppSees(): OllamaModels {
  const app = createOllamaModels();
  return {
    async describe(baseUrl, model) {
      const profile = await app.describe(baseUrl, model);
      if (!profile) return null;
      const numCtx = Math.min(profile.settings.numCtx, 8_192);
      const outputTokens = outputTokensFor(numCtx, profile.settings.think);
      return { ...profile, settings: { ...profile.settings, numCtx, outputTokens } };
    },
    loaded: (baseUrl, model, numCtx) => app.loaded(baseUrl, model, numCtx),
    running: (baseUrl) => app.running(baseUrl),
  };
}

/** Asks in the conversation (a new one when null) and waits until its Answer has ended. */
async function ask(core: Core, conversationId: string | null, text: string, mindId: string) {
  const started = Date.now();
  const result = await core.askInConversation({ conversationId, text, mindId });
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
  return { answer, seconds: (Date.now() - started) / 1000 };
}

/** The checks of the Citations in the Blocks given, in order. */
function checksIn(blocks: readonly { attrs?: Record<string, unknown>; content?: unknown[] }[]) {
  const checks: string[] = [];
  const visit = (node: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (node.type === CITATION_NODE) checks.push(String(node.attrs?.check));
    for (const child of (node.content ?? []) as (typeof node)[]) visit(child);
  };
  for (const block of blocks) visit(block);
  return checks;
}

describe.each(LIVE)("Answers in the assistant, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: Answers in English and Chinese cite, and keep their Citations, found, once added to a note`,
    { timeout: 600_000 },
    async () => {
      const dataDir = await createTempDataFolder();
      const sources = await createTempDataFolder();
      const core = startCore(dataDir, {
        createChatModel: createAiSdkChatModel,
        ...(live.kind === "ollama" && {
          ollamaModels: live.local ? ollamaAsTheAppSees() : createOllamaModels(),
        }),
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({
        kind: live.kind,
        ...(live.apiKey && { apiKey: live.apiKey }),
        modelId: live.model,
      });
      if (live.local) await core.setLocalOnly(true);
      await addAndProcess(core, [
        await writeSourceFile(sources, TIDES.name, TIDES.contents),
        await writeSourceFile(sources, CHAOXI.name, CHAOXI.contents),
      ]);
      const mind = await core.createMind({ title: "Tides" });
      const writer = await connectToMind(core, mind.id);
      writeMind(writer, [note("Notes on the tides."), note("")]);
      await writer.settled();

      const report: string[] = [`## ${live.name} · ${live.model}`];
      let conversationId: string | null = null;
      // Kept whatever happens, so a model that does worse says how.
      const keep = async () => {
        if (!process.env.INCARNAMIND_LIVE_REPORT) return;
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      };
      onTestFinished(keep);
      for (const question of QUESTIONS) {
        const { answer, seconds }: { answer: ConversationAnswer; seconds: number } = await ask(
          core,
          conversationId,
          question,
          mind.id,
        );
        conversationId = answer.conversationId;
        const blocks = answerBlocks(answer);
        const inAnswer = checksIn(blocks as never);
        report.push(
          `- ${question}: ${answer.status}${answer.errorKind ? ` (${answer.errorKind})` : ""}, ${seconds.toFixed(1)} s, Citations ${inAnswer.join(" ") || "none"}\n  ${answer.text.replace(/\n+/g, " ")}`,
        );
        expect(answer.status, answer.errorMessage ?? "").toBe("done");

        const added = await core.addToNote({
          mindId: mind.id,
          blocks,
          origin: { from: messageReference(answer.conversationId, answer.id), question },
          model: answer.model,
        });
        const reader = await connectToMind(core, mind.id);
        const kept = readMind(reader);
        const addedBlocks: { attrs?: Record<string, unknown>; content?: unknown[] }[] = [];
        kept.forEach((node) => {
          if (added.blockIds.includes(String(node.attrs.id))) addedBlocks.push(node.toJSON());
        });
        const inNote = checksIn(addedBlocks);
        report.push(`  added: Citations ${inNote.join(" ") || "none"}`);
        // Checked again where they land: what was found in the Answer is found in the note.
        expect(inNote.length).toBe(inAnswer.length);
        inAnswer.forEach((check, index) => {
          if (check === "found") expect(inNote[index]).toBe("found");
        });
      }
      // How many cite is the model's to do better at; what they cite, the note keeps.
      expect(report.some((line) => / Citations (?!none)/.test(line))).toBe(true);
    },
  );
});
