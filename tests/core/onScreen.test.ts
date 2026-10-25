/**
 * The Documents open on screen go with a Question in the assistant (#1334): one line before the
 * Question, naming those it may search, so "this document" means the one the User is looking at.
 * Through the core's public interface, as the composer and Try again send them.
 */
import { describe, expect, test } from "vitest";
import type { AskInConversationInput, Core } from "../../src/core";
import { InvalidInputError } from "../../src/core/errors";
import { answerEnded, setUpWithDocuments } from "../helpers/citations";
import { note, writeMind } from "../helpers/minds";
import { promptOf, streamingModel } from "../helpers/models";

const CONTRACT = {
  name: "Employment contract.txt",
  contents: "Employment contract.\nEither party may end this contract with one month's notice.\n",
};
const NDA = {
  name: "Mutual NDA.txt",
  contents: "Mutual non-disclosure agreement.\nConfidentiality lasts five years.\n",
};

async function setUp() {
  const model = streamingModel("Noted.");
  const set = await setUpWithDocuments(model, [CONTRACT, NDA]);
  const idOf = (name: string) => {
    const found = set.documents.find((each) => each.name === name);
    if (!found) throw new Error(`No Document ${name}.`);
    return found.id;
  };
  return { ...set, model, contract: idOf("Employment contract"), nda: idOf("Mutual NDA") };
}

async function ask(core: Core, input: AskInConversationInput) {
  const result = await core.askInConversation(input);
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
  return result;
}

/** The text of the request's last user message: the Question, after what it is asked beside. */
const lastSent = (model: ReturnType<typeof streamingModel>, call: number) =>
  promptOf(model, call)
    .filter((message) => message.role === "user")
    .at(-1)?.text ?? "";

const instructionsOf = (model: ReturnType<typeof streamingModel>, call: number) =>
  promptOf(model, call).find((message) => message.role === "system")?.text ?? "";

describe("The Documents on screen in the assistant", { timeout: 30_000 }, () => {
  // protects=the Documents open on screen reach the model by name, the focused group's first, on one line before the Question, and the rule that reads them is in the instructions (#1334); fails_when=they are left out, reordered, or the rule is missing; no_claim=what a real model makes of them, which the everyday evaluation measures.
  test("start the Question's message, the focused group's first", async () => {
    const { core, mind, model, contract, nda } = await setUp();

    await ask(core, {
      text: "Write a short summary of this document.",
      mindId: mind.id,
      onScreen: [nda, contract],
    });

    expect(lastSent(model, 0)).toMatch(
      /(?:^|\n\n)On screen now: "Mutual NDA", "Employment contract"\n\nWrite a short summary of this document\.$/,
    );
    const rules = instructionsOf(model, 0);
    expect(rules).toContain('A line "On screen now: …" before the Question');
    expect(rules).toContain("ask which one with ask_user");
    expect(rules).toContain("five lines at most");
  });

  // protects=with nothing on screen the Question goes as before, with no line; fails_when=an empty line or label is sent; no_claim=none beyond protects.
  test("send no line when none is open", async () => {
    const { core, mind, model } = await setUp();

    await ask(core, { text: "Summarise my notes", mindId: mind.id, onScreen: [] });

    expect(lastSent(model, 0)).not.toContain("On screen now");
  });

  // protects=a Document on screen outside the Question's Search scope is left out, so the scope and what leaves the computer stay as they were; fails_when=it is named; no_claim=none beyond protects.
  test("leave out a Document outside the Question's Search scope", async () => {
    const { core, mind, model, contract, nda } = await setUp();
    const scope = { folderIds: [], tagIds: [], documentIds: [contract] };

    await ask(core, { text: "Summarise this document.", mindId: mind.id, scope, onScreen: [nda] });
    await ask(core, {
      text: "Summarise this document.",
      mindId: mind.id,
      scope,
      onScreen: [nda, contract],
    });

    expect(lastSent(model, 0)).not.toContain("On screen now");
    expect(lastSent(model, 0)).not.toContain("Mutual NDA");
    expect(lastSent(model, 1)).toMatch(
      /(?:^|\n\n)On screen now: "Employment contract"\n\nSummarise this document\.$/,
    );
  });

  // protects=Try again reads what is on screen when it is pressed, and nothing of it is kept with the Question; fails_when=it reuses what was open when the Question was asked, or reads nothing; no_claim=none beyond protects.
  test("Try again reads what is on screen then", async () => {
    const { core, mind, model, contract, nda } = await setUp();
    const asked = await ask(core, {
      text: "Write a short summary of this document.",
      mindId: mind.id,
      onScreen: [contract],
    });
    const again = (onScreen?: string[]) =>
      core
        .regenerateConversationAnswer({
          conversationId: asked.conversation.id,
          answerId: asked.answerId,
          ...(onScreen && { onScreen }),
        })
        .then((result) => {
          if (!result.asked) throw new Error("Not asked again.");
          return answerEnded(core, result.answerId);
        });

    await again([nda]);
    await again();

    expect(lastSent(model, 1)).toMatch(/(?:^|\n\n)On screen now: "Mutual NDA"\n\nWrite a short/);
    expect(lastSent(model, 2)).not.toContain("On screen now");
    const { messages } = await core.getConversation(asked.conversation.id);
    expect(messages.find((message) => message.kind === "question")).not.toHaveProperty("onScreen");
  });

  // protects=opening another Document never changes the Mind's part of the request, which a provider's prompt cache keeps (#343, #564); fails_when=the line goes into the Mind's message or the instructions; no_claim=none beyond protects.
  test("leave the Mind's message and the instructions as they were", async () => {
    const { core, mind, client, model, contract, nda } = await setUp();
    writeMind(client, [note("Call with Harbour Logistics on Friday.")]);
    await client.settled();
    const first = await ask(core, { text: "What is this?", mindId: mind.id, onScreen: [contract] });

    await ask(core, {
      text: "And this?",
      mindId: mind.id,
      conversationId: first.conversation.id,
      onScreen: [nda],
    });

    for (const call of [0, 1])
      expect(instructionsOf(model, call)).not.toContain('On screen now: "');
    const mindOf = (call: number) =>
      /^<mind [\s\S]*?<\/mind>/.exec(
        promptOf(model, call).find((message) => message.role === "user")?.text ?? "",
      )?.[0];
    expect(mindOf(0)).toContain("Call with Harbour Logistics on Friday.");
    expect(mindOf(0)).not.toContain("On screen now");
    expect(mindOf(1)).toBe(mindOf(0));
  });

  // protects=anything but a list of Document ids is refused before anything is kept; fails_when=it is kept or ignored; no_claim=none beyond protects.
  test("refuse what isn't a list of Document ids", async () => {
    const { core, mind } = await setUp();

    await expect(
      core.askInConversation({
        text: "Summarise this document.",
        mindId: mind.id,
        onScreen: [""],
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(await core.listConversations()).toEqual([]);
  });
});
