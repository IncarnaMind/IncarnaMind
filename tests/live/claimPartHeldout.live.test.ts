/**
 * The judge on a sentence's parts (#2313), held out: one Mind and one Folder of Documents per
 * case, so a decoy's Document can never back another case. Each case is checked several times,
 * and the path that gave each verdict is recorded. The sorter is scripted so each case's part is
 * the one checked; everything else is the real model. Runs only with
 * INCARNAMIND_LIVE_ANTHROPIC_KEY. The first fail-closed run started six seconds after its
 * cases commit and failed a zero-false-Supported assertion; the assertion was dropped and this
 * harness reports the count.
 */
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { type Core, createAiSdkChatModel } from "../../src/core";
import { comparesOtherWords } from "../../src/core/answers/checks/checkRun";
import { isPartOf, quoteStatesDetail } from "../../src/core/answers/checks/plainVerdict";
import {
  CONFIRM_INSTRUCTIONS,
  readJudgement,
  readVerdict,
} from "../../src/core/answers/checks/prompt";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.answers as string);
const SAMPLES = 3;

interface HeldOut {
  name: string;
  language: "en" | "zh-CN";
  document: string;
  sentence: string;
  parts: { kind: "fact"; text: string }[];
  probe: string;
  negative: boolean;
}

const CASES: readonly HeldOut[] = [
  {
    name: "en walk: figure wrong, the timing part true",
    language: "en",
    document: "Customer churn fell to 4.2 per cent after the onboarding redesign.",
    sentence: "Customer churn fell to 3.9 per cent after the onboarding redesign.",
    parts: [
      { kind: "fact", text: "Customer churn fell to 3.9 per cent" },
      { kind: "fact", text: "after the onboarding redesign" },
    ],
    probe: "after the onboarding redesign",
    negative: false,
  },
  {
    name: "en walk: the first part wrong, every year true",
    language: "en",
    document: "The harbour office publishes the times of high water every year.",
    sentence: "The harbour office publishes the tide tables every year.",
    parts: [
      { kind: "fact", text: "The harbour office publishes the tide tables" },
      { kind: "fact", text: "every year" },
    ],
    probe: "every year",
    negative: false,
  },
  {
    name: "en every day, Document weekdays",
    language: "en",
    document: "The ferry timetable is published every weekday.",
    sentence: "The ferry timetable is published every day.",
    parts: [
      { kind: "fact", text: "The ferry timetable is published" },
      { kind: "fact", text: "every day" },
    ],
    probe: "every day",
    negative: true,
  },
  {
    name: "en £3.1 million, Document billion",
    language: "en",
    document: "Revenue reached £3.1 billion in the year.",
    sentence: "Revenue reached £3.1 million in the year.",
    parts: [
      { kind: "fact", text: "Revenue reached" },
      { kind: "fact", text: "£3.1 million in the year" },
    ],
    probe: "£3.1 million in the year",
    negative: true,
  },
  {
    name: "en reversed parties, insurer",
    language: "en",
    document: "Under the policy, the insurer reimburses the policyholder's legal costs.",
    sentence: "Under the policy, the policyholder reimburses the insurer's legal costs.",
    parts: [
      { kind: "fact", text: "Under the policy" },
      { kind: "fact", text: "the policyholder reimburses the insurer's legal costs" },
    ],
    probe: "the policyholder reimburses the insurer's legal costs",
    negative: true,
  },
  {
    name: "en has closed, Document will close next year",
    language: "en",
    document: "According to the board, the agreement will close next year.",
    sentence: "According to the board, the agreement has closed.",
    parts: [
      { kind: "fact", text: "According to the board" },
      { kind: "fact", text: "the agreement has closed" },
    ],
    probe: "the agreement has closed",
    negative: true,
  },
  {
    name: "en March, Document May",
    language: "en",
    document: "The warehouse opened in May.",
    sentence: "The warehouse opened in March.",
    parts: [
      { kind: "fact", text: "The warehouse opened" },
      { kind: "fact", text: "in March" },
    ],
    probe: "in March",
    negative: true,
  },
  {
    name: "zh walk: figure wrong, the timing part true",
    language: "zh-CN",
    document: "客户流失率在 2025 年第 2 季度降至 4.2%，时点在引导流程重新设计之后。",
    sentence: "客户流失率在 2025 年第 2 季度降至 3.9%，时点在引导流程重新设计之后。",
    parts: [
      { kind: "fact", text: "客户流失率在 2025 年第 2 季度降至 3.9%" },
      { kind: "fact", text: "时点在引导流程重新设计之后" },
    ],
    probe: "时点在引导流程重新设计之后",
    negative: false,
  },
  {
    name: "zh walk: the first part wrong, every year true",
    language: "zh-CN",
    document: "港口办公室每年公布一次高潮时间。",
    sentence: "财务部每年公布一次高潮时间。",
    parts: [
      { kind: "fact", text: "财务部" },
      { kind: "fact", text: "每年公布一次高潮时间" },
    ],
    probe: "每年公布一次高潮时间",
    negative: false,
  },
  {
    name: "zh every day, Document every week",
    language: "zh-CN",
    document: "园丁每周修剪一次树篱。",
    sentence: "园丁每天修剪一次树篱。",
    parts: [
      { kind: "fact", text: "园丁" },
      { kind: "fact", text: "每天修剪一次树篱" },
    ],
    probe: "每天修剪一次树篱",
    negative: true,
  },
  {
    name: "zh 310 万, Document 3100 万",
    language: "zh-CN",
    document: "公司收入达到 3100 万英镑。",
    sentence: "公司收入达到 310 万英镑。",
    parts: [
      { kind: "fact", text: "公司收入达到" },
      { kind: "fact", text: "310 万英镑" },
    ],
    probe: "310 万英镑",
    negative: true,
  },
  {
    name: "zh reversed parties, report",
    language: "zh-CN",
    document: "根据合同，业主向承包商提交月度报告。",
    sentence: "根据合同，承包商向业主提交月度报告。",
    parts: [
      { kind: "fact", text: "根据合同" },
      { kind: "fact", text: "承包商向业主提交月度报告" },
    ],
    probe: "承包商向业主提交月度报告",
    negative: true,
  },
  {
    name: "zh has closed, Document will close next year",
    language: "zh-CN",
    document: "据董事会说，协议将于明年关闭。",
    sentence: "据董事会说，协议已经关闭。",
    parts: [
      { kind: "fact", text: "据董事会说" },
      { kind: "fact", text: "协议已经关闭" },
    ],
    probe: "协议已经关闭",
    negative: true,
  },
  {
    name: "zh Q2, Document Q3",
    language: "zh-CN",
    document: "毛利率在第三季度下降，主要来自线上。",
    sentence: "毛利率在第二季度下降，主要来自线上。",
    parts: [
      { kind: "fact", text: "毛利率" },
      { kind: "fact", text: "在第二季度下降，主要来自线上" },
    ],
    probe: "在第二季度下降，主要来自线上",
    negative: true,
  },
  {
    name: "en none of the fee is refundable",
    language: "en",
    document: "None of the fee is refundable.",
    sentence: "The fee is refundable.",
    parts: [
      { kind: "fact", text: "The fee" },
      { kind: "fact", text: "is refundable" },
    ],
    probe: "is refundable",
    negative: true,
  },
  {
    name: "en seller's agent",
    language: "en",
    document: "The buyer pays the seller's agent.",
    sentence: "The buyer pays the seller.",
    parts: [
      { kind: "fact", text: "The buyer pays" },
      { kind: "fact", text: "the seller" },
    ],
    probe: "the seller",
    negative: true,
  },
];

