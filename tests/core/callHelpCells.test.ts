/**
 * A call help reply's Citation of a table row keeps its cells as the cite found them (#2847): the
 * Document's own words, like the quote beside them. They are kept for call help alone, read
 * tolerantly from storage, never sent to a model, never carried into a Note, and never read again
 * when the Document changes. Scripted models only: nothing is sent anywhere.
 */
import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Core, Meeting } from "../../src/core";
import { pageBlocks } from "../../src/shared/answerBlocks";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, queryDatabase } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;
const PRICES =
  "Plan,Price,Sign-on\nTeam,$25 per seat a month,No\nEnterprise,$45 per seat a month,Yes\n";
const NAMED = [
  { name: "Plan", value: "Enterprise" },
  { name: "Price", value: "$45 per seat a month" },
  { name: "Sign-on", value: "Yes" },
];

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? "";

/** The line of the shown Passage that holds `words`, as the model quotes it. */
const lineWith = (text: string, words: string) =>
  (text.split("\n").find((line) => line.includes(words)) ?? "").replace(/^\[[^\]]*\]\s*/, "");

/** A model that cites the Enterprise row of the price sheet, found ahead or searched, then answers. */
function citingRow(calls: ModelCall[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      if (call.results.some((result) => result.tool === "cite")) {
        return { text: "★ Enterprise is $45 a seat, with sign-on [^1]\n→ answers at once" };
      }
      const shown = [call.prompt, ...call.results.map((result) => result.text)].flatMap((text) => [
        ...shownPassages(block(text, "found-in-documents")),
        ...shownPassages(text),
      ]);
      const passage = shown.find((each) => each.text.includes("$45 per seat"));
      if (!passage && call.tools.includes("search_documents") && call.results.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "Enterprise price" } }] };
      }
      if (!passage) return { text: "★ Let me check the price sheet\n→ buys time" };
      const quote = lineWith(passage.text, "Enterprise");
      return {
        calls: [
          { tool: "cite", input: { citations: [{ marker: 1, passage: passage.id, quote }] } },
        ],
      };
    },
    { judgesItsAnswers: true },
  );
}

