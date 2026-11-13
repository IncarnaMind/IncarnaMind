import type { Core } from "../../src/core";
import type { Language } from "../../src/core/language";
import { answerEnded } from "./citations";
import { createTempDataFolder } from "./core";
import { addAndProcess, writeSourceFile } from "./documents";
import { connectToMind } from "./mindClient";
import { writeMind } from "./minds";
import { type GenerateCall, scriptedModel, unscripted } from "./models";
import { stoppedMeeting, transcribingCore, until } from "./transcription";

const SECOND = 1000;
const HOUR = 3_600_000;

/** What the earlier call's other side said, and the option a press makes of it again. */
export const EARLIER_LINE: Record<Language, { line: string; sentence: string }> = {
  en: {
    line: "Understood, your data stays in Europe then.",
    sentence: "Your data stays in Europe",
  },
  "zh-CN": { line: "明白，数据就留在欧洲。", sentence: "数据就留在欧洲" },
};

/** The Folder's ordinary Document, so a press reads the Documents. */
const TERMS: Record<Language, { name: string; text: string }> = {
  en: {
    name: "Hosting terms.md",
    text: "# Hosting terms\n\nThe pilot's data is kept in our Frankfurt data centre for twelve months.\n",
  },
  "zh-CN": {
    name: "托管条款.md",
    text: "# 托管条款\n\n试点的数据在我们法兰克福的数据中心保存十二个月。\n",
  },
};

const OTHER_SIDE: Record<Language, string[]> = {
  en: ["Where does your data have to stay?", EARLIER_LINE.en.line],
  "zh-CN": ["你们的数据必须放在哪里？", EARLIER_LINE["zh-CN"].line],
};

/**
 * A help button's press made before anyone has spoken in the live call (#3005), from a Note that
 * keeps a Citation of the earlier call's line, the earlier call stopped three hours before. Its
 * model cites the Note's Citation, and judges every sentence it is given unsupported from the
 * start, keeping each batch.
 */
export async function pressedBeforeFirstLine(language: Language) {
  const { line, sentence } = EARLIER_LINE[language];
  const batches: GenerateCall[] = [];
  const model = scriptedModel(
    (call) => {
      if (call.results.some((result) => result.tool === "cite")) {
        return { text: `★ ${sentence} [^1]\n→ keeps it moving` };
      }
      if (/· C1\]/.test(call.prompt)) {
        return {
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: "C1", quote: line }] } },
          ],
        };
      }
      return { text: `★ ${sentence}\n→ keeps it moving` };
    },
    {
      generate: (call) => {
        // Stop starts the Transcript's own work (its tags, the notes filled in), none of it this one's.
        if (call.question === undefined) return { error: { status: 500, message: "Not here." } };
        if (call.question === "claimed-changes") return { text: '{"claims":[]}' };
        if (call.question === "request-done")
          return { text: '{"asks_change":"no","request":"none"}' };
        if (call.question !== "sentence-batch") return unscripted(call.question, call.system);
        batches.push(call);
        return {
          text: JSON.stringify({
            sentences: [...call.prompt.matchAll(/<sentence number="(\d+)">/g)].map(
              ([, number]) => ({
                number: Number(number),
                kind: "fact",
                verdict: "unsupported",
                roles: "same",
                time: "same",
                quoted: "states",
                says: "The quote says something else.",
              }),
            ),
          }),
        };
      },
    },
  );
  const dataDir = await createTempDataFolder();
  const { core, record, clock } = await transcribingCore(dataDir, {
    model,
    engine: {
      lines: ["Let's go over where the data is hosted."],
      theirLines: OTHER_SIDE[language],
    },
  });
  await core.updateSettings({ user: { language } });
  const folder = await core.createLibraryGroup({ name: "Tallowmere Freight", description: "" });
  const [terms] = await addAndProcess(core, [
    await writeSourceFile(await createTempDataFolder(), TERMS[language].name, TERMS[language].text),
  ]);
  if (!terms) throw new Error("The Folder's Document wasn't added.");
  await core.moveToFolder({ documentIds: [terms.id], folderId: folder.id });

  const earlier = await core.createMeeting({ folderId: folder.id });
  await core.startMeeting({ meetingId: earlier.id, systemAudio: true });
  await until(core, earlier.id, (transcript) => transcript.state === "live");
  record(9 * SECOND);
  await until(core, earlier.id, (transcript) => transcript.lines >= 4);
  const stopped = await stoppedMeeting(core, dataDir, earlier.id);
  clock.advance(3 * HOUR);

  // A model with a price, so the check has an estimate.
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) {
    core.on("consent.requested", (request) => {
      void core.respondToConsent(request.requestId, true);
    });
    await core.allowDataFlow("chat", saved.service.id);
  }
  const live = await core.createMeeting({ folderId: folder.id });
  await core.startMeeting({ meetingId: live.id, systemAudio: true });
  await until(core, live.id, (transcript) => transcript.state === "live");

  const found = await core.findPassages({ text: line, mindId: null, scope: null });
  const passage = found.find((each) => each.documentId === stopped.document.id);
  if (!passage) throw new Error("The earlier call's line isn't found.");
  const kept = await core.citePassage({ passageId: passage.passageId, text: line });
  if (!kept) throw new Error("The earlier call's line can't be cited.");
  const client = await connectToMind(core, live.mindId);
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "kept" },
      content: [
        { type: "text", text: `${sentence} ` },
        {
          type: "citation",
          attrs: {
            passageId: kept.passageId,
            documentId: kept.documentId,
            documentName: kept.documentName,
            contentHash: kept.contentHash,
            pageFrom: kept.pageFrom,
            pageTo: kept.pageTo,
            location: kept.location,
            quote: kept.quote,
            check: "found",
            checkReason: null,
          },
        },
      ],
    },
  ]);
  await client.settled();

  const pressed = await core.askMeetingHelp({
    meetingId: live.id,
    kind: "say",
    conversationId: null,
  });
  if (!pressed.asked) throw new Error("Not pressed.");
  await answerEnded(core, pressed.answerId);
  const pressIds = { conversationId: pressed.conversation.id, answerId: pressed.answerId };
  return { core, dataDir, line, batches, pressIds, earlier: stopped.document.id };
}

/** The press's Question and Answer, as the conversation holds them. */
export async function turnOf(core: Core, ids: { conversationId: string; answerId: string }) {
  const { messages } = await core.getConversation(ids.conversationId);
  const answer = messages.find((message) => message.id === ids.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  const question = messages.find((message) => message.id === answer.questionId);
  if (question?.kind !== "question") throw new Error("No Question.");
  return { question, answer };
}
