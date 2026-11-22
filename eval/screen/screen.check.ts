import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createAiSdkChatModel, type ScreenCapture, type TextRecognizer } from "../../src/core";
import { BUILT_IN_TEXT_RECOGNITION_MODEL } from "../../src/core/documents/scan/model";
import { createOnnxTextRecognizer } from "../../src/core/documents/scan/onnx";
import { downloadModel, isModelDownloaded } from "../../src/core/embedding/download";
import { answerEnded } from "../../tests/helpers/citations";
import { createTempDataFolder } from "../../tests/helpers/core";
import { fakeScreen, screenAdapters } from "../../tests/helpers/screens";
import { transcribingCore } from "../../tests/helpers/transcription";
import { evalCache } from "../lib/cache";
import { chatProviderOf, chatSettings } from "../lib/config";
import { drawFrame, frames } from "./frames";

test("twenty shared frames through local text recognition and in-call Questions", async () => {
  const chat = chatSettings(process.env);
  if (!chat) throw new Error("Configure INCARNAMIND_EVAL_CHAT_KIND, MODEL and KEY first.");
  const model = BUILT_IN_TEXT_RECOGNITION_MODEL;
  const directory = join(evalCache(), "models", model.folder);
  if (!isModelDownloaded(directory, model.source.files))
    await downloadModel({
      directory,
      source: model.source,
      signal: new AbortController().signal,
      onProgress() {},
    });
  const actual = createOnnxTextRecognizer();
  await actual.load({
    detector: join(directory, model.files.detector),
    recognizer: join(directory, model.files.recognizer),
  });
  const selected = String(process.env.INCARNAMIND_SCREEN_CASES ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number);
  const results = [];
  try {
    for (const [index, spec] of frames.entries()) {
      if (selected.length && !selected.includes(index + 1)) continue;
      const frame = drawFrame(spec);
      const fake = fakeScreen();
      const capture: ScreenCapture = {
        ...fake.capture,
        async start(window, sink, signal) {
          const session = await fake.capture.start(window, sink, signal);
          return { ...session, grab: async () => frame };
        },
      };
      let ocrMs = 0;
      const reader: TextRecognizer = {
        async load() {},
        close() {},
        readFile: (file) => actual.readFile(file, 1),
        async read(picture, page) {
          const at = performance.now();
          const lines = await actual.read(picture, page);
          ocrMs += performance.now() - at;
          return lines;
        },
      };
      const { core, clock } = await transcribingCore(await createTempDataFolder(), {
        createChatModel: createAiSdkChatModel,
        adapters: screenAdapters(capture, reader),
      });
      try {
        const provider = await core.saveChatProvider(chatProviderOf(chat));
        if (provider.service) await core.allowDataFlow("chat", provider.service.id);
        await core.updateSettings({ user: { callHelpModel: "answers" } });
        const meeting = await core.createMeeting();
        await core.startMeeting({ meetingId: meeting.id });
        await core.listShareableWindows(meeting.id);
        await core.readSharedScreen({ meetingId: meeting.id, windowId: "zoom" });
        await vi.waitFor(
          async () => {
            clock.advance(1000);
            fake.sample();
            if (
              (await core.listMeetings()).find((each) => each.id === meeting.id)?.screen
                ?.screens !== 1
            )
              throw new Error("Waiting for local OCR.");
          },
          { timeout: 45_000, interval: 30 },
        );
        const at = performance.now();
        let first: null | number = null;
        const stop = core.on("answer.delta", (e) => {
          if (e.text.trim() && first === null) first = performance.now() - at;
        });
        const result = await core.askMeetingQuestion({
          meetingId: meeting.id,
          text: spec.question,
        });
        if (!result.asked) throw new Error(`Question was declined: ${JSON.stringify(result)}`);
        const ended = await answerEnded(core, result.answerId);
        stop();
        const answer = (await core.getConversation(result.conversation.id)).messages.find(
          (item) => item.id === result.answerId,
        );
        if (answer?.kind !== "answer") throw new Error("Answer missing.");
        const output = {
          case: index + 1,
          model: chat.modelId,
          event: ended.event,
          error: answer.errorKind,
          ocrMs: Math.round(ocrMs),
          firstMs: first === null ? null : Math.round(first),
          screen: answer.steps?.sent?.sharedScreen,
          correct:
            spec.expected.some((term) => answer.text.includes(term)) &&
            !/无法(?:确定|确认|判断)|看不清|cannot (?:determine|confirm|tell)|unable to (?:determine|confirm)/iu.test(
              answer.text,
            ),
          text: answer.text,
          citations: answer.citations.map((item) => ({
            kind: item.location?.kind,
            check: item.check,
            reason: item.checkReason,
          })),
        };
        results.push(output);
        if (process.env.INCARNAMIND_SCREEN_RESULTS)
          await appendFile(process.env.INCARNAMIND_SCREEN_RESULTS, `${JSON.stringify(output)}\n`);
        console.log(JSON.stringify(output));
        await core.stopMeeting(meeting.id);
        if (ended.event === "failed")
          throw new Error(`The model request failed: ${answer.errorKind}`);
      } finally {
        core.close();
      }
    }
  } finally {
    actual.close();
  }
  expect(results.filter((r) => r.correct).length / results.length).toBeGreaterThanOrEqual(0.95);
});
