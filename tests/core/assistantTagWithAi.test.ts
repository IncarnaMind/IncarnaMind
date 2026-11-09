/**
 * Tag with AI from the assistant (#2339): the Tags it proposes wait in the Review, none is added
 * from the chat, the app writes the reply as it does for Organize, and one Undo takes its
 * proposals back out, leaving what waited before as it was. The model's choices are scripted.
 */
import { describe, expect, test } from "vitest";
import type { ConversationAnswer, Core } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { scriptedModel } from "../helpers/models";
import { tagNamesOf, waitForTagging } from "../helpers/tags";

const DOCUMENTS = [
  { name: "Lease Harbour Street.md", contents: "# Harbour Street\n\nThe rent is 900 euros.\n" },
  { name: "Lease Mill Lane.md", contents: "# Mill Lane\n\nThe tenant pays rent quarterly.\n" },
  { name: "Q3 commentary.md", contents: "# Q3\n\nRevenue grew 4%.\n" },
];

/**
 * The assistant runs documents.tagWithAi with no ids, then says `reply`; the tagger calls each
 * lease a Contract and the rest a Report.
 */
function tagging(reply: string) {
  return scriptedModel(
    (call) =>
      call.results.some((each) => each.tool === "run_command")
        ? { text: reply }
        : { calls: [{ tool: "run_command", input: { command: "documents.tagWithAi" } }] },
    {
      generate: ({ prompt }) => {
        const data = JSON.parse(prompt) as { documents?: { ref: string; name: string }[] };
        return {
          text: JSON.stringify({
            tagged: (data.documents ?? []).map((each) => ({
              ref: each.ref,
              kind: each.name.startsWith("Lease") ? "contract" : "report",
              tags: [],
              topic: { name: "", description: "" },
            })),
          }),
        };
      },
    },
  );
}

const runOf = (answer: ConversationAnswer): string => {
  const run = answer.toolCalls.find((call) => call.command?.run)?.command?.run;
  if (!run) throw new Error("No command ran.");
  return run;
};

const waiting = async (core: Core) =>
  (await core.getOrganizeReview()).items
    .map((item) => ({ id: item.id, tags: item.tags.map((tag) => tag.name) }))
    .sort((a, b) => a.id.localeCompare(b.id));

describe("Tag with AI from the assistant proposes and adds nothing (#2339)", () => {
  test("its Tags wait in the Review, the app writes the reply, and one Undo takes them back", async () => {
    const { core, mind, documents } = await setUpWithDocuments(
      tagging("I've added the Contract Tag to both leases."),
      DOCUMENTS,
    );
    const before = await waiting(core);

    const answer = await askAssistant(core, { text: "Tag my documents", mindId: mind.id });

    expect(answer.text).toBe(
      "Proposed Tags for 3 Documents: “Contract” (2), “Report” (1). No Tag has been added yet: review them to add them.",
    );
    for (const document of documents) expect(await tagNamesOf(core, document.id)).toEqual([]);
    const done = answer.toolCalls.find((call) => call.command?.command === "documents.tagWithAi");
    expect(done?.command?.tags).toEqual([
      { name: "Contract", count: 2 },
      { name: "Report", count: 1 },
    ]);
    expect(done?.command?.review?.count).toBe(3);

    await core.undoCommands(runOf(answer));
    expect(await waiting(core)).toEqual(before);
  });

  // protects=when the tagging service can't be reached, the assistant is told so, not that no Tag fits, and the Left out rows the run wrote go with its Undo; fails_when=the reply says nothing fits, or the rows stay after Undo; no_claim=the words of the model's own reply.
  test("when the service can't be reached it says so, and its Undo takes back the rows it wrote", async () => {
    let said = "";
    const model = scriptedModel(
      (call) => {
        const done = call.results.find((each) => each.tool === "run_command");
        if (done) {
          said = done.text;
          return { text: "Done." };
        }
        return { calls: [{ tool: "run_command", input: { command: "documents.tagWithAi" } }] };
      },
      { generate: () => ({ error: { status: 503, message: "Overloaded." } }) },
    );
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "sk-ant-test",
    });
    if (!saved.service) throw new Error("Anthropic is no service.");
    await core.allowDataFlow("chat", saved.service.id);
    await core.allowDataFlow("tagging", saved.service.id);
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: true, turnOn: true });
    const before = await waiting(core);

    const answer = await askAssistant(core, { text: "Tag my documents", mindId: mind.id });

    expect(said).toContain("couldn't reach Anthropic for 3 Documents");
    expect((await waiting(core)).length).toBeGreaterThan(before.length);
    await core.undoCommands(runOf(answer));
    expect(await waiting(core)).toEqual(before);
  });

  test("in Chinese too, a kind in the interface's language", async () => {
    const { core, mind } = await setUpWithDocuments(tagging(""), DOCUMENTS);
    await core.updateSettings({ user: { language: "zh-CN" } });

    const answer = await askAssistant(core, { text: "给这些文档打标签", mindId: mind.id });

    expect(answer.text).toBe(
      "已为 3 个文档建议标签：“合同”（2 个）、“报告”（1 个）。还没有添加任何标签：查看并确认后才会添加。",
    );
  });
});

