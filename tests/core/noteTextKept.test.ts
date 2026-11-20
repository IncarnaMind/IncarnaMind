import { describe, expect, test } from "vitest";
import { askAssistant, changesIn } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { shownWithChanges } from "../helpers/minds";
import {
  judgesNothing,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/*
 * What the model writes into a Note goes in as written (#3462): no rule reads its sentences for
 * talk about its own searching or for pointers to an earlier Answer. The model is told, where it
 * writes the Note's text, what goes in the Note and what in its reply; what it writes is the Note's.
 */

const INFERENCE = "Read together, the Passages suggest the warranty covers parts but not labour.";
const ABSENCE = "合同段落中没有约定任何逾期违约金。";
const CLOSING = "Together, the Passages cover the rent, the term and the break clause.";
const CONTENT = [
  "## Lease summary",
  "The rent is reviewed every three years.",
  INFERENCE,
  ABSENCE,
  CLOSING,
].join("\n\n");

async function written() {
  const model = scriptedModel(
    ({ results }): ScriptedReply =>
      results.length === 0
        ? { calls: [{ tool: "create_mind", input: { title: "Lease notes", content: CONTENT } }] }
        : { text: "Made “Lease notes”." },
    { generate: judgesNothing },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const answer = await askAssistant(core, { text: "Make a new note on the lease", mindId: null });
  return { core, model, answer };
}

describe("What the model writes into a Note (#3462)", () => {
  // protects=an inference from the Documents, a finding that they hold nothing on something, and a summary's closing paragraph on what they cover go into the Note, in English and Chinese, though they name the Passages; fails_when=any is taken out; no_claim=what a real model writes.
  test("goes in as written: an inference, a finding of what the Documents leave out, and a closing paragraph", async () => {
    const { core, answer } = await written();

    const [change] = changesIn(answer);
    const made = await connectToMind(core, change?.mindId ?? "");
    expect(shownWithChanges(made)).toEqual([
      "+ Lease summary",
      "+ The rent is reviewed every three years.",
      `+ ${INFERENCE}`,
      `+ ${ABSENCE}`,
      `+ ${CLOSING}`,
    ]);
  });

  // protects=the model is told where it writes a Note's text that what the Documents say, and what they don't hold where asked, go in the Note, and what it searched, read, tried or couldn't find goes in its reply; fails_when=the principle is missing from the field's description; no_claim=how a real model follows it.
  test("is asked for, where the model writes it, as what the Documents say, its own searching left to the reply", async () => {
    const { model } = await written();

    const create = model.doStreamCalls[0]?.tools?.find((each) => each.name === "create_mind");
    if (create?.type !== "function") throw new Error("create_mind is not a function tool.");
    const schema = JSON.stringify(create.inputSchema);
    expect(schema).toContain(
      "Write what the Documents say, and what they don't hold where the User asked; what you searched, read, tried or couldn't find along the way goes in your reply.",
    );
  });
});