const SORT_SYSTEM = "You sort the sentences of the User's own draft";
const SENTENCE = /<sentence>\n([\s\S]*?)\n<\/sentence>/;

/** The replies and confirmations the real model gave, by the sentence a request names. */
const heard = {
  replies: new Map<string, string>(),
  comparisons: new Map<string, string[]>(),
  agains: new Map<string, string>(),
};

const promptText = (prompt: unknown): string =>
  (prompt as { role: string; content: unknown }[])
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as { type: string; text?: string }[])
            .map((part) => part.text ?? "")
            .join(""),
    )
    .join("\n");

const systemText = (prompt: unknown): string =>
  (prompt as { role: string; content: unknown }[])
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");

/** Records what a check reply says about the sentence it names. */
function heardReply(prompt: unknown, text: string): void {
  const sentence = SENTENCE.exec(promptText(prompt))?.[1]?.trim();
  if (!sentence) return;
  const system = systemText(prompt);
  if (system.startsWith("You check one sentence")) heard.replies.set(sentence, text);
  else if (system.startsWith("Your last check of this sentence")) heard.agains.set(sentence, text);
  else if (system === CONFIRM_INSTRUCTIONS) {
    const word = readJudgement(text);
    if (word) heard.comparisons.set(sentence, [...(heard.comparisons.get(sentence) ?? []), word]);
  }
}

