/**
 * The Search scope and the Folder in front go with a Question in the assistant (#2529): lines
 * before the Question that name the scope as the composer's chip shows it, so "this folder" has
 * something to point at. Through the core's public interface, as the composer sends them.
 */
import { describe, expect, test } from "vitest";
import type { AskInConversationInput, Core, SearchScope } from "../../src/core";
import { answerEnded, setUpWithDocuments } from "../helpers/citations";
import { note, writeMind } from "../helpers/minds";
import { type ModelCall, promptOf, scriptedModel } from "../helpers/models";

const REPORTS = ["Q1 results.txt", "Q2 results.txt", "Annual review.txt", "Board deck.txt"];
const CONTRACTS = ["Lease Harbour Street.txt", "Lease Mill Lane.txt"];
const CLIENT_B = ["Client B lease.txt"];
const LOOSE = ["Loose notes.txt"];
const BODY = (name: string) => `${name.replace(".txt", "")}.\nA made-up page about ${name}.\n`;

const everyFile = [...REPORTS, ...CONTRACTS, ...CLIENT_B, ...LOOSE].map((name) => ({
  name,
  contents: BODY(name),
}));

const SCOPE_BEFORE_QUESTION = (scope: string, question: string) =>
  new RegExp(`(?:^|\\n\\n)${scope}\\n\\n${question}$`);

const noScope: SearchScope = { folderIds: [], tagIds: [], documentIds: [] };

async function setUp(
  script: (call: ModelCall) => ReturnType<Parameters<typeof scriptedModel>[0]> = () => ({
    text: "Noted.",
  }),
  names = { reports: "Reports & presentations", contracts: "Contracts", clientB: "Client B" },
) {
  const model = scriptedModel(script);
  const set = await setUpWithDocuments(model, everyFile);
  const { core, documents } = set;
  const idsOf = (files: readonly string[]) =>
    documents
      .filter((document) => files.includes(`${document.name}.txt`))
      .map((document) => document.id);
  const folder = async (name: string, files: readonly string[]) => {
    const made = await core.createLibraryGroup({ name, description: "" });
    for (const id of idsOf(files)) await core.assignDocumentGroup(id, made.id);
    return made;
  };
  const reports = await folder(names.reports, REPORTS);
  const contracts = await folder(names.contracts, CONTRACTS);
  const clientB = await folder(names.clientB, CLIENT_B);
  await core.createLibraryGroup({ name: "Empty", description: "" });
  return { ...set, model, reports, contracts, clientB, idsOf };
}

async function ask(core: Core, input: AskInConversationInput) {
  const result = await core.askInConversation(input);
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
  return result;
}

const lastSent = (model: ReturnType<typeof scriptedModel>, call: number) =>
  promptOf(model, call)
    .filter((message) => message.role === "user")
    .at(-1)?.text ?? "";

const instructionsOf = (model: ReturnType<typeof scriptedModel>, call: number) =>
  promptOf(model, call).find((message) => message.role === "system")?.text ?? "";

const folderScope = (...folderIds: string[]): SearchScope => ({ ...noScope, folderIds });

