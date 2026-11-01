import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_CHECK_ARGUMENT, type EngineModuleCheck } from "../../src/core/engineModules";
import type { AnalysisEnd } from "../../src/shared/analysis";

/** How each fake engine process answers, by its module. */
type Answer = { found: EngineModuleCheck[] } | { exitCode: number } | { fatal: string };

const engines = vi.hoisted(() => ({
  answers: new Map<string, Answer>(),
  forks: [] as { path: string; args: string[]; serviceName: string }[],
  pythonEnd: { kind: "done" } as AnalysisEnd,
  pictures: 1,
  withoutGlyphs: [] as string[],
  exits: [] as number[],
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: { exit: (code: number) => engines.exits.push(code) },
    utilityProcess: {
      fork: (path: string, args: string[], options: { serviceName: string }) => {
        engines.forks.push({ path, args, serviceName: options.serviceName });
        const child = new EventEmitter();
        Object.assign(child, { kill: () => setImmediate(() => child.emit("exit", 0)) });
        const answer = engines.answers.get(path) ?? { found: [] };
        setImmediate(() => {
          if ("found" in answer) child.emit("message", answer.found);
          else if ("fatal" in answer) {
            child.emit("error", "FatalError", answer.fatal, "");
            child.emit("exit", 133);
          } else child.emit("exit", answer.exitCode);
        });
        return child;
      },
    },
  };
});
vi.mock("../../src/main/embedderProcess?modulePath", () => ({ default: "embedder.js" }));
vi.mock("../../src/main/rerankerProcess?modulePath", () => ({ default: "reranker.js" }));
vi.mock("../../src/main/scanReaderProcess?modulePath", () => ({ default: "scanReader.js" }));
vi.mock("../../src/main/transcriberProcess?modulePath", () => ({ default: "transcriber.js" }));
vi.mock("../../src/main/speakerProcess?modulePath", () => ({ default: "speaker.js" }));
vi.mock("../../src/main/platform", () => ({
  seccompHelper: () => undefined,
  analysisRuntime: () => ({
    languages: [],
    run: async () => ({
      end: engines.pythonEnd,
      output: {
        withoutGlyphs: engines.withoutGlyphs,
        pictures: Array.from({ length: engines.pictures }, () => ({
          title: "",
          png: "iVBORw0KGgo",
          width: 640,
          height: 480,
        })),
      },
      ms: 1,
    }),
    close: () => undefined,
  }),
}));

const { checkEngines, runEngineCheck } = await import("../../src/main/engineCheck");

const log = { info() {}, warn() {}, error() {}, exception() {}, console() {} };
const loaded = (module: string): EngineModuleCheck => ({ module, problem: null });

beforeEach(() => {
  engines.answers.clear();
  engines.forks.length = 0;
  engines.exits.length = 0;
  engines.pythonEnd = { kind: "done" };
  engines.pictures = 1;
  engines.withoutGlyphs = [];
  engines.answers.set("embedder.js", { found: [loaded("onnxruntime-node")] });
  engines.answers.set("transcriber.js", { found: [loaded("sherpa-onnx-node")] });
});

describe("The engine check", () => {
  it("starts every engine process as the app does, only to load its modules", async () => {
    await checkEngines(log);
    expect(engines.forks).toEqual(
      ["embedder.js", "reranker.js", "scanReader.js", "transcriber.js", "speaker.js"].map(
        (path) => ({
          path,
          args: [ENGINE_CHECK_ARGUMENT],
          serviceName: expect.stringMatching(/^IncarnaMind /),
        }),
      ),
    );
  });

  it("says which process loaded each module, and names a process that stopped before it answered", async () => {
    engines.answers.set("speaker.js", { exitCode: 1 });
    const checks = await checkEngines(log);
    expect(checks).toEqual(
      expect.arrayContaining([
        { process: "IncarnaMind embedding", module: "onnxruntime-node", problem: null },
        { process: "IncarnaMind transcription", module: "sherpa-onnx-node", problem: null },
        {
          process: "IncarnaMind speakers",
          module: null,
          problem: "stopped before it answered (exit code 1)",
        },
        {
          process: "Analyses window",
          module: "Pyodide, numpy, pandas, scipy, statsmodels, scikit-learn and matplotlib",
          problem: null,
        },
      ]),
    );
  });

  it("says where a process that hit a fatal error stopped", async () => {
    engines.answers.set("scanReader.js", { fatal: "v8::internal::Heap::FatalProcessOutOfMemory" });
    const checks = await checkEngines(log);
    expect(checks).toContainEqual({
      process: "IncarnaMind text recognition",
      module: null,
      problem: "stopped with a FatalError at v8::internal::Heap::FatalProcessOutOfMemory",
    });
  });

  it("gives Python's own message when Pyodide or its packages don't load", async () => {
    engines.pythonEnd = {
      kind: "error",
      message: "ModuleNotFoundError: No module named 'pandas'",
      line: 1,
    };
    const checks = await checkEngines(log);
    expect(checks.find((each) => each.process === "Analyses window")?.problem).toBe(
      "ModuleNotFoundError: No module named 'pandas'",
    );
  });

  it("says so when the models ran but matplotlib drew no picture", async () => {
    engines.pictures = 0;
    const checks = await checkEngines(log);
    expect(checks.find((each) => each.process === "Analyses window")?.problem).toBe(
      "matplotlib drew no picture",
    );
    engines.pictures = 1;
    const again = await checkEngines(log);
    expect(again.find((each) => each.process === "Analyses window")?.problem).toBeNull();
  });

  it("says so when a plot's Chinese couldn't be drawn with the bundled font", async () => {
    engines.pictures = 0;
    engines.withoutGlyphs = ["各地区收入"];
    const checks = await checkEngines(log);
    expect(checks.find((each) => each.process === "Analyses window")?.problem).toBe(
      "matplotlib couldn't draw a plot's Chinese title with the bundled font",
    );
  });
});

describe("Running the engine check", () => {
  let folder = "";
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "incarnamind-engine-check-"));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("writes what it found and exits with 0 when everything loaded", async () => {
    const report = join(folder, "engines.json");
    await runEngineCheck(report, log);
    const written = JSON.parse(await readFile(report, "utf8"));
    expect(written.platform).toBe(process.platform);
    expect(written.checks).toContainEqual({
      process: "IncarnaMind transcription",
      module: "sherpa-onnx-node",
      problem: null,
    });
    expect(engines.exits).toEqual([0]);
  });

  it("exits with 1 when a module didn't load", async () => {
    engines.answers.set("transcriber.js", {
      found: [{ module: "sherpa-onnx-node", problem: "sherpa-onnx-node loaded without Vad" }],
    });
    await runEngineCheck(join(folder, "engines.json"), log);
    expect(engines.exits).toEqual([1]);
  });
});
