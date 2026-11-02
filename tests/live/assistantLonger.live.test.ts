/**
 * "Longer" over a summary the assistant wrote (#1385, #1897), against real models, in English and
 * in Chinese: a short cited summary of a contract written into the Note in front, then a request
 * for it a bit longer or twice as long, in words no prompt or Tool description uses. Counted per
 * run, each measured from the Note's text before and after, in words, or characters for Chinese:
 * the growth is within what was asked (a bit longer: more than 1, at most 1.65 times; twice as
 * long: 1.6 to 2.4 times), every sentence it added has a Citation or a check's mark, the sizes
 * the reply states are the measured ones, and the Note holds one summary. Each model runs only
 * when its key is in the environment; the variables are those of
 * ./assistantChangesMinds.live.test.ts.
 *
 * INCARNAMIND_LIVE_LIMIT runs only the first so many requests of each kind and language. Set
 * INCARNAMIND_LIVE_REPORT to a file to keep what each run gave back.
 */
import { appendFile } from "node:fs/promises";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import type { ChatProviderKind, Core } from "../../src/core";
import { CITATION_NODE, CLAIM_CHECK_MARK } from "../../src/core/api";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import {
  comparableSentence,
  INLINE_NODE,
  isClaim,
  sentenceSpans,
} from "../../src/shared/sentences";
import { countFor, countText, mostlyCjk } from "../../src/shared/wordCount";
import { checkReply, isCheckRun } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, resolveChanges } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const LIVE: { name: string; kind: ChatProviderKind; apiKey: string | undefined; model: string }[] =
  [
    {
      name: "Anthropic",
      kind: "anthropic",
      apiKey: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
      model:
        process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
        (catalogProvider("anthropic")?.roles.quickTasks as string),
    },
  ];

type Kind = "a bit" | "twice";

const LANGUAGES = [
  {
    language: "English",
    file: "Employment contract.md",
    contents: [
      "# Employment contract: Dana Whitfield and Larkspur Analytics Ltd",
      "1. Role. Dana Whitfield is employed as a Data Analyst in the Reporting team, reporting to the Head of Reporting, from 3 March 2025.",
      "2. Probation. The first six months are a probation period, during which either party may end the contract with two weeks' notice.",
      "3. Hours. Normal hours are 37.5 a week, Monday to Friday, with core hours from 10:00 to 16:00. Overtime is paid at 1.5 times the hourly rate when the line manager agrees to it in advance.",
      "4. Pay. The salary is £41,500 a year, paid monthly on the last working day, and reviewed every April.",
      "5. Holiday. The employee has 25 days of paid holiday a year as well as public holidays, and may carry up to 5 unused days into the next year.",
      "6. Notice. After probation, either party ends the contract with one month's written notice.",
      "7. Confidentiality. The employee keeps client data confidential during the employment and for two years after it ends.",
    ].join("\n\n"),
    first: "Write a short summary of the employment contract into this note.",
    seed: {
      query: "employment contract salary notice",
      content:
        "## Summary\n\nDana Whitfield joins Larkspur Analytics as a Data Analyst in the Reporting team from 3 March 2025 [^1]. The salary is £41,500 a year, paid monthly [^2]. After a six-month probation, either party gives one month's written notice [^3].",
      quotes: [
        "Dana Whitfield is employed as a Data Analyst in the Reporting team, reporting to the Head of Reporting, from 3 March 2025.",
        "The salary is £41,500 a year, paid monthly on the last working day",
        "After probation, either party ends the contract with one month's written notice.",
      ],
    },
    salary: /41,500/g,
    requests: {
      "a bit": [
        "Expand the summary a little.",
        "Could you make the summary slightly longer?",
        "Add a bit more detail to the summary.",
        "Flesh out the summary a little more.",
        "Make the summary a little more detailed, but not much longer.",
      ],
      twice: [
        "Make the summary double its current length.",
        "Expand the summary to about two times its length.",
        "Grow the summary so it's roughly double.",
      ],
    } satisfies Record<Kind, string[]>,
  },
  {
    language: "Chinese",
    file: "劳动合同.md",
    contents: [
      "# 劳动合同：林晓雯与蓝橡数据分析有限公司",
      "一、岗位。林晓雯受聘为报表部数据分析师，向报表部负责人汇报，自2025年3月3日起履职。",
      "二、试用期。前六个月为试用期，试用期内任何一方提前两周通知即可解除合同。",
      "三、工时。标准工时为每周37.5小时，周一至周五，核心工作时间为10:00至16:00。经直属上级事先同意的加班，按小时工资的1.5倍支付。",
      "四、薪酬。年薪为人民币415,000元，于每月最后一个工作日按月发放，每年四月调整一次。",
      "五、假期。员工每年享有25天带薪年假，另加法定节假日，未休年假最多可结转5天至下一年。",
      "六、解除。试用期满后，任何一方须提前一个月书面通知方可解除合同。",
      "七、保密。员工在职期间及离职后两年内，须对客户数据保密。",
    ].join("\n\n"),
    first: "把这份劳动合同写成一段简短的摘要放进这个笔记。",
    seed: {
      query: "劳动合同 年薪 解除",
      content:
        "## 摘要\n\n林晓雯自2025年3月3日起受聘为蓝橡数据分析有限公司报表部数据分析师[^1]。年薪为人民币415,000元，按月发放[^2]。试用期为六个月，期满后解除合同须提前一个月书面通知[^3]。",
      quotes: [
        "林晓雯受聘为报表部数据分析师，向报表部负责人汇报，自2025年3月3日起履职。",
        "年薪为人民币415,000元，于每月最后一个工作日按月发放",
        "试用期满后，任何一方须提前一个月书面通知方可解除合同。",
      ],
    },
    salary: /415,000/g,
    requests: {
      "a bit": [
        "把摘要稍微扩写一点。",
        "摘要再详细一点点。",
        "摘要稍微加长一些。",
        "摘要有点短，稍微补充一下。",
        "把摘要略微展开一些。",
      ],
      twice: ["把摘要扩写到现在的两倍长。", "摘要篇幅加倍。", "摘要扩充一倍。"],
    } satisfies Record<Kind, string[]>,
  },
] as const;

