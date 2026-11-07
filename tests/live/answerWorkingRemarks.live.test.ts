/**
 * The model's working remarks in Answers (#2371), on a real model: the held-out document
 * Questions in ../helpers/workingRemarkHeldOut and the held-out workbook Questions in
 * ../helpers/rentalHeldOut, each asked in a conversation of its own, in English and Chinese.
 * Every Answer is recorded with the model's own text for it, so a paragraph the Answer doesn't
 * show can be read for whether it was working or the User's Answer, and with the requests and
 * tokens it cost. Runs only when INCARNAMIND_LIVE_ANTHROPIC_KEY is set
 * (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default); INCARNAMIND_LIVE_REPORT keeps the run.
 */
import { appendFile } from "node:fs/promises";
import { expect, test } from "vitest";
import type { ChatModelFactory, ChatModelSpec, ConversationAnswer, Core } from "../../src/core";
import { answerInstructions } from "../../src/core/answers/prompt";
import { judgeWorkingText, WORKING_TEXT_INSTRUCTIONS } from "../../src/core/answers/workingText";
import { costOf } from "../../src/core/cost/price";
import { fromData } from "../../src/core/promptData";
import { catalogModel } from "../../src/core/providers/catalog";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { RENTAL_HELD_OUT, rentalPropertyWorkbook } from "../helpers/rentalHeldOut";
import { DOCUMENT_HELD_OUT, WORKING_REMARK_DOCUMENTS } from "../helpers/workingRemarkHeldOut";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;

/**
 * The model's own working remarks read in Answers before the fix. The engine knows none of them
 * and matches no phrase; the judgement decides each part. A part carrying one of these must not
 * reach an Answer.
 */
const WORKING_REMARKS: readonly string[] = ["Citations need to be recorded now."];

/** Text a model wrote after its Answer, just before `cite`: what the judge must say of each part. */
const JUDGE_PROBES: readonly {
  question: string;
  answer: string;
  texts: readonly string[];
  parts: readonly ("answer" | "working")[];
}[] = [
  {
    question: "When do spring tides happen?",
    answer: "Spring tides come at new and full moon [^1].",
    texts: ["Citations need to be recorded now."],
    parts: ["working"],
  },
  {
    question: "How long does the lease run?",
    answer: "The lease runs for six years from 1 April 2027 [^1].",
    texts: ["This document doesn't say how notice must be served."],
    parts: ["answer"],
  },
  {
    question: "What moves the Year 3 cash flow?",
    answer: "The Year 3 cash flow after debt service is 26,400 [=1].",
    texts: ["The other assumptions, such as the mortgage rate, do not affect this figure."],
    parts: ["answer"],
  },
  {
    question: "租期多长，从什么时候开始？",
    answer: "Harbour View 第 7 单元的租期为六年，从 2027 年 4 月 1 日开始[^1]。",
    texts: ["这里的起始日期和期限来自租约正文。"],
    parts: ["answer"],
  },
  {
    question: "Suppose we got the seller down to 1,000,000. Where would the equity multiple land?",
    answer: "At a 1,000,000 purchase price, the equity multiple would be about 2.2x [=1].",
    texts: ["I changed only the purchase price input and left the other assumptions as they are."],
    parts: ["answer"],
  },
  {
    question: "Can you break down what moves the Year 2 cash flow after debt service?",
    answer: "Year 2 cash flow after debt service is 27,332.7 [=1].",
    texts: [
      "This suggests that because debt service is fixed, the cash flow changes by more than the change in net operating income.",
    ],
    parts: ["answer"],
  },
  {
    question: "合同有效期多长，从什么时候开始？",
    answer: "合同有效期为三年，从 2026 年 9 月 1 日起算[^1]。",
    texts: ["现在需要记录引用。"],
    parts: ["working"],
  },
  {
    question: "第5年年底的贷款余额是怎么算出来的？",
    answer:
      "第 5 年年底的贷款余额是 481,354.4[^1]。它不是一次算出来的，而是每年滚动计算：年初余额减去当年本金，得到年末余额。",
    texts: ["这意味着，第 5 年年底的余额是前几年本金逐年偿还后剩下的结果。"],
    parts: ["answer"],
  },
  {
    question: "这份摘要怎么说付款？",
    answer: "货款按季度结算，每季度末支付 120 万元人民币[^1]。",
    texts: ["这一信息来自《供应商合同摘要》。"],
    parts: ["answer"],
  },
  {
    question: "How long is the lease?",
    answer: "The lease runs for six years from 1 April 2027 [^1].",
    texts: ["Let me file the citations for those claims."],
    parts: ["working"],
  },
  {
    question: "货款怎么结算？",
    answer: "货款按季度结算，每季度末支付 120 万元人民币[^1]。",
    texts: ["我先记录引用。"],
    parts: ["working"],
  },
  {
    question: "What does the lease say?",
    answer: "The lease runs for six years [^1].",
    texts: ["The notice must be nine months.", "Citations need to be recorded now."],
    parts: ["answer", "working"],
  },
  {
    question: "净售房所得主要受哪些假设影响？",
    answer: "净售房所得受购买价、升值率和首付比例影响。",
    texts: [
      "这意味着，购买价、升值率和首付比例对净售房所得的影响可能最大，因为它们同时影响售价和贷款余额。我没有计算每个假设变动一个单位时的具体影响，如需了解，可以逐一测算。",
    ],
    parts: ["answer"],
  },
];

