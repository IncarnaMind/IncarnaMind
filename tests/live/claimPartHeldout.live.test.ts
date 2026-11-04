/**
 * The judge on a sentence's parts (#2313), held out: one Mind and one Folder of Documents per
 * case, so a decoy's Document can never back another case. Each case is checked several times,
 * and the path that gave each verdict is recorded. The sorter is scripted so each case's part is
 * the one checked; everything else is the real model. Runs only with
 * INCARNAMIND_LIVE_ANTHROPIC_KEY. The cases were committed before the run.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { type Core, createAiSdkChatModel } from "../../src/core";
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
    name: "en every year, Document every week",
    language: "en",
    document: "The harbour office publishes the times of high water every week.",
    sentence: "The harbour office publishes the times of high water every year.",
    parts: [
      { kind: "fact", text: "The harbour office publishes the times of high water" },
      { kind: "fact", text: "every year" },
    ],
    probe: "every year",
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
    name: "en reversed parties",
    language: "en",
    document: "Under the lease, the Landlord pays the Tenant's repair costs.",
    sentence: "Under the lease, the Tenant pays the Landlord's repair costs.",
    parts: [
      { kind: "fact", text: "Under the lease" },
      { kind: "fact", text: "the Tenant pays the Landlord's repair costs" },
    ],
    probe: "the Tenant pays the Landlord's repair costs",
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
    name: "en Q2, Document Q3",
    language: "en",
    document: "Gross margin fell in Q3, mostly in online.",
    sentence: "Gross margin fell in Q2, mostly in online.",
    parts: [
      { kind: "fact", text: "Gross margin fell" },
      { kind: "fact", text: "in Q2, mostly in online" },
    ],
    probe: "in Q2, mostly in online",
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
    name: "zh every year, Document every week",
    language: "zh-CN",
    document: "港口办公室每周公布一次高潮时间。",
    sentence: "港口办公室每年公布一次高潮时间。",
    parts: [
      { kind: "fact", text: "港口办公室" },
      { kind: "fact", text: "每年公布一次高潮时间" },
    ],
    probe: "每年公布一次高潮时间",
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
    name: "zh reversed parties",
    language: "zh-CN",
    document: "根据租赁协议，承租方承担出租方的维修费用。",
    sentence: "根据租赁协议，出租方承担承租方的维修费用。",
    parts: [
      { kind: "fact", text: "根据租赁协议" },
      { kind: "fact", text: "出租方承担承租方的维修费用" },
    ],
    probe: "出租方承担承租方的维修费用",
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
];

const SORT_SYSTEM = "You sort the sentences of the User's own draft";
const SENTENCE = /<sentence>\n([\s\S]*?)\n<\/sentence>/;

/** The replies and confirmations the real model gave, by the sentence a request names. */
const heard = { replies: new Map<string, string>(), judgements: new Map<string, string>() };

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
  else if (system.startsWith("Compare a sentence")) {
    const word =
      /judge?ment[\s*_]*[:：][\s*_"'“”`]*(supported|partly|unsupported|conflict|same|neither)/i
        .exec(text)?.[1]
        ?.toLowerCase();
    if (word) heard.judgements.set(sentence, word);
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

/** The verdict a case's probe part shows, and the path that gave it. */
function judged(span: ReturnType<typeof claimSpans>[number] | undefined, probe: string) {
  const part = span?.check.parts?.find(
    (each) => span.sentence.text.slice(each.span.start, each.span.end) === probe,
  );
  const verdict = part?.verdict ?? null;
  const reply = heard.replies.get(probe) ?? "";
  const replyVerdict =
    /Verdict[\s*_]*[:：][\s*_"'“”`]*(supported|unsupported|contradicted)/i
      .exec(reply)?.[1]
      ?.toLowerCase() ?? null;
  const confirmation = heard.judgements.get(probe) ?? null;
  const path =
    verdict === "supported"
      ? replyVerdict === "contradicted"
        ? "states"
        : "supported reply"
      : `refused (reply ${replyVerdict ?? "unread"}, confirmation ${confirmation ?? "none"})`;
  return { verdict, replyVerdict, confirmation, path };
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
          heard.judgements.clear();
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
          results[index]?.samples.push(judged(span, each.probe));
        }
      }
      const { spent } = await core.getCostSummary();
      const flat = results.flatMap((caseResult) =>
        caseResult.samples.map((sample) => ({ ...caseResult, ...sample })),
      );
      const report = {
        model: MODEL,
        samples: SAMPLES,
        cases: results,
        falseSupported: flat.filter((one) => one.negative && one.verdict === "supported").length,
        decoySamples: flat.filter((one) => one.negative).length,
        trueSupported: flat.filter((one) => !one.negative && one.verdict === "supported").length,
        positiveSamples: flat.filter((one) => !one.negative).length,
        spent,
      };
      const file = join(dataDir, "held-out.json");
      writeFileSync(file, JSON.stringify(report, null, 2));
      process.stdout.write(
        `held out: ${report.falseSupported}/${report.decoySamples} decoy samples read Supported; ${report.trueSupported}/${report.positiveSamples} true samples read Supported; spend ${JSON.stringify(spent)}; report ${file}\n`,
      );
      for (const each of results)
        process.stdout.write(
          `${each.negative ? "NEG" : "POS"} ${each.name}: ${each.samples
            .map(
              (one) =>
                `${one.verdict}/${one.replyVerdict ?? "-"}/${one.confirmation ?? "-"}=${one.path}`,
            )
            .join(" | ")}\n`,
        );
      expect(results.every((one) => one.samples.length === SAMPLES)).toBe(true);
    },
  );
});
