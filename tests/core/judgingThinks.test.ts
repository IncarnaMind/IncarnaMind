import { expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const SENTENCE = "Refunds are paid within 14 days if the item is unopened.";
const PLANS: Record<string, Plan> = { [SENTENCE]: { verdict: "supported", quote: SENTENCE } };

/** A model that answers a check as planned and keeps what it was asked. */
function recording() {
  const runs: ModelCall[] = [];
  const questions: string[] = [];
  const model = scriptedModel(
    (call) => {
      runs.push(call);
      return checkReply(call, PLANS);
    },
    {
      generate(call) {
        questions.push(call.question ?? "");
        return checkGenerate(PLANS)(call);
      },
    },
  );
  return { model, runs, questions };
}

// protects=on an AI service, the step that judges a sentence against its Passages is sent to the same model asked to think, and the check's other requests are not; a model on this computer is not asked to think (#3257); fails_when=the judging step is sent without thinking, the sort or a second look is sent thinking, or a local model is made to think; no_claim=how hard the model thinks, or that thinking judges better
test.each([
  { where: "an AI service", service: true },
  { where: "this computer", service: false },
])("a check on $where: the judging step thinks only on a service", async ({ service }) => {
  const plain = recording();
  const thinking = recording();
  const asked: string[] = [];
  const { core, client, mind } = await setUpWithDocuments(
    plain.model,
    [{ name: "Refunds.md", contents: SENTENCE }],
    {
      createChatModel: (spec) => {
        const thinks = spec.thinking === "careful" || spec.thinking === "answer";
        if (thinks) asked.push(spec.modelId);
        return thinks ? thinking.model : plain.model;
      },
    },
  );
  let chosen: { providerId: string; modelId: string } | undefined;
  if (service) {
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (!provider.service) throw new Error("The test provider has no service.");
    await core.allowDataFlow("checks", provider.service.id);
    chosen = { providerId: provider.id, modelId: "claude-haiku-5-5" };
  }
  writeMind(client, [
    { type: "paragraph", attrs: { id: "p" }, content: [{ type: "text", text: SENTENCE }] },
  ]);
  await client.settled();

  await core.checkMind({
    requestId: crypto.randomUUID(),
    mindId: mind.id,
    mode: "all",
    ...(chosen && { model: chosen }),
  });
  await client.settled();

  expect(claimSpans(readMind(client)).map((span) => span.check.state)).toEqual(["supported"]);
  const [judged, rest] = service ? [thinking, plain] : [plain, thinking];
  expect(judged.runs.filter(isCheckRun).length).toBeGreaterThan(0);
  expect(rest.runs.filter(isCheckRun)).toEqual([]);
  expect(plain.questions).toContain("find-claims");
  expect(thinking.questions).toEqual([]);
  expect(asked).toEqual(service ? expect.arrayContaining(["claude-haiku-5-5"]) : []);
  core.close();
});
