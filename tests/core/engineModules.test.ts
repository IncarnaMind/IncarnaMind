import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { checkEngineModules, engineModule } from "../../src/core/engineModules";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

class Recognizer {
  static async createAsync() {
    return new Recognizer();
  }
  decode() {
    return "";
  }
}

describe("An engine module's loader", () => {
  test("gives the module when it has every function the app calls, on a class's prototype too", async () => {
    const loaded = { Recognizer, Vad: class {} };
    const module = engineModule("speech", async () => loaded, ["Recognizer.createAsync", "Vad"]);
    expect(await module.load()).toBe(loaded);
  });

  test("names the module and every function it loaded without", async () => {
    // A CommonJS package through a native import(): its exports only on `default` (#1233).
    const module = engineModule("sherpa-onnx-node", async () => ({ default: { Recognizer } }), [
      "Recognizer.createAsync",
      "Vad",
    ]);
    await expect(module.load()).rejects.toThrow(
      "sherpa-onnx-node loaded without Recognizer.createAsync, Vad",
    );
  });

  test("takes a value that isn't a function as missing", async () => {
    const module = engineModule("runtime", async () => ({ Tensor: 1, session: null }), [
      "Tensor",
      "session.create",
    ]);
    await expect(module.load()).rejects.toThrow("runtime loaded without Tensor, session.create");
  });
});

describe("Checking engine modules", () => {
  test("reports each module in turn, a failure as its problem, without throwing", async () => {
    const found = await checkEngineModules([
      engineModule("first", async () => ({ run() {} }), ["run"]),
      {
        name: "second",
        load: () => Promise.reject(new Error("Cannot find module 'second-darwin-x64'")),
      },
      engineModule("third", async () => ({}), ["run"]),
    ]);
    expect(found).toEqual([
      { module: "first", problem: null },
      { module: "second", problem: "Cannot find module 'second-darwin-x64'" },
      { module: "third", problem: "third loaded without run" },
    ]);
  });
});

// Node imports each module itself, through the app's own loader, as the built engine processes do:
// no bundler's interop (#1233, #1239). sandbox-runtime, an ES module, loads alike either way
// (tests/main/sandbox.test.ts).
const LOAD = `
  const { CANVAS, checkEngineModules, ONNX_RUNTIME, TOKENIZERS } = await import("./src/core/engineModules.ts");
  const { SHERPA, SHERPA_ADDON } = await import("./src/core/transcription/sherpa.ts");
  console.log(JSON.stringify(await checkEngineModules([ONNX_RUNTIME, TOKENIZERS, SHERPA, SHERPA_ADDON, CANVAS])));
`;

test("every engine module loads through its own loader when Node imports it", {
  timeout: 60_000,
}, () => {
  const output = execFileSync(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--import",
      "./scripts/tsResolve.mjs",
      "--input-type=module",
      "-e",
      LOAD,
    ],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, ORT_DISABLE_TELEMETRY: "1" } },
  );
  expect(JSON.parse(output.trim().split("\n").at(-1) ?? "[]")).toEqual([
    { module: "onnxruntime-node", problem: null },
    { module: "@huggingface/tokenizers", problem: null },
    { module: "sherpa-onnx-node", problem: null },
    { module: "sherpa-onnx-node/addon.js", problem: null },
    { module: "@napi-rs/canvas", problem: null },
  ]);
});
