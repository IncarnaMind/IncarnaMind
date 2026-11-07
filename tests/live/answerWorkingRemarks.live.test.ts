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
 * The model's own working remarks read in Answers before the fix, and what the judge must say of
 * each: the engine doesn't know these, and no phrase is matched. The two caveats must stay.
 */
const WORKING_REMARKS: readonly string[] = ["Citations need to be recorded now."];

/** Text a model wrote after its Answer, just before `cite`: what the judge must call it. */
const JUDGE_PROBES: readonly {
  question: string;
  answer: string;
  text: string;
  part: "answer" | "working";
}[] = [
  {
    question: "When do spring tides happen?",
    answer: "Spring tides come at new and full moon [^1].",
    text: "Citations need to be recorded now.",
    part: "working",
  },
  {
    question: "How long does the lease run?",
    answer: "The lease runs for six years from 1 April 2027 [^1].",
    text: "This document doesn't say how notice must be served.",
    part: "answer",
  },
  {
    question: "What moves the Year 3 cash flow?",
    answer: "The Year 3 cash flow after debt service is 26,400 [=1].",
    text: "The other assumptions, such as the mortgage rate, do not affect this figure.",
    part: "answer",
  },
  {
    question: "租期多长，从什么时候开始？",
    answer: "Harbour View 第 7 单元的租期为六年，从 2027 年 4 月 1 日开始[^1]。",
    text: "这里的起始日期和期限来自租约正文。",
    part: "answer",
  },
  {
    question: "Suppose we got the seller down to 1,000,000. Where would the equity multiple land?",
    answer: "At a 1,000,000 purchase price, the equity multiple would be about 2.2x [=1].",
    text: "I changed only the purchase price input and left the other assumptions as they are.",
    part: "answer",
  },
  {
    question: "Can you break down what moves the Year 2 cash flow after debt service?",
    answer: "Year 2 cash flow after debt service is 27,332.7 [=1].",
    text: "This suggests that because debt service is fixed, the cash flow changes by more than the change in net operating income.",
    part: "answer",
  },
  {
    question: "合同有效期多长，从什么时候开始？",
    answer: "合同有效期为三年，从 2026 年 9 月 1 日起算[^1]。",
    text: "现在需要记录引用。",
    part: "working",
  },
  {
    question: "第5年年底的贷款余额是怎么算出来的？",
    answer:
      "第 5 年年底的贷款余额是 481,354.4[^1]。它不是一次算出来的，而是每年滚动计算：年初余额减去当年本金，得到年末余额。",
    text: "这意味着，第 5 年年底的余额是前几年本金逐年偿还后剩下的结果。",
    part: "answer",
  },
  {
    question: "这份摘要怎么说付款？",
    answer: "货款按季度结算，每季度末支付 120 万元人民币[^1]。",
    text: "这一信息来自《供应商合同摘要》。",
    part: "answer",
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
 * The paragraphs of the model's own text that an Answer doesn't show, by the Answer call that
 * wrote each: a preamble, a draft written again, or text the engine took back.
 */
const droppedFrom = (
  calls: readonly Request[],
  shown: string,
): { call: number; block: number; tools: string; paragraph: string }[] => {
  // The Answer may renumber a marker, so markers are compared as nothing at all.
  const plain = (text: string) =>
    text
      .replace(/\[[\^=][^\]]*\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const present = plain(shown);
  return calls.flatMap((request, index) =>
    request.blocks.flatMap((block, at) =>
      block.text
        .split(/\r?\n[ \t]*\r?\n+/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph !== "" && !present.includes(plain(paragraph)))
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
    // What a word or a figure is compared as: spacing and commas may differ in the Answer.
    const plain = (text: string) => text.replace(/[\s,]/g, "");
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
      report.push(
        `### ${question}`,
        `${answer.status}${saysIt ? "" : " (doesn't say the answer)"}; Citations ${answer.citations.length}; ${tokensLine(made)}`,
        `Tools: ${answer.toolCalls.map((call) => call.tool).join("; ") || "none"}`,
        `Wrote: ${written.map((each, index) => `call ${index + 1} ${each.blocks.length} block(s)${each.tools.length > 0 ? ` with ${each.tools.join("+")}` : ""}`).join("; ") || "nothing"}`,
        ...(judged.length > 0
          ? [`Judged: ${judged.map((each) => each.text.replace(/\s+/g, " ")).join(" / ")}`]
          : []),
        `> ${answer.text.replace(/\s+/g, " ")}`,
        ...(working.length > 0 ? [`Working remark in the Answer: ${working.join(" / ")}`] : []),
        ...droppedFrom(written, answer.text).map(
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
    const judgedProbes: ("answer" | "working" | null)[] = [];
    for (const each of JUDGE_PROBES) {
      judgedProbes.push(
        probeModel
          ? await judgeWorkingText(
              probeModel,
              undefined,
              probe.signal,
              each.question,
              each.answer,
              each.text,
            )
          : null,
      );
    }
    const expected = JUDGE_PROBES.map((each) => each.part);
    report.push(
      `Judge probes: ${judgedProbes.join(", ")} (expected ${expected.join(", ")}); ${tokensLine(requests.slice(probeBefore))}`,
    );
    report.push(
      `${asked.length - failed.length} of ${asked.length} done and with no working remark.`,
      `All: ${tokensLine(all)}`,
    );
    if (REPORT) await appendFile(REPORT, `${report.join("\n")}\n\n`);
    console.log(report.at(-3));
    console.log(report.at(-2));
    console.log(report.at(-1));
    expect(judgedProbes).toEqual(expected);
    for (const miss of failed) console.log(`failed: ${miss}`);
    for (const miss of unanswered) console.log(`didn't say the answer: ${miss}`);
    expect(failed).toEqual([]);
    expect(unanswered).toEqual([]);
  },
);
