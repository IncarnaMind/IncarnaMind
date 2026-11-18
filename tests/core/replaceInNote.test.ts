import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { askAssistant, changesIn, lastResult, mindCalls } from "../helpers/assistant";
import { checkReply, isCheckRun } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, readMind, resolveChanges, writeMind } from "../helpers/minds";
import { judgesNothing, type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

/**
 * A small change inside a Note made as an exact replacement (#3284): the model gives the words as
 * the Note holds them and their new words, and the app swaps them. Only the words that differ
 * change, with Citations and looks under the kept words left alone, in one change; words that
 * aren't there, are there more than once or have a Citation inside are refused with the reason, and
 * nothing changes. The model's choices are scripted; real models' are in
 * tests/live/smallEdits.live.test.ts.
 */

const SALARY = "The salary is £41,500 a year, paid monthly. The notice is one month.";
const FLOORS = "The desk is on the third floor. The kitchen is on the third floor.";
const DEPOSIT = "The deposit is two months of rent";

interface Swap {
  old: string;
  now: string;
  part?: string;
}

/** A model that gives edit_mind each of `swaps` in turn, then says it is done. */
function swapModel(swaps: readonly Swap[]) {
  let tries = 0;
  return scriptedModel(
    (call: ModelCall) => {
      if (isCheckRun(call)) return checkReply(call, {});
      const done = call.results.filter((result) => result.tool === "edit_mind");
      const next = swaps[tries];
      if (done.length === tries && next) {
        tries++;
        return {
          calls: [
            {
              tool: "edit_mind",
              input: {
                old_text: next.old,
                new_text: next.now,
                ...(next.part !== undefined && { part: next.part }),
              },
            },
          ],
        };
      }
      return { text: "Done." };
    },
    { generate: judgesNothing },
  );
}

/** A paragraph with a bold word, a Citation after it, and more text. */
const withCitation = (documentId: string, contentHash: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content: [
    { type: "text", text: `${DEPOSIT}, ` },
    { type: "text", text: "held", marks: [{ type: "bold" }] },
    { type: "text", text: " by the agent" },
    {
      type: "citation",
      attrs: {
        passageId: "passage-1",
        documentId,
        documentName: "Lease",
        contentHash,
        pageFrom: null,
        pageTo: null,
        quote: "The deposit is two months of rent.",
        check: "found",
        checkReason: null,
      },
    },
    { type: "text", text: ". Pets need the landlord's written consent." },
  ],
});

async function askToSwap(model: MockLanguageModelV4, request: string) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const folder = await core.createLibraryGroup({ name: "Flat", description: "" });
  const sources = await createSourceFolder();
  const added = await core.addDocuments(
    [await writeSourceFile(sources, "Lease.md", "# Lease\n\nThe deposit is two months of rent.\n")],
    { groupId: folder.id },
  );
  const [document] = await waitForProcessing(
    core,
    added.documents.map((each) => each.id),
  );
  const mind = await core.createMind({ title: "Flat notes", folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    note(SALARY),
    note(FLOORS),
    heading(2, "Deposit"),
    withCitation(document?.id ?? "", document?.contentHash ?? ""),
    heading(2, "Pets"),
    note("The pet rule is in the lease. The deposit is two months of rent."),
    note("看板组每周二上午十点开会半小时，报告负责人参加。"),
  ]);
  await client.settled();
  const answer = await askAssistant(core, {
    text: request,
    mindId: mind.id,
    scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
  });
  await client.settled();
  await resolveChanges(client, "accept");
  const doc = readMind(client);
  const paragraphs: string[] = [];
  doc.forEach((node) => {
    paragraphs.push(node.textContent);
  });
  return { answer, client, paragraphs, doc, core, mindId: mind.id };
}

const toldToTheModel = (model: MockLanguageModelV4) =>
  model.doStreamCalls
    .flatMap((call) => call.prompt)
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .map((part) => (part.type === "tool-result" ? JSON.stringify(part.output) : ""))
    .join("\n");

