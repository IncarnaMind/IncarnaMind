import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { SaveChatProviderInput } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

const FIRST =
  "Tea drinking began in southwest China, where it was first used as a medicinal drink.";
const TEA = { name: "Tea history.md", contents: `# Tea history\n\n${FIRST}\n` };

const QUESTION = "Which Document is the fastest to read? Answer in one short sentence.";

/** A model running on in its reply, with no Citation in it, far past anything it was asked for. */
const NOTES =
  "Wait, there may be a second copy of this file. Let's search again to be safe. ".repeat(200);

/** A model that searches once, then writes `reply` for what it read. */
const searchingThenWriting = (reply: string) =>
  scriptedModel((call: ModelCall): ScriptedReply => {
    if (call.json) return { text: JSON.stringify({ citations: [] }) };
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: "tea" } }] };
    return { text: reply };
  });

const NO_MORE = "You can make no more calls";

/** A model that searches on every step, and on the last one does what `onLast` says. */
const searchingTo = (calls: ModelCall[], onLast: (asked: number) => ScriptedReply) => {
  let asked = 0;
  return scriptedModel((call: ModelCall): ScriptedReply => {
    if (call.json) return { text: JSON.stringify({ citations: [] }) };
    calls.push(call);
    if (call.prompt.includes(NO_MORE)) return onLast(++asked);
    return { calls: [{ tool: "search_documents", input: { query: `tea ${calls.length}` } }] };
  });
};

/** The Tea Document, answered by a cloud provider the User has allowed. */
async function setUpOn(input: SaveChatProviderInput, model: MockLanguageModelV4) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  const saved = await core.saveChatProvider(input);
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, TEA.name, TEA.contents)]);
  return { core };
}