const WITHIN: Record<Kind, (times: number) => boolean> = {
  "a bit": (times) => times > 1 && times <= 1.65,
  twice: (times) => times >= 1.6 && times <= 2.4,
};

const ASK_LIMIT_MS = 240_000;

/**
 * The summary the assistant wrote first, the same in every run and on every commit: written by a
 * scripted model, cited, so what is measured is only the real model's "longer".
 */
function seedModel(seed: { query: string; content: string; quotes: readonly string[] }) {
  // Every sentence of the seed is in the contract: each check finds it supported.
  const supported = new Proxy({}, { get: () => ({ verdict: "supported" }) });
  return scriptedModel((call: ModelCall): ScriptedReply => {
    if (isCheckRun(call)) return checkReply(call, supported);
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: seed.query } }] };
    if (call.results.some((result) => result.tool === "add_to_mind")) return { text: "Done." };
    const [passage] = shownPassages(search.text);
    const citations = seed.quotes.map((quote, index) => ({
      marker: index + 1,
      passage: passage?.id,
      quote,
    }));
    return {
      calls: [
        { tool: "cite", input: { citations } },
        { tool: "add_to_mind", input: { content: seed.content } },
      ],
    };
  });
}

async function ask(core: Core, text: string, mindId: string, folderId: string) {
  const result = await core.askInConversation({
    text,
    mindId,
    scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
  });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await new Promise<void>((resolve) => {
    // A reply that never ends would hold the run: past this, it is counted as it stands.
    const limit = setTimeout(done, ASK_LIMIT_MS);
    const stops = [
      core.on("answer.finished", ({ answerId }) => answerId === result.answerId && done()),
      core.on("answer.failed", ({ answerId }) => answerId === result.answerId && done()),
    ];
    function done() {
      clearTimeout(limit);
      for (const stop of stops) stop();
      resolve();
    }
  });
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

interface NoteSentence {
  text: string;
  cited: boolean;
  marked: boolean;
}

/** The Note's sentences once its changes are accepted, each with whether it cites or carries a check's mark. */
function sentencesOf(doc: ProseMirrorNode): { text: string; sentences: NoteSentence[] } {
  const sentences: NoteSentence[] = [];
  const lines: string[] = [];
  doc.descendants((block) => {
    if (!block.isTextblock) return true;
    if (block.type.name === "heading") {
      lines.push(block.textContent);
      return false;
    }
    let text = "";
    const marked: boolean[] = [];
    const cited: boolean[] = [];
    block.forEach((child) => {
      const piece = child.isText ? (child.text ?? "") : INLINE_NODE;
      text += piece;
      for (const _ of piece) {
        marked.push(child.marks.some((mark) => mark.type.name === CLAIM_CHECK_MARK));
        cited.push(child.type.name === CITATION_NODE);
      }
    });
    lines.push(text.replaceAll(INLINE_NODE, ""));
    for (const span of sentenceSpans(text)) {
      const words = text.slice(span.from, span.to).replaceAll(INLINE_NODE, "").trim();
      if (words === "") continue;
      sentences.push({
        text: words,
        cited: cited.slice(span.from, span.to).some(Boolean),
        marked: marked.slice(span.from, span.to).some(Boolean),
      });
    }
    return false;
  });
  return { text: lines.join("\n"), sentences };
}

async function noteNow(client: MindClient) {
  await client.settled();
  await resolveChanges(client, "accept");
  return sentencesOf(readMind(client));
}

/** Words, a Chinese character counting as one, as the Note's own count counts. */
const sizeOf = (text: string) => countFor(countText(text), "words");

/**
 * The sizes a reply states, read as a person would: multiples ("twice as long", "1.5 倍",
 * "加倍"), percentages, and counts of words, characters or sentences.
 */
function statedSizes(reply: string) {
  const multiples: number[] = [];
  const counts: { count: number; of: "words" | "sentences" }[] = [];
  const english = [
    [/\b(?:twice|double[sd]?|two times)\b/gi, () => 2],
    [/\b(?:three times|triple[sd]?)\b/gi, () => 3],
    [/\bhalf again\b/gi, () => 1.5],
    [/\b(\d+(?:\.\d+)?)\s*(?:times|×|x)\b/gi, (match: RegExpMatchArray) => Number(match[1])],
    [/\b(\d+)\s*%\s*(?:longer|more)/gi, (match: RegExpMatchArray) => 1 + Number(match[1]) / 100],
  ] as const;
  const chinese = [
    [/(?:两|二)倍|加倍|翻(?:了)?(?:一)?倍|(?:增加|扩充|扩写|加长)(?:了)?一倍/g, () => 2],
    [/(\d+(?:\.\d+)?)\s*倍/g, (match: RegExpMatchArray) => Number(match[1])],
    [/(?:三)倍/g, () => 3],
    [
      /(?:增加|加长|扩充|多)(?:了)?(?:约|大约|近)?(\d+)\s*%/g,
      (match: RegExpMatchArray) => 1 + Number(match[1]) / 100,
    ],
  ] as const;
  for (const [pattern, value] of [...english, ...chinese]) {
    for (const match of reply.matchAll(pattern)) multiples.push(value(match));
  }
  for (const match of reply.matchAll(/(\d[\d,]*)\s*(?:words|characters|个?字(?!段))/gi)) {
    counts.push({ count: Number((match[1] ?? "").replace(/,/g, "")), of: "words" });
  }
  for (const match of reply.matchAll(
    /(\d+|one|two|three|four|five|six)\s+(?:new\s+|more\s+)?sentences|(\d+)\s*(?:个)?句/gi,
  )) {
    const said = (match[1] ?? match[2] ?? "").toLowerCase();
    const named = ["one", "two", "three", "four", "five", "six"].indexOf(said);
    counts.push({ count: named >= 0 ? named + 1 : Number(said), of: "sentences" });
  }
  return { multiples, counts };
}

describe.each(LIVE)("Longer, at the length asked, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: "longer" grows the assistant's summary in place by about what was asked, every added sentence cited or marked, the reply's sizes measured`,
    { timeout: 3_600_000 },
    async () => {
      const limit = Number(process.env.INCARNAMIND_LIVE_LIMIT ?? 99);
      const report: string[] = [
        `## ${live.name} · ${live.model} (#1385, longer at the length asked)`,
      ];
      const totals: string[] = [];
      let spent = 0;
      const failures: string[] = [];
      for (const each of LANGUAGES) {
        for (const kind of ["a bit", "twice"] as const) {
          const requests = each.requests[kind].slice(0, limit);
          let within = 0;
          let covered = 0;
          let truthful = 0;
          let inPlace = 0;
          let ran = 0;
          for (const request of requests) {
            let seeding = true;
            const seeded = seedModel(each.seed);
            const core = startCore(await createTempDataFolder(), {
              createChatModel: (spec) => (seeding ? seeded : createAiSdkChatModel(spec)),
            });
            try {
              core.on(
                "consent.requested",
                (asked) => void core.respondToConsent(asked.requestId, true),
              );
              const questions: string[] = [];
              // The User reading the question passes it by, as one who asked for no choice would.
              core.on("question.asked", (asked) => {
                questions.push(asked.question.question);
                void core.answerUserQuestion(asked.requestId, { skipped: true });
              });
              await core.saveChatProvider({
                kind: live.kind,
                ...(live.apiKey && { apiKey: live.apiKey }),
                modelId: live.model,
              });
              const sources = await createSourceFolder();
              const folder = await core.createLibraryGroup({
                name: each.language,
                description: "",
              });
              const added = await core.addDocuments(
                [await writeSourceFile(sources, each.file, each.contents)],
                { groupId: folder.id },
              );
              await waitForProcessing(
                core,
                added.documents.map((document) => document.id),
              );
              const mind = await core.createMind({ title: each.language, folderId: folder.id });
              const client = await connectToMind(core, mind.id);
              await client.settled();
              const first = await ask(core, each.first, mind.id, folder.id);
              seeding = false;
              const before = await noteNow(client);
              const second = await ask(core, request, mind.id, folder.id);
              const after = await noteNow(client);
              ran++;
              const cjk = mostlyCjk(countText(before.text));
              const was = sizeOf(before.text);
              const now = sizeOf(after.text);
              const times = was === 0 ? 0 : now / was;
              const old = new Set(
                before.sentences.map((sentence) => comparableSentence(sentence.text)),
              );
              const addedSentences = after.sentences.filter(
                (sentence) => !old.has(comparableSentence(sentence.text)) && isClaim(sentence.text),
              );
              const bare = addedSentences.filter((sentence) => !sentence.cited && !sentence.marked);
              const stated = statedSizes(second.text);
              const falseMultiples = stated.multiples.filter(
                (multiple) => Math.abs(multiple - times) / Math.max(times, 0.01) > 0.2,
              );
              const falseCounts = stated.counts.filter(({ count, of }) =>
                of === "words"
                  ? Math.abs(count - now) / Math.max(now, 1) > 0.15 &&
                    Math.abs(count - was) / Math.max(was, 1) > 0.15 &&
                    Math.abs(count - (now - was)) / Math.max(now - was, 1) > 0.15
                  : Math.abs(count - addedSentences.length) > 1,
              );
              const salaries = after.text.match(each.salary)?.length ?? 0;
              const isWithin = WITHIN[kind](times);
              const isCovered = bare.length === 0 && addedSentences.length > 0;
              const isTruthful = falseMultiples.length === 0 && falseCounts.length === 0;
              const isInPlace = salaries <= 1 && now > 0;
              if (isWithin) within++;
              if (isCovered) covered++;
              if (isTruthful) truthful++;
              if (isInPlace) inPlace++;
              const tools = second.toolCalls
                .map((call) => {
                  const how = [
                    "content" in call.input ? "content" : "",
                    "instruction" in call.input ? "instruction" : "",
                    call.input.times_as_long !== undefined
                      ? `×${String(call.input.times_as_long)}`
                      : "",
                  ].filter(Boolean);
                  return `${call.tool}${how.length > 0 ? `[${how.join(" ")}]` : ""}${call.mindProblem ? `!${call.mindProblem.kind}` : ""}`;
                })
                .join(", ");
              const lines = [
                `- ${each.language} · ${kind} · “${request}”: first ${first.status}, then ${second.status} (${tools || "no tools"}); ${was} → ${now} ${cjk ? "characters" : "words"} = ${times.toFixed(2)}×${isWithin ? "" : " OUT OF BOUND"}; added ${addedSentences.length} sentences, ${bare.length} with no Citation and no mark${isCovered ? "" : " UNCOVERED"}; reply states ${JSON.stringify(stated)}${isTruthful ? "" : " FALSE"}; salary ${salaries}×${isInPlace ? "" : " TWO SUMMARIES"}`,
                `  reply: ${second.text.replace(/\n/g, " ⏎ ").slice(0, 600)}`,
                ...bare.map((sentence) => `  bare: ${sentence.text.slice(0, 200)}`),
                ...questions.map((question) => `  asked the User: ${question}`),
                `  note: ${after.text.replace(/\n/g, " ⏎ ").slice(0, 1200)}`,
              ];
              report.push(...lines);
              if (process.env.INCARNAMIND_LIVE_REPORT) {
                await appendFile(
                  `${process.env.INCARNAMIND_LIVE_REPORT}.runs`,
                  `${lines.join("\n")}\n`,
                );
              }
              if (!isWithin || !isCovered || !isTruthful || !isInPlace) {
                failures.push(`${each.language} · ${kind} · “${request}”`);
              }
            } finally {
              const cost = await core.getCostSummary();
              spent += cost.spent
                .filter((money) => money.currency === "USD")
                .reduce((sum, money) => sum + money.amount, 0);
              core.close();
            }
          }
          totals.push(
            `  ${each.language} · ${kind}: within ${within}/${ran}, every added sentence cited or marked ${covered}/${ran}, sizes stated truly ${truthful}/${ran}, one summary ${inPlace}/${ran}`,
          );
        }
      }
      report.push(...totals, `  spent: $${spent.toFixed(4)}`);
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      expect(failures).toEqual([]);
    },
  );
});
