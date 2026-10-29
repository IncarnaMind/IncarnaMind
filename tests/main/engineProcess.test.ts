import { beforeEach, describe, expect, it, vi } from "vitest";
import { engineEnvironment } from "../../src/main/engineEnvironment";

interface Fork {
  path: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

const forks: Fork[] = vi.hoisted(() => []);

vi.mock("electron", () => ({
  utilityProcess: {
    fork: (path: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      forks.push({ path, args, env: options.env });
      return { postMessage: () => undefined, on: () => undefined, kill: () => undefined };
    },
  },
}));
vi.mock("../../src/main/embedderProcess?modulePath", () => ({ default: "embedder.js" }));
vi.mock("../../src/main/rerankerProcess?modulePath", () => ({ default: "reranker.js" }));
vi.mock("../../src/main/scanReaderProcess?modulePath", () => ({ default: "scanReader.js" }));
vi.mock("../../src/main/transcriberProcess?modulePath", () => ({ default: "transcriber.js" }));
vi.mock("../../src/main/speakerProcess?modulePath", () => ({ default: "speaker.js" }));

const { createUtilityProcessEmbedder } = await import("../../src/main/embedder");
const { createUtilityProcessCrossEncoder } = await import("../../src/main/reranker");
const { createUtilityProcessTextRecognizer } = await import("../../src/main/scanReader");
const { createUtilityProcessSeparator } = await import("../../src/main/speakerSeparator");
const { createUtilityProcessTranscriber } = await import("../../src/main/transcriber");

/** What the engine would load: these tests start the process and read how, not what it runs. */
const files = {} as never;

const engines: { name: string; module: string; start(): void }[] = [
  {
    name: "embedding",
    module: "embedder.js",
    start: () =>
      void createUtilityProcessEmbedder()
        .load(files)
        .catch(() => undefined),
  },
  {
    name: "reranking",
    module: "reranker.js",
    start: () =>
      void createUtilityProcessCrossEncoder()
        .load(files)
        .catch(() => undefined),
  },
  {
    name: "text recognition",
    module: "scanReader.js",
    start: () =>
      void createUtilityProcessTextRecognizer()
        .load(files)
        .catch(() => undefined),
  },
  {
    name: "speech",
    module: "transcriber.js",
    start: () =>
      void createUtilityProcessTranscriber()
        .load(files)
        .catch(() => undefined),
  },
  {
    name: "speakers",
    module: "speaker.js",
    start: () =>
      void createUtilityProcessSeparator()
        .separate({ parts: [], model: files })
        .catch(() => undefined),
  },
];

describe("engine processes", () => {
  beforeEach(() => {
    forks.length = 0;
  });

  it.each(engines)("start the $name process with ONNX Runtime's telemetry turned off", (engine) => {
    process.env.INCARNAMIND_ENGINE_TEST = "kept";
    engine.start();
    expect(forks).toHaveLength(1);
    expect(forks[0]?.path).toBe(engine.module);
    expect(forks[0]?.env?.ORT_DISABLE_TELEMETRY).toBe("1");
    expect(forks[0]?.env?.INCARNAMIND_ENGINE_TEST).toBe("kept");
  });
});

describe("engineEnvironment", () => {
  it("keeps the app's own environment", () => {
    expect(engineEnvironment({ PATH: "/bin", LANG: "zh_CN.UTF-8" }, "linux")).toMatchObject({
      PATH: "/bin",
      LANG: "zh_CN.UTF-8",
    });
  });

  it("turns telemetry off whatever the app was started with", () => {
    expect(engineEnvironment({ ORT_DISABLE_TELEMETRY: "0" }, "darwin").ORT_DISABLE_TELEMETRY).toBe(
      "1",
    );
  });

  it.each(["darwin", "linux"] as const)("sets only the documented opt-out on %s", (platform) => {
    expect(engineEnvironment({}, platform)).toEqual({ ORT_DISABLE_TELEMETRY: "1" });
  });

  it("also stops the Windows library registering its ETW provider", () => {
    expect(engineEnvironment({}, "win32")).toEqual({
      ORT_DISABLE_TELEMETRY: "1",
      ORT_RUNNING_UNIT_TESTS: "1",
    });
  });
});