describe("A small change as an exact replacement", { timeout: 30_000 }, () => {
  // protects=a figure swapped in a paragraph changes those words and no others, in one change the call reports by its old and new words; fails_when=another paragraph or word changes, or the call says more than was measured
  test("swaps the words and nothing else", async () => {
    const model = swapModel([{ old: "£41,500 a year", now: "£43,000 a year" }]);

    const { answer, paragraphs } = await askToSwap(model, "The salary is now £43,000.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done"]);
    expect(paragraphs[0]).toBe(
      "The salary is £43,000 a year, paid monthly. The notice is one month.",
    );
    expect(paragraphs[1]).toBe(FLOORS);
    expect(changesIn(answer)).toMatchObject([
      { proposals: 1, swapped: { old: "41,500", now: "43,000" } },
    ]);
    expect(lastResult(model)).toContain(
      "Changed “£41,500 a year” to “£43,000 a year” in “Flat notes”",
    );
  });

  // protects=the change's own words, which the card shows, are the words that differ, not the whole phrase the model gave, and a language set without spaces keeps a few characters beside the change; fails_when=the card repeats the phrase, or cuts a word or a number in two
  test.each([
    ["The salary is £41,500 a year", "The salary is £43,000 a year", "41,500", "43,000"],
    ["The notice is one month", "The notice is two months", "one month", "two months"],
    ["每周二上午十点开会", "每周三上午十点开会", "每周二上午", "每周三上午"],
    ["Pets need the landlord's written consent", "Pets need the written consent", "landlord's", ""],
    ["The notice is one month", "The notice is one full month", "one", "one full"],
  ])("the card says what differs: %s", async (before, after, old, now) => {
    const model = swapModel([{ old: before, now: after }]);

    const { answer } = await askToSwap(model, "Fix it.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done"]);
    expect(changesIn(answer)[0]?.swapped).toEqual({ old, now });
  });

  // protects=a swap is one change with one Checkpoint, and restoring it puts the Note back as it was; fails_when=a swap leaves none to go back to, or more than one
  test("lands as one change with one Undo", async () => {
    const model = swapModel([{ old: "£41,500 a year", now: "£43,000 a year" }]);

    const { core, mindId, client } = await askToSwap(model, "The salary is now £43,000.");

    const { checkpoints } = await core.listCheckpoints(mindId);
    expect(checkpoints).toHaveLength(1);
    await core.restoreCheckpoint(mindId, checkpoints[0]?.id ?? "");
    await client.settled();
    const back: string[] = [];
    readMind(client).forEach((node) => {
      back.push(node.textContent);
    });
    expect(back[0]).toBe(SALARY);
  });

  // protects=words that aren't in the Note as written are refused with the reason, nothing changes, and the model's second try lands; fails_when=a near match is swapped, or the refusal gives no way forward
  test("words that aren't there are refused and nothing changes", async () => {
    const model = swapModel([
      { old: "£41,000 a year", now: "£43,000 a year" },
      { old: "£41,500 a year", now: "£43,000 a year" },
    ]);

    const { answer, paragraphs } = await askToSwap(model, "The salary is now £43,000.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["failed", "done"]);
    expect(mindCalls(answer)[0]?.mindProblem).toMatchObject({ kind: "no-words" });
    expect(toldToTheModel(model)).toContain("no paragraph holds “£41,000 a year” as written");
    expect(toldToTheModel(model)).toContain("Give old_text exactly as the Note reads it");
    expect(paragraphs[0]).toContain("£43,000");
  });

  // protects=a swap asked for again, the old words gone and the new there, is refused and told it is already made, so the model stops; fails_when=the refusal gives no hint that the Note already holds the new words
  test("the same swap again is told it is already made", async () => {
    const model = swapModel([
      { old: "£41,500 a year", now: "£43,000 a year" },
      { old: "£41,500 a year", now: "£43,000 a year" },
    ]);

    const { answer, paragraphs } = await askToSwap(model, "The salary is now £43,000.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done", "failed"]);
    expect(toldToTheModel(model)).toContain("if that is this change, it is already made");
    expect(paragraphs[0]).toBe(
      "The salary is £43,000 a year, paid monthly. The notice is one month.",
    );
  });

  // protects=words found more than once are refused with where, and the one asked for lands once it is told apart by more words; fails_when=either place is changed on the first try
  test("words found twice are refused, then land once told apart", async () => {
    const model = swapModel([
      { old: "on the third floor", now: "on the second floor" },
      { old: "The desk is on the third floor", now: "The desk is on the second floor" },
    ]);

    const { answer, paragraphs } = await askToSwap(model, "The desk is on the second floor.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["failed", "done"]);
    expect(mindCalls(answer)[0]?.mindProblem).toMatchObject({ kind: "several-words", count: 2 });
    expect(toldToTheModel(model)).toContain("is in it 2 times, in paragraphs that start");
    expect(paragraphs[1]).toBe(
      "The desk is on the second floor. The kitchen is on the third floor.",
    );
  });

  // protects=naming the paragraph narrows where the words are looked for, so the same words in another section aren't a second place; fails_when=part is ignored
  test("a part narrows the search to its section", async () => {
    const model = swapModel([
      { old: "two months of rent", now: "three months of rent", part: "Pets" },
    ]);

    const { answer, paragraphs } = await askToSwap(model, "In Pets, the deposit is three months.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done"]);
    expect(paragraphs[5]).toBe(
      "The pet rule is in the lease. The deposit is three months of rent.",
    );
    expect(paragraphs[3]).toContain("two months of rent");
  });

  // protects=a part the Note doesn't hold doesn't stop a swap, since the words alone find their place; fails_when=a swap is refused for a paragraph label it was given
  test("a part the Note doesn't hold is ignored", async () => {
    const model = swapModel([{ old: "£41,500 a year", now: "£43,000 a year", part: "Salary" }]);

    const { answer, paragraphs } = await askToSwap(model, "The salary is now £43,000.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done"]);
    expect(paragraphs[0]).toBe(
      "The salary is £43,000 a year, paid monthly. The notice is one month.",
    );
  });

  // protects=words as written across a Citation's place aren't found, and the refusal shows the paragraph with its marker so the model can try again; fails_when=the Citation is dropped or moved
  test("words across a Citation are not found, and the refusal shows the paragraph", async () => {
    const model = swapModel([
      { old: "by the agent. Pets need", now: "by the landlord. Pets need" },
    ]);

    const { answer, paragraphs } = await askToSwap(model, "The agent is the landlord.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["failed"]);
    expect(mindCalls(answer)[0]?.mindProblem).toMatchObject({ kind: "no-words" });
    expect(paragraphs[3]).toContain("held by the agent");
  });

  // protects=the Citation and the bold under the kept words stay where they were when the words around them change; fails_when=the Citation or the bold goes
  test("a Citation and a look under kept words stay", async () => {
    const model = swapModel([
      { old: "is two months of rent,", now: "is three months of rent," },
      { old: "The pet rule is in the lease", now: "The pet rule is in the contract" },
    ]);

    const { answer, doc } = await askToSwap(
      model,
      "The deposit is three months, and the rule is in the contract.",
    );

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done", "done"]);
    const paragraph = doc.child(3);
    expect(paragraph.textContent).toContain(
      "The deposit is three months of rent, held by the agent",
    );
    const kinds: string[] = [];
    paragraph.forEach((child) => {
      kinds.push(
        child.type.name + (child.marks.some((mark) => mark.type.name === "bold") ? ":bold" : ""),
      );
    });
    expect(kinds.filter((kind) => kind === "citation")).toHaveLength(1);
    expect(kinds).toContain("text:bold");
  });

  // protects=words that are also in a paragraph whose changes are still waiting are not swapped in the one other paragraph that holds them, since which one was meant can't be told; fails_when=the swap lands in the paragraph that can be read
  test("words also in a paragraph with changes waiting are refused, and the other paragraph stays", async () => {
    const model = swapModel([
      { old: "The pet rule is in the lease.", now: "The pet rule is in the contract." },
      { old: "The deposit is two months of rent", now: "The deposit is one month of rent" },
    ]);

    const { answer, paragraphs } = await askToSwap(model, "Fix the pet rule and the deposit.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done", "failed"]);
    expect(toldToTheModel(model)).toContain("with changes still waiting");
    expect(paragraphs[3]).toContain("The deposit is two months of rent, held by the agent");
    expect(paragraphs[5]).toBe(
      "The pet rule is in the contract. The deposit is two months of rent.",
    );
  });

  // protects=an empty new_text takes the words out and says so; fails_when=the words stay or the reply claims a swap
  test("an empty new text takes the words out", async () => {
    const model = swapModel([{ old: " The notice is one month.", now: "" }]);

    const { answer, paragraphs } = await askToSwap(model, "Drop the notice sentence.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done"]);
    expect(paragraphs[0]).toBe("The salary is £41,500 a year, paid monthly.");
    expect(lastResult(model)).toContain("Took “ The notice is one month.” out of “Flat notes”");
  });
});