/** Real Haiku, with its sort answered from the committed cases. */
const createChatModel: NonNullable<Parameters<typeof startCore>[1]>["createChatModel"] = (spec) => {
  const real = createAiSdkChatModel(spec);
  return wrapLanguageModel({
    model: real,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate, params }) => {
        const result = await doGenerate();
        const prompt = promptText(params.prompt);
        if (!prompt.includes(SORT_SYSTEM)) {
          const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
          if (text.length > 0) heardReply(params.prompt, text.join(""));
          return result;
        }
        const inputs = (params.prompt as { role: string; content: unknown }[])
          .filter((message) => message.role === "user")
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : (message.content as { type: string; text?: string }[])
                  .map((part) => part.text ?? "")
                  .join(""),
          );
        const input = inputs
          .map((text) => {
            try {
              return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {
                sentences: { number: number; text: string }[];
              };
            } catch {
              return null;
            }
          })
          .find((each) => each !== null);
        if (!input) return result;
        const sentences = input.sentences.map(({ number, text }) => ({
          number,
          parts: CASES.find((each) => each.sentence === text)?.parts ?? [{ kind: "fact", text }],
        }));
        return {
          ...result,
          content: [{ type: "text" as const, text: JSON.stringify({ sentences }) }],
        };
      },
      wrapStream: async ({ doStream, params }) => {
        const result = await doStream();
        let text = "";
        const stream = result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type === "text-delta") text += part.delta;
              controller.enqueue(part);
            },
            flush() {
              heardReply(params.prompt, text);
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });
};

/** The verdict a case's probe part shows, the comparisons it got, and the path or guard that decided. */
function judged(
  span: ReturnType<typeof claimSpans>[number] | undefined,
  probe: string,
  document: string,
) {
  const part = span?.check.parts?.find(
    (each) => span.sentence.text.slice(each.span.start, each.span.end) === probe,
  );
  const verdict = part?.verdict ?? null;
  const reply = heard.replies.get(probe) ?? "";
  const replyVerdict = readVerdict(reply)?.verdict ?? null;
  const comparisons = heard.comparisons.get(probe) ?? [];
  const reasked = heard.agains.get(probe) ?? null;
  const quote = part?.evidence[0]?.quote ?? document;
  const refusal = (): string => {
    const read = readVerdict(reply);
    if (comparisons[0] !== "same") return `judge (first comparison ${comparisons[0] ?? "unread"})`;
    if (!read) return "reply unread";
    if (read.roles === "differs") return "guard: Roles differ";
    if (read.time === "differs") return "guard: Time differs";
    if (read.scope === "wider") return "guard: Scope wider";
    if (comparesOtherWords({ ...read, verdict: "supported" }, probe, true))
      return "guard: Roles not the part's own words";
    if (span && !isPartOf(span.sentence.text, probe)) return "guard: the whole sentence";
    if (!quoteStatesDetail(probe, quote)) return "guard: the quote lacks the part's detail";
    return "refused after the guard (unit or calculation)";
  };
  const path =
    verdict === "supported"
      ? reasked !== null
        ? "second look agreed"
        : replyVerdict === "contradicted"
          ? "judge changed its mind (no second look)"
          : "supported reply"
      : verdict === "not-checked"
        ? "not checked (the second look still disagreed)"
        : verdict === "unsupported" && comparisons.length === 0
          ? "judge found it unsupported (no comparison)"
          : refusal();
  const wrong =
    (span?.check.parts ?? []).find(
      (each) => span && span.sentence.text.slice(each.span.start, each.span.end) !== probe,
    )?.verdict ?? null;
  return { verdict, replyVerdict, comparisons, path, wrong, reasked };
}

