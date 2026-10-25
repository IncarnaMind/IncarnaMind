/**
 * What a model reads of a Citation names its Document as the Document is named now (#710), as
 * the screen does (#532): a rename shows in the Question context, and the name stored when the
 * Citation was made is read only once the Document is gone. The Mind never changes, and History
 * keeps each Checkpoint's own names.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { BLOCK_ID_ATTRIBUTE, type Document } from "../../src/core";
import { contentHash } from "../../src/core/answers/blocks";
import {
  answerEnded,
  askAndFinish,
  citingModel,
  contextOfNextQuestion,
  setUpWithDocuments,
} from "../helpers/citations";
import { writeMind } from "../helpers/minds";
import { promptOf, streamingModel } from "../helpers/models";

const FERRY = { name: "Ferry.txt", contents: "The ferry leaves at nine." };
const TIDES = { name: "Tides.txt", contents: "Spring tides come at new moon." };
const QUOTE = "The ferry leaves at nine.";

/** A paragraph that cites the Document, with the name it has stored. */
const citing = (document: Document, storedName: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content: [
    { type: "text", text: "It leaves early " },
    {
      type: "citation",
      attrs: {
        passageId: "passage-1",
        documentId: document.id,
        documentName: storedName,
        contentHash: document.contentHash,
        pageFrom: 2,
        pageTo: 2,
        location: { kind: "page", from: 2, to: 2 },
        quote: QUOTE,
        check: "found",
      },
    },
  ],
});

const documentNamed = (documents: readonly Document[], name: string) => {
  const found = documents.find((each) => each.name === name);
  if (!found) throw new Error(`No Document ${name}.`);
  return found;
};

describe("a Question's context", () => {
  test("names a renamed Document as it is now, and a deleted one as it was cited", async () => {
    const model = streamingModel("Noted.");
    const { core, client, mind, documents } = await setUpWithDocuments(model, [FERRY, TIDES]);
    const ferry = documentNamed(documents, "Ferry");
    writeMind(client, [citing(ferry, "Ferry")]);
    await client.settled();

    expect(await contextOfNextQuestion(core, client, mind.id, model, "When?")).toContain(
      "It leaves early [Ferry, p. 2 · C1]",
    );

    await core.renameDocument(ferry.id, "Ferry timetable");
    const renamed = await contextOfNextQuestion(core, client, mind.id, model, "And later?");
    expect(renamed).toContain("It leaves early [Ferry timetable, p. 2 · C1]");
    expect(renamed).not.toContain("[Ferry, p. 2");

    await core.deleteDocument(ferry.id);
    const deleted = await contextOfNextQuestion(core, client, mind.id, model, "And on Sunday?");
    expect(deleted).toContain("It leaves early [Ferry, p. 2 · C1]");
    expect(deleted).not.toContain("Ferry timetable");
  });

  test("leaves the Answers it wrote as they were: a rename doesn't make one look edited", async () => {
    const model = citingModel({
      query: "ferry",
      records: (passages) => [{ marker: 1, passage: passages[0]?.id, quote: QUOTE }],
      answer: "It leaves at nine [^1].",
    });
    const { core, client, mind, documents } = await setUpWithDocuments(model, [FERRY, TIDES]);
    const { answerId } = await askAndFinish(core, client, mind.id, "When does the ferry leave?");
    const answer = () => {
      const found = client.blocks
        .toArray()
        .find(
          (block): block is Y.XmlElement =>
            block instanceof Y.XmlElement && block.getAttribute(BLOCK_ID_ATTRIBUTE) === answerId,
        );
      if (!found) throw new Error("No Answer.");
      return found;
    };
    const unedited = () => answer().getAttribute("generatedHash") === contentHash(answer());
    expect(unedited()).toBe(true);

    await core.renameDocument(documentNamed(documents, "Ferry").id, "Ferry timetable");
    await client.settled();

    expect(unedited()).toBe(true);
  });
});

describe("the assistant's context", () => {
  test("names the Mind it reads and its earlier Answers' Documents as they are now", async () => {
    const model = citingModel({
      query: "ferry",
      records: (passages) => [{ marker: 1, passage: passages[0]?.id, quote: QUOTE }],
      answer: "It leaves at nine [^1].",
    });
    const { core, client, mind, documents } = await setUpWithDocuments(model, [FERRY, TIDES]);
    const ferry = documentNamed(documents, "Ferry");
    writeMind(client, [citing(ferry, "Ferry")]);
    await client.settled();
    const asked = async (text: string, conversationId: string | null) => {
      const calls = model.doStreamCalls.length;
      const result = await core.askInConversation({ conversationId, text, mindId: mind.id });
      if (!result.asked) throw new Error("The Question wasn't asked.");
      await answerEnded(core, result.answerId);
      const sent = promptOf(model, calls)
        .map((message) => message.text)
        .join("\n\n");
      return { sent, conversationId: result.conversation.id };
    };

    const first = await asked("When does the ferry leave?", null);
    expect(first.sent).toContain("It leaves early [Ferry, p. 2 · C1]");

    await core.renameDocument(ferry.id, "Ferry timetable");
    const renamed = await asked("And on Sunday?", first.conversationId);
    expect(renamed.sent).toContain("It leaves early [Ferry timetable, p. 2 · C1]");
    expect(renamed.sent).toMatch(/It leaves at nine \[Ferry timetable[^\]]*\]/);
    expect(renamed.sent).not.toMatch(/\[Ferry[,\]]/);

    await core.deleteDocument(ferry.id);
    const deleted = await asked("And on Monday?", first.conversationId);
    // Each reads as it was cited: the Answer written after the rename was cited as "Ferry timetable".
    expect(deleted.sent).toContain("It leaves early [Ferry, p. 2 · C1]");
    expect(deleted.sent).toContain("It leaves at nine [Ferry, line 1 · C");
    expect(deleted.sent).toContain("It leaves at nine [Ferry timetable, line 1 · C");
  });
});

describe("History", () => {
  test("shows each Checkpoint's own names after a Document is renamed", async () => {
    const { core, client, mind, documents } = await setUpWithDocuments(streamingModel("Noted."), [
      FERRY,
    ]);
    const ferry = documentNamed(documents, "Ferry");
    writeMind(client, [citing(ferry, "Ferry")]);
    await client.settled();
    const earlier = await core.saveCheckpoint(mind.id, "accept");

    await core.renameDocument(ferry.id, "Ferry timetable");
    writeMind(client, [citing(ferry, "Ferry timetable")]);
    await client.settled();

    const { rows } = await core.compareCheckpoints({ mindId: mind.id, from: earlier.id, to: null });
    const cited = (side: "left" | "right") =>
      rows[0]?.[side]?.parts.flatMap((part) => (part.kind === "citation" ? [part.work] : []));
    expect(cited("left")).toEqual([expect.objectContaining({ documentName: "Ferry" })]);
    expect(cited("right")).toEqual([expect.objectContaining({ documentName: "Ferry timetable" })]);
  });
});
