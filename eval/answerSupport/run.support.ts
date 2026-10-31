/**
 * `npm run eval:support` (README.md): each sentence an Answer might write, checked against the
 * quote it cites as the Answer checks it before it ends (#2311), on a real chat model. The cases
 * (./cases) are the walk's two fixtures, held-out sentences of the same mistakes and controls;
 * the supported set is Find support's supported sentences that state a date or year
 * (eval/checks/labels.json), each citing its labelled quote.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { CitedQuote, ClaimCheckResult, Core, Document } from "../../src/core";
import { readChecksSet } from "../checks/lib/set";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog, type Log } from "../lib/log";
import { CASES, DOCUMENTS } from "./cases";

const ROOT = resolve(__dirname, "../..");
const DATED =
  /(?:19|20)\d\d|年|月|January|February|March|April|May|June|July|August|September|October|November|December/;

interface Row {
  id: string;
  set: string;
  language: string;
  sentence: string;
  /** Whether its quote supports it. */
  supported: boolean;
  verdict: ClaimCheckResult["verdict"];
  /** What the check said, for reading the misses. */
  said: string | null;
  /** Each part the check named, with its words and its result. */
  parts: { kind: string; words: string; verdict: string | null; said: string | null }[];
  seconds: number;
  dollars: number;
}

