/**
 * What a press sends the model, whole, in each of the evaluation's arms (#2847): every request of
 * every button's press, its prompt, Tools and settings, on both models the gate runs, in a call in
 * English and one in Chinese. Main's hashes were taken by running this file on main at 4217d5de9;
 * the form's are what its gate sends, so the commit that turns the form on is proven by them.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import {
  type CallHelpForm,
  GENERAL_HELP,
  MEETING_TEMPLATES,
  type MeetingHelpKind,
  type MeetingHelpTemplate,
  TEMPLATE_HELP,
} from "../../src/shared/meetingHelp";
import { answerEnded, answerJudged, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { type GenerateCall, judgesNothing, scriptedModel, scriptedModels } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;
const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;

const CALLS = {
  English: {
    language: "en",
    said: {},
    sheet:
      "Price sheet 2026\n\nTeam plan: $25 per seat a month.\nEnterprise plan: $45 per seat a month, single sign-on included.",
    quote: "Enterprise plan: $45 per seat a month, single sign-on included.",
    reply:
      "★ Yes, Enterprise is $45 a seat\n> Enterprise is $45 per seat a month, with single sign-on [^1]\n→ answers at once\n\nI'll send the price sheet today\n→ buys time\n\n= Ask how many seats they need",
  },
  Chinese: {
    language: "zh-CN",
    said: {
      lines: ["我们先看一下报价。", "团队版每个席位每月二十五美元。"],
      theirLines: ["企业版能便宜一点吗？", "四十个席位一共多少钱？"],
    },
    sheet:
      "价目表 2026\n\n团队版：每个席位每月 25 美元。\n企业版：每个席位每月 45 美元，含单点登录。",
    quote: "企业版：每个席位每月 45 美元，含单点登录。",
    reply:
      "★ 是的，企业版每个席位 45 美元\n＞ 企业版每个席位每月 45 美元，含单点登录 [^1]\n→ 直接回答\n\n我今天把价目表发给你\n→ 争取时间\n\n= 问他们需要多少个席位",
  },
} as const;
type CallLanguage = keyof typeof CALLS;

/** Each press's requests as main sends them: one hash over every press of a call. */
const MAIN: Record<CallLanguage, string> = {
  English: "4a6fc33a93be45877772e695498fe5552f52dd31f6a8c9e4e2a4bd57ce1ebcac",
  Chinese: "c862afc71d24d8bf02c25ddf93fa3f8ff3cdc5019739e992ecb5ec355171adcc",
};

/** Check's presses alone, as main sends them. */
const MAIN_CHECK: Record<CallLanguage, string> = {
  English: "a2c63a35f9dd24b17fc2b534708524f6a01df8cad58d03b437e2fb9973f14001",
  Chinese: "6ce4a534bb3e0d2827d37e6c40fb2d18a1d543d91f2156829f452fb617b8086e",
};

/** Each press's requests in the form, as its gate sends them. */
const FORM: Record<CallLanguage, string> = {
  English: "03bb862dd4277766783d4f615baeb2a01d23856b467b754cbbd03606e74a9ac0",
  Chinese: "c3c8c86f20076395cd417ca9f1c6c90efe0fddca3897ceb688f662e896261a7a",
};

/** What each switch the evaluation sets sends; with none, a press is asked as the app asks it. */
const ARMS = [
  { arm: "no switch", form: undefined, sends: MAIN },
  { arm: "as before", form: "as before", sends: MAIN },
  { arm: "the form", form: "fact lines", sends: FORM },
] as const;

/** Each button, with the template that adds it. */
const BUTTONS: { kind: MeetingHelpKind; template: MeetingHelpTemplate | null }[] = [
  ...GENERAL_HELP.map((kind) => ({ kind, template: null })),
  ...MEETING_TEMPLATES.flatMap((template) =>
    TEMPLATE_HELP[template].map((kind) => ({ kind, template })),
  ),
];

/** An id made each run, and a conversation's cache key, a hash of one. */
const MADE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<="promptCacheKey":")[0-9a-f]{32}/g;

/**
 * The days around the run, as a Transcript's file says when it was last changed: the computer's
 * clock, not the test's, sets it.
 */
const DAYS = new Set(
  [-1, 0, 1].flatMap((days) => {
    const at = new Date(Date.now() + days * 86_400_000);
    const local = [at.getFullYear(), at.getMonth() + 1, at.getDate()]
      .map((part) => String(part).padStart(2, "0"))
      .join("-");
    return [at.toISOString().slice(0, 10), local];
  }),
);

/**
 * A request as it is sent, whole, but for its abort signal; what a run makes is named by order, and
 * the day it runs is "today".
 */
