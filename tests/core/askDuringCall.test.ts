/**
 * Asking during a call (#144), through the core's public interface as the
 * assistant asks: a Question from the meeting's Mind while it records goes with
 * the live transcript, indexed up to that moment, which the Answer cites by
 * time without searching; the Mind's note is untouched; a Question from
 * another Mind, or after Stop, goes without it.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { AskInConversationInput, ConversationAnswer, Core } from "../../src/core";
import { FAKE_LINES } from "../../src/core/transcription/fake";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;
const NEWEST = FAKE_LINES[5] as string;

/** The live transcript the model was sent with the Question, as its Passages. */
const transcriptIn = (text: string) => {
  const block = /<live-transcript>\n([\s\S]*?)\n<\/live-transcript>/.exec(text)?.[1];
  return block === undefined ? null : shownPassages(block);
};

/** What the User's messages of a request said. */
const userText = (call: ModelCall) =>
  call.options.prompt
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    )
    .join("\n");

/** A model that cites the transcript's newest line it was given, without searching. */
function listeningModel(calls: ModelCall[]) {
  return scriptedModel((call) => {
    calls.push(call);
    const passages = transcriptIn(userText(call));
    const newest = passages?.find((passage) => passage.text.includes(NEWEST));
    if (!newest) return { text: "I heard nothing of the call." };
    if (!call.results.some((result) => result.tool === "cite")) {
      return {
        calls: [
          {
            tool: "cite",
            input: { citations: [{ marker: 1, passage: newest.id, quote: NEWEST }] },
          },
        ],
      };
    }
    return { text: "They'll confirm with the payment provider by Friday [^1]." };
  });
}

async function setUp(model: MockLanguageModelV4) {
  const dataDir = await createTempDataFolder();
  const { core, record } = await transcribingCore(dataDir, { model });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const meeting = await core.createMeeting();
  return { core, record, meeting };
}

async function ask(core: Core, input: AskInConversationInput): Promise<ConversationAnswer> {
  const result = await core.askInConversation(input);
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

describe("Asking during a call", { timeout: 60_000 }, () => {
  test("a Question from the meeting's Mind goes with the transcript up to now, and its Answer cites a line by time; the note is untouched", async () => {
    const calls: ModelCall[] = [];
    const { core, record, meeting } = await setUp(listeningModel(calls));
    await core.startMeeting({ meetingId: meeting.id });
    record(9 * SECOND, ["microphone"]);
    const early = await until(core, meeting.id, (transcript) => transcript.lines >= 4);
    await vi.waitFor(
      async () => {
        const found = await core.searchPassages("eighteenth of November", { mode: "keyword" });
        expect(found.map((passage) => passage.documentId)).toContain(early.documentId);
      },
      { timeout: 20_000, interval: 50 },
    );
    // The newest lines, just said: the Transcript isn't indexed again for a while yet.
    record(5 * SECOND, ["microphone"]);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 6);
    expect(await core.searchPassages("Friday", { mode: "keyword" })).toEqual([]);
    const client = await connectToMind(core, meeting.mindId);

    const answer = await ask(core, {
      mindId: meeting.mindId,
      text: "What did they say about the payment provider?",
    });

    expect(calls[0] && userText(calls[0])).toContain("<live-transcript>");
    expect(calls[0]?.system).toContain("The User is in a meeting that is being recorded");
    expect(calls.flatMap((call) => call.results.map((result) => result.tool))).not.toContain(
      "search_documents",
    );
    expect(answer.citations).toEqual([
      expect.objectContaining({
        documentId: live.documentId,
        quote: NEWEST,
        location: expect.objectContaining({ kind: "time", speaker: "Speaker ?" }),
        check: "found",
      }),
    ]);
    expect(answer.steps?.sent).toEqual({ documents: [], transcript: true });
    expect(readMind(client).textContent).toBe("");
  });

  test("the transcript's lines say who said them, so Questions about what they said are about the other side", async () => {
    const calls: ModelCall[] = [];
    const { core, record, meeting } = await setUp(listeningModel(calls));
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(9 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 4);
    await ask(core, {
      mindId: meeting.mindId,
      text: "What did they say about the payment provider?",
    });

    const [firstCall] = calls;
    if (!firstCall) throw new Error("The model wasn't asked.");
    const sent = userText(firstCall);
    expect(sent).toMatch(/\[\d+:\d{2} Me\] /);
    expect(sent).toMatch(/\[\d+:\d{2} Them\] /);
    expect(firstCall.system).toContain('"Them" is the other side of the call');
    expect(firstCall.system).toContain("never guess");
  });

  test("a Question that isn't a button is not told the live text is behind, whatever the Transcript's state (#1366)", async () => {
    const calls: ModelCall[] = [];
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, {
      model: listeningModel(calls),
      engine: { decodeMs: 30 },
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.state === "live");
    record(40 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.state === "behind");

    const answer = await ask(core, {
      mindId: meeting.mindId,
      text: "What did they say about the payment provider?",
    });

    expect(calls[0]?.system).not.toContain("fell behind");
    expect(answer.steps?.textBehind).toBeUndefined();
  });

  test("a Question from another Mind, or after Stop, goes without the transcript", async () => {
    const calls: ModelCall[] = [];
    const { core, record, meeting } = await setUp(listeningModel(calls));
    await core.startMeeting({ meetingId: meeting.id });
    record(14 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 6);
    const other = await core.createMind({ title: "Elsewhere" });

    await ask(core, { mindId: other.id, text: "What did they say about the payment provider?" });
    expect(calls.at(-1)?.system).not.toContain("being recorded");

    await core.stopMeeting(meeting.id);
    await ask(core, {
      mindId: meeting.mindId,
      text: "What did they say about the payment provider?",
    });
    expect(calls.at(-1)?.system).not.toContain("being recorded");
  });
});