async function setUp(prices = PRICES) {
  const calls: ModelCall[] = [];
  const dataDir = await createTempDataFolder();
  const models = scriptedModels(citingRow(calls));
  const { core, record } = await transcribingCore(dataDir, {
    createChatModel: models.createChatModel,
    engine: {
      lines: ["Let's go through the plans."],
      theirLines: ["What does Enterprise cost per seat, and is sign-on included?"],
    },
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createSourceFolder();
  const added = await core.addDocuments([await writeSourceFile(sources, "Prices.csv", prices)]);
  await waitForProcessing(
    core,
    added.documents.map((document) => document.id),
  );
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(6 * SECOND);
  await until(core, meeting.id, (transcript) => transcript.lines >= 2);
  return { core, meeting, calls, dataDir };
}

async function press(core: Core, meeting: Meeting, conversationId: string | null = null) {
  const asked = await core.askMeetingHelp({
    meetingId: meeting.id,
    kind: "answer",
    conversationId,
  });
  if (!asked.asked) throw new Error("Not asked.");
  await answerEnded(core, asked.answerId);
  const { messages } = await core.getConversation(asked.conversation.id);
  const answer = messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No reply.");
  return { answer, conversationId: asked.conversation.id };
}

describe("A call help Citation of a table row", { timeout: 120_000 }, () => {
  // protects=a press's Citation of a sheet's row keeps its cells, each after its column's name, as the cite found them, and reads them back from storage the same (#2847); fails_when=the cells are missing, named otherwise than the sheet's header, or differ once stored; no_claim=how the panel lays them out.
  test("keeps its cells as the cite found them, the same once stored", async () => {
    const { core, meeting } = await setUp();
    const seen: unknown[] = [];
    core.on("answer.citationAdded", ({ citation }) => seen.push(citation.cells));
    const { answer } = await press(core, meeting);
    expect(answer.citations.map((citation) => citation.cells)).toEqual([NAMED]);
    expect(seen).toEqual([NAMED]);
    // Plain data: it crosses the bridge as it is.
    expect(structuredClone(answer.citations[0]?.cells)).toEqual(NAMED);
  });

  test("a typed Question's Citation of the same row keeps none", async () => {
    const { core, meeting } = await setUp();
    const asked = await core.askInConversation({
      mindId: meeting.mindId,
      text: "What does Enterprise cost per seat?",
    });
    if (!asked.asked) throw new Error("Not asked.");
    await answerEnded(core, asked.answerId);
    const { messages } = await core.getConversation(asked.conversation.id);
    const answer = messages.find((message) => message.id === asked.answerId);
    expect(answer?.kind === "answer" && answer.citations.map((citation) => citation.cells)).toEqual(
      [undefined],
    );
  });

  // protects=the cells are the Document's words as cited: a Document changed and read again later leaves a kept reply's cells as they were, as its quote is (#2847); fails_when=the cells are read again from the new version; no_claim=what the Citation's card says of the change.
  test("a Document changed later leaves the cells as cited", async () => {
    const { core, meeting } = await setUp();
    const { answer, conversationId } = await press(core, meeting);
    const documentId = answer.citations[0]?.documentId ?? "";
    const path = (await core.listDocuments()).find((each) => each.id === documentId)?.path;
    if (!path) throw new Error("The price sheet has no file.");
    // Documents wait while a call records.
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (transcript) => transcript.state === "saved");
    await writeFile(path, PRICES.replace("$45", "$49").replace("Plan,Price", "Tier,Cost"));
    await core.reconcileDocuments();
    const [processed] = await waitForProcessing(core, [documentId]);
    expect(processed?.status).toBe("ready");
    const { messages } = await core.getConversation(conversationId);
    const again = messages.find((message) => message.id === answer.id);
    expect(again?.kind === "answer" && again.citations[0]?.cells).toEqual(NAMED);
  });

  // protects=a stored cells value that is malformed or partial reads as none, never an error, so its line draws as quoted; an unknown field on a stored Citation, as an older build meets the cells, reads through and stays when the reply is written again (#2847); fails_when=a malformed value throws, reaches the panel, or a rewrite drops an unknown field; no_claim=what an older build's panel draws.
  test("a malformed cells value reads as none; an unknown field reads through and is kept", async () => {
    const { core, meeting, dataDir } = await setUp();
    const { answer, conversationId } = await press(core, meeting);
    const store = (cells: unknown) =>
      queryDatabase(
        dataDir,
        "UPDATE conversation_messages SET citations = ? WHERE id = ? RETURNING id",
        [
          JSON.stringify(
            answer.citations.map((citation) => ({ ...citation, cells, fromLater: { kept: 1 } })),
          ),
          answer.id,
        ],
      );
    const read = async () => {
      const { messages } = await core.getConversation(conversationId);
      const found = messages.find((message) => message.id === answer.id);
      if (found?.kind !== "answer") throw new Error("No reply.");
      return found.citations[0];
    };
    for (const malformed of [
      "Enterprise $45",
      [{ name: "Plan" }],
      [{ name: 3, value: "Enterprise" }],
      [{ name: "Plan", value: "Enterprise" }, null],
      { name: "Plan", value: "Enterprise" },
    ]) {
      store(malformed);
      expect((await read())?.cells, JSON.stringify(malformed)).toBeUndefined();
    }
    store(NAMED);
    expect(await read()).toMatchObject({ cells: NAMED, fromLater: { kept: 1 } });
  });

  // protects=the cells never reach a model: a follow-up press after a table Citation sends the same requests, byte for byte, whether the earlier reply keeps its cells or not (#2847); fails_when=any request of the follow-up differs; no_claim=what the follow-up says.
  test("a follow-up press sends the same requests with the cells and without them", async () => {
    const followUp = async (keep: boolean) => {
      const { core, meeting, calls, dataDir } = await setUp();
      const first = await press(core, meeting);
      if (!keep) {
        queryDatabase(
          dataDir,
          "UPDATE conversation_messages SET citations = ? WHERE id = ? RETURNING id",
          [
            JSON.stringify(first.answer.citations.map(({ cells: _cells, ...rest }) => rest)),
            first.answer.id,
          ],
        );
      }
      const from = calls.length;
      await press(core, meeting, first.conversationId);
      return calls.slice(from).map((call) => [call.system, call.prompt].join("\n\n"));
    };
    const [withCells, without] = [await followUp(true), await followUp(false)];
    expect(withCells.length).toBeGreaterThan(0);
    expect(withCells).toEqual(without);
    expect(withCells.join("\n")).not.toContain('"cells"');
  });

  test("Add to note carries no cells into the Note's Citation", async () => {
    const { core, meeting } = await setUp();
    const { answer } = await press(core, meeting);
    expect(answer.citations[0]?.cells).toEqual(NAMED);
    const blocks = JSON.stringify(pageBlocks(answer, "Answer their question"));
    expect(blocks).toContain('"type":"citation"');
    expect(blocks).not.toContain("cells");
    expect(blocks).not.toContain('"name":"Price"');
  });
});
