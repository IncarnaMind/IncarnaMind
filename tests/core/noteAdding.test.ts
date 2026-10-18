import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import {
  type AskInConversationInput,
  type ConversationAnswer,
  type Core,
  InvalidInputError,
  messageReference,
  PROPOSAL_ATTRIBUTE,
} from "../../src/core";
import { answerBlocks } from "../../src/shared/answerBlocks";
import { allOrigins } from "../../src/shared/blockOrigins";
import { withoutFraming } from "../../src/shared/noteBlocks";
import { aiUseOfAccepted, pendingProposals, resolveProposals } from "../../src/shared/proposals";
import { citingModel } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, writeMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/**
 * Add to note (#201) through the core's public interface, as the assistant
 * uses it for a Mind that isn't open in the editor: an Answer of a
 * conversation, as Blocks, goes into a Mind with its Citations checked again
 * there and a link back to the Answer, and Undo takes it out.
 */

const SPRING = "Spring tides happen just after a new moon or a full moon.";
const PDF = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  { lines: ["Spring and neap tides", SPRING] },
]);
const QUESTION = "When are spring tides?";

async function setUp(model: MockLanguageModelV4) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return core;
}

/** Asks in the assistant and waits for the Answer, written. */
async function askAndWait(core: Core, input: AskInConversationInput): Promise<ConversationAnswer> {
  const result = await core.askInConversation(input);
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await new Promise<void>((resolve) => {
    const stop = core.on("answer.finished", ({ answerId }) => {
      if (answerId !== result.answerId) return;
      stop();
      resolve();
    });
  });
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

/** A core with a cited Answer in a conversation, and a Mind of Notes to add it to. */
async function citedAnswer() {
  const model = citingModel({
    query: "spring tides",
    records: (passages) => [
      { marker: 1, passage: passages[0]?.id, pageFrom: 2, pageTo: 2, quote: SPRING },
    ],
    answer: "Spring tides come at new and full moon [^1].",
  });
  const core = await setUp(model);
  const sources = await createSourceFolder();
  const [document] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.pdf", PDF)]);
  if (!document) throw new Error("Nothing was added.");
  const answer = await askAndWait(core, { text: QUESTION });
  return { core, answer, document };
}

const originOf = (answer: ConversationAnswer) => ({
  from: messageReference(answer.conversationId, answer.id),
  question: QUESTION,
});

describe("Add to note into a Mind that isn't open", { timeout: 60_000 }, () => {
  test("goes at its end, in place of its empty last line, Citations checked there, with a link back and a record of AI use; Undo takes it out", async () => {
    const { core, answer, document } = await citedAnswer();
    const mind = await core.createMind({ title: "Essay" });
    const writer = await connectToMind(core, mind.id);
    writeMind(writer, [note("Intro"), note("")]);
    await writer.settled();

    const added = await core.addToNote({
      mindId: mind.id,
      blocks: answerBlocks(answer),
      origin: originOf(answer),
      model: answer.model,
    });
    expect(added.blockIds).toHaveLength(1);

    const reader = await connectToMind(core, mind.id);
    const read = readMind(reader);
    expect(read.childCount).toBe(2);
    expect(read.child(0).textContent).toBe("Intro");
    const paragraph = read.child(1);
    expect(paragraph.attrs.id).toBe(added.blockIds[0]);
    expect(paragraph.textContent).toBe("Spring tides come at new and full moon .");
    const citations: Record<string, unknown>[] = [];
    paragraph.descendants((node) => {
      if (node.type.name === "citation") citations.push(node.attrs);
    });
    expect(citations).toEqual([
      expect.objectContaining({ documentId: document.id, quote: SPRING, check: "found" }),
    ]);
    // The link back, by Block id, beside the Blocks.
    expect(allOrigins(reader.doc).get(added.blockIds[0] ?? "")).toEqual(originOf(answer));
    expect(await core.listAiUse(mind.id)).toEqual([
      expect.objectContaining({
        kind: "answer-added",
        outcome: "kept",
        modelId: "local-model",
        blockIds: added.blockIds,
        // The words, and the Citation as one.
        characters: "Spring tides come at new and full moon .".length + 1,
      }),
    ]);

    // The link leads to the conversation by its name; deleted, it says so.
    expect(await core.resolveReference(originOf(answer).from)).toMatchObject({
      status: "available",
      name: "When are spring tides",
    });
    await core.deleteConversation(answer.conversationId);
    expect(await core.resolveReference(originOf(answer).from)).toMatchObject({
      status: "deleted",
      name: "When are spring tides",
    });

    await core.undoAddToNote({ mindId: mind.id, blockIds: added.blockIds });
    const after = await connectToMind(core, mind.id);
    expect(readMind(after).childCount).toBe(1);
    expect(readMind(after).child(0).textContent).toBe("Intro");
    expect(allOrigins(after.doc).size).toBe(0);
  });

  test("into a new Mind, waits as changes to accept, each Block one; accepted, it is recorded as an Answer added", async () => {
    const { core, answer } = await citedAnswer();
    const mind = await core.createMind({ title: "When are spring tides" });
    const added = await core.addToNote({
      mindId: mind.id,
      blocks: answerBlocks(answer),
      origin: originOf(answer),
      model: answer.model,
      proposed: true,
    });
    const client = await connectToMind(core, mind.id);
    const [block] = client.blocks.toArray();
    expect(
      block && "getAttribute" in block && block.getAttribute(PROPOSAL_ATTRIBUTE),
    ).toMatchObject({ kind: "insert" });
    expect(pendingProposals(client.blocks)).toHaveLength(1);
    // Nothing is recorded until it is accepted.
    expect(await core.listAiUse(mind.id)).toEqual([]);

    let accepted: ReturnType<typeof resolveProposals> = [];
    client.doc.transact(() => {
      accepted = resolveProposals(client.blocks, () => true, "accept");
    });
    await client.settled();
    const entries = aiUseOfAccepted(client.doc, mind.id, accepted, new Date().toISOString());
    expect(entries).toEqual([
      expect.objectContaining({
        kind: "answer-added",
        modelId: "local-model",
        blockIds: added.blockIds,
      }),
    ]);
  });

  // protects=#1061: the model's line about how it went about the request stays in the panel, and only the summaries go into the Mind, as the window's Add to note adds a whole Answer; fails_when=the explaining line reaches the Mind; no_claim=every way a model explains itself.
  test("leaves out the model's line about how it went about the request", async () => {
    const reply = [
      "你没有说明是哪一份合同，所以我把四份文档各写了一段简短摘要。",
      "## 合同 A",
      "租期为两年，月租金为八千元。",
      "## 合同 B",
      "押金为两个月租金。",
    ].join("\n\n");
    const core = await setUp(scriptedModel(() => ({ text: reply })));
    const answer = await askAndWait(core, { text: "写一下合同的摘要" });
    const mind = await core.createMind({ title: "合同笔记" });

    await core.addToNote({
      mindId: mind.id,
      blocks: withoutFraming(answerBlocks({ ...answer, status: "done" })),
      origin: null,
      model: answer.model,
    });

    const client = await connectToMind(core, mind.id);
    await client.settled();
    const text = readMind(client).textContent;
    expect(text).not.toContain("你没有说明");
    expect(text).toContain("租期为两年");
    expect(text).toContain("押金为两个月租金");
  });

  test("takes only Notes, and a link back that is one", async () => {
    const { core, answer } = await citedAnswer();
    const mind = await core.createMind({ title: "Essay" });
    await expect(
      core.addToNote({
        mindId: mind.id,
        blocks: [{ type: "question", content: [{ type: "text", text: "Why?" }] }],
        origin: null,
        model: null,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      core.addToNote({
        mindId: mind.id,
        blocks: answerBlocks(answer),
        origin: { from: { artifactKind: "conversation" }, question: QUESTION } as never,
        model: null,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      core.addToNote({ mindId: mind.id, blocks: [], origin: null, model: null }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("An Answer as Blocks", () => {
  test("while written, a marker whose Citation hasn't come shows as being checked; once ended, it is left out", () => {
    const streaming = answerBlocks({
      text: "Tides [^1] and moons [^2] too",
      citations: [],
      figures: [],
      status: "streaming",
    });
    const markers: unknown[] = [];
    const visit = (node: {
      type: string;
      attrs?: Record<string, unknown>;
      content?: unknown[];
    }) => {
      if (node.type === "citation") markers.push(node.attrs?.check);
      for (const child of (node.content ?? []) as (typeof node)[]) visit(child);
    };
    streaming.forEach(visit);
    expect(markers).toEqual(["checking", "checking"]);

    const ended = answerBlocks({
      text: "Tides [^1].",
      citations: [],
      figures: [],
      status: "done",
    });
    expect(ended).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "Tides.", marks: [{ type: "generated" }] }],
      },
    ]);
  });
});