const spentOf = async (core: Core) =>
  (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((total, each) => total + each.amount, 0);

/** The Passage of `document` that holds `quote`, as an Answer's Citation names it. */
async function citedQuote(
  core: Core,
  documents: Iterable<Document>,
  name: string,
  quote: string,
): Promise<CitedQuote> {
  const document = [...documents].find((each) => each.name === name);
  if (!document) throw new Error(`${name} wasn't added.`);
  const found = (await core.searchPassages(quote)).filter(
    (each) => each.documentId === document.id,
  );
  const passage = found.find((each) => each.text.includes(quote.slice(0, 12))) ?? found[0];
  return {
    documentName: document.name,
    documentId: document.id,
    contentHash: document.contentHash,
    ...(passage && { passageId: passage.passageId }),
    quote,
  };
}

async function checkEach(
  core: Core,
  items: readonly {
    id: string;
    set: string;
    language: string;
    sentence: string;
    supported: boolean;
    cited: () => Promise<CitedQuote>;
  }[],
  model: { providerId: string; modelId: string },
  spend: { total: number; cap: number },
  log: Log,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const item of items) {
    if (spend.total >= spend.cap) {
      log(`Stopped before ${item.id}: $${spend.total.toFixed(4)} spent, the budget's reached.`);
      break;
    }
    const before = await spentOf(core);
    const started = Date.now();
    let result: ClaimCheckResult;
    try {
      result = await core.checkClaim({ claim: item.sentence, cited: [await item.cited()], model });
    } catch (error) {
      log(`  ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const said =
      result.verdict === "unsupported"
        ? (result.unsupported?.reason ?? null)
        : result.verdict === "not-checked"
          ? `${result.reason}${result.detail ? `: ${result.detail}` : ""}`
          : result.says;
    const row: Row = {
      id: item.id,
      set: item.set,
      language: item.language,
      sentence: item.sentence,
      supported: item.supported,
      verdict: result.verdict,
      said,
      parts: (result.parts ?? []).map((part) => ({
        kind: part.kind,
        words: item.sentence.slice(part.span.start, part.span.end),
        verdict: part.verdict,
        said: part.says ?? part.unsupported?.reason ?? null,
      })),
      seconds: (Date.now() - started) / 1000,
      dollars: (await spentOf(core)) - before,
    };
    rows.push(row);
    spend.total += row.dollars;
    log(
      `  ${row.id}: ${row.verdict}${row.supported === (row.verdict === "supported") ? "" : " ✗"}`,
    );
  }
  return rows;
}

function summary(rows: readonly Row[]): string[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.set} · ${row.language}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([key, each]) => {
    const wrongGreen = each.filter((row) => !row.supported && row.verdict === "supported").length;
    const falseMarks = each.filter(
      (row) => row.supported && (row.verdict === "unsupported" || row.verdict === "contradicted"),
    ).length;
    const notChecked = each.filter((row) => row.verdict === "not-checked").length;
    const unsupported = each.filter((row) => !row.supported).length;
    return `${key}: ${each.length} sentences; ${unsupported - wrongGreen} of ${unsupported} unsupported ones refused; ${falseMarks} supported ones marked; ${notChecked} not checked`;
  });
}

test("Answer sentences against the quotes they cite", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const chat = config.chat;
  if (!chat) {
    log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY (eval/README.md).");
    return;
  }
  const arm = process.env.INCARNAMIND_EVAL_SUPPORT_ARM?.trim() || "after";
  const sets = (process.env.INCARNAMIND_EVAL_SUPPORT_SETS?.trim() || "cases,supported").split(",");
  const only = process.env.INCARNAMIND_EVAL_SUPPORT_ONLY?.trim() || null;
  // A model's verdict on one sentence varies from request to request: each is checked this often.
  const repeats = Number(process.env.INCARNAMIND_EVAL_SUPPORT_REPEATS ?? "1") || 1;
  const spend = { total: 0, cap: Number(process.env.INCARNAMIND_EVAL_SUPPORT_BUDGET ?? "1") || 1 };
  const rows: Row[] = [];

  const run = async (
    name: string,
    documents: { key: string; path: string }[],
    webPages: { key: string; address: string; html: string }[],
    items: (documents: Iterable<Document>, core: Core) => Parameters<typeof checkEach>[1],
  ) => {
    const library = await openLibrary({
      name: `support-${name}`,
      embedder: createWorkerEmbedder(),
      documents,
      webPages,
      keep: config.keepData,
      embeddings: false,
      log,
    });
    try {
      const { core } = library;
      // Setting the variables is the consent to send the sentences and Passages to the model.
      core.on("consent.requested", (request) => {
        void core.respondToConsent(request.requestId, request.flow.id === "checks");
      });
      const provider = await core.saveChatProvider(chatProviderOf(chat));
      const model = { providerId: provider.id, modelId: chat.modelId };
      const wanted = items(library.documents.values(), core)
        .filter((each) => !only || only.split(",").includes(each.id))
        .flatMap((each) => Array.from({ length: repeats }, () => each));
      log(`${chat.modelId} · ${arm} · ${name}: ${wanted.length} sentences`);
      rows.push(...(await checkEach(core, wanted, model, spend, log)));
    } finally {
      await library.close();
    }
  };

  if (sets.includes("cases")) {
    const folder = await mkdtemp(join(tmpdir(), "incarnamind-support-"));
    try {
      const documents = await Promise.all(
        DOCUMENTS.map(async ({ name, contents }) => {
          const path = join(folder, name);
          await writeFile(path, contents);
          return { key: name, path };
        }),
      );
      await run("cases", documents, [], (added, core) => {
        const all = [...added];
        return CASES.map((each) => ({
          ...each,
          cited: () => citedQuote(core, all, each.document, each.quote),
        }));
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  if (sets.includes("supported")) {
    const set = await readChecksSet(ROOT);
    const files = set.folder.filter((document) => !document.address);
    const webPages = await Promise.all(
      set.folder.flatMap(({ name, path, address }) =>
        address
          ? [readFile(join(ROOT, path), "utf8").then((html) => ({ key: name, address, html }))]
          : [],
      ),
    );
    await run(
      "supported",
      files.map((document) => ({ key: document.name, path: join(ROOT, document.path) })),
      webPages,
      (added, core) => {
        const all = [...added];
        const shownName = (labelled: string) =>
          all.find((each) => each.name === labelled || labelled.startsWith(`${each.name}.`))
            ?.name ?? labelled;
        return set.items.flatMap((item) =>
          item.set === "find-support" &&
          item.label === "supported" &&
          item.evidence &&
          DATED.test(item.sentence)
            ? [
                {
                  id: item.id,
                  set: "supported",
                  language: item.language === "zh" ? "zh-CN" : "en",
                  sentence: item.sentence,
                  supported: true,
                  cited: () => {
                    const evidence = item.evidence;
                    if (!evidence) throw new Error(`${item.id} has no evidence.`);
                    return citedQuote(core, all, shownName(evidence.document), evidence.quote);
                  },
                },
              ]
            : [],
        );
      },
    );
  }

  const out = join(
    config.resultsDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-support-${chat.modelId}-${arm}`,
  );
  await mkdir(out, { recursive: true });
  const lines = summary(rows);
  await writeFile(
    join(out, "report.json"),
    JSON.stringify(
      { commit: commitOf(ROOT), model: chat.modelId, arm, spent: spend.total, lines, rows },
      null,
      2,
    ),
  );
  for (const line of lines) log(line);
  log(`$${spend.total.toFixed(4)} spent; report in ${out}`);
});
