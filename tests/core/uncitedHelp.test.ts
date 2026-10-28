import { expect, test } from "vitest";
import { checkGenerate, checkReply, isCheckRun, sentenceOf } from "../helpers/checks";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;

test("call help never starts uncited background checks", { timeout: 60_000 }, async () => {
  const checked: string[] = [];
  const model = scriptedModel(
    (call: ModelCall) => {
      if (isCheckRun(call)) {
        checked.push(sentenceOf(call));
        return checkReply(call, {});
      }
      return { text: "★ They want a 15% discount and delivery by March 3\n→ note it" };
    },
    { generate: checkGenerate({}) },
  );
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(model);
  const { core, record } = await transcribingCore(dataDir, {
    createChatModel: models.createChatModel,
    engine: {},
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createSourceFolder();
  const added = await core.addDocuments([
    await writeSourceFile(sources, "Price sheet.txt", "Team plan: $25 per seat a month."),
  ]);
  await waitForProcessing(
    core,
    added.documents.map((document) => document.id),
  );
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(9 * SECOND);
  await until(core, meeting.id, (text) => text.lines >= 4);
  const result = await core.askMeetingHelp({ meetingId: meeting.id, kind: "sum" });
  if (!result.asked) throw new Error("Call help wasn't asked.");
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  expect(answer?.kind).toBe("answer");
  if (answer?.kind !== "answer") throw new Error("No such Answer.");
  expect(checked).toEqual([]);
  expect(answer.claimChecks).toEqual([]);
});
