import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { askAssistant, lastResult, mindCalls } from "../helpers/assistant";
import { checkReply, isCheckRun } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { judgesNothing, type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

/**
 * Adding to the User's own Note at the length they asked for (#1385): the model reads the amount
 * from their words and gives `times_as_long`; the code measures the Note and what is added, refuses
 * an add off that length with the sizes to add (twice at most in an Answer), and tells the model
 * the size it came to, so its reply states the measured one. The Note's own text is never
 * rewritten. The model's choices are scripted; real models' are in
 * tests/live/assistantLonger.live.test.ts.
 */

const LEASE = [
  "# Lease",
  "",
  "Rent is due on the first of each month. The deposit is two months of rent. The tenant pays for water and power. Pets need the landlord's written consent.",
].join("\n");
const QUOTES = [
  "Rent is due on the first of each month.",
  "The deposit is two months of rent.",
  "The tenant pays for water and power.",
  "Pets need the landlord's written consent.",
];

/** The User's own Note: 23 words in three sentences. */
const OWN = [
  "Rent is due on the first of each month.",
  "The deposit is two months of rent.",
  "The tenant pays for water and power.",
];

/** 29 words: the Note would be 52. */
const TOO_MUCH =
  "Pets need the landlord's written consent [^4]. Rent is due on the first of each month [^1]. The deposit is two months of rent [^2]. The tenant pays for water and power [^3].";
/** 13 words: the Note would be 36, within the 28 to 37 that 1.5 times its 23 allows. */
const A_LITTLE =
  "Pets need the landlord's written consent [^4]. The deposit is two months of rent [^2].";

/** A model that searches, cites every sentence of the lease, and gives add_to_mind each of `adds` in turn. */
function addModel(adds: readonly { content: string; times?: number }[]) {
  let tries = 0;
  return scriptedModel(
    (call: ModelCall) => {
      if (isCheckRun(call)) return checkReply(call, {});
      const { results } = call;
      const search = results.find((result) => result.tool === "search_documents");
      if (!search)
        return { calls: [{ tool: "search_documents", input: { query: "rent deposit" } }] };
      const [passage] = shownPassages(search.text);
      const cite = {
        tool: "cite",
        input: {
          citations: QUOTES.map((quote, index) => ({
            marker: index + 1,
            passage: passage?.id,
            quote,
          })),
        },
      };
      const done = results.filter((result) => result.tool === "add_to_mind");
      const next = adds[tries];
      if (done.length === tries && next) {
        tries++;
        return {
          calls: [
            ...(tries === 1 ? [cite] : []),
            {
              tool: "add_to_mind",
              input: {
                content: next.content,
                ...(next.times !== undefined && { times_as_long: next.times }),
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

async function askToAdd(model: MockLanguageModelV4, request: string) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const folder = await core.createLibraryGroup({ name: "Flat", description: "" });
  const sources = await createSourceFolder();
  const added = await core.addDocuments([await writeSourceFile(sources, "Lease.md", LEASE)], {
    groupId: folder.id,
  });
  await waitForProcessing(
    core,
    added.documents.map((document) => document.id),
  );
  const mind = await core.createMind({ title: "Flat notes", folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  writeMind(
    client,
    OWN.map((sentence) => note(sentence)),
  );
  await client.settled();
  const answer = await askAssistant(core, {
    text: request,
    mindId: mind.id,
    scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
  });
  return { answer };
}

const toldToTheModel = (model: MockLanguageModelV4) =>
  model.doStreamCalls
    .flatMap((call) => call.prompt)
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .map((part) => (part.type === "tool-result" ? JSON.stringify(part.output) : ""))
    .join("\n");

describe("Adding to the User's own Note at the length asked", { timeout: 30_000 }, () => {
  // protects=an add off the length asked is refused with the sizes to add, counted from the Note as it is; fails_when=text three times what was asked goes into the Note unchallenged
  test("an add off the length is refused, with the sizes to add", async () => {
    const model = addModel([
      { content: TOO_MUCH, times: 1.5 },
      { content: A_LITTLE, times: 1.5 },
    ]);

    const { answer } = await askToAdd(model, "Make my note a little longer from the lease.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["failed", "done"]);
    expect(toldToTheModel(model)).toContain(
      "the Note holds 23 words and this adds 29, and times_as_long asks for 1.5 times. Add 5 to 14 words",
    );
    expect(lastResult(model)).toContain("(from 23 to 36 words, not shorter: 1.6 times as long)");
  });

  // protects=a length is refused twice at most in an Answer, so a model that misses twice still lands on the third try, with how far it is from what was asked (#1385); fails_when=a second miss lands unrefused, or a third is refused
  test("two misses are refused, the third lands and says how far it is", async () => {
    const model = addModel([
      { content: TOO_MUCH, times: 1.5 },
      { content: TOO_MUCH, times: 1.5 },
      { content: TOO_MUCH, times: 1.5 },
    ]);

    const { answer } = await askToAdd(model, "Make my note a little longer from the lease.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["failed", "failed", "done"]);
    expect(lastResult(model)).toContain(
      "(from 23 to 52 words, not shorter: 2.3 times as long, where times_as_long was 1.5)",
    );
  });

  // protects=with no amount given, an add is never refused for its length and the result still says the measured size, so a reply states it truly; fails_when=text is refused with no length asked, or the result says nothing of the size
  test.each([
    ["none given", undefined],
    ["1", 1],
  ])("with no amount asked (%s) nothing is refused and the size is measured", async (_, times) => {
    const model = addModel([{ content: TOO_MUCH, ...(times !== undefined && { times }) }]);

    const { answer } = await askToAdd(model, "Add more from the lease to my note.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done"]);
    expect(toldToTheModel(model)).not.toContain("times_as_long asks for");
  });

  // protects=the User's own sentences stay as they wrote them: an add only adds
  test("the Note's own sentences are kept as they were", async () => {
    const model = addModel([{ content: A_LITTLE, times: 1.5 }]);

    const { answer } = await askToAdd(model, "Make my note a little longer from the lease.");

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done"]);
    expect(lastResult(model)).toContain("Wrote");
  });
});
