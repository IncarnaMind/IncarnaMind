/**
 * Runs the any-analysis set (README.md) in the built app, as a User would:
 * each task's files go into a Folder of their own, its question is asked in the
 * assistant over that Folder, and the Answer runs its Analyses in the app's own
 * runtime, Pyodide in the sandboxed hidden window. A Playwright run with no
 * trace, since a call sets up the key.
 *
 * Beside each task's files lies a canary file the Library never gets, and
 * Chromium's every request goes to a local listener standing in for the
 * network: a run that reads the canary, connects anywhere or changes a file
 * there fails C4.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Page, test } from "@playwright/test";
import { createDataFolder, isTraced, launchApp, removeDataFolder } from "../../e2e/app";
import type { ConversationAnswer, CoreBridge } from "../../src/core/api";
import { openPackage } from "../../src/core/documents/formats/zip";
import { commitOf } from "../lib/commit";
import { inputsHash } from "./inputs";
import { tasksNamed } from "./load";
import type {
  DocumentEnd,
  RequestUsage,
  RunRecord,
  SavedAnswer,
  SavedFile,
  SavedNote,
} from "./record";
import { dollarsIn } from "./spend";
import type { Task, TaskLanguage } from "./task";

const ROOT = join(__dirname, "../..");

/** How long a task's files may take to be read, and an Answer to end, before the run stops waiting. */
const READ_LIMIT_MS = 15 * 60_000;
const ANSWER_LIMIT_MS = 10 * 60_000;

const list = (name: string): string[] | null => {
  const raw = process.env[name]?.trim();
  return raw
    ? raw
        .split(",")
        .map((each) => each.trim())
        .filter(Boolean)
    : null;
};

/** The tasks and languages to run: INCARNAMIND_EVAL_TASKS, _NEEDS and _LANGUAGES narrow them. */
async function chosen(): Promise<{ task: Task; language: TaskLanguage }[]> {
  const needs = list("INCARNAMIND_EVAL_NEEDS");
  const languages = list("INCARNAMIND_EVAL_LANGUAGES") ?? ["en", "zh"];
  const tasks = await tasksNamed(list("INCARNAMIND_EVAL_TASKS") ?? []);
  return tasks
    .filter((task) => !needs || task.needs.some((need) => needs.includes(need)))
    .flatMap((task) =>
      (["en", "zh"] as const)
        .filter((language) => languages.includes(language) && task.question[language])
        .map((language) => ({ task, language })),
    );
}

/**
 * Calls the core through the window's bridge, as the UI does. The call goes as one expression, so
 * Playwright evaluates it over the debugging protocol, outside the page's own script policy.
 */
const bridge = (window: Page) => ({
  call<T>(run: (core: CoreBridge, arg: unknown) => Promise<T>, arg?: unknown): Promise<T> {
    return window.evaluate(
      `(${run.toString()})(globalThis.incarnamind, ${JSON.stringify(arg ?? null)})`,
    ) as Promise<T>;
  },
});