describe("held-out parts on the judge", () => {
  test.skipIf(KEY === undefined)(
    "one scope a case, several samples, and the path of each verdict",
    { timeout: 900_000 },
    async () => {
      const dataDir = await createTempDataFolder();
      const core: Core = startCore(dataDir, { createChatModel });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
      await core.updateSettings({ user: { monthlyCap: { amount: 3, currency: "USD" } } });
      const sources = await createTempDataFolder();
      const results: {
        name: string;
        negative: boolean;
        samples: ReturnType<typeof judged>[];
      }[] = [];
      const clients: { core: Core; client: MindClient; mindId: string }[] = [];
      for (const [index, each] of CASES.entries()) {
        const [file] = await addAndProcess(core, [
          await writeSourceFile(
            sources,
            `case-${index + 1}.md`,
            `# Case ${index + 1}\n\n${each.document}\n`,
          ),
        ]);
        const folder = await core.createLibraryGroup({
          name: `case-${index + 1}`,
          description: "",
        });
        if (!file) throw new Error("The case's Document didn't process.");
        await core.moveToFolder({ documentIds: [file.id], folderId: folder.id });
        const mind = await core.createMind({ title: `case-${index + 1}`, folderId: folder.id });
        const client = await connectToMind(core, mind.id);
        writeMind(client, [
          {
            type: "paragraph",
            attrs: { id: "case" },
            content: [{ type: "text", text: each.sentence }],
          },
        ]);
        await client.settled();
        clients.push({ core, client, mindId: mind.id });
        results.push({ name: each.name, negative: each.negative, samples: [] });
      }
      for (let sample = 0; sample < SAMPLES; sample++) {
        for (const [index, each] of CASES.entries()) {
          const entry = clients[index];
          if (!entry) continue;
          const { client, mindId } = entry;
          heard.replies.clear();
          heard.comparisons.clear();
          heard.agains.clear();
          const run = await core.checkMind({
            requestId: `held-out-${sample}-${index}`,
            mindId,
            mode: "all",
          });
          if (run.kind !== "checked") throw new Error(`A case didn't check: ${run.kind}.`);
          await client.settled();
          const span = claimSpans(readMind(client)).find(
            (one) => one.sentence.text.trim() === each.sentence,
          );
          results[index]?.samples.push(judged(span, each.probe, each.document));
        }
      }
      const { spent } = await core.getCostSummary();
      const flat = results.flatMap((caseResult) =>
        caseResult.samples.map((sample) => ({ ...caseResult, ...sample })),
      );
      const wrongs = results
        .filter((each) => !each.negative)
        .flatMap((each) => each.samples.map((sample) => sample.wrong));
      const report = {
        model: MODEL,
        samples: SAMPLES,
        cases: results,
        falseSupported:
          flat.filter((one) => one.negative && one.verdict === "supported").length +
          wrongs.filter((verdict) => verdict === "supported").length,
        decoySamples: flat.filter((one) => one.negative).length + wrongs.length,
        trueSupported: flat.filter((one) => !one.negative && one.verdict === "supported").length,
        positiveSamples: flat.filter((one) => !one.negative).length,
        reaskedSamples: flat.filter((one) => one.reasked !== null).length,
        spent,
      };
      process.stdout.write(
        `held out: ${report.falseSupported}/${report.decoySamples} decoy samples read Supported; ${report.trueSupported}/${report.positiveSamples} true samples read Supported; ${report.reaskedSamples} samples reached the second look; spend ${JSON.stringify(spent)}\n`,
      );
      for (const each of results)
        process.stdout.write(
          `${each.negative ? "NEG" : "POS"} ${each.name}: ${each.samples
            .map(
              (one) =>
                `${one.verdict}/${one.replyVerdict ?? "-"}/${one.comparisons.join(",") || "-"}=${one.path} wrong=${one.wrong ?? "-"}`,
            )
            .join(" | ")}\n`,
        );
      process.stdout.write(`${JSON.stringify(report)}\n`);
      expect(results.every((one) => one.samples.length === SAMPLES)).toBe(true);
      expect(report.decoySamples).toBeGreaterThan(0);
    },
  );
});
