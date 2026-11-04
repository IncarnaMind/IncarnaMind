/**
 * `npx vitest run --config eval/runCode/vitest.config.ts eval/runCode/pythonFailures.runcode.ts`
 * (#2351): what a real model does once run_code can't get Python, for each way it fails
 * (./pythonFailures). Python fails as it does in the app: a stand-in release on this computer
 * serves an archive whose interpreter can't import (load), one that doesn't match its SHA-256
 * (integrity), one that can't be unpacked (storage), or nothing listens (network). bash and the
 * Analysis in Pyodide (`run_analysis`, the app's own Pyodide run under Node) run for real.
 *
 * Settings: INCARNAMIND_EVAL_CHAT_* as for `npm run eval`; INCARNAMIND_EVAL_FAILURE_CASES, case ids
 * to run; INCARNAMIND_EVAL_SPEND_CAP, the most it may spend in USD (default 1). The report goes to
 * eval/results/.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import type { AnswerToolCall, ConversationAnswer, Core } from "../../src/core";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import type { PythonRuntimeManifest } from "../../src/core/runCode";
import { createProcessLauncher } from "../../src/main/processes";
import { createCodeHost } from "../../src/main/runCode/host";
import { type TarEntry, writeTarZst } from "../../src/main/runCode/tar";
import { loadOsSandbox, readDeniedFolders } from "../../src/main/sandbox";
import { codeToolOn } from "../../tests/helpers/models";
import { pyodideAnalysisRuntime } from "../../tests/helpers/pyodideAnalysis";
import { createSweepGuard } from "../../tests/helpers/sweepGuard";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import {
  FAILURE_CASES,
  type Failure,
  type FailureCase,
  type FailureDocuments,
  writeFailureDocuments,
} from "./pythonFailures";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** A stand-in runtime archive: an interpreter that exits 3, so its first import fails. */
async function archive(folder: string, name: string, extra: TarEntry[] = []): Promise<Buffer> {
  const interpreter = "#!/bin/sh\nexit 3\n";
  const entries: TarEntry[] = [
    { kind: "directory", path: "python", mode: 0o755, mtime: 1_700_000_000 },
    {
      kind: "file",
      path: "python/bin/python3",
      mode: 0o755,
      mtime: 1_700_000_000,
      size: Buffer.byteLength(interpreter),
    },
    ...extra,
  ];
  const path = join(folder, name);
  await writeTarZst(path, entries, () => Readable.from([Buffer.from(interpreter)]), 3);
  return readFile(path);
}

