import { afterEach, expect, test, vi } from "vitest";
import { judgeClaims } from "../../eval/everyday/judge";
import { chatModelSpecOf, chatProviderOf, readConfig } from "../../eval/lib/config";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { askAndFinish, setUpWithDocuments } from "../helpers/citations";
import { fakeProvider } from "../helpers/fakeProvider";
import { replyingModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

afterEach(() => vi.unstubAllGlobals());

const SPRING = "Spring tides happen at new moon and at full moon.";
const TIDES = buildPdf([{ lines: ["Spring and neap tides", SPRING] }]);
const INTERNATIONAL = "https://api.moonshot.ai/v1";

// protects=the evaluation reaches Kimi through the app's own provider at the endpoint it names, International here, and neither its Answers nor its judge send a temperature, which Kimi refuses (#1288); fails_when=a request goes to the China endpoint or carries a temperature; no_claim=what Kimi itself answers.
test("the evaluation asks Kimi International as the app does, with no temperature", async () => {
  const { chat, judge } = readConfig("/repo", {
    INCARNAMIND_EVAL_CHAT_KIND: "kimi",
    INCARNAMIND_EVAL_CHAT_MODEL: "kimi-k2.6",
    INCARNAMIND_EVAL_CHAT_KEY: "key-for-the-test",
    INCARNAMIND_EVAL_CHAT_ENDPOINT: "intl",
    INCARNAMIND_EVAL_JUDGE_KIND: "kimi",
    INCARNAMIND_EVAL_JUDGE_MODEL: "kimi-k3",
    INCARNAMIND_EVAL_JUDGE_KEY: "key-for-the-test",
    INCARNAMIND_EVAL_JUDGE_ENDPOINT: "intl",
  });
  if (!chat || !judge) throw new Error("The settings name no chat model or judge.");
  const { core, client, mind } = await setUpWithDocuments(
    replyingModel(),
    [{ name: "Tides.pdf", contents: TIDES }],
    { createChatModel: createAiSdkChatModel },
  );
  const saved = await core.saveChatProvider(chatProviderOf(chat));
  expect(saved).toMatchObject({ kind: "kimi", endpoint: "intl" });
  await core.allowDataFlow("chat", new URL(INTERNATIONAL).origin);
  const requests = fakeProvider(new URL(INTERNATIONAL).host, {
    protocol: "chat",
    models: { data: [{ id: "kimi-k2.6" }] },
    query: "spring tides",
    records: (passages) => [
      { marker: 1, passage: passages[0]?.id, pageFrom: 1, pageTo: 1, quote: SPRING },
    ],
    answer: "Spring tides come at new and full moon [^1].",
  });

  await askAndFinish(core, client, mind.id, "When are spring tides?");
  await judgeClaims(
    createAiSdkChatModel({ ...chatModelSpecOf(judge), thinking: "off" }),
    "Done.",
    [],
  );

  const asked = requests.filter((request) => request.method === "POST");
  expect(asked.map((request) => request.body.model)).toContain("kimi-k3");
  expect(asked.length).toBeGreaterThanOrEqual(3);
  for (const request of asked) {
    expect(request.url).toBe(`${INTERNATIONAL}/chat/completions`);
    expect(request.body).not.toHaveProperty("temperature");
  }
});
