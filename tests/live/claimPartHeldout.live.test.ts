/**
 * The judge on a sentence's parts (#2313), held out: parts the Document states, and decoys whose
 * own detail is wrong. The sorter is scripted so each case's part is the one checked; everything
 * else is the real model. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY. The cases were committed
 * before the run; the JSON report is written to /tmp/lane-2313e-heldout.json.
 */
import { writeFileSync } from "node:fs";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { type Core, createAiSdkChatModel } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.answers as string);

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
    name: "en every year, stated",
    language: "en",
    document: "The harbour office publishes the times of high water every year.",
    sentence: "The harbour office publishes the times of high water every year.",
    parts: [
      { kind: "fact", text: "The harbour office publishes the times of high water" },
      { kind: "fact", text: "every year" },
    ],
    probe: "every year",
    negative: false,
  },
  {
    name: "en after the redesign, stated",
    language: "en",
    document: "Customer churn fell to 4.2 per cent after the onboarding redesign.",
    sentence: "Customer churn fell to 4.2 per cent after the onboarding redesign.",
    parts: [
      { kind: "fact", text: "Customer churn fell to 4.2 per cent" },
      { kind: "fact", text: "after the onboarding redesign" },
    ],
    probe: "after the onboarding redesign",
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
    name: "zh churn after the redesign, stated",
    language: "zh-CN",
    document: "客户流失率在 2025 年第 2 季度降至 4.2%，时点在引导流程重新设计之后。",
    sentence: "客户流失率在 2025 年第 2 季度降至 4.2%，时点在引导流程重新设计之后。",
    parts: [
      { kind: "fact", text: "客户流失率在 2025 年第 2 季度降至 4.2%" },
      { kind: "fact", text: "时点在引导流程重新设计之后" },
    ],
    probe: "时点在引导流程重新设计之后",
    negative: false,
  },
  {
    name: "zh every year, stated",
    language: "zh-CN",
    document: "港口办公室每年公布一次高潮时间。",
    sentence: "港口办公室每年公布一次高潮时间。",
    parts: [
      { kind: "fact", text: "港口办公室" },
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

/** Real Haiku, with its sort answered from the committed cases. */
const createChatModel: NonNullable<Parameters<typeof startCore>[1]>["createChatModel"] = (spec) => {
  const real = createAiSdkChatModel(spec);
  return wrapLanguageModel({
    model: real,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate, params }) => {
        const result = await doGenerate();
        if (!JSON.stringify(params.prompt).includes(SORT_SYSTEM)) return result;
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
        const sentences = input.sentences.map(({ number, text }) => {
          const found = CASES.find((each) => each.sentence === text);
          return { number, parts: found?.parts ?? [{ kind: "fact", text }] };
        });
        return {
          ...result,
          content: [{ type: "text" as const, text: JSON.stringify({ sentences }) }],
        };
      },
    },
  });
};

describe("held-out parts on the judge", () => {
  test.skipIf(KEY === undefined)(
    "states the true parts and refuses the decoys",
    { timeout: 900_000 },
    async () => {
      const core: Core = startCore(await createTempDataFolder(), { createChatModel });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
      await core.updateSettings({ user: { monthlyCap: { amount: 3, currency: "USD" } } });
      const sources = await createTempDataFolder();
      const documents = await Promise.all(
        CASES.map((each, index) =>
          writeSourceFile(
            sources,
            `case-${index + 1}.md`,
            `# Case ${index + 1}\n\n${each.document}\n`,
          ),
        ),
      );
      await addAndProcess(core, documents);
      const mind = await core.createMind({ title: "Held out", folderId: null });
      const client = await connectToMind(core, mind.id);
      writeMind(
        client,
        CASES.map((each, index) => ({
          type: "paragraph",
          attrs: { id: `case-${index + 1}` },
          content: [{ type: "text", text: each.sentence }],
        })),
      );
      await client.settled();

      const run = await core.checkMind({ requestId: "held-out", mindId: mind.id, mode: "all" });
      await client.settled();
      const versions = new Map(
        (await core.listDocuments()).map((each) => [each.id, each.contentHash]),
      );
      const spans = claimSpans(readMind(client));
      const results = CASES.map((each) => {
        const span = spans.find((one) => one.sentence.text.trim() === each.sentence);
        const judged = span?.check.parts?.find(
          (part) => span.sentence.text.slice(part.span.start, part.span.end) === each.probe,
        );
        return {
          name: each.name,
          negative: each.negative,
          sentence: span
            ? claimCheckShown(span.check, {
                text: span.sentence.text,
                versions,
                folderId: null,
                scope: null,
                figureContexts: null,
              })
            : null,
          probe: judged?.verdict ?? null,
          says: judged?.says ?? null,
          unsupported: judged?.unsupported?.reason ?? null,
        };
      });
      const { spent } = await core.getCostSummary();
      const report = {
        model: MODEL,
        run,
        falseSupported: results.filter((each) => each.negative && each.probe === "supported")
          .length,
        negatives: results.filter((each) => each.negative).length,
        trueSupported: results.filter((each) => !each.negative && each.probe === "supported")
          .length,
        positives: results.filter((each) => !each.negative).length,
        spent,
        results,
      };
      writeFileSync("/tmp/lane-2313e-heldout.json", JSON.stringify(report, null, 2));
      expect(run.kind).toBe("checked");
    },
  );
});