describe("The Search scope in the assistant's Question", { timeout: 60_000 }, () => {
  // protects=a Folder scope reaches the model by name with its Document count, just before the Question; fails_when=only the Documents in scope reach it, as before #2529, or the count is not the Folder's; no_claim=what a real model makes of it, which the evaluation measures.
  test("names a Folder by name with its Document count", async () => {
    const { core, model, reports } = await setUp();

    await ask(core, { text: "Summarise this folder.", scope: folderScope(reports.id) });

    expect(lastSent(model, 0)).toMatch(
      SCOPE_BEFORE_QUESTION(
        'Search scope: the Folder "Reports & presentations" \\(4 Documents\\)',
        "Summarise this folder\\.",
      ),
    );
    expect(lastSent(model, 0)).not.toContain("Contracts");
    expect(instructionsOf(model, 0)).toContain('A line "Search scope: …" before the Question');
  });

  // protects=a Tag, several Folders and a pick of Documents are named as the chip shows them; fails_when=one is left out or counted wrongly; no_claim=none beyond protects.
  test("names a Tag, several Folders and a pick of Documents", async () => {
    const { core, model, reports, contracts, idsOf } = await setUp();
    const budget = await core.createTag({ name: "Budget" });
    await core.addTagToDocuments(idsOf(["Q1 results.txt", "Board deck.txt"]), budget.id);

    await ask(core, { text: "What is in here?", scope: { ...noScope, tagIds: [budget.id] } });
    await ask(core, {
      text: "What is in here?",
      scope: folderScope(contracts.id, reports.id),
    });
    await ask(core, {
      text: "What is in here?",
      scope: {
        ...noScope,
        documentIds: idsOf(["Q1 results.txt", "Loose notes.txt", "Q2 results.txt"]),
      },
    });

    expect(lastSent(model, 0)).toContain('Search scope: the Tag "Budget" (2 Documents)\n\n');
    expect(lastSent(model, 1)).toContain(
      'Search scope: the Folder "Contracts" (2 Documents), the Folder "Reports & presentations" (4 Documents)\n\n',
    );
    expect(lastSent(model, 2)).toContain("Search scope: 3 Documents the User picked\n\n");
  });

  // protects=with no scope the line says All Documents with the count, and how many Folders the User keeps apart are left out, as the chip says; fails_when=a walled Folder's name or Documents are given, or the count of Folders is wrong; no_claim=none beyond protects.
  test("says All Documents, and how many Folders are left out, without naming them", async () => {
    const { core, model, clientB } = await setUp();
    await core.updateLibraryGroup(clientB.id, {
      name: clientB.name,
      description: "",
      keepInside: true,
    });

    await ask(core, { text: "What do I have?" });

    expect(lastSent(model, 0)).toContain("Search scope: All Documents · 1 Folder left out (7)\n");
    expect(lastSent(model, 0)).not.toContain("Client B");
  });

  // protects=a Folder behind a wall is never named to a Note outside it, whatever scope arrives; fails_when=its name or its Documents appear; no_claim=none beyond protects.
  test("never names a walled Folder to a Note outside the wall", async () => {
    const { core, model, clientB, reports } = await setUp();
    await core.updateLibraryGroup(clientB.id, {
      name: clientB.name,
      description: "",
      keepInside: true,
    });
    const outside = await core.createMind({ title: "Outside note" });

    await ask(core, {
      text: "Summarise this folder.",
      mindId: outside.id,
      scope: folderScope(clientB.id, reports.id),
    });

    const sent = lastSent(model, 0);
    expect(sent).toContain('Search scope: the Folder "Reports & presentations" (4 Documents)');
    expect(sent).not.toContain("Client B");
    expect(instructionsOf(model, 0)).not.toContain("Client B");
  });

  // protects=a Note inside a wall is given its wall's Folder as the whole scope, whatever scope arrives; fails_when=another Folder is named to it; no_claim=none beyond protects.
  test("names only its own wall to a Note inside it", async () => {
    const { core, model, clientB, reports } = await setUp();
    await core.updateLibraryGroup(clientB.id, {
      name: clientB.name,
      description: "",
      keepInside: true,
    });
    const inside = await core.createMind({ title: "Client B note", folderId: clientB.id });

    await ask(core, {
      text: "Summarise this folder.",
      mindId: inside.id,
      scope: folderScope(reports.id),
    });

    expect(lastSent(model, 0)).toMatch(
      SCOPE_BEFORE_QUESTION(
        'Search scope: the Folder "Client B" \\(1 Document\\)',
        "Summarise this folder\\.",
      ),
    );
    expect(lastSent(model, 0)).not.toContain("Reports");
  });

  // protects=the Note's own Folder is named as the Folder in front when the scope doesn't name it, with its first Documents so they can be read alone; fails_when=it is left out, or named when the scope already is that Folder; no_claim=none beyond protects.
  test("names the Folder of the Note in front when the scope does not", async () => {
    const { core, model, reports } = await setUp();
    const inFolder = await core.createMind({ title: "Plan", folderId: reports.id });

    await ask(core, { text: "Summarise this folder.", mindId: inFolder.id, scope: noScope });
    await ask(core, {
      text: "Summarise this folder.",
      mindId: inFolder.id,
      scope: folderScope(reports.id),
    });

    const sent = lastSent(model, 0);
    expect(sent).toContain("Search scope: All Documents (8)\nThe Note in front is in the Folder ");
    const listed =
      /Folder "Reports & presentations" \(4 Documents: (.+)\)\n\nSummarise this folder\.$/.exec(
        sent,
      )?.[1];
    expect(listed?.split(", ").sort()).toEqual([
      '"Annual review"',
      '"Board deck"',
      '"Q1 results"',
      '"Q2 results"',
    ]);
    expect(lastSent(model, 1)).toContain(
      'Search scope: the Folder "Reports & presentations" (4 Documents)\n\nSummarise',
    );
    expect(lastSent(model, 1)).not.toContain("The Note in front");
  });

  // protects=with nothing named, the Folders that hold Documents are listed (the empty and the walled left out), so a question can name them; fails_when=the list is missing, names a walled or empty Folder, or shows when the scope names a Folder; no_claim=none beyond protects.
  test("lists the Folders to choose from when neither the scope nor a Note names one", async () => {
    const { core, model, clientB, reports } = await setUp();
    await core.updateLibraryGroup(clientB.id, {
      name: clientB.name,
      description: "",
      keepInside: true,
    });

    await ask(core, { text: "Summarise this folder." });
    await ask(core, { text: "Summarise this folder.", scope: folderScope(reports.id) });

    expect(lastSent(model, 0)).toContain(
      'The User\'s Folders: "Contracts" (2 Documents), "Reports & presentations" (4 Documents)\n\nSummarise this folder.',
    );
    expect(lastSent(model, 0)).not.toContain("Empty");
    expect(lastSent(model, 0)).not.toContain("Client B");
    expect(lastSent(model, 1)).not.toContain("The User's Folders");
  });

  // protects=a library with no Folder gets the scope line alone, and a Question from Help buttons none; fails_when=an empty Folders line is sent; no_claim=none beyond protects.
  test("sends no list of Folders when the User has none", async () => {
    const model = scriptedModel(() => ({ text: "Noted." }));
    const { core } = await setUpWithDocuments(model, [{ name: "Alone.txt", contents: "Alone.\n" }]);

    await ask(core, { text: "Summarise this folder." });

    expect(lastSent(model, 0)).toMatch(
      SCOPE_BEFORE_QUESTION("Search scope: All Documents \\(1\\)", "Summarise this folder\\."),
    );
  });

  // protects=Try again reads the scope as it is then; fails_when=the line is missing from a regenerated Answer; no_claim=none beyond protects.
  test("is sent again with Try again", async () => {
    const { core, model, reports } = await setUp();
    const asked = await ask(core, {
      text: "Summarise this folder.",
      scope: folderScope(reports.id),
    });

    const again = await core.regenerateConversationAnswer({
      conversationId: asked.conversation.id,
      answerId: asked.answerId,
    });
    if (!again.asked) throw new Error("Not asked again.");
    await answerEnded(core, again.answerId);

    expect(lastSent(model, 1)).toContain('Search scope: the Folder "Reports & presentations"');
  });

  // protects=the instructions and the Note's message do not change with the scope, so a provider's prompt cache keeps its start; fails_when=a scope line goes into the instructions or the Note's message; no_claim=none beyond protects.
  test("leaves the instructions and the Note's message as they were", async () => {
    const { core, model, client, mind, reports, contracts } = await setUp();
    writeMind(client, [note("Call with Harbour Logistics on Friday.")]);
    await client.settled();

    await ask(core, { text: "What is here?", mindId: mind.id, scope: folderScope(reports.id) });
    await ask(core, { text: "What is here?", mindId: mind.id, scope: folderScope(contracts.id) });

    const mindOf = (call: number) =>
      /^<mind [\s\S]*?<\/mind>/.exec(
        promptOf(model, call).find((message) => message.role === "user")?.text ?? "",
      )?.[0];
    for (const call of [0, 1]) {
      expect(instructionsOf(model, call)).not.toContain('Search scope: the Folder "');
      expect(mindOf(call)).toContain("Call with Harbour Logistics on Friday.");
      expect(mindOf(call)).not.toContain("Search scope");
    }
    expect(mindOf(1)).toBe(mindOf(0));
  });
});

