/**
 * Choose the Citation (#1554), on Claude Haiku 5.5 by default, over the held-out sentences written
 * before any prompt was tried. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY and makes no request
 * without one. INCARNAMIND_LIVE_REPORT keeps every verdict, token count and the spend. The fix may
 * never make a sentence Supported that its words don't back.
 */
import { appendFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { createAiSdkChatModel } from "../../src/core";
import type { ClaimCheckResult, Document } from "../../src/core/api";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { CHOSEN_CITATION_CASES, HELD_OUT_DOCUMENTS } from "../helpers/notFoundFixesHeldOut";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.answers as string);

type Usage = {
  inputTokens: { total?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens: { total?: number };
};

const verdictOf = (result: ClaimCheckResult) => result.verdict;

describe.skipIf(KEY === undefined)("a not-found sentence's fixes, live", () => {
  test("a chosen Citation never makes a sentence Supported its words don't back", {
    timeout: 1_200_000,
  }, async () => {
    const tokens = { requests: 0, input: 0, cached: 0, output: 0 };
    const count = (usage: Usage) => {
      tokens.requests++;
      tokens.input += usage.inputTokens.total ?? 0;
      tokens.cached += usage.inputTokens.cacheRead ?? 0;
      tokens.output += usage.outputTokens.total ?? 0;
    };
    const createChatModel = (spec: Parameters<typeof createAiSdkChatModel>[0]) =>
      wrapLanguageModel({
        model: createAiSdkChatModel(spec),
        middleware: {
          specificationVersion: "v4",
          wrapGenerate: async ({ doGenerate }) => {
            const result = await doGenerate();
            count(result.usage);
            return result;
          },
          wrapStream: async ({ doStream }) => {
            const result = await doStream();
            const stream = result.stream.pipeThrough(
              new TransformStream({
                transform(part, controller) {
                  if (part.type === "finish") count(part.usage);
                  controller.enqueue(part);
                },
              }),
            );
            return { ...result, stream };
          },
        },
      });
    const core = startCore(await createTempDataFolder(), { createChatModel });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
    const sources = await createTempDataFolder();
    const paths = await Promise.all(
      HELD_OUT_DOCUMENTS.map((each) => writeSourceFile(sources, each.name, each.contents)),
    );
    const documents = await addAndProcess(core, paths);
    const documentNamed = (name: string): Document => {
      const found = documents.find((each) => `${each.name}.md` === name || each.name === name);
      if (!found) throw new Error(`No Document ${name}.`);
      return found;
    };
    const cite = async (name: string, words: string) => {
      const document = documentNamed(name);
      const cited = await core.citeSelection({
        documentId: document.id,
        parts: [{ unit: null, text: words }],
      });
      if (cited.check !== "found") throw new Error(`“${words}” isn't found in ${name}.`);
      return { cited, document };
    };

    const chosen = [];
    for (const each of CHOSEN_CITATION_CASES) {
      const { cited, document } = await cite(each.document, each.words);
      const result = await core.checkClaim({
        claim: each.sentence,
        cited: [
          {
            documentName: document.name,
            documentId: document.id,
            contentHash: cited.contentHash ?? undefined,
            passageId: cited.passageId ?? undefined,
            quote: cited.quote,
          },
        ],
      });
      const evidence = result.verdict === "not-checked" ? null : result.evidence;
      // Supported on the words chosen, or on another line the check found for the sentence.
      const onChosen =
        evidence !== null &&
        (evidence.quote.includes(cited.quote) || cited.quote.includes(evidence.quote));
      chosen.push({
        id: each.id,
        language: each.language,
        supported: each.supported,
        verdict: verdictOf(result),
        evidence: evidence?.quote ?? null,
        onChosen,
        falseSupported:
          verdictOf(result) === "supported" &&
          !each.supported &&
          (onChosen || each.elsewhere !== true),
      });
    }

    const { spent } = await core.getCostSummary();
    const report = {
      model: MODEL,
      tokens,
      spent,
      chosen,
      falseSupported: chosen.filter((each) => each.falseSupported).length,
    };
    if (process.env.INCARNAMIND_LIVE_REPORT) {
      await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    }

    expect(report.falseSupported).toBe(0);
  });
});
