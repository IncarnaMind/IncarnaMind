import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { EngineCheck, EngineCheckReport } from "../../src/main/engineCheck";
import { APP_ARGS, homeEnv, KEYCHAIN_ARGS } from "../../tests/helpers/home";
import { launchEnvironment } from "../launchEnvironment";
import { packagedExecutable, packagedLogLines } from "./app";

test.use({ trace: "off" });

/** Python's first start in the Analyses window may take two minutes on a slow runner (src/main/analysis.ts). */
const CHECK_LIMIT_MS = 5 * 60_000;

/** Every engine module, in the process that loads it, as the app on `platform` runs them. */
const expected = (platform: NodeJS.Platform): string[] => [
  "IncarnaMind embedding: onnxruntime-node",
  "IncarnaMind embedding: @huggingface/tokenizers",
  "IncarnaMind reranking: onnxruntime-node",
  "IncarnaMind reranking: @huggingface/tokenizers",
  "IncarnaMind text recognition: onnxruntime-node",
  "IncarnaMind text recognition: @napi-rs/canvas",
  "IncarnaMind transcription: sherpa-onnx-node",
  "IncarnaMind transcription: sherpa-onnx-node/addon.js",
  "IncarnaMind speakers: sherpa-onnx-node",
  ...(platform === "win32" ? [] : ["main process: @anthropic-ai/sandbox-runtime"]),
  ...(platform === "linux" ? ["main process: sandbox-runtime's seccomp helper"] : []),
  "Analyses window: Pyodide, numpy, pandas, scipy, statsmodels, scikit-learn and matplotlib",
];

const described = (check: EngineCheck) =>
  `${check.module ?? "the process"} in ${check.process}: ${check.problem ?? "loaded"}`;

let dataDir = "";
const folders: string[] = [];

test.afterEach(async () => {
  const testInfo = test.info();
  if (testInfo.status !== testInfo.expectedStatus && dataDir) {
    const lines = await packagedLogLines(dataDir, /ERROR|WARN/);
    await testInfo.attach("app log", { body: lines.join("\n"), contentType: "text/plain" });
    console.log(lines.slice(-30).join("\n"));
  }
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

function runCheck(report: string, home: string): Promise<{ code: number | null; output: string }> {
  const temp = join(home, "Temp");
  return new Promise((resolve, reject) => {
    const child = spawn(
      packagedExecutable,
      [`--check-engines=${report}`, ...KEYCHAIN_ARGS, ...APP_ARGS],
      {
        env: launchEnvironment({
          ...homeEnv(home),
          TMPDIR: temp,
          TMP: temp,
          TEMP: temp,
          INCARNAMIND_DATA_DIR: dataDir,
          ORT_DISABLE_TELEMETRY: "1",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const keep = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const limit = setTimeout(() => child.kill(), CHECK_LIMIT_MS);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(limit);
      resolve({ code, output: output.slice(-8_000) });
    });
  });
}

// protects=a release never ships an engine that can't load (#1239): the packaged app, as built for this platform, loads each engine's native module in the process that runs it, through the engine's own loader, and finds every function the app calls, the way #1233 failed only in the built app while every test passed on the fake engines; then Python starts in the Analyses window from the packaged files and runs a regression, a forecast, a clustering and a plot with a Chinese title, drawn with the bundled font, offline; fails_when=a module is left out of the package or inside app.asar, its platform's build is missing, it loads without what the code calls (a CommonJS package through a native import()), an engine process can't start, or Pyodide, numpy, pandas, scipy, statsmodels, scikit-learn or matplotlib don't load or run, or the plot's Chinese can't be drawn; no_claim=any model (none is downloaded), what an engine computes (the real-engine specs beside this one), or Analyses' isolation (e2e/analysis.spec.ts).
test("the packaged app loads every engine's modules, each in the process that runs it", async () => {
  test.setTimeout(CHECK_LIMIT_MS + 60_000);
  expect(existsSync(packagedExecutable), `${packagedExecutable}: run npm run dist:dir first`).toBe(
    true,
  );
  const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
  dataDir = await mkdtemp(join(tmpdir(), "incarnamind-data-"));
  folders.push(home, dataDir);
  await mkdir(join(home, "Temp"));
  const report = join(home, "engines.json");

  const { code, output } = await runCheck(report, home);
  expect(existsSync(report), `The check wrote no report (exit code ${code}):\n${output}`).toBe(
    true,
  );
  const { platform, arch, checks }: EngineCheckReport = JSON.parse(await readFile(report, "utf8"));
  console.log(`${packagedExecutable} (${platform} ${arch}):\n${checks.map(described).join("\n")}`);

  expect(
    checks.filter((each) => each.problem !== null).map(described),
    "Engine modules that didn't load",
  ).toEqual([]);
  expect(checks.map((each) => `${each.process}: ${each.module}`).sort()).toEqual(
    expected(platform).sort(),
  );
  expect(code, output).toBe(0);
});
