import { describe, expect, test } from "vitest";
import type { Core, UserQuestionRequest } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { answerEnded, askAndFinish, setUpWithDocuments } from "../helpers/citations";
import { nextEvent } from "../helpers/core";
import { type ModelCall, scriptedModel } from "../helpers/models";

/*
 * The assistant asks the User a question with options (#1374), through the core's public
 * interface as the window answers it. The model's choices are scripted; real models' are tried by
 * hand.
 */

const DOCUMENTS = [
  { name: "Lease Harbour Street.md", contents: "# Harbour Street\n\nThe rent is 900 euros.\n" },
  { name: "Lease Mill Lane.md", contents: "# Mill Lane\n\nThe rent is 700 euros.\n" },
  { name: "Board minutes.md", contents: "# Board\n\nThe board met in March.\n" },
];

const WHICH = {
  question: "Which Documents should I summarise?",
  detail: "Your Library has 3. The two newest are picked.",
  multiple: true,
  other: true,
  options: [
    { label: "Lease Mill Lane", description: "Markdown", preselected: true },
    { label: "Board minutes", description: "Markdown", recommended: true, preselected: true },
    { label: "Lease Harbour Street", description: "Markdown" },
  ],
};

const SCOPE = {
  question: "Search all Documents?",
  options: [
    { label: "All my Documents", description: "3 Documents", recommended: true },
    { label: "Answer without Documents", description: "No Citations" },
  ],
};

/** A model that asks each of these in turn, then replies with what it was told of the last. */
const asking = (...questions: Record<string, unknown>[]) =>
  scriptedModel((call: ModelCall) => {
    const asked = call.results.filter((each) => each.tool === "ask_user");
    const next = questions[asked.length];
    if (next) return { calls: [{ tool: "ask_user", input: next }] };
    return { text: asked.at(-1)?.text ?? "Done." };
  });

/** Answers the next question the assistant asks with `answer`, and gives back what it asked. */
function answering(core: Core, answer: (asked: UserQuestionRequest) => unknown) {
  const asked: UserQuestionRequest[] = [];
  core.on("question.asked", (request) => {
    asked.push(request);
    void core.answerUserQuestion(
      request.requestId,
      answer(request) as Parameters<Core["answerUserQuestion"]>[1],
    );
  });
  return asked;
}

