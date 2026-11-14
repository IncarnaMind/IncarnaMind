import { describe, expect, test } from "vitest";
import { writtenSentences } from "../../eval/lib/writtenSentences";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { noteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noteStateOf } from "../../src/renderer/src/noteState";
import { selfCheckLines, selfChecksOf } from "../../src/renderer/src/selfChecks";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, resolveChanges } from "../helpers/minds";
import { judgesNothing, type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

/*
 * Whose sentence a write's check reads is decided where its mark lands (#3019), and that check
 * lands after the reply (#2830): a sentence the assistant wrote that joins a cited fact to its own
 * conclusion reads Not checked for that conclusion, a finished sentence its count covers.
 */

const LINE = "The tide turns twice a day.";
const LINE_ZH = "港口的潮水每天都会涨落两次。";
const TIDES = { name: "Tides.md", contents: `# Tides\n\n${LINE}\n\n${LINE_ZH}\n` };

const WRITES = {
  en: {
    quote: LINE,
    fact: "Tides turn twice in a day here",
    conclusion: ", so boats should leave early",
    stop: ".",
  },
  "zh-CN": {
    quote: LINE_ZH,
    fact: "这里的潮水每天涨落两次",
    conclusion: "，所以船应该早点出发",
    stop: "。",
  },
} as const;

type Language = keyof typeof WRITES;

const joined = (language: Language) => {
  const { fact, conclusion, stop } = WRITES[language];
  return `${fact}${conclusion}${stop}`;
};

const plain = (language: Language) => `${WRITES[language].fact}${WRITES[language].stop}`;

/** How the check names the joined sentence's parts in its first turn, as the sorter would. */
const PARTS: Record<string, { kind: "fact" | "opinion"; text: string }[]> = Object.fromEntries(
  (Object.keys(WRITES) as Language[]).map((language) => [
    joined(language),
    [
      { kind: "fact", text: WRITES[language].fact },
      { kind: "opinion", text: WRITES[language].conclusion.replace(/^[,，]\s*/, "") },
    ],
  ]),
);

const PLANS: Record<string, Plan> = Object.fromEntries(
  (Object.keys(WRITES) as Language[]).flatMap((language) => {
    const { quote, fact } = WRITES[language];
    const plan: Plan = { verdict: "supported", quote, says: quote, judgement: "same" };
    return [
      [fact, plan],
      [plain(language), plan],
    ];
  }),
);

function partsReply(call: ModelCall) {
  const named = PARTS[sentenceOf(call)];
  if (named && call.results.length === 0 && call.system.includes("Parts:"))
    return {
      text: `Parts: ${JSON.stringify(named)}`,
      calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }],
    };
  return checkReply(call, PLANS);
}

/**
 * The assistant writes both sentences into the Note in front, each citing the line; every request
 * of the write's check waits until the Answer has ended, so a check sent before the reply would
 * hold the Answer for good.
 */
function writingModel(language: Language, replied: Promise<void>) {
  const { quote, stop } = WRITES[language];
  const content = `${joined(language).slice(0, -1)}[^1]${stop} ${plain(language).slice(0, -1)}[^1]${stop}`;
  return scriptedModel(
    (call) => {
      if (isCheckRun(call)) {
        const reply = partsReply(call);
        return "error" in reply ? reply : { ...reply, pause: { after: 0, until: replied } };
      }
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(search.text).find((each) => each.text.includes(quote));
        return {
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } },
          ],
        };
      }
      if (!call.results.some((result) => result.tool === "add_to_mind"))
        return { calls: [{ tool: "add_to_mind", input: { content } }] };
      return { text: "Added it." };
    },
    { generate: judgesNothing },
  );
}

const shownIn = (client: MindClient) =>
  claimsOf(readMind(client), {
    footing: "not-yet-known",
    versions: null,
    folderId: null,
    scope: null,
  }).claims;

describe("The assistant's own conclusion, checked after the reply", { timeout: 60_000 }, () => {
  // protects=a sentence the assistant wrote that joins a cited fact to its own conclusion, checked in the background once the reply has ended, reads Not checked for the assistant's conclusion in the Note and in the evaluation's record, while a sentence with only the fact reads Supported; the line under the card counts both as checked with none needing a look, and the badge reads the Note checked with nothing left to check, in English and Chinese (#3019, #2830); fails_when=the conclusion's sentence reads Supported, counts as needing a look or as left to check, or the check runs before the reply ends; no_claim=how the sorter names parts.
  test.each(["en", "zh-CN"] as const)("%s", async (language) => {
    let replied = () => {};
    const ended = new Promise<void>((resolve) => {
      replied = resolve;
    });
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(writingModel(language, ended)).createChatModel,
    });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    core.on("answer.finished", () => replied());
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    for (const flow of ["chat", "checks"] as const)
      if (saved.service) await core.allowDataFlow(flow, saved.service.id);
    const sources = await createTempDataFolder();
    await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);
    const mind = await core.createMind({ title: "Harbour" });
    const client = await connectToMind(core, mind.id);

    const asked = await core.askInConversation({ text: "Add a line on tides", mindId: mind.id });
    if (!asked.asked) throw new Error("Not asked.");
    expect((await answerEnded(core, asked.answerId)).event).toBe("finished");
    await client.settled();
    const { messages } = await core.getConversation(asked.conversation.id);
    const answer = messages.find((message) => message.id === asked.answerId);
    if (answer?.kind !== "answer") throw new Error("No Answer.");

    const claims = shownIn(client);
    expect(claims.map((claim) => [claim.check.text, claim.shown])).toEqual([
      [joined(language), { state: "not-checked", reason: "assistant-conclusion" }],
      [plain(language), { state: "supported" }],
    ]);

    const [check] = selfChecksOf(answer.toolCalls);
    if (!check?.blocks) throw new Error("No check of the write.");
    expect(
      writtenSentences(client.blocks, new Set(check.blocks)).map((each) => [
        each.text,
        each.state,
        each.reason,
      ]),
    ).toEqual([
      [joined(language), "not-checked", "assistant-conclusion"],
      [plain(language), "supported", null],
    ]);

    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    expect([check.checked, check.failed, check.look]).toEqual([2, 0, 0]);
    expect(selfCheckLines(check, t, language).map((line) => [line.kind, line.text])).toEqual([
      ["checked", t("selfCheck.checkedOnly", { checked: 2 })],
    ]);

    // The badge counts what the Note holds, as the window has it once the reply's changes apply.
    await resolveChanges(client, "accept");
    await client.settled();
    const health = noteHealth(readMind(client), {
      claims: shownIn(client),
      citationCheck: (attributes) => attributes.check,
      skipped: new Set(),
      unexamined: new Set(),
      kept: [],
    });
    expect([health.checkable, health.supported, health.toCheck.length]).toEqual([2, 1, 0]);
    expect(health.lookClaims).toEqual([]);
    expect(noteStateOf(health)?.kind).toBe("checked");
  });
});
