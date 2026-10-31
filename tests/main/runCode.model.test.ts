/**
 * A real model calling run_code (spike, docs/adr/0025): whether it gives its
 * figures with the cells they came from, so the app can check them. Runs
 * only with RUN_CODE_MODEL=1, an Anthropic key and RUN_CODE_PYTHON; writes
 * what each question came to, and its tokens, to RUN_CODE_MODEL_OUT.
 */
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { expect, test } from "vitest";
import { type CodeRun, createCodeRunner } from "../../src/core/runCode";
import { runCodeTool } from "../../src/core/runCode/tool";
import { createProcessLauncher } from "../../src/main/processes";
import { loadOsSandbox } from "../../src/main/sandbox";
import { createTempDataFolder } from "../helpers/core";

const python = process.env.RUN_CODE_PYTHON;
const site = process.env.RUN_CODE_SITE;
const MODEL = "claude-haiku-5-5";

const SALES = [
  "region,quarter,revenue",
  "North,Q1,120.5",
  "South,Q1,98",
  "East,Q1,143.25",
  "North,Q2,131",
  "South,Q2,101.5",
  "East,Q2,150",
  "North,Q3,128.75",
  "South,Q3,99",
  "East,Q3,162",
  "",
].join("\n");

const QUESTIONS = [
  "What was total revenue across all regions and quarters, and how much of it came from North?",
  "Which region had the highest revenue in Q3, and what was that revenue?",
  "What is South's average quarterly revenue?",
  "How much did East earn in the first two quarters combined?",
  "In how many region-quarters was revenue above 120?",
];

test.skipIf(process.env.RUN_CODE_MODEL !== "1" || !python || !process.env.ANTHROPIC_API_KEY)(
  "a real model gives run_code figures the app can check",
  async () => {
    const runtime = dirname(
      dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime")),
    );
    const sandbox = await loadOsSandbox({
      seccompHelper: join(runtime, "vendor", "seccomp", process.arch, "apply-seccomp"),
    });
    if (!sandbox.available || !python) throw new Error("no sandbox or no Python");
    const root = await realpath(await createTempDataFolder());
    const home = join(root, "home");
    const tempDir = join(root, "temp");
    await mkdir(home);
    await mkdir(tempDir);
    const csv = join(home, "sales.csv");
    await writeFile(csv, SALES);
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const runner = createCodeRunner({
      executor: sandbox.createExecutor({
        processes: createProcessLauncher(async () => env),
        environment: async () => env,
        tempDir,
        denyRead: [home, tempDir],
        reportError: () => undefined,
      }),
      tempDir,
      python: { command: python, ...(site ? { site } : {}) },
      limits: {
        fileBytes: 50 * 1024 * 1024,
        processes: 64,
        memoryBytes: 2 * 1024 ** 3,
        folderBytes: 200 * 1024 * 1024,
      },
      maxOutputBytes: 65_536,
      files: { count: 20, bytes: 5 * 1024 * 1024 },
    });
    const document = {
      documentId: "doc-sales",
      name: "sales.csv",
      path: csv,
      contentHash: createHash("sha256").update(SALES).digest("hex"),
    };
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const trials = [];
    for (const question of QUESTIONS) {
      const runs: CodeRun[] = [];
      const runCode = runCodeTool({
        runner,
        documentOf: (id) => (id === "P1" ? document : null),
        ran: (_id, run) => runs.push(run),
      });
      const result = await generateText({
        model: anthropic(MODEL),
        system:
          "You answer questions about the User's Documents. Work numbers out with run_code, never in your head. Give each figure you state with figure(...) when it is a sum, mean, minimum, maximum or count of a column, so it can be checked, and with result(...) otherwise. Write each figure's marker [=n] where its number goes.",
        prompt: `Passage P1 is from sales.csv (a CSV, 9 rows under the headings region, quarter, revenue):\nregion,quarter,revenue\nNorth,Q1,120.5\nSouth,Q1,98\n…\n\nQuestion: ${question}`,
        tools: {
          [runCode.name]: tool({
            description: runCode.description,
            inputSchema: jsonSchema<Record<string, unknown>>(runCode.inputSchema),
            execute: (input, { toolCallId, abortSignal }) =>
              runCode.call(input, {
                toolCallId,
                signal: abortSignal ?? new AbortController().signal,
                canCallAgain: () => true,
              }),
          }),
        },
        stopWhen: stepCountIs(4),
      });
      trials.push({
        question,
        requests: result.steps.length,
        usage: result.steps.map((step) => step.usage),
        calls: runs.length,
        figures: runs.flatMap((run) =>
          run.figures.map((figure) => ({
            name: figure.name,
            value: figure.value,
            how: figure.of?.how ?? null,
            rows: figure.of?.rows ?? null,
            check: figure.check.kind,
          })),
        ),
        exits: runs.map((run) => run.exec?.exitCode ?? null),
        errors: runs.map(
          (run) => run.refused ?? run.exec?.stderr.trim().split("\n").slice(-2).join(" | ") ?? "",
        ),
        code: runs.map((run) => run.codeSha256.slice(0, 12)),
        answer: result.text,
      });
    }
    const out = process.env.RUN_CODE_MODEL_OUT;
    if (out) await writeFile(out, JSON.stringify({ model: MODEL, trials }, null, 1));
    expect(trials.length).toBe(5);
  },
  600_000,
);