type Usage = {
  inputTokens?: { total?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens?: { total?: number };
};

interface Billed {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

const billedOf = (usage: Usage | undefined): Billed => ({
  input: usage?.inputTokens?.total ?? 0,
  cacheRead: usage?.inputTokens?.cacheRead ?? 0,
  cacheWrite: usage?.inputTokens?.cacheWrite ?? 0,
  output: usage?.outputTokens?.total ?? 0,
});

interface Request {
  /** The text the model wrote in this request, reasoning left out. */
  text: string;
  /** Its text blocks, as the provider streamed them, in order. */
  blocks: { id: string; text: string }[];
  /** The Tools it called. */
  tools: string[];
  /** What it was sent, as JSON: the judgement's parts are read back from it. */
  prompt: string;
  /** The request's system prompt: the Answer's own calls write its text, the checks' don't. */
  system: string;
  billed: Billed;
}

/** A request the Answer itself wrote text for: not a check's, a sort's or a Citation retry's. */
const writesAnswer = (each: Request) => each.system.startsWith(answerInstructions().slice(0, 40));

const requests: Request[] = [];
/** The spec the Answers' model was made from, for the judge probe after them. */
let answerSpec: ChatModelSpec | undefined;
const counting: ChatModelFactory = (spec) => {
  answerSpec ??= spec;
  const model = createAiSdkChatModel(spec);
  const systemOf = (options: unknown): string => {
    const prompt = (options as { prompt?: { role: string; content: unknown }[] }).prompt ?? [];
    const system = prompt.find((message) => message.role === "system");
    if (!system) return "";
    return typeof system.content === "string"
      ? system.content
      : (system.content as { type: string; text?: string }[])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("");
  };
  const promptOf = (options: unknown): string =>
    JSON.stringify((options as { prompt?: unknown }).prompt ?? "");
  return new Proxy(model, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "doGenerate" && typeof value === "function")
        return async (...args: unknown[]) => {
          const result = (await value.apply(target, args)) as {
            content: { type: string; text?: string; toolName?: string }[];
            usage?: Usage;
          };
          const text = result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("");
          requests.push({
            text,
            blocks: text === "" ? [] : [{ id: "generate", text }],
            tools: result.content.flatMap((part) =>
              part.type === "tool-call" && part.toolName ? [part.toolName] : [],
            ),
            prompt: promptOf(args[0]),
            system: systemOf(args[0]),
            billed: billedOf(result.usage),
          });
          return result;
        };
      if (property === "doStream" && typeof value === "function")
        return async (...args: unknown[]) => {
          const result = (await value.apply(target, args)) as {
            stream: ReadableStream<{
              type: string;
              id?: string;
              delta?: string;
              toolName?: string;
              usage?: Usage;
            }>;
          };
          const entry: Request = {
            text: "",
            blocks: [],
            tools: [],
            prompt: promptOf(args[0]),
            system: systemOf(args[0]),
            billed: billedOf(undefined),
          };
          requests.push(entry);
          const [given, read] = result.stream.tee();
          void (async () => {
            const reader = read.getReader();
            for (let part = await reader.read(); !part.done; part = await reader.read()) {
              if (part.value.type === "finish")
                Object.assign(entry.billed, billedOf(part.value.usage));
              if (part.value.type === "tool-call" && part.value.toolName)
                entry.tools.push(part.value.toolName);
              if (part.value.type === "text-start")
                entry.blocks.push({ id: part.value.id ?? "", text: "" });
              if (part.value.type !== "text-delta") continue;
              entry.text += part.value.delta ?? "";
              const block = entry.blocks.findLast((each) => each.id === (part.value.id ?? ""));
              if (block) block.text += part.value.delta ?? "";
              else entry.blocks.push({ id: part.value.id ?? "", text: part.value.delta ?? "" });
            }
          })();
          return { ...result, stream: given };
        };
      return value;
    },
  });
};