describe("The assistant asks the User a question with options (#1374)", { timeout: 60_000 }, () => {
  // protects=a question waits in the tray with the recommended option first, and the model reads the User's choice, which its Answer keeps with the thread; fails_when=the order is the model's, the Answer goes on without the answer, or History loses it; no_claim=the tray's looks.
  test("asks, waits for the choice, and keeps it with the thread", async () => {
    const model = asking(SCOPE);
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const asked = answering(core, () => ({
      skipped: false,
      chosen: ["All my Documents"],
      wrote: null,
    }));

    const answer = await askAssistant(core, { text: "What is the rent?", mindId: mind.id });

    expect(asked).toEqual([
      expect.objectContaining({
        answerId: answer.id,
        question: expect.objectContaining({
          question: "Search all Documents?",
          options: [
            expect.objectContaining({ label: "All my Documents", recommended: true }),
            expect.objectContaining({ label: "Answer without Documents", recommended: false }),
          ],
          multiple: false,
          answer: null,
        }),
      }),
    ]);
    expect(answer.text).toContain("The User answered “All my Documents”");
    const stored = (await core.getConversation(answer.conversationId)).messages.find(
      (message) => message.id === answer.id,
    );
    expect(stored?.kind === "answer" && stored.toolCalls[0]).toMatchObject({
      tool: "ask_user",
      source: "asks",
      status: "done",
      asked: { answer: { skipped: false, chosen: ["All my Documents"], wrote: null } },
    });
    expect(await core.listUserQuestions()).toEqual([]);
  });

  // protects=several may be chosen, with options ticked already and the User's own words; the answer lists the choices in the question's order; fails_when=a choice or the words are lost; no_claim=which ones a model ticks.
  test("several chosen, with the User's own words", async () => {
    const model = asking(WHICH);
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const asked = answering(core, () => ({
      skipped: false,
      chosen: ["Lease Harbour Street", "Board minutes"],
      wrote: "and the one about the boiler",
    }));

    const answer = await askAssistant(core, {
      text: "Summarise the main documents",
      mindId: mind.id,
    });

    expect(asked[0]?.question).toMatchObject({
      detail: "Your Library has 3. The two newest are picked.",
      multiple: true,
      other: true,
      options: [
        { label: "Board minutes", recommended: true, preselected: true },
        { label: "Lease Mill Lane", recommended: false, preselected: true },
        { label: "Lease Harbour Street", recommended: false, preselected: false },
      ],
    });
    expect(answer.text).toContain(
      "“Board minutes” and “Lease Harbour Street” and in their own words: “and the one about the boiler”",
    );
  });

  // protects=Esc skips: the model is told to go on with the recommended option and say what it assumed, and the thread keeps that it was skipped; fails_when=the Answer waits for ever or claims a choice; no_claim=the words of the Answer.
  test("a skipped question tells the model to go on with the recommended option", async () => {
    const model = asking(SCOPE);
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    answering(core, () => ({ skipped: true }));

    const answer = await askAssistant(core, { text: "What is the rent?", mindId: mind.id });

    expect(answer.text).toContain("The User skipped the question. Go on with “All my Documents”");
    expect(answer.toolCalls[0]?.asked?.answer).toEqual({ skipped: true });
  });

  // protects=an answer the question doesn't take is refused and the question keeps waiting: a choice it didn't offer, two where one may be chosen, words where none may be written, or nothing; fails_when=any of them reaches the model; no_claim=the window, which offers only valid answers.
  test("an answer the question doesn't take is refused, and it keeps waiting", async () => {
    const model = asking(SCOPE);
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const requested = nextEvent(core, "question.asked");
    const result = await core.askInConversation({ text: "What is the rent?", mindId: mind.id });
    if (!result.asked) throw new Error("Not asked.");
    const { requestId } = await requested;

    for (const wrong of [
      { skipped: false, chosen: ["Somewhere else"], wrote: null },
      { skipped: false, chosen: ["All my Documents", "Answer without Documents"], wrote: null },
      { skipped: false, chosen: [], wrote: "my own" },
      { skipped: false, chosen: [], wrote: null },
    ]) {
      await expect(core.answerUserQuestion(requestId, wrong)).rejects.toMatchObject({
        wording: { key: "error.question.answer" },
      });
    }
    expect(await core.listUserQuestions()).toHaveLength(1);

    await core.answerUserQuestion(requestId, { skipped: true });
    await answerEnded(core, result.answerId);
  });

  // protects=at most two questions in one Answer, asked one after another even when the model calls them at once; fails_when=a third is asked, or two wait at once; no_claim=how a real model spaces them.
  test("two questions wait one after the other, and a third is refused", async () => {
    const model = scriptedModel((call: ModelCall) => {
      if (call.results.length === 0) {
        return {
          calls: [
            { tool: "ask_user", input: SCOPE },
            { tool: "ask_user", input: WHICH },
          ],
        };
      }
      if (call.results.length === 2) return { calls: [{ tool: "ask_user", input: SCOPE }] };
      return { text: call.results.at(-1)?.text ?? "Done." };
    });
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const waitingWhenAsked: number[] = [];
    core.on("question.asked", (request) => {
      void core.listUserQuestions().then((waiting) => {
        waitingWhenAsked.push(waiting.length);
        void core.answerUserQuestion(request.requestId, { skipped: true });
      });
    });

    const answer = await askAssistant(core, {
      text: "Summarise the main documents",
      mindId: mind.id,
    });

    expect(waitingWhenAsked).toEqual([1, 1]);
    expect(answer.toolCalls.map((call) => call.status)).toEqual(["done", "done", "failed"]);
    expect(answer.text).toContain("You have asked 2 questions in this answer");
  });

  // protects=stopping the Answer takes its question out of the tray in every window; fails_when=the question stays waiting; no_claim=Tasks.
  test("stopping the Answer withdraws its question", async () => {
    const model = asking(SCOPE);
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const requested = nextEvent(core, "question.asked");
    const result = await core.askInConversation({ text: "What is the rent?", mindId: mind.id });
    if (!result.asked) throw new Error("Not asked.");
    const { requestId } = await requested;
    const withdrawn = nextEvent(core, "question.answered");

    await core.stopConversationAnswer({
      conversationId: result.conversation.id,
      answerId: result.answerId,
    });

    expect(await withdrawn).toEqual({ requestId, answer: null });
    expect(await core.listUserQuestions()).toEqual([]);
  });

  // protects=the question is offered in the assistant only, where the tray is; fails_when=a Question in a Mind can ask; no_claim=Tasks.
  test("is offered in the assistant, and not to a Question in a Mind", async () => {
    const tools: string[][] = [];
    const model = scriptedModel((call) => {
      tools.push(call.tools);
      return { text: "Done." };
    });
    const { core, mind, client } = await setUpWithDocuments(model, DOCUMENTS);

    await askAssistant(core, { text: "Summarise the main documents", mindId: mind.id });
    expect(tools.at(-1)).toContain("ask_user");
    await askAndFinish(core, client, mind.id, "Summarise the main documents");
    expect(tools.at(-1)).not.toContain("ask_user");
  });
});