async function release(folder: string) {
  const files = new Map<string, Buffer>([
    ["load.tar.zst", await archive(folder, "load.tar.zst")],
    [
      "storage.tar.zst",
      await archive(folder, "storage.tar.zst", [
        {
          kind: "symlink",
          path: "python/lib",
          mode: 0o777,
          mtime: 1_700_000_000,
          target: "../../..",
        },
      ]),
    ],
  ]);
  const server = createServer((request, response) => {
    const bytes = files.get((request.url ?? "").slice(1));
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": bytes.byteLength });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const manifest = (file: string, sha256?: string): PythonRuntimeManifest => {
    const bytes = files.get(file) ?? Buffer.alloc(1000);
    return {
      file,
      url: `http://127.0.0.1:${port}/${file}`,
      size: bytes.byteLength,
      sha256: sha256 ?? createHash("sha256").update(bytes).digest("hex"),
      platform: `${process.platform}-${process.arch}`,
      python: "3.14.10",
      packages: {},
    };
  };
  const manifests: Record<Failure, PythonRuntimeManifest> = {
    load: manifest("load.tar.zst"),
    integrity: manifest("load.tar.zst", "0".repeat(64)),
    storage: manifest("storage.tar.zst"),
    // Nothing listens on the discard port.
    network: { ...manifest("load.tar.zst"), url: "http://127.0.0.1:9/load.tar.zst" },
  };
  return { manifests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

interface Observed {
  id: string;
  language: FailureCase["language"];
  failure: Failure;
  /** Each Analysis call in order: its Tool, language and how it ended. */
  calls: string[];
  /** run_code calls in Python after the first that couldn't get Python. */
  pythonRetries: number;
  bashCalls: number;
  runAnalysisDone: number;
  /** The figures the reply gives, as shown. */
  figures: string[];
  /** Numbers the reply typed outside its markers and Citations. */
  typedNumbers: string[];
  total?: number;
  count?: number;
  reply: string;
  seconds: number;
  spent: number;
  error?: string;
}

const typedNumbersIn = (text: string): string[] =>
  text.replace(/\[[^\]]*\]/g, " ").match(/\d[\d,.]*/g) ?? [];

const describeCall = (call: AnswerToolCall) => {
  const language =
    call.tool === "run_code" ? `/${call.input.language === "bash" ? "bash" : "python"}` : "";
  const end = call.analysis
    ? `${call.analysis.end}${call.analysis.python ? `:${call.analysis.python}` : ""}`
    : call.status;
  return `${call.tool}${language} ${end}`;
};

async function spentUsd(core: Core): Promise<number> {
  return (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((sum, each) => sum + each.amount, 0);
}

async function ask(core: Core, each: FailureCase): Promise<Observed> {
  const spentBefore = await spentUsd(core);
  const started = performance.now();
  const asked = await core.askInConversation({ text: each.question });
  if (!asked.asked) throw new Error(`${each.id} wasn't asked: ${JSON.stringify(asked)}`);
  let error: string | undefined;
  await new Promise<void>((resolve) => {
    const stops = [
      core.on("answer.finished", (event) => {
        if (event.answerId !== asked.answerId) return;
        for (const stop of stops) stop();
        resolve();
      }),
      core.on("answer.failed", (event) => {
        if (event.answerId !== asked.answerId) return;
        error = JSON.stringify(event);
        for (const stop of stops) stop();
        resolve();
      }),
    ];
  });
  const content = await core.getConversation(asked.conversation.id);
  const found = content.messages.find((message) => message.id === asked.answerId);
  const answer: ConversationAnswer | null = found?.kind === "answer" ? found : null;
  const calls = (answer?.toolCalls ?? []).filter(
    (call) => call.tool === "run_code" || call.tool === "run_analysis",
  );
  const python = (call: AnswerToolCall) =>
    call.tool === "run_code" && call.input.language !== "bash";
  const firstMiss = calls.findIndex((call) => call.analysis?.python !== undefined);
  return {
    id: each.id,
    language: each.language,
    failure: each.failure,
    calls: calls.map(describeCall),
    pythonRetries: firstMiss < 0 ? 0 : calls.slice(firstMiss + 1).filter(python).length,
    bashCalls: calls.filter((call) => call.tool === "run_code" && call.input.language === "bash")
      .length,
    runAnalysisDone: calls.filter(
      (call) => call.tool === "run_analysis" && call.analysis?.end === "done",
    ).length,
    figures: (answer?.figures ?? []).map((figure) => figure.shown),
    typedNumbers: typedNumbersIn(answer?.text ?? ""),
    ...(each.total !== undefined && { total: each.total }),
    ...(each.count !== undefined && { count: each.count }),
    reply: answer?.text ?? "",
    seconds: Math.round((performance.now() - started) / 100) / 10,
    spent: (await spentUsd(core)) - spentBefore,
    ...(error && { error }),
  };
}

test("run_code when Python can't be had", async () => {
  const started = new Date();
  const log = createLog(started.getTime());
  const config = readConfig(root);
  if (!config.chat) {
    log("python failures: skipped, it needs a real chat model (INCARNAMIND_EVAL_CHAT_*).");
    return;
  }
  const provider = chatProviderOf(config.chat);
  const cap = Number(process.env.INCARNAMIND_EVAL_SPEND_CAP ?? "1");
  const ids = process.env.INCARNAMIND_EVAL_FAILURE_CASES?.split(",").map((id) => id.trim());
  const cases = ids ? FAILURE_CASES.filter((each) => ids.includes(each.id)) : FAILURE_CASES;
  const sandbox = await loadOsSandbox();
  if (!sandbox.available) throw new Error(`The OS sandbox can't start here: ${sandbox.reason}`);
  const scratch = await mkdtemp(join(tmpdir(), "incarnamind-eval-python-failures-"));
  const served = await release(scratch);
  const analysisRuntime = await pyodideAnalysisRuntime();
  const guard = createSweepGuard();
  const observed: Observed[] = [];
  let spent = 0;
  try {
    const groups = new Map<string, FailureCase[]>();
    for (const each of cases) {
      const key = `${each.failure}|${each.documents}`;
      groups.set(key, [...(groups.get(key) ?? []), each]);
    }
    for (const [key, group] of groups) {
      if (spent >= cap) break;
      const [failure, documents] = key.split("|") as [Failure, FailureDocuments];
      const sources = await mkdtemp(join(scratch, "sources-"));
      const home = await mkdtemp(join(scratch, "home-"));
      const library = await openLibrary({
        name: `python-failure-${failure}-${documents}`,
        embedder: createFakeEmbedder(),
        documents: await writeFailureDocuments(sources, documents),
        embeddings: false,
        keep: config.keepData,
        log,
        analysisRuntime,
        ...codeToolOn(),
        executor: sandbox.createExecutor({
          processes: createProcessLauncher(async () => ({ PATH: "/usr/bin:/bin" })),
          environment: async () => ({ PATH: "/usr/bin:/bin" }),
          tempDir: tmpdir(),
          denyRead: readDeniedFolders({
            platform: process.platform,
            home,
            dataDir: home,
            temporaryFolder: tmpdir(),
          }),
          reportError: (problem) => log(`The sandbox couldn't clean up: ${String(problem)}`),
          runRecords: guard.records(join(home, "runs")),
          sweep: { stopper: guard.stopper },
        }),
        codeRuntime: createCodeHost({
          python: served.manifests[failure],
          font: null,
          appVersion: "eval",
        }),
      });
      try {
        const { core } = library;
        core.on("consent.requested", (request) => {
          void core.respondToConsent(request.requestId, true);
        });
        const saved = await core.saveChatProvider(provider);
        if (saved.service) await core.allowDataFlow("chat", saved.service.id);
        for (const each of group) {
          if (spent >= cap) break;
          const seen = await ask(core, each);
          spent += seen.spent;
          observed.push(seen);
          log(
            `${each.id} (${each.language}, ${failure}): ${seen.calls.join(", ") || "no Analysis"}; Python retries ${seen.pythonRetries}; figures ${seen.figures.join(" ") || "none"}; typed ${seen.typedNumbers.join(" ") || "none"} (${seen.seconds} s, $${seen.spent.toFixed(4)})`,
          );
        }
      } finally {
        await library.close();
      }
    }
  } finally {
    await served.close();
    await rm(scratch, { recursive: true, force: true });
  }
  const report = {
    run: {
      startedAt: started.toISOString(),
      commit: commitOf(root),
      model: `${provider.kind}/${provider.modelId}`,
      spentUsd: spent,
      capUsd: cap,
    },
    totals: {
      cases: observed.length,
      pythonRetries: observed.reduce((sum, each) => sum + each.pythonRetries, 0),
      withRetries: observed.filter((each) => each.pythonRetries > 0).length,
    },
    cases: observed,
  };
  const out = join(
    root,
    "eval",
    "results",
    `${started.toISOString().replaceAll(":", "-")}-python-failures.json`,
  );
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  log(`Spent $${spent.toFixed(4)}. Report: ${out}`);
});
