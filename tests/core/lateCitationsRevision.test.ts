/**
 * Citations that go in after a write (`settle`) never write over a Block that says another thing
 * since: a later revision of the same Answer that kept its id, or the User's own words (#2711).
 * The model is scripted: no request is paid for.
 */
import { describe, expect, test } from "vitest";
import { askAssistant } from "../helpers/assistant";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient, typeInto } from "../helpers/mindClient";
import { note, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

const FIRST = "The contract runs for two years.";
const QUOTE = "It runs for two years.";

async function setUp(script: (call: ModelCall, client: MindClient) => ScriptedReply) {
  let target: MindClient | null = null;
  const model = scriptedModel((call) => script(call, target as MindClient));
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createSourceFolder();
  await addAndProcess(core, [
    await writeSourceFile(
      sources,
      "Supplier contract.md",
      "# Supplier contract\n\nIt runs for two years.\n",
    ),
  ]);
  const mind = await core.createMind({ title: "Launch notes" });
  target = await connectToMind(core, mind.id);
  writeMind(target, [note("Notes.")]);
  await target.settled();
  return { core, client: target, mindId: mind.id };
}

const ran = (call: ModelCall, tool: string) =>
  call.results.filter((result) => result.tool === tool).length;

describe("Citations that go in after a write (#2711)", () => {
  // protects=a Block that says another thing than the write left, whether a later call of the Answer revised it keeping its id or the User typed in it, keeps what it says when the write's Citations go in, and the write's card counts what it wrote; fails_when=the earlier write's words come back over it; no_claim=how often a real model revises its own text.
  test("words typed into the Block before the Citations go in stay", async () => {
    let typed = false;
    const { core, client, mindId } = await setUp((call, note) => {
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) {
        return { calls: [{ tool: "search_documents", input: { query: "supplier contract" } }] };
      }
      if (ran(call, "add_to_mind") === 0) {
        return {
          calls: [
            { tool: "add_to_mind", input: { mind: "Launch notes", content: `${FIRST}[^1]` } },
          ],
        };
      }
      // The Block is in the Note, its marker unrecorded: the User types in it before cite records it.
      if (!typed) {
        typed = true;
        typeInto(note, 1, FIRST.length - 1, " and a day");
      }
      if (ran(call, "cite") === 0) {
        const passage = shownPassages(search.text).find((each) => each.text.includes(QUOTE));
        const citations = [{ marker: 1, passage: passage?.id, quote: QUOTE }];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return { text: "Done." };
    });

    const answer = await askAssistant(core, {
      text: "Add the contract term to Launch notes",
      mindId,
    });
    await client.settled();

    expect(shownWithChanges(client).join("\n")).toContain(
      "The contract runs for two years and a day.",
    );
    const [change] = answer.toolCalls.flatMap((call) => (call.mindChange ? [call.mindChange] : []));
    expect(change).toMatchObject({ proposals: 1 });
  });
});