describe('A Question about "this folder" with a Folder in scope', { timeout: 60_000 }, () => {
  /** A model that goes on with the Folder its context names, and asks only when it names none. */
  const readsTheScope = (call: ModelCall) => {
    const named = /Search scope: the Folder "([^"]+)"/.exec(call.prompt)?.[1];
    if (call.results.length > 0) return { text: call.results.at(-1)?.text ?? "" };
    if (named) return { text: `Summary of ${named}.` };
    return {
      calls: [
        {
          tool: "ask_user",
          input: {
            question: "Which folder would you like me to summarise?",
            options: [{ label: "One" }, { label: "Two" }],
          },
        },
      ],
    };
  };

  for (const [language, request, names] of [
    [
      "English",
      "Summarise this folder.",
      { reports: "Reports & presentations", contracts: "Contracts", clientB: "Client B" },
    ],
    [
      "Chinese",
      "总结一下这个文件夹。",
      { reports: "报告与演示", contracts: "合同", clientB: "客户乙" },
    ],
  ] as const) {
    // protects=with a Folder in scope the summary goes ahead and the User is asked nothing, in English and in Chinese; fails_when=the context leaves the Folder unnamed, so a model has to ask which one; no_claim=that a real model reads it, which the evaluation measures.
    test(`runs the summary and asks nothing (${language})`, async () => {
      const { core, reports } = await setUp(readsTheScope, names);
      const asked: string[] = [];
      core.on("question.asked", (request) => asked.push(request.question.question));

      const result = await ask(core, { text: request, scope: folderScope(reports.id) });

      const { messages } = await core.getConversation(result.conversation.id);
      const answer = messages.find((message) => message.id === result.answerId);
      expect(answer?.kind === "answer" && answer.text).toBe(`Summary of ${names.reports}.`);
      expect(asked).toEqual([]);
    });
  }
});
