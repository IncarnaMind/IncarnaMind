/**
 * A check made faster without checking less (#2532): as many sentences at once as the provider
 * was measured to take, each sending the same requests it would at six. The model's replies are
 * scripted.
 */
import { expect, test } from "vitest";
import type { CoreAdapters, SaveChatProviderInput } from "../../src/core";
import { claimsAtOnce, sentencesAtOnce } from "../../src/core/answers/checks/runChecks";
import type { PreparedChatModel } from "../../src/core/providers/chat";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

const MOON = "Spring tides come at new and full moon.";
const TIDES = { name: "Tides.md", contents: `# Tides\n\n${MOON}\n` };

const tides = (count: number) =>
  Array.from({ length: count }, (_, index) => `Spring tide ${index + 1} comes at new moon.`);

/** Checks this note's sentences on `provider`; what each sentence's check sent, and the most at once. */
async function checkNote(
  provider: SaveChatProviderInput,
  sentences: readonly string[],
  adapters: Partial<CoreAdapters> = {},
) {
  const plans: Record<string, Plan> = Object.fromEntries(
    sentences.map((sentence) => [sentence, { verdict: "supported", quote: MOON }]),
  );
  const sent = new Map<string, string[]>();
  const running = new Set<string>();
  let most = 0;
  const model = scriptedModel(
    (call: ModelCall) => {
      if (!isCheckRun(call)) return { text: "" };
      const sentence = sentenceOf(call);
      sent.set(sentence, [
        ...(sent.get(sentence) ?? []),
        [call.system, call.tools.join(","), call.prompt].join("\n"),
      ]);
      if (call.results.length === 0) {
        running.add(sentence);
        most = Math.max(most, running.size);
      }
      const reply = checkReply(call, plans);
      if ("text" in reply && reply.text?.startsWith("Verdict")) running.delete(sentence);
      return reply;
    },
    { generate: checkGenerate(plans) },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    ...adapters,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider(provider);
  if (saved.service) await core.allowDataFlow("checks", saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);
  const mind = await core.createMind({ title: "Tide notes" });
  const client = await connectToMind(core, mind.id);
  writeMind(
    client,
    sentences.map((sentence, index) => ({
      type: "paragraph",
      attrs: { id: `tide-${index + 1}` },
      content: [{ type: "text", text: sentence }],
    })),
  );
  await client.settled();

  const result = await core.checkMind({ requestId: "run-all", mindId: mind.id, mode: "all" });

  expect(result).toMatchObject({ kind: "checked", sentences: sentences.length });
  await client.settled();
  const marks = claimSpans(readMind(client)).map((span) => ({
    sentence: span.sentence.text,
    state: span.check.state,
    says: span.check.says,
    quote: span.check.evidence?.quote ?? null,
  }));
  return { sent, most, marks };
}

const HAIKU: SaveChatProviderInput = {
  kind: "anthropic",
  apiKey: "sk-ant-test",
  modelId: "claude-haiku-5-5",
};

// protects=a check sends as many sentences at once as its provider was measured to take: twelve to Anthropic, six to a service the catalog has no number for (#2532, #1618); fails_when=Anthropic gets six, or an unmeasured service more than six; no_claim=a real provider's rate limits, which the run's backoff answers.
test.each([
  [12, "Anthropic", HAIKU],
  [
    6,
    "a service measured at no number",
    { kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" },
  ],
] as const)("Check this note sends %i sentences at once to %s", async (atOnce, _, provider) => {
  const { most } = await checkNote(provider, tides(13));

  expect(most).toBe(atOnce);
});

// protects=sending more sentences at once changes nothing a sentence's check sends or concludes: each sends the same requests, byte for byte, and lands the same mark at six and at twelve (#2532); fails_when=a check's requests or its verdict depend on how many run beside it; no_claim=the order in which their replies come.
test("each sentence's check sends the same requests and lands the same mark at six and at twelve at once", async () => {
  const sentences = tides(9);
  const atSix = await checkNote(HAIKU, sentences, {
    modelFacts: () => ({ checksAtOnce: 6 }),
  });
  const atTwelve = await checkNote(HAIKU, sentences, {
    modelFacts: () => ({ checksAtOnce: 12 }),
  });

  expect(atSix.most).toBe(6);
  expect(atTwelve.most).toBe(9);
  expect(atTwelve.sent.size).toBe(9);
  for (const sentence of sentences) {
    expect(atTwelve.sent.get(sentence)).toEqual(atSix.sent.get(sentence));
  }
  expect(atTwelve.marks).toHaveLength(9);
  expect(atTwelve.marks).toEqual(atSix.marks);
  expect(atTwelve.marks.every((mark) => mark.state !== "checking")).toBe(true);
});

// protects=a plan signed in with the User's own account keeps six sentences at once, though it reads its provider's facts, and what has no per-sentence backoff (the sorting, an Answer's batches, the background watch) keeps six on any service (#2532); fails_when=the Claude sign-in gets Anthropic's twelve, or the sorting gets them; no_claim=the plan's own limits, which no run measured.
test("six at once on a Claude sign-in, and for what isn't a run of sentence checks", () => {
  const facts = { checksAtOnce: 12 };
  const on = (kind: "anthropic" | "claude-account") =>
    ({
      provider: { kind, service: { id: "anthropic" } },
      capabilities: { known: true, facts },
    }) as unknown as PreparedChatModel;

  expect(sentencesAtOnce(on("anthropic"))).toBe(12);
  expect(sentencesAtOnce(on("claude-account"))).toBe(6);
  expect(claimsAtOnce(on("anthropic"))).toBe(6);
});
