/**
 * A Mind's own Search scope in the assistant (#1359): its Folder while the
 * Folder holds a Document, else every Document, so a Mind filed into an empty
 * Folder still finds and cites what the User has. A scope the User chose stays
 * as chosen; with nothing in it, the model is told why it can't search.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { AskInConversationInput, ConversationAnswer, SearchScope } from "../../src/core/api";
import { changesIn } from "../helpers/assistant";
import { checkReply, isCheckRun } from "../helpers/checks";
import { answerEnded, citingModel, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { type ModelCall, promptOf, type ScriptedReply, scriptedModel } from "../helpers/models";

const DPA = {
  name: "DPA - Copperleaf.txt",
  contents:
    "Data Processing Agreement with Copperleaf.\nClause 3: Copperleaf processes personal data only on documented instructions.\n",
};
const LEASE = {
  name: "Office lease.txt",
  contents: "Office lease.\nThe tenant pays rent quarterly in advance.\n",
};
const CLAUSE = "Copperleaf processes personal data only on documented instructions.";

const citing = () =>
  citingModel({
    query: "Copperleaf clause 3",
    records: (passages) => [
      {
        marker: 1,
        passage: passages.find((each) => each.document === "DPA - Copperleaf")?.id,
        quote: CLAUSE,
      },
    ],
    answer: "Copperleaf processes personal data only on documented instructions [^1].",
  });

const folderScope = (folderId: string): SearchScope => ({
  folderIds: [folderId],
  tagIds: [],
  documentIds: [],
});

async function ask(
  core: Awaited<ReturnType<typeof setUpWithDocuments>>["core"],
  input: AskInConversationInput,
) {
  const result = await core.askInConversation(input);
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  const question = messages.find((message) => message.id === result.questionId);
  if (answer?.kind !== "answer" || question?.kind !== "question") throw new Error("Not asked.");
  return { answer: answer as ConversationAnswer, question };
}

/** Searches, then writes what it found into a new note, cited. */
const makesANote = () =>
  scriptedModel((call: ModelCall): ScriptedReply => {
    if (isCheckRun(call)) return checkReply(call, {});
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) {
      return { calls: [{ tool: "search_documents", input: { query: "Copperleaf clause 3" } }] };
    }
    if (call.results.some((result) => result.tool === "create_mind")) return { text: "Made it." };
    const passage = shownPassages(search.text).find((each) => each.document === "DPA - Copperleaf");
    return {
      calls: [
        {
          tool: "cite",
          input: { citations: [{ marker: 1, passage: passage?.id, quote: CLAUSE }] },
        },
        {
          tool: "create_mind",
          input: { title: "DPA summary", content: `${CLAUSE} [^1]` },
          streamInput: true,
        },
      ],
    };
  });

const instructions = (model: ReturnType<typeof citing>) =>
  promptOf(model, 0).find((message) => message.role === "system")?.text ?? "";

