/**
 * Answers that quote pages with nested, curly and German quotation marks and with inch marks, from a
 * real model (#2504). Each Question has its own Note and Documents. A model runs only when its key
 * is in the environment, so `npx vitest run` makes no request without one.
 *
 *   INCARNAMIND_LIVE_DEEPSEEK_KEY   DeepSeek (INCARNAMIND_LIVE_DEEPSEEK_MODEL, its Answers model by default)
 *   INCARNAMIND_LIVE_REPEATS        how many times each Question is asked (1 by default)
 *   INCARNAMIND_LIVE_REPORT         a file to keep each Answer as a JSON line: its text, the page it
 *                                   quotes, and each Citation's marker, quote and check
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, onTestFinished, test } from "vitest";
import type { AnswerUsage, Citation, Core } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

interface Case {
  lang: "en" | "zh" | "de";
  document: { name: string; contents: string };
  question: string;
}

const SITE = {
  name: "Site visit notes.md",
  contents:
    "# Site visit notes\n\nThe fitter said, “Use a 6” pipe under the drive, and a 4” pipe for the downspout.” The inspector wrote that the “cooling-off period” is 14 days and that the ‘soft start’ option must stay on. The owner called it “the ‘quiet’ plan” and asked for a 3’6” gate.\n",
};
const MEMO = {
  name: "Policy memo.md",
  contents:
    "# Policy memo\n\nThe board's memo states: “Members must use the ‘secure upload’ form for every file.” It adds that “the ‘72-hour rule’ applies to refunds” and that “no exceptions are made for ‘urgent’ requests.”\n",
};
const SITE_ZH = {
  name: "现场记录.md",
  contents:
    "# 现场记录\n\n师傅说：“车道下面要用6”的管子，落水管用4”的。”检查员写道，“冷静期”为14天，“软启动”功能必须保持开启。业主把它称为“‘安静’方案”，并要一扇3’6”高的门。\n",
};
const NOTICE_ZH = {
  name: "会员公告.md",
  contents:
    "# 会员公告\n\n公告指出：“会员必须使用‘安全上传’表单提交每个文件。”公告还称「退款适用『72小时规则』」，并且「『紧急』申请也不例外」。\n",
};
const RECORD_DE = {
  name: "Baustellenprotokoll.md",
  contents:
    "# Baustellenprotokoll\n\nDer Monteur sagte: „Unter der Einfahrt brauchen wir ein 6” Rohr und für das Fallrohr ein 4” Rohr.“ Die Prüferin schrieb, die „Widerrufsfrist“ betrage 14 Tage und der ‚Sanftanlauf‘ müsse eingeschaltet bleiben. Die Eigentümerin nannte es „den ‚leisen‘ Plan“.\n",
};
const LETTER_DE = {
  name: "Rundschreiben.md",
  contents:
    "# Rundschreiben\n\nDas Rundschreiben hält fest: „Mitglieder müssen für jede Datei das Formular ‚Sicherer Upload‘ verwenden.“ Weiter heißt es, „die ‚72-Stunden-Regel‘ gilt für Erstattungen“ und „auch ‚dringende‘ Anträge sind keine Ausnahme“.\n",
};

const CASES: Case[] = [
  {
    lang: "en",
    document: SITE,
    question: "What exactly did the fitter say about the pipes? Quote him word for word.",
  },
  {
    lang: "en",
    document: SITE,
    question: "What did the owner call the plan, in her own words, and what gate did she ask for?",
  },
  {
    lang: "en",
    document: SITE,
    question:
      "Quote what the inspector wrote about the cooling-off period and the soft start option.",
  },
  {
    lang: "en",
    document: MEMO,
    question: "What does the memo say members must use? Quote it exactly.",
  },
  {
    lang: "en",
    document: MEMO,
    question: "Quote what the memo says about refunds and about urgent requests.",
  },
  { lang: "zh", document: SITE_ZH, question: "师傅关于管子是怎么说的？请原文引用。" },
  { lang: "zh", document: SITE_ZH, question: "业主怎么称呼这个方案？她要多高的门？请引用原话。" },
  { lang: "zh", document: NOTICE_ZH, question: "公告说会员必须使用什么？请原文引用。" },
  { lang: "zh", document: NOTICE_ZH, question: "退款适用什么规则？紧急申请呢？请引用公告原文。" },
  {
    lang: "de",
    document: RECORD_DE,
    question: "Was genau sagte der Monteur über die Rohre? Bitte wörtlich zitieren.",
  },
  {
    lang: "de",
    document: RECORD_DE,
    question: "Wie nannte die Eigentümerin den Plan, und was schrieb die Prüferin? Bitte zitieren.",
  },
  {
    lang: "de",
    document: LETTER_DE,
    question: "Was müssen Mitglieder laut Rundschreiben verwenden? Bitte wörtlich zitieren.",
  },
  {
    lang: "de",
    document: LETTER_DE,
    question:
      "Welche Regel gilt für Erstattungen, und was gilt für dringende Anträge? Bitte zitieren.",
  },
];

const KEY = process.env.INCARNAMIND_LIVE_DEEPSEEK_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ??
  (catalogProvider("deepseek")?.roles.answers as string);
const REPEATS = Number(process.env.INCARNAMIND_LIVE_REPEATS ?? "1");
const RUNS = CASES.flatMap((each, index) =>
  Array.from({ length: REPEATS }, (_, repeat) => ({
    ...each,
    index,
    repeat,
    id: `${index}-${repeat}`,
  })),
);

async function ask(core: Core, text: string, mindId: string) {
  const citations = new Map<number, Citation>();
  const stopAdded = core.on("answer.citationAdded", ({ marker, citation }) =>
    citations.set(marker, citation),
  );
  const result = await core.askInConversation({ conversationId: null, text, mindId });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  const { checked, usage } = await new Promise<{ checked: Citation[]; usage: AnswerUsage | null }>(
    (resolve) => {
      const stops = [
        core.on("answer.finished", (event) => {
          if (event.answerId !== result.answerId) return;
          for (const stop of stops) stop();
          resolve({ checked: event.citations, usage: event.usage });
        }),
        core.on("answer.failed", ({ answerId }) => {
          if (answerId !== result.answerId) return;
          for (const stop of stops) stop();
          resolve({ checked: [], usage: null });
        }),
      ];
    },
  );
  stopAdded();
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  const markers = [...citations.entries()].map(([marker, citation]) => ({
    marker,
    passageId: citation.passageId,
    quote: citation.quote,
    check:
      checked.find((done) => done.passageId === citation.passageId && done.quote === citation.quote)
        ?.check ?? null,
  }));
  return { answer, markers, checked, usage };
}

describe.skipIf(KEY === undefined)("Quotation marks, live: DeepSeek", { timeout: 300_000 }, () => {
  test.each(RUNS)("$lang $id: $question", async (each) => {
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    await core.saveChatProvider({ kind: "deepseek", ...(KEY && { apiKey: KEY }), modelId: MODEL });
    await addAndProcess(core, [
      await writeSourceFile(sources, each.document.name, each.document.contents),
    ]);
    const mind = await core.createMind({ title: "Notes" });
    const { answer, markers, checked, usage } = await ask(core, each.question, mind.id);
    const report = process.env.INCARNAMIND_LIVE_REPORT;
    const line = {
      model: MODEL,
      lang: each.lang,
      case: each.index,
      repeat: each.repeat,
      question: each.question,
      page: each.document.contents,
      status: answer.status,
      text: answer.text,
      markers,
      usage,
      checks: checked.map((citation) => ({
        quote: citation.quote,
        check: citation.check,
        reason: citation.checkReason,
      })),
    };
    if (report) onTestFinished(() => appendFile(report, `${JSON.stringify(line)}\n`));
    expect(answer.status, answer.errorMessage ?? "").toBe("done");
  });
});