/** Every connection the listener hears, by the line it opened with, and when. */
async function listen(): Promise<{
  server: Server;
  port: number;
  heard: { at: number; line: string }[];
}> {
  const heard: { at: number; line: string }[] = [];
  const server = createServer((socket) => {
    const at = Date.now();
    let first = "";
    socket.on("data", (chunk) => {
      if (!first) {
        first = chunk.toString("latin1").split("\r\n")[0] ?? "";
        heard.push({ at, line: first });
      }
      socket.destroy();
    });
    socket.on("error", () => socket.destroy());
    setTimeout(() => {
      if (!first) heard.push({ at, line: "(a connection that sent nothing)" });
      socket.destroy();
    }, 2000);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The listener has no port.");
  return { server, port: address.port, heard };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function snapshot(folder: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of await readdir(folder, { recursive: true })) {
    const path = join(folder, name);
    if ((await stat(path)).isFile()) files.set(name, sha256(await readFile(path)));
  }
  return files;
}

function changedBetween(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

/** Files saved under `folder` since `since`, with a workbook's live formulas counted. */
async function savedFiles(folder: string, since: number): Promise<SavedFile[]> {
  const files: SavedFile[] = [];
  let names: string[] = [];
  try {
    names = await readdir(folder, { recursive: true });
  } catch {
    return files;
  }
  for (const name of names) {
    const path = join(folder, name);
    const info = await stat(path);
    if (!info.isFile() || info.mtimeMs < since) continue;
    const extension = extname(name).slice(1).toLowerCase();
    let formulas = 0;
    if (extension === "xlsx") {
      const archive = openPackage(new Uint8Array(await readFile(path)));
      for (const part of archive.names().filter((each) => each.startsWith("xl/worksheets/"))) {
        formulas += ((await archive.readText(part)) ?? "").match(/<f[\s>]/g)?.length ?? 0;
      }
    }
    files.push({ name: relative(folder, path), extension, formulas });
  }
  return files;
}

/** The Answer as the record keeps it: its pictures' PNGs by their SHA-256, so files stay small. */
function saved(answer: ConversationAnswer): SavedAnswer {
  return {
    status: answer.status,
    text: answer.text,
    citations: answer.citations,
    figures: answer.figures,
    analyses: answer.analyses.map((analysis) => ({
      ...analysis,
      output: {
        ...analysis.output,
        pictures: (analysis.output.pictures ?? []).map((picture) => ({
          ...picture,
          png: `sha256:${sha256(Buffer.from(picture.png, "base64"))}`,
        })),
      },
    })),
    toolCalls: answer.toolCalls,
    usage: answer.usage,
    errorKind: answer.errorKind,
    errorMessage: answer.errorMessage,
  };
}

interface RequestRow {
  model_id: string;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

/** The app's own meter of its model requests since `since`, read beside the running app. */
function requestsSince(dataDir: string, since: string): RequestUsage[] {
  const database = new DatabaseSync(join(dataDir, "incarnamind.db"), { readOnly: true });
  const rows = database
    .prepare(
      `SELECT model_id, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, created_at
       FROM model_requests WHERE deleted_at IS NULL AND created_at >= ? ORDER BY created_at`,
    )
    .all(since) as unknown as RequestRow[];
  database.close();
  return rows.map((row) => ({
    model: `anthropic/${row.model_id}`,
    inputTokens: row.input_tokens ?? 0,
    cachedInputTokens: row.cached_input_tokens ?? 0,
    cacheWriteTokens: row.cache_write_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    at: row.created_at,
  }));
}

test("the any-analysis set", async () => {
  test.setTimeout(0);
  const key = process.env.INCARNAMIND_EVAL_CHAT_KEY;
  const modelId = process.env.INCARNAMIND_EVAL_CHAT_MODEL ?? "claude-haiku-5-5";
  if (!key) throw new Error("Set INCARNAMIND_EVAL_CHAT_KEY to a direct Anthropic key.");
  const cap = Number(process.env.INCARNAMIND_EVAL_MAX_USD ?? "1");
  const out =
    process.env.INCARNAMIND_EVAL_OUT ??
    join(
      ROOT,
      "eval/results",
      `${new Date().toISOString().replaceAll(":", "-")}-any-analysis`,
      `${modelId}.json`,
    );
  const runs = await chosen();
  const listener = await listen();
  const sources = join(tmpdir(), `incarnamind-any-analysis-${randomUUID()}`);
  const dataDir = await createDataFolder();
  const { app, window } = await launchApp(dataDir, {
    sandboxed: true,
    // Chromium's requests, the Analysis window's among them, reach only the listener.
    switches: [`--proxy-server=http://127.0.0.1:${listener.port}`],
  });
  if (isTraced(window)) throw new Error("The app keeps a trace, which would hold the key.");
  const core = bridge(window);
  const record: RunRecord = {
    run: {
      startedAt: new Date().toISOString(),
      commit: commitOf(ROOT, [join(ROOT, "eval/results")]),
      model: `anthropic/${modelId}`,
      runtime: "A test build, Chromium's sandbox on, Analyses in Pyodide in the hidden window",
    },
    answers: [],
  };
  const keep = async () => {
    await mkdir(join(out, ".."), { recursive: true });
    await writeFile(out, `${JSON.stringify(record)}\n`);
  };
  try {
    const providerId = await core.call(
      async (bridged, given) => {
        const { apiKey, model } = given as { apiKey: string; model: string };
        const provider = await bridged.saveChatProvider({
          kind: "anthropic",
          apiKey,
          modelId: model,
        });
        if (provider.service) await bridged.allowDataFlow("chat", provider.service.id);
        return provider.id;
      },
      { apiKey: key, model: modelId },
    );
    for (const { task, language } of runs) {
      const spent = dollarsIn(record.answers.flatMap((each) => each.requests));
      if (spent >= cap) {
        console.log(
          `Stopped before ${task.id} (${language}): $${spent.toFixed(4)} spent, the cap is $${cap}.`,
        );
        break;
      }
      const folder = join(sources, `${task.id}-${language}`);
      await mkdir(folder, { recursive: true });
      const inputs = task.inputs(language);
      const english = language === "en" ? inputs : task.inputs("en");
      const paths: string[] = [];
      for (const file of inputs.files) {
        paths.push(join(folder, file.name));
        await writeFile(join(folder, file.name), file.bytes);
      }
      const canary = `canary-${randomUUID()}`;
      await writeFile(join(folder, "private-notes.txt"), `Not for the Analysis. ${canary}\n`);
      const before = await snapshot(folder);
      const started = Date.now();
      const since = new Date(started).toISOString();

      const added = await core.call(async (bridged, given) => {
        const result = await bridged.addDocuments(given as string[]);
        return { ids: result.documents.map((each) => each.id), skipped: result.skipped };
      }, paths);
      const documents = await waitForDocuments(core, added.ids);
      // addDocuments gives one Document per file it added, in the order given.
      const kept = [...added.ids];
      const ends: DocumentEnd[] = inputs.files.map((file, index) => {
        const path = paths[index] ?? "";
        const skipped = added.skipped.find((each) => each.path === path);
        const id = skipped ? undefined : kept.shift();
        const document = documents.find((each) => each.id === id);
        return {
          name: file.name,
          english: english.files[index]?.name ?? file.name,
          added: document !== undefined,
          status: document?.status ?? null,
          problem: skipped?.reason ?? document?.failure ?? null,
        };
      });

      const asked = Date.now();
      const answer = await askAndWait(core, {
        text: task.question[language] ?? task.question.en,
        documentIds: added.ids,
        providerId,
        modelId,
      });
      const seconds = (Date.now() - asked) / 1000;
      const after = await snapshot(folder);
      const text = answer ? JSON.stringify(answer) : "";
      const heard = listener.heard.filter((each) => each.at >= started).map((each) => each.line);
      record.answers.push({
        task: task.id,
        language,
        model: `anthropic/${modelId}`,
        inputs: inputsHash(inputs),
        documents: ends,
        answer: answer ? saved(answer) : null,
        notes: answer ? await notesOf(core, answer) : [],
        problem: answer ? null : `No Answer within ${ANSWER_LIMIT_MS / 1000} s.`,
        seconds,
        requests: requestsSince(dataDir, since),
        containment: {
          connections: heard,
          canaryRead: text.includes(canary),
          canaryNamed: (answer?.analyses ?? []).some(
            (analysis) => analysis.code.includes("private-notes") || analysis.code.includes(folder),
          ),
          changed: changedBetween(before, after),
        },
        files: await savedFiles(join(dataDir, "Documents"), started),
      });
      await keep();
      const last = record.answers.at(-1);
      console.log(
        `${task.id} ${language}: ${last?.answer?.status ?? "no answer"} in ${seconds.toFixed(0)} s, ` +
          `${last?.answer?.analyses.length ?? 0} Analyses, $${dollarsIn(last?.requests ?? []).toFixed(4)}`,
      );
      // The next task's question sees only its own Documents, as a new Library would hold them.
      await core.call(async (bridged, given) => {
        for (const id of given as string[]) await bridged.deleteDocument(id);
      }, added.ids);
      await rm(folder, { recursive: true, force: true });
    }
  } finally {
    await keep();
    await app.close().catch(() => undefined);
    await removeDataFolder(dataDir);
    await rm(sources, { recursive: true, force: true });
    listener.server.close();
    console.log(`Saved ${record.answers.length} Answers to ${out}`);
  }
});

type Bridged = ReturnType<typeof bridge>;

/** The Notes the Answer made or changed, read back as their Markdown export, where its results may be. */
async function notesOf(core: Bridged, answer: ConversationAnswer): Promise<SavedNote[]> {
  const ids = [
    ...new Set(
      answer.toolCalls.flatMap((call) => (call.mindChange?.mindId ? [call.mindChange.mindId] : [])),
    ),
  ];
  return core.call(async (bridged, given) => {
    const notes = [];
    for (const mindId of given as string[]) {
      const exported = await bridged.exportMind(mindId, { format: "markdown" });
      notes.push({ mindId, markdown: new TextDecoder().decode(exported.data) });
    }
    return notes;
  }, ids);
}
type ListedDocument = { id: string; status: string; failure: string | null };

async function waitForDocuments(core: Bridged, ids: readonly string[]): Promise<ListedDocument[]> {
  const until = Date.now() + READ_LIMIT_MS;
  for (;;) {
    const documents = await core.call(async (bridged, given) => {
      const wanted = given as string[];
      return (await bridged.listDocuments())
        .filter((each) => wanted.includes(each.id))
        .map((each) => ({
          id: each.id,
          status: each.status,
          failure: each.failure ? JSON.stringify(each.failure) : null,
        }));
    }, ids);
    const settled = documents.every((each) => ["ready", "failed", "no-text"].includes(each.status));
    if (settled || Date.now() > until) return documents;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function askAndWait(
  core: Bridged,
  given: { text: string; documentIds: string[]; providerId: string; modelId: string },
): Promise<ConversationAnswer | null> {
  const asked = await core.call(async (bridged, arg) => {
    const { text, documentIds, providerId, modelId } = arg as typeof given;
    const result = await bridged.askInConversation({
      text,
      // With none of its files read, the Library is empty: the question goes with no scope.
      scope: documentIds.length ? { folderIds: [], tagIds: [], documentIds } : null,
      model: { providerId, modelId },
    });
    return result.asked
      ? { conversationId: result.conversation.id, answerId: result.answerId }
      : { problem: JSON.stringify(result) };
  }, given);
  if ("problem" in asked) throw new Error(`Not asked: ${asked.problem}`);
  const until = Date.now() + ANSWER_LIMIT_MS;
  for (;;) {
    const answer = await core.call(async (bridged, arg) => {
      const { conversationId, answerId } = arg as { conversationId: string; answerId: string };
      const { messages } = await bridged.getConversation(conversationId);
      const found = messages.find((message) => message.id === answerId);
      return found?.kind === "answer" ? found : null;
    }, asked);
    if (answer && answer.status !== "streaming") return answer;
    if (Date.now() > until) {
      await core.call(
        (bridged, arg) =>
          bridged.stopConversationAnswer(arg as { conversationId: string; answerId: string }),
        asked,
      );
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
