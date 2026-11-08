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
import { tagNamesOf } from "../helpers/tags";

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

  test("in Chinese too, a kind in the interface's language", async () => {
    const { core, mind } = await setUpWithDocuments(tagging(""), DOCUMENTS);
    await core.updateSettings({ user: { language: "zh-CN" } });

    const answer = await askAssistant(core, { text: "给这些文档打标签", mindId: mind.id });

    expect(answer.text).toBe(
      "已为 3 个文档建议标签：“合同”（2 个）、“报告”（1 个）。还没有添加任何标签：查看并确认后才会添加。",
    );
  });
});