describe("A Mind's own Search scope in the assistant", { timeout: 30_000 }, () => {
  // protects=a Mind filed into a Folder with no Documents searches every Document, so a request for cited text finds the Document Not in a Folder and cites it, and the Question says it searched everything (#1359); fails_when=the Answer is written from nothing, uncited, or the Question keeps the empty Folder as its scope; no_claim=what a real model writes, which the pull request's hand check covers.
  test("is every Document while the Mind's Folder holds none", async () => {
    const model = citing();
    const { core } = await setUpWithDocuments(model, [DPA, LEASE]);
    const contracts = await core.createLibraryGroup({
      name: "Contracts & agreements",
      description: "",
    });
    const mind = await core.createMind({ title: "Vendor notes", folderId: contracts.id });

    const { answer, question } = await ask(core, {
      text: "Add a two-sentence summary of clause 3 of the DPA, with Citations.",
      mindId: mind.id,
      // As a composer that shows the Mind's Folder sends it.
      scope: folderScope(contracts.id),
    });

    expect(model.doStreamCalls[0]?.tools?.map((each) => each.name)).toContain("search_documents");
    expect(instructions(model)).not.toContain("holds no Documents");
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]?.documentName).toBe("DPA - Copperleaf");
    expect(question.scope).toBeNull();
  });

  // protects=the Mind's Folder, once it holds a Document, is what its Questions search again: only its Documents; fails_when=it searches everything, or Documents outside the Folder; no_claim=none beyond protects.
  test("is the Mind's Folder once it holds a Document", async () => {
    const model = citing();
    const { core, documents } = await setUpWithDocuments(model, [DPA, LEASE]);
    const contracts = await core.createLibraryGroup({
      name: "Contracts & agreements",
      description: "",
    });
    const mind = await core.createMind({ title: "Vendor notes", folderId: contracts.id });
    const dpa = documents.find((each) => each.name === "DPA - Copperleaf");
    if (!dpa) throw new Error("No DPA.");
    await core.assignDocumentGroup(dpa.id, contracts.id);

    const { answer, question } = await ask(core, {
      text: "What does clause 3 of the DPA say?",
      mindId: mind.id,
      scope: folderScope(contracts.id),
    });

    expect(instructions(model)).toContain("The User limited this Question to 1 Document");
    expect(answer.citations[0]?.documentName).toBe("DPA - Copperleaf");
    expect(question.scope).toEqual(folderScope(contracts.id));
  });

  // protects=a scope the User chose that holds nothing stays as chosen, and the model is told it has no search because the scope is empty, not because a Tool failed, and not to write what a Document says; fails_when=it widens by itself, or the model is left to blame its Tools; no_claim=how a real model words its reply.
  test("a Folder the User chose that holds nothing stays, and the model is told why it can't search", async () => {
    const model = citing();
    const { core, mind } = await setUpWithDocuments(model, [DPA]);
    const empty = await core.createLibraryGroup({ name: "Board papers", description: "" });

    const { answer, question } = await ask(core, {
      text: "Summarise clause 3 of the DPA, with Citations.",
      mindId: mind.id,
      scope: folderScope(empty.id),
    });

    expect(question.scope).toEqual(folderScope(empty.id));
    expect(model.doStreamCalls[0]?.tools?.map((each) => each.name) ?? []).not.toContain(
      "search_documents",
    );
    const told = instructions(model);
    expect(told).toContain("holds no Documents, so there is nothing to search");
    expect(told).toContain("never say a Tool is unavailable");
    expect(told).toContain("never state what a Document says");
    expect(answer.citations).toHaveLength(0);
  });

  // protects=a note the assistant makes from a Mind in an empty Folder is filed in that Folder, though the search widened to every Document; fails_when=it lands Not in a Folder; no_claim=none beyond protects.
  test("a note made from a Mind in an empty Folder is filed in that Folder", async () => {
    const model = makesANote();
    const { core } = await setUpWithDocuments(model, [DPA]);
    const contracts = await core.createLibraryGroup({ name: "Contracts", description: "" });
    const mind = await core.createMind({ title: "Vendor notes", folderId: contracts.id });

    const result = await core.askInConversation({
      text: "Summarise the DPA into a new note",
      mindId: mind.id,
      scope: folderScope(contracts.id),
    });
    if (!result.asked) throw new Error("Not asked.");
    await answerEnded(core, result.answerId);
    const { messages } = await core.getConversation(result.conversation.id);
    const answer = messages.find((message) => message.id === result.answerId);
    if (answer?.kind !== "answer") throw new Error("No Answer.");

    const [made] = changesIn(answer);
    expect(made).toMatchObject({ created: true, cited: 1 });
    const note = (await core.listMinds()).find((each) => each.id === made?.mindId);
    expect(note?.folderId).toBe(contracts.id);
  });

  // protects=with no Documents and no examples at all, the model is still told there is nothing to search and not to blame its Tools; fails_when=it is told nothing; no_claim=how a real model words its reply.
  test("with no Documents at all, the model is told why it can't search", async () => {
    const model = citing();
    const { core, mind } = await setUpWithDocuments(model, []);

    await ask(core, { text: "Summarise the DPA, with Citations.", mindId: mind.id });

    const told = instructions(model);
    expect(told).toContain(
      "None of the User's own Documents can be searched yet, so there is nothing",
    );
    expect(told).toContain("never say a Tool is unavailable");
  });
});

describe("A Mind's own Search scope everywhere else", { timeout: 30_000 }, () => {
  // protects=suggestions while writing take the same rule: a Mind in an empty Folder counts every Document; fails_when=it reports no Documents; no_claim=the suggestion itself.
  test("suggestions count every Document while the Mind's Folder holds none", async () => {
    const { core } = await setUpWithDocuments(citing(), [DPA]);
    const contracts = await core.createLibraryGroup({ name: "Contracts", description: "" });
    const mind = await core.createMind({ title: "Vendor notes", folderId: contracts.id });

    const outcome = await core.suggestNext({
      requestId: randomUUID(),
      mindId: mind.id,
      paragraph: "Copperleaf processes personal data. It does so only on instructions.",
      scope: folderScope(contracts.id),
    });

    expect(outcome).toEqual({ kind: "off", scopeHasDocuments: true });
  });

  // protects=Check against Documents takes the same rule: a Mind in an empty Folder checks against every Document, as its chip says (#1359); fails_when=it says there is nothing to check against; no_claim=the verdict.
  test("checks a sentence against every Document while the Mind's Folder holds none", async () => {
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply =>
        isCheckRun(call) ? checkReply(call, {}) : { text: "No." },
    );
    const { core } = await setUpWithDocuments(model, [DPA]);
    const contracts = await core.createLibraryGroup({ name: "Contracts", description: "" });
    const mind = await core.createMind({ title: "Vendor notes", folderId: contracts.id });
    const client = await connectToMind(core, mind.id);
    const sentence = note(CLAUSE);
    writeMind(client, [sentence]);
    await client.settled();

    const result = await core.checkSentences({
      requestId: randomUUID(),
      mindId: mind.id,
      action: "check-against-documents",
      from: { blockId: String(sentence.attrs?.id), offset: 0 },
      to: { blockId: String(sentence.attrs?.id), offset: CLAUSE.length },
    });

    expect(result.kind).toBe("checked");
  });
});
