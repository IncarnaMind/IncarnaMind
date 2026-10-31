/**
 * `npm run eval:absence` (README.md): sentences that say something is absent from a named
 * Document, checked by the app's own check with a real chat model (#1443), over that Document and
 * over a Library too long to read whole. Every absence Supported must rest on a whole read: the
 * report counts any Supported on the search alone, and gives every request's tokens.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { ChatModelChoice, ClaimCheckResult, Core, Money } from "../../src/core";
import { buildPdf } from "../../tests/helpers/pdf";
import { writeFilingDocuments } from "../everyday/filings";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder, prepareGpuFile } from "../lib/rerank";
import { type RequestTokens, tokenLine, watchTokens } from "../lib/tokens";
import {
  ABSENCE_DOCUMENTS,
  ABSENCE_SENTENCES,
  type AbsenceLanguage,
  type AbsenceSentence,
} from "./absenceCases";

const ROOT = resolve(__dirname, "../..");

const dollarsOf = (spent: readonly Money[]) =>
  spent.filter((each) => each.currency === "USD").reduce((total, each) => total + each.amount, 0);
const spentOf = async (core: Core) => dollarsOf((await core.getCostSummary()).spent);

interface AbsenceRow {
  model: string;
  language: AbsenceLanguage;
  scope: "document" | "library";
  repeat: number;
  key: string;
  kind: AbsenceSentence["kind"];
  text: string;
  verdict: ClaimCheckResult["verdict"];
  reason: string | null;
  /** Pages the whole read read, by Document; empty when no whole read backs the result. */
  read: string[];
  quote: string | null;
  quotesClause: boolean;
  spent: number;
  requests: RequestTokens[];
}

const squeezed = (text: string) => text.replace(/\s+/g, "");

/** What a row's result is, against what its sentence is. */
function judged(row: AbsenceRow): "right" | "wrong" | "not-checked" {
  if (row.verdict === "not-checked") return "not-checked";
  if (row.kind === "holds")
    return row.verdict === "supported" && row.read.length > 0 ? "right" : "wrong";
  if (row.kind === "there")
    return row.verdict === "contradicted" && row.quotesClause ? "right" : "wrong";
  return row.verdict === "supported" && row.quotesClause ? "right" : "wrong";
}