describe("Tag with AI with no Documents named takes only what the turn may see (#2339, #2308)", () => {
  const FILES = [
    { name: "Client A lease.md", contents: "# Client A\n\nThe lease runs two years.\n" },
    { name: "Client B lease.md", contents: "# Client B\n\nThe lease runs three years.\n" },
    { name: "General notes.md", contents: "# General\n\nThe office opens at nine.\n" },
  ];

  /** Client A and Client B are walled Folders, each with its lease; General is outside. */
  async function walls() {
    const sent: string[] = [];
    const model = scriptedModel(
      (call) =>
        call.results.some((each) => each.tool === "run_command")
          ? { text: "Done." }
          : { calls: [{ tool: "run_command", input: { command: "documents.tagWithAi" } }] },
      {
        generate: ({ prompt }) => {
          const data = JSON.parse(prompt) as { documents?: { ref: string; name: string }[] };
          for (const each of data.documents ?? []) sent.push(each.name);
          return {
            text: JSON.stringify({
              tagged: (data.documents ?? []).map((each) => ({
                ref: each.ref,
                kind: "contract",
                tags: [],
                topic: { name: "", description: "" },
              })),
            }),
          };
        },
      },
    );
    const { core, mind, documents } = await setUpWithDocuments(model, FILES);
    await waitForTagging(
      core,
      documents.map((each) => each.id),
    );
    const walled = async (name: string) => {
      const document = documents.find((each) => each.name.startsWith(name));
      if (!document) throw new Error(`${name} wasn't added.`);
      const folder = await core.createLibraryGroup({ name, description: "" });
      await core.assignDocumentGroup(document.id, folder.id);
      await core.updateLibraryGroup(folder.id, { name, description: "", keepInside: true });
      return folder;
    };
    const clientA = await walled("Client A");
    await walled("Client B");
    const noteA = await core.createMind({ title: "Client A note", folderId: clientA.id });
    sent.length = 0;
    return { core, outside: mind, noteA, sent };
  }

  test("in a Note walled to Client A, only Client A's Documents are sent", async () => {
    const { core, noteA, sent } = await walls();

    await askAssistant(core, { text: "Tag my documents", mindId: noteA.id });

    expect(sent).toEqual(["Client A lease"]);
  });

  test("outside every wall, only the Documents outside walls are sent", async () => {
    const { core, outside, sent } = await walls();

    await askAssistant(core, { text: "用 AI 重新给所有文件打标签", mindId: outside.id });

    expect(sent).toEqual(["General notes"]);
  });

  test("where the User stopped tagging, or with tagging off, nothing is sent", async () => {
    const { core, outside, sent } = await walls();
    await core.setTaggingWithAi(null, false);

    await askAssistant(core, { text: "Tag my documents", mindId: outside.id });
    expect(sent).toEqual([]);

    await core.setTaggingWithAi(null, true);
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    await askAssistant(core, { text: "Tag my documents", mindId: outside.id });
    expect(sent).toEqual([]);

    await core.saveLibrarySettings({ ...settings, automatic: true, turnOn: true });
    await askAssistant(core, { text: "Tag my documents", mindId: outside.id });
    expect(sent).toEqual(["General notes"]);
  });
});
