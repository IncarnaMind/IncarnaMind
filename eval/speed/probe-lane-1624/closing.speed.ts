import { join, resolve } from "node:path";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { test } from "vitest";
import { reports } from "../../everyday/asking";
import { readConfig } from "../../lib/config";
import { createWorkerEmbedder } from "../../lib/embedder";
import { openLibrary } from "../../lib/library";
import { createLog } from "../../lib/log";
import { createWorkerCrossEncoder } from "../../lib/rerank";
import { FLOWS } from "../flows";
import { modelsAsked } from "../settings";

const ROOT = resolve(__dirname, "../../..");

test.skipIf(!process.env.PROBE_LANE_1624)("closing calls", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  let t0 = performance.now();
  const seen: string[] = [];
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapStream: async ({ doStream, params }) => {
      const start = performance.now() - t0;
      const sys = params.prompt.find((m) => m.role === "system");
      const head =
        typeof sys?.content === "string" ? sys.content.slice(0, 90).replace(/\n/g, " ") : "";
      const result = await doStream();
      seen.push(`stream ${start.toFixed(0)}ms tools=${params.tools?.length ?? 0} ${head}`);
      return result;
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const start = performance.now() - t0;
      const sys = params.prompt.find((m) => m.role === "system");
      const head =
        typeof sys?.content === "string" ? sys.content.slice(0, 90).replace(/\n/g, " ") : "";
      const result = await doGenerate();
      seen.push(`generate ${start.toFixed(0)}..${(performance.now() - t0).toFixed(0)}ms ${head}`);
      return result;
    },
  };
  const library = await openLibrary({
    name: "probe-closing",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(config.rerankOnCpu),
    documents: await reports(),
    embeddings: false,
    keep: false,
    log,
    chatModels: (inner) => (spec) => wrapLanguageModel({ model: inner(spec), middleware }),
  });
  try {
    const { core, documents } = library;
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    const flow = FLOWS.find((each) => each.id === "question");
    if (!flow) throw new Error("no flow");
    for (const model of modelsAsked()) {
      await core.saveChatProvider(model);
      for (const language of ["en", "zh-CN"] as const) {
        await core.updateSettings({ user: { language } });
        seen.length = 0;
        t0 = performance.now();
        const signs = await flow.run({ core, language, documents });
        console.log(
          `== ${model.modelId} ${language} done ${signs.doneMs.toFixed(0)} words ${signs.firstWordsMs?.toFixed(0)}`,
        );
        for (const line of seen) console.log(`   ${line}`);
      }
    }
  } finally {
    await library.close();
  }
  throw new Error("show logs");
});
