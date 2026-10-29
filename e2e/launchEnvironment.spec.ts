import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { isRecord } from "../src/core/errors";
import { unzip } from "../tests/helpers/docx";
import { createDataFolder, isTraced, launchApp, removeDataFolder, tracePath } from "./app";

let dataDir = "";

test.beforeEach(async () => {
  dataDir = await createDataFolder();
});

test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const mark = `planted-${randomUUID()}`;

/**
 * What a developer's shell or a job may hold: a provider's key, the same key under a second name,
 * two other providers' keys, the real-model tests' and the evaluation's keys, and a proxy's password.
 */
const PLANTED: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: `sk-ant-api03-${mark}-1`,
  ANTHROPIC_API_KEY_2: `sk-ant-api03-${mark}-2`,
  OPENAI_API_KEY: `sk-proj-${mark}-3`,
  MOONSHOT_API_KEY: `sk-${mark}-4`,
  INCARNAMIND_LIVE_ANTHROPIC_KEY: `sk-ant-api03-${mark}-5`,
  INCARNAMIND_EVAL_CHAT_KEY: `sk-ant-api03-${mark}-6`,
  HTTPS_PROXY: `http://tester:${mark}-7@127.0.0.1:9`,
};

async function withPlanted<T>(run: () => Promise<T>): Promise<T> {
  const before = Object.keys(PLANTED).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, PLANTED);
  try {
    return await run();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function launchedEnvironment(trace: Buffer | undefined): Map<string, string> {
  for (const line of (trace ?? "").toString().split("\n")) {
    if (!line.trim()) continue;
    const event: unknown = JSON.parse(line);
    if (!isRecord(event) || event.type !== "context-options" || !isRecord(event.options)) continue;
    const env = event.options.env;
    if (!Array.isArray(env)) throw new Error("The trace's context options hold no environment.");
    return new Map(env.filter(isRecord).map((each) => [String(each.name), String(each.value)]));
  }
  throw new Error("The trace holds no context options.");
}

test("a kept trace holds no key from the test's own environment, whatever its name", async () => {
  const madeUp = `sk-proj-made-up-${randomUUID()}`;
  const { app, window } = await withPlanted(() =>
    launchApp(dataDir, { trace: true, extraEnv: { OPENAI_API_KEY: madeUp } }),
  );
  expect(isTraced(window)).toBe(true);
  const names = await app.evaluate(() => Object.keys(process.env));
  expect(names.filter((name) => name in PLANTED)).toEqual(["OPENAI_API_KEY"]);
  expect(await app.evaluate(() => process.env.OPENAI_API_KEY)).toBe(madeUp);
  await app.close();

  const files = unzip(await readFile(tracePath(dataDir)));
  const env = launchedEnvironment(files.get("trace.trace"));
  expect(env.get("INCARNAMIND_DATA_DIR")).toBe(dataDir);
  expect([...env.keys()].filter((name) => name in PLANTED)).toEqual(["OPENAI_API_KEY"]);
  expect(env.get("OPENAI_API_KEY")).toBe(madeUp);

  const scanned = new Map(files);
  const logs = join(dataDir, "logs");
  for (const file of await readdir(logs))
    scanned.set(join(logs, file), await readFile(join(logs, file)));
  const holding = [...scanned]
    .filter(([name, content]) => name.includes(mark) || content.includes(mark))
    .map(([name]) => name);
  expect(holding).toEqual([]);
});
