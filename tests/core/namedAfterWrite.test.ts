import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { askAssistant, lastResult } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { type ScriptedReply, scriptedModel, scriptedModels } from "../helpers/models";

/**
 * A Note with no title is named by its first line, which a write may give it or change (#2830):
 * every result the model reads after a write names the Note as the User finds it then, never as
 * it was called before, so the reply never names a Note that is gone. In Chinese, where the
 * stale name ("未命名") reached replies; on a scripted model.
 */

const heading = (text: string): JSONContent => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text }],
});
const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const SUMMARY = [heading("潮汐摘要"), paragraph("大潮出现在新月和满月前后。")];
const TRANSLATED = "## Tide summary\n\nSpring tides come around the new and full moon.";

/** A Note with no title holding the assistant's own `blocks`; asked anything, the model makes `call`, then replies. */
async function untitledNote(call: ScriptedReply, blocks: readonly JSONContent[] | null) {
  const model = scriptedModel(
    (each): ScriptedReply => (each.results.length > 0 ? { text: "好的。" } : call),
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "" });
  const client = await connectToMind(core, mind.id);
  if (blocks) {
    await core.addToNote({
      mindId: mind.id,
      blocks: [...blocks],
      origin: null,
      model: null,
    });
  }
  await client.settled();
  return { core, model, mindId: mind.id };
}

describe("After a write, the model reads the Note's name as it is now", { timeout: 30_000 }, () => {
  // protects=a write into the empty Note in front, which has no title, names it in its result by the first line the write gave it (#2769, #2830); fails_when=the result names it as untitled, which the reply repeats; no_claim=the words the model replies with.
  test("add_to_mind into the empty untitled Note in front names it by its new first line", async () => {
    const { core, model, mindId } = await untitledNote(
      {
        calls: [
          { tool: "add_to_mind", input: { content: "## 潮汐摘要\n\n大潮出现在新月和满月前后。" } },
        ],
      },
      null,
    );

    await askAssistant(core, { text: "把潮汐的摘要写进这页", mindId });

    expect(lastResult(model)).toContain("its first line now names “潮汐摘要”");
    expect(lastResult(model)).not.toMatch(/Untitled|未命名/);
  });

  // protects=edit_mind's new text over the assistant's own text, which applies at once, names the Note by the first line it gives it once applied (#2830); fails_when=the result names it by its first line before the write, a Note the User can't find once the change applies; no_claim=what the model replies.
  test("edit_mind over the assistant's own text names the Note by the new first line", async () => {
    const { core, model, mindId } = await untitledNote(
      { calls: [{ tool: "edit_mind", input: { part: "潮汐摘要", content: TRANSLATED } }] },
      SUMMARY,
    );

    await askAssistant(core, { text: "把这段摘要翻译成英文", mindId });

    expect(lastResult(model)).toContain("in “Tide summary”");
    expect(lastResult(model)).not.toContain("潮汐摘要");
  });
});