const PRICE = catalogModel("anthropic", MODEL)?.price;
const priced = (each: Billed): number =>
  PRICE
    ? costOf(
        {
          inputTokens: each.input,
          cachedInputTokens: each.cacheRead,
          cacheWriteTokens: each.cacheWrite,
          outputTokens: each.output,
        },
        PRICE,
        new Date(),
        { cacheWrites: true },
      )
    : Number.NaN;

const tokensLine = (list: readonly Request[]): string => {
  if (list.length === 0) return "0 requests";
  const billed = list.map((each) => each.billed);
  const sum = (key: keyof Billed) => billed.reduce((total, each) => total + each[key], 0);
  const uncached = sum("input") - sum("cacheRead") - sum("cacheWrite");
  const cost = billed.reduce((total, each) => total + priced(each), 0);
  return `${list.length} requests; uncached input ${uncached}, cache reads ${sum("cacheRead")}, cache writes ${sum("cacheWrite")}, output ${sum("output")}; $${cost.toFixed(4)}`;
};

/**
 * What two stretches of Answer text are compared as: the engine renumbers markers, places missing
 * ones and may tidy quotation marks, so markers, quotes, punctuation and spacing are left out.
 */
const comparable = (text: string) =>
  text.replace(/\[[\^=][^\]]*\]/g, "").replace(/[\s,，。.;；:：!?！？"'“”‘’「」『』()（）]/g, "");

/**
 * The paragraphs of the model's own text that an Answer doesn't show, by the Answer call that
 * wrote each: a preamble, a draft written again, or text the engine took back.
 */
const droppedFrom = (
  calls: readonly Request[],
  shown: string,
): { call: number; block: number; tools: string; paragraph: string }[] => {
  const present = comparable(shown);
  return calls.flatMap((request, index) =>
    request.blocks.flatMap((block, at) =>
      block.text
        .split(/\r?\n[ \t]*\r?\n+/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph !== "" && !present.includes(comparable(paragraph)))
        .map((paragraph) => ({
          call: index + 1,
          block: at + 1,
          tools: request.tools.join(", ") || "none",
          paragraph,
        })),
    ),
  );
};

interface Answered {
  answer: ConversationAnswer;
  /** What the Answer's own model calls wrote, and what they cost. */
  made: readonly Request[];
}

async function ask(core: Core, text: string): Promise<Answered> {
  const before = requests.length;
  const result = await core.askInConversation({ text });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await new Promise<void>((resolve) => {
    const stops = [
      core.on("answer.finished", (finished) => {
        if (finished.answerId === result.answerId) done();
      }),
      core.on("answer.failed", ({ answerId }) => answerId === result.answerId && done()),
    ];
    function done() {
      for (const stop of stops) stop();
      resolve();
    }
  });
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return { answer, made: requests.slice(before) };
}

test.skipIf(KEY === undefined)(
  "an Answer on held-out document and workbook Questions shows no working remark and loses no Answer text",
  { timeout: 1_800_000 },
  async () => {
    const core = startCore(await createTempDataFolder(), { createChatModel: counting });
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
    const folder = await createTempDataFolder();
    const paths = await Promise.all(
      [
        ...WORKING_REMARK_DOCUMENTS.map((document) => ({
          name: document.name,
          contents: document.contents,
        })),
        { name: "Rental property.xlsx", contents: new Uint8Array(rentalPropertyWorkbook().xlsx()) },
      ].map((file) => writeSourceFile(folder, file.name, file.contents)),
    );
    await addAndProcess(core, paths);

    const asked: { question: string; says?: string; answered: Answered }[] = [];
    for (const each of DOCUMENT_HELD_OUT) {
      asked.push({ ...each, answered: await ask(core, each.question) });
    }
    for (const each of RENTAL_HELD_OUT) {
      asked.push({ question: each.question, answered: await ask(core, each.question) });
    }

    const report = [`## Answers' working remarks, held out · ${MODEL}`];
    const failed: string[] = [];
    const unanswered: string[] = [];
    const lost: string[] = [];
    // What a word or a figure is compared as: "six" and "6", "九" and "9", spacing and commas may differ.
    const DIGITS: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
      零: 0,
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
    };
    const plain = (text: string) =>
      text
        .replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (word) =>
          String(DIGITS[word.toLowerCase()] ?? word),
        )
        .replace(/[零一二两三四五六七八九]/g, (digit) => String(DIGITS[digit] ?? digit))
        .replace(/[\s,]/g, "");
    // A footnote definition is stripped from every Answer (withoutFootnoteDefinitions), so its loss isn't the Answer's.
    const footnote = (text: string) => /^ {0,3}\[\^\d{1,4}\]:/.test(text);
    // A Tool's tag written where its call belongs is not Answer text either (takeToolText).
    const toolText = (text: string) =>
      /^<\/?(?:cite|calculate|search_documents|tool_call|tool_calls|tool_use|function_call|function_calls|invoke)\b/i.test(
        text.trim(),
      );
    const all: Request[] = [];
    for (const { question, says, answered } of asked) {
      const { answer, made } = answered;
      all.push(...made);
      const working = WORKING_REMARKS.filter((remark) =>
        plain(answer.text).includes(plain(remark)),
      );
      const saysIt = says === undefined || plain(answer.text).includes(plain(says));
      if (answer.status !== "done" || working.length > 0) failed.push(question);
      else if (!saysIt) unanswered.push(question);
      const written = made.filter(writesAnswer);
      const judged = made.filter((each) => each.system === WORKING_TEXT_INSTRUCTIONS);
      // The parts the judgement called the model's working: text the Answer is meant not to show.
      const judgedWorking = judged.flatMap((each) => {
        let parts: unknown;
        let prompt: string;
        try {
          parts = (JSON.parse(each.text) as { parts?: unknown }).parts;
          const sent = JSON.parse(each.prompt) as { role: string; content: unknown }[];
          prompt = sent
            .flatMap((message) =>
              typeof message.content === "string"
                ? [message.content]
                : (message.content as { type: string; text?: string }[])
                    .filter((part) => part.type === "text")
                    .map((part) => part.text ?? ""),
            )
            .join("\n");
        } catch {
          return [];
        }
        const segments = [...prompt.matchAll(/<reply id="\d+">\n([\s\S]*?)\n<\/reply>/g)].map(
          (match) => fromData(match[1] ?? ""),
        );
        return Array.isArray(parts)
          ? segments.filter((_, index) => parts[index] === "working")
          : [];
      });
      // Every paragraph of the Answer's own last call that isn't the judgement's working, or a
      // footnote, must be in the Answer: otherwise the User's text was lost.
      const lastCall = written.length;
      const drops = droppedFrom(written, answer.text).filter(
        ({ call, paragraph }) =>
          call === lastCall &&
          !footnote(paragraph) &&
          !toolText(paragraph) &&
          !judgedWorking.some(
            (part) =>
              comparable(paragraph).includes(comparable(part)) ||
              comparable(part).includes(comparable(paragraph)),
          ),
      );
      lost.push(...drops.map(({ paragraph }) => `${question}: ${paragraph}`));
      report.push(
        `### ${question}`,
        `${answer.status}${saysIt ? "" : " (doesn't say the answer)"}; Citations ${answer.citations.length}; ${tokensLine(made)}`,
        `Tools: ${answer.toolCalls.map((call) => call.tool).join("; ") || "none"}`,
        `Wrote: ${written.map((each, index) => `call ${index + 1} ${each.blocks.length} block(s)${each.tools.length > 0 ? ` with ${each.tools.join("+")}` : ""}`).join("; ") || "nothing"}`,
        ...(judgedWorking.length > 0
          ? [
              `Judged working: ${judgedWorking.map((part) => part.replace(/\s+/g, " ")).join(" / ")}`,
            ]
          : []),
        `> ${answer.text.replace(/\s+/g, " ")}`,
        ...(working.length > 0 ? [`Working remark in the Answer: ${working.join(" / ")}`] : []),
        ...drops.map(
          ({ call, block, tools, paragraph }) =>
            `- lost (call ${call}, block ${block}, tools: ${tools}): ${paragraph}`,
        ),
        ...droppedFrom(written, answer.text)
          .filter(
            ({ call, paragraph }) =>
              call === lastCall && !drops.some((drop) => drop.paragraph === paragraph),
          )
          .map(
            ({ call, block, tools, paragraph }) =>
              `- not shown (call ${call}, block ${block}, tools: ${tools}): ${paragraph}`,
          ),
        "",
      );
    }
    const probeBefore = requests.length;
    const probeModel = answerSpec
      ? counting({
          ...answerSpec,
          modelId: catalogProvider("anthropic")?.roles.quickTasks ?? "claude-haiku-5-5",
          thinking: "off",
        })
      : null;
    const probe = new AbortController();
    const judgedProbes: (("answer" | "working")[] | null)[] = [];
    for (const each of JUDGE_PROBES) {
      judgedProbes.push(
        probeModel
          ? await judgeWorkingText(
              probeModel,
              undefined,
              probe.signal,
              each.question,
              each.answer,
              each.texts,
            )
          : null,
      );
    }
    const expected = JUDGE_PROBES.map((each) => each.parts);
    report.push(
      `Judge probes: ${JSON.stringify(judgedProbes)} (expected ${JSON.stringify(expected)}); ${tokensLine(requests.slice(probeBefore))}`,
      `Lost from the Answer's own last call: ${lost.length}`,
    );
    report.push(
      `${asked.length - failed.length} of ${asked.length} done and with no working remark.`,
      `All: ${tokensLine(all)}`,
    );
    if (REPORT) await appendFile(REPORT, `${report.join("\n")}\n\n`);
    console.log(report.at(-4));
    console.log(report.at(-3));
    console.log(report.at(-2));
    console.log(report.at(-1));
    expect(judgedProbes).toEqual(expected);
    for (const miss of lost) console.log(`lost: ${miss}`);
    expect(lost).toEqual([]);
    for (const miss of failed) console.log(`failed: ${miss}`);
    for (const miss of unanswered) console.log(`didn't say the answer: ${miss}`);
    expect(failed).toEqual([]);
    expect(unanswered).toEqual([]);
  },
);
