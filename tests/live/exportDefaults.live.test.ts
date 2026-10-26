/**
 * A Word export the assistant starts asks nothing (#1945), against a real model: told to export,
 * the model runs the export without choosing whether to mark the text IncarnaMind wrote, the file
 * marks it, and the Saved line says what the file was written with. It runs only with
 * INCARNAMIND_LIVE_ANTHROPIC_KEY (model: INCARNAMIND_LIVE_ANTHROPIC_MODEL, else the catalogue's
 * quick model), and is skipped otherwise.
 *
 * Set INCARNAMIND_LIVE_REPORT to a file to keep the call the model made, the reply and the Saved line.
 */
import { appendFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import type { AnswerToolCall, CommandDone, ConversationAnswer, Core } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { chosenParts, optionsFor } from "../../src/shared/exportOptions";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";
import { part, unzip } from "../helpers/docx";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const BEGAN = Date.now();

const record = (line = ""): void => {
  if (!REPORT) return;
  const at = ((Date.now() - BEGAN) / 1000).toFixed(1).padStart(6);
  appendFileSync(REPORT, `${at} s  ${line}\n`);
};

/** Asks in a new conversation and waits until its Answer has ended. */
async function ask(core: Core, text: string, mindId: string): Promise<ConversationAnswer> {
  const result = await core.askInConversation({ conversationId: null, text, mindId });
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

describe("A Word export the assistant starts, live: Anthropic", () => {
  test.skipIf(KEY === undefined)(
    `${MODEL}: “Export this Mind as Word” asks nothing, marks the text IncarnaMind wrote, and the Saved line says so`,
    { timeout: 300_000 },
    async () => {
      const core: Core = startCore(await createTempDataFolder(), {
        createChatModel: createAiSdkChatModel,
      });
      const output = await createTempDataFolder();
      onTestFinished(() => record());
      record(`## Anthropic · ${MODEL}`);
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      core.on("question.asked", (asked) => {
        record(`question asked: “${asked.question.question}”`);
        void core.answerUserQuestion(asked.requestId, { skipped: true });
      });
      core.on("approval.requested", (asked) => {
        record(`approval asked for ${asked.tool}`);
        void core.respondToApproval(asked.requestId, "allow-once");
      });

      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY, modelId: MODEL });
      await core.setOutputLocation(output);
      const mind = await core.createMind({ title: "Deal notes" });
      await core.addToNote({
        mindId: mind.id,
        blocks: [
          { type: "paragraph", content: [{ type: "text", text: "Notes on the Northwind deal." }] },
        ],
        origin: null,
        model: null,
      });
      await core.addToNote({
        mindId: mind.id,
        blocks: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "The deal closed in March, on the terms agreed.",
                marks: [{ type: "generated" }],
              },
            ],
          },
        ],
        origin: null,
        model: null,
      });
      record("ready");

      const answer = await ask(core, "Export this Mind as Word", mind.id);
      for (const call of answer.toolCalls) {
        record(`${call.tool} ${JSON.stringify(call.input)} → ${call.status}`);
      }
      record(`reply: ${answer.text}`);
      const done = answer.toolCalls
        .filter((call: AnswerToolCall) => call.source === "commands")
        .map((call) => call.command)
        .find((command): command is CommandDone => command?.command === "mind.export");
      record(`command: ${JSON.stringify(done)}`);

      // The model left the marking to the app: no `marks` in the call it made.
      expect(done).toBeDefined();
      const exported = answer.toolCalls.find((call) => call.command?.command === "mind.export");
      expect(JSON.stringify(exported?.input ?? {})).not.toContain("marks");
      expect(done?.file?.name).toBe("Deal notes.docx");
      expect(done?.marking).toMatchObject({ choice: "mark", how: "default" });
      expect(await readdir(output)).toEqual(["Deal notes.docx"]);
      const files = unzip(await readFile(join(output, "Deal notes.docx")));
      const comments = files.has("word/comments.xml") ? part(files, "word/comments.xml") : "";
      expect(comments).toContain("Written by IncarnaMind");

      // The Saved line the window draws for that file, from the same parts and the same options.
      const preferences = (await core.getSettings()).user.exportOptions;
      const written = optionsFor("docx", preferences);
      const preview = await core.previewMindExport(mind.id, written);
      const parts = chosenParts((key, params) => translate("en", key, params), {
        places:
          preview.citationPlace === null
            ? null
            : { citations: preview.citations, place: preview.citationPlace },
        markAiText: preview.markAiText,
      });
      record(
        `Saved line: Saved “${done?.file?.name}” in ${done?.file?.folder} · ${parts.join(" · ")} · Change`,
      );
    },
  );
});