function requestText(request: object): string {
  const made = new Map<string, string>();
  return JSON.stringify(request, (key, value) => (key === "abortSignal" ? undefined : value))
    .replace(MADE, (id) => {
      if (!made.has(id)) made.set(id, `made-${made.size + 1}`);
      return made.get(id) ?? id;
    })
    .replace(/\d{4}-\d{2}-\d{2}/g, (day) => (DAYS.has(day) ? "today" : day));
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The judge's questions; Stop's own work and the Transcript's aren't this test's. */
const judging = (call: GenerateCall) =>
  call.question === undefined
    ? { error: { status: 500, message: "Not this test's." } }
    : judgesNothing(call);

/** Presses a button in a conversation of its own, and waits until every check of its reply is done. */
async function pressOnce(core: Core, meetingId: string, kind: MeetingHelpKind) {
  const asked = await core.askMeetingHelp({ meetingId, kind });
  if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
  expect((await answerEnded(core, asked.answerId)).event).toBe("finished");
  await answerJudged(core, asked.conversation.id, asked.answerId);
  await core.deleteConversation(asked.conversation.id);
}

/**
 * Every button pressed in a call with the price sheet in its Library, on each model: by model and
 * button, the hash of every request its press sent, the streamed ones in order, then the judge's.
 */
async function pressEach(
  callLanguage: CallLanguage,
  form?: CallHelpForm,
): Promise<Map<string, string>> {
  const call = CALLS[callLanguage];
  const model = scriptedModel(
    (request) => {
      const sheet = shownPassages(request.prompt).findLast((passage) =>
        passage.text.includes(call.quote),
      );
      const cited = request.results.some((result) => result.tool === "cite");
      if (!cited && sheet && request.tools.includes("cite")) {
        const citations = [{ marker: 1, passage: sheet.id, quote: call.quote }];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return { text: call.reply };
    },
    { generate: judging },
  );
  const dataDir = await createTempDataFolder();
  const { core, record } = await transcribingCore(dataDir, {
    createChatModel: scriptedModels(model).createChatModel,
    engine: call.said,
    ...(form && { callHelpForm: () => form }),
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.updateSettings({ user: { language: call.language } });
  const sources = await createSourceFolder();
  const added = await core.addDocuments([
    await writeSourceFile(sources, "Price sheet.txt", call.sheet),
  ]);
  await waitForProcessing(
    core,
    added.documents.map((document) => document.id),
  );
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(9 * SECOND);
  await until(core, meeting.id, (transcript) => transcript.lines >= 4);

  const pressed = new Map<string, string>();
  for (const modelId of MODELS) {
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId,
    });
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);
    let template: MeetingHelpTemplate | null = null;
    for (const button of BUTTONS) {
      if (button.template && button.template !== template) {
        await core.setMeetingTemplate({ meetingId: meeting.id, template: button.template });
        template = button.template;
      }
      const streams = model.doStreamCalls.length;
      const generates = model.doGenerateCalls.length;
      await pressOnce(core, meeting.id, button.kind);
      const sent = model.doStreamCalls.slice(streams).map(requestText);
      const judged = model.doGenerateCalls.slice(generates).map(requestText).sort();
      pressed.set(`${modelId} ${button.kind}`, sha([...sent, "", ...judged].join("\n")));
    }
    await core.setMeetingTemplate({ meetingId: meeting.id, template: null });
  }
  return pressed;
}

const runs = new Map<string, Promise<Map<string, string>>>();
const pressesIn = (callLanguage: CallLanguage, form?: CallHelpForm) => {
  const key = `${callLanguage} ${form ?? "none"}`;
  const run = runs.get(key) ?? pressEach(callLanguage, form);
  runs.set(key, run);
  return run;
};

/** One hash over the presses' requests, in the buttons' order: every button's, or one's. */
const hashOf = (pressed: Map<string, string>, only?: MeetingHelpKind) =>
  sha(
    [...pressed]
      .filter(([key]) => !only || key.endsWith(` ${only}`))
      .map(([key, hash]) => `${key} ${hash}`)
      .join("\n"),
  );

describe("what a press sends the model, whole (#2847)", { timeout: 120_000 }, () => {
  // protects=with no switch and with "as before", every press of every button sends what main sends, each request whole (prompt, Tools and settings) and byte for byte, on both of the gate's models, in English and Chinese, so the gate's as-before arm is main; and with the form, every press sends exactly what the form's gate sent, so the commit that turns the form on is proven by it; fails_when=one byte of one request differs; no_claim=what a model writes.
  test.each(
    ARMS.flatMap((arm) =>
      (["English", "Chinese"] as const).map((language) => ({ ...arm, language })),
    ),
  )("$arm, in $language", async ({ form, sends, language }) => {
    expect(hashOf(await pressesIn(language, form))).toBe(sends[language]);
  });

  // protects=Check is asked as on main in every arm, the form's too, its whole press byte for byte, in English and Chinese, since its verdict went wrong on Claude Haiku 5.5 in the form; fails_when=one byte of one of its requests differs in any arm; no_claim=how a model answers it.
  test.each(["English", "Chinese"] as const)(
    "Check, in %s, as on main in every arm",
    async (language) => {
      for (const { form } of ARMS) {
        expect(hashOf(await pressesIn(language, form), "check")).toBe(MAIN_CHECK[language]);
      }
    },
  );

  // protects=the form changes the requests of every button but Check and the readings of what they want, and theirs not at all; fails_when=one of them changes, or another doesn't; no_claim=whether the wording works.
  test.each(["English", "Chinese"] as const)(
    "the form's changed presses, in %s",
    async (language) => {
      const today = await pressesIn(language);
      const form = await pressesIn(language, "fact lines");
      const unchanged = [...form]
        .filter(([key, hash]) => today.get(key) === hash)
        .map(([key]) => key);
      expect(unchanged).toEqual(MODELS.flatMap((model) => [`${model} want`, `${model} check`]));
    },
  );
});