describe("A model that writes its notes instead of an Answer (#1344)", { timeout: 30_000 }, () => {
  // protects=a reply that runs on for pages after a search, with no Citation in it, never stays as the Answer: it has no text and fails with a line to try again; fails_when=the notes are the Answer's text or it is "done"; no_claim=what a real model writes.
  test("a reply that runs on with no Citation fails as no Answer, with none of it left", async () => {
    const { core } = await setUpWithDocuments(searchingThenWriting(NOTES), [TEA]);

    const answer = await askAssistant(core, { text: QUESTION }, "failed");

    expect(answer.errorKind).toBe("no-answer");
    expect(answer.text).toBe("");
  });

  // protects=a general-knowledge Answer after a search that found nothing, with no marker in it, is an Answer, not notes; fails_when=a reply of a couple of thousand characters with no marker is failed; no_claim=what the Answer says.
  test("a few thousand characters with no marker after a search stay", async () => {
    const general = `The Documents say nothing about brewing temperatures, so this is general knowledge. ${"Green tea is brewed cooler than black tea. ".repeat(45)}`;
    const { core } = await setUpWithDocuments(searchingThenWriting(general), [TEA]);

    const answer = await askAssistant(core, { text: "How hot should the water be for tea?" });

    expect(answer.status).toBe("done");
    expect(answer.text.length).toBeGreaterThan(1_800);
  });

  // protects=a long Answer whose sentences carry Citations is not taken for notes, however long; fails_when=a cited Answer is cut off at the length of notes; no_claim=none beyond protects.
  test("a long Answer with a Citation stays", async () => {
    const long = `Tea was first drunk in southwest China [^1].\n\n${"It spread along the trade routes. ".repeat(80)}`;
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      if (call.json) return { text: JSON.stringify({ citations: [] }) };
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "tea" } }] };
      return { text: long };
    });
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: "Where was tea first drunk?" });

    expect(answer.status).toBe("done");
    expect(answer.text.length).toBeGreaterThan(2_000);
  });

  // protects=long text before any search is the User's request, an essay or a poem, and stays; fails_when=a long reply with no search is failed; no_claim=none beyond protects.
  test("long text without a search stays", async () => {
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply =>
        call.json ? { text: JSON.stringify({ citations: [] }) } : { text: NOTES },
    );
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: "Write me a long poem about tea." });

    expect(answer.status).toBe("done");
    expect(answer.text.length).toBeGreaterThan(3_000);
  });

  // protects=when the model uses every step on searches, the last step is told it has no more calls and to say what wasn't checked, may choose no Tool, and is capped, with the Tools still listed; fails_when=the last request has no such line, no cap, or lets the model choose a Tool; no_claim=what a real model writes after it (#1344).
  test("the last step is told to write from what was read, may choose no Tool, and is capped", async () => {
    const calls: ModelCall[] = [];
    const model = searchingTo(calls, () => ({
      text: "I read some of the Documents, and didn't check the rest.",
    }));
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: QUESTION });

    const last = calls.at(-1);
    expect(answer.status).toBe("done");
    expect(calls).toHaveLength(10);
    expect(last?.options.toolChoice?.type).toBe("none");
    expect(last?.tools).toEqual(calls.at(-2)?.tools);
    expect(last?.options.maxOutputTokens).toBe(8_000);
    expect(last?.prompt).toContain(
      "You can make no more calls, and none can record a Citation now",
    );
    expect(last?.prompt).toContain("say plainly what you didn't check");
    for (const earlier of calls.slice(0, -1)) {
      expect(earlier.prompt).not.toContain(NO_MORE);
      expect(earlier.options.maxOutputTokens).toBeUndefined();
    }
  });

  // protects=a long Answer on the last step with no marker in it is the Answer, whatever its length, as the model is told no Citation can be recorded there; fails_when=the length rule cuts it and the Answer fails (#1344).
  test("a long Answer with no marker on the last step stays", async () => {
    const long = `Of the Documents I read, the Tea history is the shortest. ${"It was read in full and the rest was not checked. ".repeat(300)}`;
    const model = searchingTo([], () => ({ text: long }));
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: QUESTION });

    expect(answer.status).toBe("done");
    expect(answer.text.length).toBeGreaterThan(12_000);
  });

  // protects=on Anthropic, which refuses a thinking block once the tool list changes, the last step keeps its tool choice, with the same Tools; fails_when=the last step there chooses none, which drops the Tools and fails the request with a 400 (#1344).
  test("on Anthropic the last step keeps the Tools in its request", async () => {
    const calls: ModelCall[] = [];
    const model = searchingTo(calls, () => ({ text: "I read some of the Documents." }));
    const { core } = await setUpOn(
      { kind: "anthropic", apiKey: "sk-test", modelId: "claude-haiku-5-5" },
      model,
    );

    const answer = await askAssistant(core, { text: QUESTION });

    const last = calls.at(-1);
    expect(answer.status).toBe("done");
    expect(last?.options.toolChoice?.type ?? "auto").toBe("auto");
    expect(last?.tools).toEqual(calls.at(-2)?.tools);
    expect(last?.prompt).toContain(NO_MORE);
    expect(last?.options.maxOutputTokens).toBe(8_000);
  });

  // protects=a model that writes 4,096 tokens at most (GPT-4 Turbo) is asked for no more than that on the last step, not the 8,000 of the engine's cap; fails_when=the cap is the engine's whatever the model (#1344).
  test("a model with less output than the cap is asked for no more than it writes", async () => {
    const calls: ModelCall[] = [];
    const model = searchingTo(calls, () => ({ text: "I read some of the Documents." }));
    const { core } = await setUpOn(
      { kind: "openai", apiKey: "sk-test", modelId: "gpt-4-turbo" },
      model,
    );

    await askAssistant(core, { text: QUESTION });

    expect(calls.at(-1)?.options.maxOutputTokens).toBe(4_096);
  });

  // protects=a model that calls a Tool on the last step has the call refused with a result that says so, and writes on the one more call it gets; fails_when=the call is made, or the Answer fails (#1344).
  test("a Tool called on the last step is refused, and the one more call writes the Answer", async () => {
    const calls: ModelCall[] = [];
    const model = searchingTo(calls, (asked) =>
      asked === 1
        ? { calls: [{ tool: "search_documents", input: { query: "one more" } }] }
        : { text: "I read some of the Documents, and didn't check the rest." },
    );
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: QUESTION });

    expect(answer.status).toBe("done");
    expect(calls).toHaveLength(11);
    expect(calls.at(-1)?.results.at(-1)?.text).toContain("No more calls are allowed");
    expect(answer.text).toContain("didn't check the rest");
  });

  // protects=a model that calls a Tool on the one more call too gets no further call: the Answer fails as "The model sent no Answer", with Try again; fails_when=it goes on calling, or the Answer is blank but "done" (#1344).
  test("a model that calls a Tool again on the one more call fails as no Answer", async () => {
    const calls: ModelCall[] = [];
    const model = searchingTo(calls, () => ({
      calls: [{ tool: "search_documents", input: { query: "again" } }],
    }));
    const { core } = await setUpWithDocuments(model, [TEA]);

    const answer = await askAssistant(core, { text: QUESTION }, "failed");

    expect(calls).toHaveLength(11);
    expect(answer.errorKind).toBe("no-answer");
    expect(answer.text).toBe("");
  });
});
