/**
 * The Citations an Answer left out, asked of a real model (#2306): an ordinary Answer, not a
 * Meeting's notes. The model's own reply is swapped for one that writes its markers but gives no
 * records, so the one request for its Citations is made every time; for each Answer it counts
 * how many of the markers end as Citations found in the Document, which model spec the request
 * went to (its thinking), and that request's tokens. Written to INCARNAMIND_LIVE_REPORT when set.
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Claude Haiku 5.5
 * by default).
 */
import { appendFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { CITE_RETRY_INSTRUCTIONS } from "../../src/core/answers/prompt";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { streamedReply } from "../helpers/models";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;

const LEASE = [
  "# Warehouse lease",
  "",
  "The lease of Unit 4 at Dockside runs for five years from 1 March 2027.",
  "",
  "The rent is 14,200 euros a month, reviewed every two years.",
  "",
  "The tenant pays the service charge of 1,150 euros a quarter.",
  "",
  "The deposit is three months' rent, returned within 60 days of the end of the lease.",
  "",
  "The tenant may break the lease after three years with six months' notice.",
].join("\n");

/** A Question, and the reply put in place of the model's: its markers, but no records. */
const ASKED = [
  {
    question: "How long does the lease run, and what is the rent?",
    reply:
      "The lease lasts five years starting in March 2027 [^1]. Monthly rent is 14,200 euros, with a review every second year [^2].",
  },
  {
    question: "What does the tenant pay besides the rent?",
    reply:
      "Each quarter the tenant owes a 1,150-euro service charge [^1]. A deposit equal to three months of rent is held and paid back within 60 days after the lease ends [^2].",
  },
  {
    question: "Can the tenant leave early?",
    reply:
      "After three years the tenant can end the lease early by giving six months' notice [^1].",
  },
  {
    question: "租期多长，租金多少？",
    reply: "租期五年，从 2027 年 3 月 1 日开始[^1]。月租金为 14,200 欧元，每两年复核一次[^2]。",
  },
  { question: "押金怎么算？", reply: "押金为三个月租金，租期结束后 60 天内退还[^1]。" },
  {
    question: "租户能提前退租吗？",
    reply: "租户满三年后可以提前解约，需提前六个月通知[^1]。",
  },
];

type Usage = {
  inputTokens: { total?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens: { total?: number; reasoning?: number };
};

interface Asked {
  thinking: string | undefined;
  output: number;
  reasoning: number;
  input: number;
  cached: number;
  written: number;
}

describe.skipIf(!KEY)(
  "The Citations an Answer left out, on a real model",
  {
    timeout: 600_000,
  },
  () => {
    test("each marker an Answer wrote without a record ends as a Citation found", async () => {
      let swap: string | null = null;
      const asked: Asked[] = [];
      /** Every request the run sent, the Citations requests and the others alike. */
      const all = { requests: 0, input: 0, cached: 0, written: 0, output: 0 };
      const count = (usage: Usage) => {
        all.requests++;
        all.input += usage.inputTokens.total ?? 0;
        all.cached += usage.inputTokens.cacheRead ?? 0;
        all.written += usage.inputTokens.cacheWrite ?? 0;
        all.output += usage.outputTokens.total ?? 0;
      };
      const createChatModel = (spec: Parameters<typeof createAiSdkChatModel>[0]) =>
        wrapLanguageModel({
          model: createAiSdkChatModel(spec),
          middleware: {
            specificationVersion: "v4",
            wrapStream: async ({ doStream, params }) => {
              const said = JSON.stringify(params.prompt);
              if (swap !== null && (params.tools?.length ?? 0) > 0 && said.includes("Dockside")) {
                const reply = swap;
                swap = null;
                return { stream: streamedReply(reply, params.abortSignal, { chunkSize: 40 }) };
              }
              const result = await doStream();
              const citing = said.includes(CITE_RETRY_INSTRUCTIONS.slice(0, 40));
              const stream = result.stream.pipeThrough(
                new TransformStream({
                  transform(part, controller) {
                    if (part.type === "finish") count(part.usage);
                    if (part.type === "finish" && citing) {
                      asked.push({
                        thinking: spec.thinking,
                        output: part.usage.outputTokens.total ?? 0,
                        reasoning: part.usage.outputTokens.reasoning ?? 0,
                        input: part.usage.inputTokens.total ?? 0,
                        cached: part.usage.inputTokens.cacheRead ?? 0,
                        written: part.usage.inputTokens.cacheWrite ?? 0,
                      });
                    }
                    controller.enqueue(part);
                  },
                }),
              );
              return { ...result, stream };
            },
            wrapGenerate: async ({ doGenerate }) => {
              const result = await doGenerate();
              count(result.usage);
              return result;
            },
          },
        });
      const core = startCore(await createTempDataFolder(), { createChatModel });
      core.on(
        "consent.requested",
        (request) => void core.respondToConsent(request.requestId, true),
      );
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
      const sources = await createSourceFolder();
      await addAndProcess(core, [await writeSourceFile(sources, "Warehouse lease.md", LEASE)]);

      const rows: string[] = [];
      let markers = 0;
      let found = 0;
      for (const { question, reply } of ASKED) {
        swap = reply;
        const before = asked.length;
        const result = await core.askInConversation({ conversationId: null, text: question });
        if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
        await new Promise<void>((resolve) => {
          const stops = [
            core.on("answer.finished", ({ answerId }) => answerId === result.answerId && done()),
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
        const wrote = reply.match(/\[\^\d+\]/g)?.length ?? 0;
        const kept = answer.citations.filter((citation) => citation.check === "found").length;
        markers += wrote;
        found += Math.min(kept, wrote);
        const request = asked.slice(before);
        rows.push(
          `| ${question} | ${Math.min(kept, wrote)}/${wrote} | ${request.map((each) => `${each.thinking ?? "default"}, ${each.output} out (${each.reasoning} thinking), ${each.input} in (${each.cached} cached, ${each.written} written)`).join("; ") || "not asked"} |`,
        );
      }
      core.close();
      if (REPORT) {
        await appendFile(
          REPORT,
          [
            `## ${MODEL}: ${found} of ${markers} markers end as Citations found`,
            "",
            `All requests: ${all.requests}, ${all.input} in (${all.cached} cache reads, ${all.written} cache writes), ${all.output} out.`,
            "",
            "| Question | Citations found | The Citations request: thinking, tokens |",
            "|---|---|---|",
            ...rows,
            "",
          ].join("\n"),
        );
      }
      expect(asked.length).toBeGreaterThan(0);
      expect(found).toBeGreaterThan(0);
    });
  },
);
