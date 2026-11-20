import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { ChatLanguageModel } from "../../src/core/providers/models";
import {
  ask,
  documentAreasRequest,
  folderRequest,
  lookHereRequest,
  QUESTION_VERSION,
  READ_ORDERS,
  READER,
  READER_OUTPUT_TOKENS,
  type ReaderRequest,
} from "./lib/folderReader";

const text = z.string().min(1);
const language = z.enum(["en", "zh-CN"]);
const folder = z.object({ name: text, description: z.string() });
const document = z.object({ name: text, text: z.string() });
const numbered = z.object({ number: text, language });
const folders = numbered.extend({ ...folder.shape, half: z.union([z.literal(1), z.literal(2)]) });
const answers = numbered.extend({ folder, document });
const documents = document.extend({
  id: text,
  scanned: z.boolean(),
  language: z.enum(["en", "zh", "zh-CN"]),
});

interface Job {
  id: string;
  requests: ReaderRequest<unknown>[];
}

export function readerJobs(mode: string, input: unknown, half?: string): Job[] {
  let jobs: Job[];
  if (mode === "folders") {
    if (half !== "1" && half !== "2") throw Error("Choose one blind half with --half 1 or 2.");
    jobs = z
      .object({ items: z.array(folders) })
      .parse(input)
      .items.filter((item) => item.half === Number(half))
      .map((item) => ({
        id: item.number,
        requests: READ_ORDERS.map((order) => folderRequest(item, item.language, order)),
      }));
  } else if (mode === "answers") {
    jobs = z
      .object({ items: z.array(answers) })
      .parse(input)
      .items.map((item) => ({
        id: item.number,
        requests: [lookHereRequest(item.folder, item.document, item.language)],
      }));
  } else if (mode === "areas") {
    jobs = z
      .array(documents)
      .parse(input)
      .filter((item) => !item.scanned)
      .map((item) => ({
        id: item.id,
        requests: [documentAreasRequest(item, item.language === "en" ? "en" : "zh-CN")],
      }));
  } else throw Error("Choose folders, areas or answers.");
  if (!jobs.length || new Set(jobs.map((job) => job.id)).size !== jobs.length)
    throw Error("The reading needs distinct items and at least one question.");
  return jobs;
}

// Microdollars per token at the registered Opus 5.5 rates. An interrupted call keeps its reservation.
const INPUT = 4;
const OUTPUT = 20;
const CAP = 11_000_000;

export function readerLedger(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS calls (key TEXT PRIMARY KEY, amount INTEGER NOT NULL, reply TEXT) STRICT;`);
  const total = () =>
    Number(db.prepare("SELECT COALESCE(sum(amount), 0) AS used FROM calls").get()?.used);
  const pending = new Map<string, Promise<unknown>>();
  const send = async (
    model: ChatLanguageModel,
    request: ReaderRequest<unknown>,
    content: string,
    identity: string,
  ) => {
    const reserve = (Buffer.byteLength(content) + 2048) * INPUT + READER_OUTPUT_TOKENS * OUTPUT;
    db.exec("BEGIN IMMEDIATE");
    try {
      const saved = db.prepare("SELECT reply FROM calls WHERE key = ?").get(identity);
      if (saved) {
        if (typeof saved.reply !== "string")
          throw Error("This request is unsettled. Reconcile its charge before resuming.");
        const parsed: unknown = JSON.parse(saved.reply);
        db.exec("COMMIT");
        return parsed;
      }
      if (total() + reserve > CAP) throw Error("The $11 reader budget cannot cover this request.");
      db.prepare("INSERT INTO calls VALUES (?, ?, NULL)").run(identity, reserve);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const answer = await ask(model, request, {
      providerOptions: {
        anthropic: {
          effort: READER.effort,
          thinking: { type: "adaptive" },
          structuredOutputMode: "outputFormat",
          serviceTier: "standard_only",
        },
      },
      signal: AbortSignal.timeout(120_000),
    });
    const cost = answer.inputTokens * INPUT + answer.outputTokens * OUTPUT;
    if (cost > reserve) db.prepare("UPDATE calls SET amount = ? WHERE key = ?").run(cost, identity);
    if (!(answer.inputTokens > 0 && answer.outputTokens > 0 && cost <= reserve))
      throw Error("Unexpected token usage. Reconcile this request before resuming.");
    db.prepare("UPDATE calls SET amount = ?, reply = ? WHERE key = ?").run(
      cost,
      JSON.stringify(answer.value),
      identity,
    );
    return answer.value;
  };
  return {
    total,
    close: () => db.close(),
    read(model: ChatLanguageModel, request: ReaderRequest<unknown>) {
      const content = JSON.stringify([
        READER,
        request.name,
        request.instructions,
        request.prompt,
        request.schema,
      ]);
      const identity = createHash("sha256").update(content).digest("hex");
      const started = pending.get(identity);
      if (started) return started;
      const result = send(model, request, content, identity).finally(() =>
        pending.delete(identity),
      );
      pending.set(identity, result);
      return result;
    },
  };
}

async function main(args: string[]) {
  const {
    positionals: [mode],
    values,
  } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      input: { type: "string" },
      half: { type: "string" },
      ledger: { type: "string" },
      out: { type: "string" },
      pilot: { type: "boolean" },
      send: { type: "boolean" },
    },
  });
  if (!values.input || !mode) throw Error("Give a mode and --input.");
  let jobs = readerJobs(mode, JSON.parse(await readFile(values.input, "utf8")), values.half);
  if (values.pilot) jobs = jobs.slice(0, 3);
  console.log(
    `${jobs.length} items, ${jobs.reduce((n, job) => n + job.requests.length, 0)} requests; ${READER.modelId}, ${READER.effort}, questions ${QUESTION_VERSION}.`,
  );
  if (!values.send) return;
  if (!values.ledger || !values.out || !process.env.ANTHROPIC_API_KEY)
    throw Error("A paid read needs --ledger, --out and ANTHROPIC_API_KEY.");
  if (values.ledger === ":memory:" || resolve(values.out) === resolve(values.ledger))
    throw Error("The reading and its persistent ledger need separate files.");
  await access(dirname(values.out), constants.W_OK);
  try {
    await access(values.out);
    throw Error("The output already exists. Choose a new reading file.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const model = createAnthropic({
    baseURL: "https://api.anthropic.com/v1",
    apiKey: process.env.ANTHROPIC_API_KEY,
  })(READER.modelId);
  const ledger = readerLedger(values.ledger);
  const entries = new Map<string, unknown>();
  let cursor = 0;
  let stopped = false;
  async function worker() {
    try {
      while (!stopped && cursor < jobs.length) {
        const job = jobs[cursor++];
        if (!job) return;
        const reads = [];
        for (const request of job.requests) {
          if (stopped) return;
          reads.push(await ledger.read(model, request));
        }
        entries.set(job.id, mode === "folders" ? { reads } : reads[0]);
      }
    } catch (error) {
      stopped = true;
      throw error;
    }
  }
  try {
    const workers = await Promise.allSettled(Array.from({ length: values.pilot ? 1 : 4 }, worker));
    for (const done of workers) if (done.status === "rejected") throw done.reason;
    const result = {
      version: { ...READER, question: QUESTION_VERSION },
      [mode]: Object.fromEntries(jobs.map(({ id }) => [id, entries.get(id)])),
    };
    const tmp = `${values.out}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try {
      await link(tmp, values.out);
    } finally {
      await unlink(tmp);
    }
  } finally {
    console.log(`Reader spent or reserved: $${(ledger.total() / 1_000_000).toFixed(6)}`);
    ledger.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
