/**
 * Real-model Citation quotes on the film's own PDFs and Question (#2110).
 * Reports the stored quote and the exact mid-phrase endings, before and after
 * the CJK line-wrap change, without steering the model.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { ChatModelChoice, Core } from "../../src/core";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder, prepareGpuFile } from "../lib/rerank";

const ROOT = resolve(__dirname, "../..");
const ANSWER_WAIT_MS = 180_000;

interface Row {
  model: string;
  language: "en" | "zh-CN";
  repeat: number;
  quote: string | null;
  check: string | null;
  mid: boolean;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  text: string;
  spent: number;
  seconds: number;
}

const CASES = [
  {
    language: "en" as const,
    question: "Is Northwind inside its leverage covenant?",
    documents: [
      "resources/examples/credit/en/Northwind Retail · Q3 2026 results.pdf",
      "resources/examples/credit/en/Northwind Retail · Senior facilities agreement (excerpt).pdf",
    ],
  },
  {
    language: "zh-CN" as const,
    question: "Northwind 有没有超出杠杆率条款的限制？",
    documents: [
      "resources/examples/credit/zh-CN/Northwind Retail · 2026 年第三季度业绩.pdf",
      "resources/examples/credit/zh-CN/Northwind Retail · 优先级贷款协议（节选）.pdf",
    ],
  },
];

const spentOf = async (core: Core) =>
  (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((total, each) => total + each.amount, 0);

function midPhrase(language: Row["language"], quote: string): boolean {
  const end = quote.trim().replace(/[\s.。"'’”]+$/u, "");
  return language === "zh-CN" ? /配送成本上升，? ?7$/u.test(end) : /37\.5% a year$/u.test(end);
}

async function ask(core: Core, text: string, model: ChatModelChoice) {
  const asked = await core.askInConversation({ text, mindId: null, conversationId: null, model });
  if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
  const finished = await new Promise<unknown>((done) => {
    const timer = setTimeout(() => done(null), ANSWER_WAIT_MS);
    const stops = [
      core.on("answer.finished", (event) => event.answerId === asked.answerId && end(event)),
      core.on("answer.failed", (event) => event.answerId === asked.answerId && end(event)),
    ];
    function end(event: unknown) {
      clearTimeout(timer);
      for (const stop of stops) stop();
      done(event);
    }
  });
  if (!finished) throw new Error(`The Answer failed or took too long: ${JSON.stringify(finished)}`);
  const { messages } = await core.getConversation(asked.conversation.id);
  const answer = messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer was kept.");
  if (answer.status !== "done")
    throw new Error(`The Answer did not finish: ${JSON.stringify(answer)}`);
  return answer;
}

test("the film's Citation quotes do not end at a PDF line wrap", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const chat = config.chat;
  if (!chat) throw new Error("Set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY.");
  const model = `${chat.kind}/${chat.modelId}`;
  const repeats = Number(process.env.INCARNAMIND_EVAL_CJK_WRAP_REPEATS ?? "10");
  const label = process.env.INCARNAMIND_EVAL_CJK_WRAP_LABEL ?? "unlabelled";
  await prepareGpuFile(config, log);
  const reranker = createWorkerCrossEncoder(config.rerankOnCpu);
  const out = join(config.resultsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-cjk-wrap`);
  await mkdir(out, { recursive: true });
  const rows: Row[] = [];
  for (const each of CASES) {
    const library = await openLibrary({
      name: `cjk-wrap-${each.language}`,
      embedder: createWorkerEmbedder(),
      modelCache: join(config.cacheDir, "models"),
      reranker,
      documents: each.documents.map((path) => ({ key: path, path: resolve(ROOT, path) })),
      keep: config.keepData,
      embeddings: false,
      recordTimings: true,
      log,
    });
    try {
      const { core } = library;
      core.on("consent.requested", (request) => {
        void core.respondToConsent(request.requestId, request.flow.id === "chat");
      });
      await core.updateSettings({ user: { language: each.language } });
      const provider = await core.saveChatProvider(chatProviderOf(chat));
      const choice: ChatModelChoice = { providerId: provider.id, modelId: chat.modelId };
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const before = await spentOf(core);
        library.timings?.begin();
        const started = Date.now();
        const answer = await ask(core, each.question, choice);
        const recording = library.timings?.end();
        const seconds = (Date.now() - started) / 1000;
        const spent = (await spentOf(core)) - before;
        const citations = answer.citations.length > 0 ? answer.citations : [null];
        for (const citation of citations) {
          const quote = citation?.quote ?? null;
          rows.push({
            model,
            language: each.language,
            repeat,
            quote,
            check: citation?.check ?? "no-citation",
            mid: quote === null ? false : midPhrase(each.language, quote),
            calls: recording?.modelCalls.length ?? 0,
            inputTokens:
              recording?.modelCalls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0) ?? 0,
            outputTokens:
              recording?.modelCalls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0) ?? 0,
            text: answer.text,
            spent,
            seconds,
          });
        }
        log(
          `${label} · ${model} · ${each.language} ${repeat}: ${citations.length} Citation(s), ${recording?.modelCalls.length ?? 0} calls, $${spent.toFixed(4)}`,
        );
      }
    } finally {
      await library.close();
    }
  }
  await writeFile(
    join(out, "rows.json"),
    JSON.stringify({ label, commit: commitOf(ROOT), rows }, null, 2),
  );
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.model}\n${row.language}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const lines = [
    `# CJK line-wrap Citations (${label})`,
    "",
    "| Model | Language | Quotes | Mid-phrase endings | Model calls | Input tokens | Output tokens | Spend (USD) |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const group of groups.values()) {
    const [first] = group;
    if (!first) continue;
    lines.push(
      `| ${first.model} | ${first.language} | ${group.length} | ${group.filter((row) => row.mid).length} | ${group.reduce((sum, row) => sum + row.calls, 0)} | ${group.reduce((sum, row) => sum + row.inputTokens, 0)} | ${group.reduce((sum, row) => sum + row.outputTokens, 0)} | ${group.reduce((sum, row) => sum + row.spent, 0).toFixed(4)} |`,
    );
  }
  lines.push("", "## Every stored quote", "");
  for (const row of rows) {
    lines.push(
      `- ${row.model} · ${row.language} · ${row.repeat} · ${row.check} · mid=${row.mid}: ${row.quote ?? "(no Citation)"}`,
    );
  }
  await writeFile(join(out, "report.md"), lines.join("\n"));
  log(`Wrote ${out}`);
});