function report(rows: readonly AbsenceRow[], commit: string): string {
  const lines = [`# Absence sentences (#1443)`, "", `Commit ${commit}.`, ""];
  const groups = new Map<string, AbsenceRow[]>();
  for (const row of rows) {
    const id = `${row.model} · ${row.scope}`;
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  for (const [id, group] of groups) {
    const absences = group.filter((row) => row.kind !== "fact");
    const searchAlone = absences.filter(
      (row) => row.verdict === "supported" && row.read.length === 0,
    );
    const count = (rows: readonly AbsenceRow[], outcome: ReturnType<typeof judged>) =>
      rows.filter((row) => judged(row) === outcome).length;
    const tokens = group.flatMap((row) => row.requests);
    lines.push(
      `## ${id}`,
      "",
      `- Absence sentences Supported on the search alone: **${searchAlone.length} of ${absences.length}**`,
      `- True absences Supported after a whole read: ${count(
        group.filter((row) => row.kind === "holds"),
        "right",
      )} of ${group.filter((row) => row.kind === "holds").length}; not checked ${count(
        group.filter((row) => row.kind === "holds"),
        "not-checked",
      )}`,
      `- Absences the Document contradicts, Contradicted with the clause: ${count(
        group.filter((row) => row.kind === "there"),
        "right",
      )} of ${group.filter((row) => row.kind === "there").length}; not checked ${count(
        group.filter((row) => row.kind === "there"),
        "not-checked",
      )}`,
      `- Plain facts Supported with their clause: ${count(
        group.filter((row) => row.kind === "fact"),
        "right",
      )} of ${group.filter((row) => row.kind === "fact").length}`,
      `- ${tokenLine(tokens)}, of them ${tokens.filter((each) => each.instructions.startsWith("Read the whole Documents")).length} whole reads`,
      `- Spent (the app's meter): $${group.reduce((total, row) => total + row.spent, 0).toFixed(4)}`,
      "",
      "| Lang | Key | Kind | Verdict | Read | Quote | Reason |",
      "|---|---|---|---|---|---|---|",
      ...group.map(
        (row) =>
          `| ${row.language} | ${row.key} | ${row.kind} | ${row.verdict}${judged(row) === "wrong" ? " ✗" : ""} | ${row.read.join("; ")} | ${(row.quote ?? "").replace(/\|/g, "/").slice(0, 80)} | ${row.reason ?? ""} |`,
      ),
      "",
    );
  }
  return lines.join("\n");
}

function list(name: string): string[] | null {
  const values = process.env[name]
    ?.split(",")
    .map((each) => each.trim())
    .filter(Boolean);
  return values && values.length > 0 ? values : null;
}

test("sentences that say something is absent", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const chat = config.chat;
  if (!chat) {
    log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY (README.md).");
    return;
  }
  const repeats = Math.max(1, Number(process.env.INCARNAMIND_EVAL_REPEATS ?? "1") || 1);
  const scopes = (list("INCARNAMIND_EVAL_ABSENCE_SCOPES") ?? ["document", "library"]) as (
    | "document"
    | "library"
  )[];
  const keys = list("INCARNAMIND_EVAL_ABSENCE_SENTENCES");
  const languages = (list("INCARNAMIND_EVAL_ABSENCE_LANGUAGES") ?? [
    "en",
    "zh-CN",
  ]) as AbsenceLanguage[];
  const budget = Number(process.env.INCARNAMIND_EVAL_ABSENCE_BUDGET ?? "0.5") || 0.5;
  const model = `${chat.kind}/${chat.modelId}`;
  await prepareGpuFile(config, log);
  const folder = await mkdtemp(join(tmpdir(), "incarnamind-absence-"));
  const documents = [];
  for (const each of ABSENCE_DOCUMENTS) {
    const path = join(folder, each.file);
    await writeFile(path, buildPdf(each.pages));
    documents.push({ key: each.file, path });
  }
  // The filings make the Library too long to read whole, as a User's Library is.
  documents.push(...(await writeFilingDocuments(folder)));
  const tokens = watchTokens();
  const library = await openLibrary({
    name: "absence",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(config.rerankOnCpu),
    documents,
    keep: config.keepData,
    embeddings: false,
    chatModels: tokens.chatModels,
    log,
  });
  const out = join(config.resultsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-absence`);
  await mkdir(out, { recursive: true });
  const rows: AbsenceRow[] = [];
  try {
    const { core } = library;
    // Setting the variables is the consent to send the sentences and the Documents to the model.
    core.on("consent.requested", (request) => {
      void core.respondToConsent(
        request.requestId,
        request.flow.id === "chat" || request.flow.id === "checks",
      );
    });
    const provider = await core.saveChatProvider(chatProviderOf(chat));
    const choice: ChatModelChoice = { providerId: provider.id, modelId: chat.modelId };
    let spent = 0;
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const language of languages) {
        await core.updateSettings({ user: { language } });
        for (const sentence of ABSENCE_SENTENCES[language].filter(
          (each) => !keys || keys.includes(each.key),
        )) {
          for (const scope of scopes) {
            if (spent > budget) break;
            const named = library.documents.get(sentence.document);
            if (!named) throw new Error(`${sentence.document} was not added.`);
            tokens.take();
            const before = await spentOf(core);
            const result = await core.checkClaim({
              claim: sentence.text,
              scope:
                scope === "document"
                  ? { folderIds: [], tagIds: [], documentIds: [named.id] }
                  : null,
              model: choice,
            });
            const cost = (await spentOf(core)) - before;
            spent += cost;
            const quote =
              result.verdict === "not-checked" ? null : (result.evidence?.quote ?? null);
            rows.push({
              model,
              language,
              scope,
              repeat,
              key: sentence.key,
              kind: sentence.kind,
              text: sentence.text,
              verdict: result.verdict,
              reason: result.verdict === "not-checked" ? result.reason : null,
              read: (result.readDocuments ?? []).map(
                (each) =>
                  `${each.documentName} (${each.locations.map((at) => ("from" in at ? `${at.from}` : at.kind)).join(", ")})`,
              ),
              quote,
              quotesClause:
                quote !== null &&
                sentence.clause !== undefined &&
                squeezed(quote).includes(squeezed(sentence.clause)),
              spent: cost,
              requests: tokens.take(),
            });
            const row = rows.at(-1);
            log(
              `${model} · ${scope} · ${language} · ${sentence.key}: ${row?.verdict} (${row && judged(row)})`,
            );
          }
        }
      }
    }
  } finally {
    const commit = await commitOf(ROOT);
    await writeFile(join(out, "report.md"), report(rows, commit));
    await writeFile(join(out, "report.json"), JSON.stringify(rows, null, 2));
    log(`Report: ${join(out, "report.md")}`);
    await library.close();
  }
});
