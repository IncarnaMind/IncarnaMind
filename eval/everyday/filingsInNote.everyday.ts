/**
 * `INCARNAMIND_EVAL_EVERYDAY=filings-in-note npm run eval:everyday` (README.md): the filing
 * Questions of #1443 asked as a Question in a Note, where a model the list names answers in one
 * call from the search of the Question's own words (#1633), instead of in the assistant. Held to
 * the filing requests' own guards: the figure, its Citation, and no sentence saying the Document
 * lacks it.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { askOne } from "../lib/citations";
import { chatModelSpecOf, chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { tokenLine, watchTokens } from "../lib/tokens";
import { ANSWER_TIMEOUT_MS, judgeOf } from "./asking";
import { CASES } from "./cases";
import { writeFilingDocuments } from "./filings";
import { judgeDocumentAbsence } from "./judge";

const ROOT = resolve(__dirname, "../..");

/** Where each request's figure is: its filing, page and words. */
const FIGURES: Record<string, { document: string; pages: [number, number]; quote: string }> = {
  "filing-comparable-en": {
    document: "Northmart Q2 2026 10-Q.pdf",
    pages: [30, 30],
    quote: "2.1%",
  },
  "filing-comparable-zh": {
    document: "北域零售 2026年第二季度季报.pdf",
    pages: [30, 30],
    quote: "2.1%",
  },
  "filing-margin-en": {
    document: "Harbour Hotels 2026 annual release.pdf",
    pages: [11, 11],
    quote: "38.2%",
  },
  "filing-margin-zh": {
    document: "港湾酒店 2026年度业绩公告.pdf",
    pages: [11, 11],
    quote: "38.2%",
  },
  "filing-recast-en": {
    document: "Delta Manufacturing 8-K 2026.pdf",
    pages: [16, 16],
    quote: "592",
  },
  "filing-recast-zh": { document: "三角洲制造 8-K 2026.pdf", pages: [16, 16], quote: "592" },
};

function figureOf(id: string) {
  const figure = FIGURES[id];
  if (!figure) throw new Error(`No figure place for ${id}.`);
  return figure;
}

interface InNoteRow {
  id: string;
  round: number;
  status: string;
  answered: boolean;
  cited: boolean;
  absence: string[];
  searches: string[];
  reply: string;
}

test.skipIf(process.env.INCARNAMIND_EVAL_EVERYDAY !== "filings-in-note")(
  "filing Questions asked in a Note",
  async () => {
    const log = createLog();
    const config = readConfig(ROOT);
    const chat = config.chat;
    if (!chat) {
      log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY (README.md).");
      return;
    }
    const runs = Number(process.env.INCARNAMIND_EVAL_EVERYDAY_RUNS ?? "3") || 3;
    const cases = CASES.filter(
      (each) => each.library === "filings" && each.expected.answerEvidence !== undefined,
    );
    const answers = watchTokens();
    const judged = watchTokens();
    const judging = judgeOf(config, chat);
    const judge = judged.wrap(
      createAiSdkChatModel({ ...chatModelSpecOf(judging), thinking: "off" }),
    );
    const library = await openLibrary({
      name: "everyday-filings-in-note",
      chatModels: answers.chatModels,
      embedder: createWorkerEmbedder(),
      modelCache: join(config.cacheDir, "models"),
      reranker: createWorkerCrossEncoder(config.rerankOnCpu),
      documents: await writeFilingDocuments(
        await mkdtemp(join(tmpdir(), "incarnamind-everyday-filings-")),
      ),
      examples: join(ROOT, "resources", "examples"),
      keep: config.keepData,
      embeddings: false,
      log,
    });
    const rows: InNoteRow[] = [];
    try {
      const { core } = library;
      // Setting the variables is the consent to send the Questions and Passages to the model.
      core.on("consent.requested", (request) => {
        void core.respondToConsent(request.requestId, request.flow.id === "chat");
      });
      await core.saveChatProvider(chatProviderOf(chat));
      for (const each of cases) {
        await core.updateSettings({ user: { language: each.language } });
        for (let round = 1; round <= runs; round++) {
          const record = await askOne(
            library,
            {
              id: each.id,
              language: each.language === "zh-CN" ? "zh" : "en",
              crossLingual: false,
              question: each.request,
              expected: figureOf(each.id),
            },
            round,
            ANSWER_TIMEOUT_MS,
          );
          const evidence = each.expected.answerEvidence;
          const metric = each.expected.documentAbsenceMetric;
          const row: InNoteRow = {
            id: each.id,
            round,
            status: record.status,
            answered: each.expected.answerWith?.test(record.text) ?? true,
            cited: record.citations.some(
              (citation) =>
                citation.check === "found" &&
                (evidence?.document.test(citation.documentName) ?? false) &&
                (evidence?.quote.test(citation.quote) ?? false),
            ),
            absence: metric
              ? await judgeDocumentAbsence(judge, record.text, metric, each.request)
              : [],
            searches: record.searches,
            reply: record.text,
          };
          rows.push(row);
          log(
            `${each.id} #${round}: ${row.answered && row.cited && row.absence.length === 0 ? "passed" : `failed (answered ${row.answered}, cited ${row.cited}, absence ${row.absence.length})`}`,
          );
        }
      }
    } finally {
      const passed = rows.filter((row) => row.answered && row.cited && row.absence.length === 0);
      const folder = join(
        config.resultsDir,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-filings-in-note`,
      );
      await mkdir(folder, { recursive: true });
      const lines = [
        `# Filing Questions asked in a Note (#1443): ${chat.kind}/${chat.modelId}`,
        "",
        `${passed.length} of ${rows.length} passed: the figure, its found Citation, and no sentence saying the Document lacks it.`,
        "",
        `- The Answers' tokens: ${tokenLine(answers.take())}`,
        `- The judge's tokens (${judging.kind}/${judging.modelId}): ${tokenLine(judged.take())}`,
        "",
        ...rows.flatMap((row) => [
          `## ${row.id} #${row.round}: ${passed.includes(row) ? "passed" : "failed"}`,
          "",
          `Searches: ${row.searches.map((query) => `“${query}”`).join(", ")}`,
          ...(row.absence.length > 0
            ? ["", `Says the Document lacks it: ${row.absence.join(" / ")}`]
            : []),
          "",
          row.reply,
          "",
        ]),
      ];
      await writeFile(join(folder, "report.md"), lines.join("\n"));
      await writeFile(join(folder, "report.json"), JSON.stringify(rows, null, 2));
      log(`${passed.length} of ${rows.length} passed; report in ${folder}`);
      await library.close();
    }
  },
);
