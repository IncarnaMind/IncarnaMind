import { expect, test } from "vitest";
import { ENGINES, launchEnvironment, standIns } from "../../e2e/launchEnvironment";

test("an app takes from the test's environment only what it needs to run", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    TMPDIR: "/tmp/run",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    TZ: "Asia/Shanghai",
    DISPLAY: ":98",
    Path: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    ANTHROPIC_API_KEY: "sk-ant-planted",
    ANTHROPIC_API_KEY_2: "sk-ant-planted-alias",
    OPENAI_API_KEY: "sk-proj-planted",
    MOONSHOT_API_KEY: "sk-planted",
    INCARNAMIND_LIVE_ANTHROPIC_KEY: "sk-ant-planted-live",
    INCARNAMIND_EVAL_CHAT_KEY: "sk-ant-planted-eval",
    NIGHTLY_ANTHROPIC_KEY_1: "sk-ant-planted-nightly",
    GH_TOKEN: "ghp_planted",
    CSC_LINK: "planted-certificate",
    HTTPS_PROXY: "http://tester:PASSWORD@proxy:8080",
    http_proxy: "http://tester:PASSWORD@proxy:8080",
    NODE_OPTIONS: "--require ./planted.js",
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_RENDERER_URL: "http://localhost:5173",
    INCARNAMIND_CHATGPT_PROFILE: "/home/tester/.incarnamind-chatgpt-profile",
    INCARNAMIND_TEST_SCANS: "/tmp/scans.json",
    UNSET: undefined,
  };
  expect(launchEnvironment({}, parent)).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/tester",
    TMPDIR: "/tmp/run",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    TZ: "Asia/Shanghai",
    DISPLAY: ":98",
    Path: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  });
});

// The packaged telemetry check (#2145) needs the app started without the runtime's own opt-outs.
test("what ONNX Runtime reads as its own opt-out never comes from the test's environment", () => {
  const parent = { CI: "true", GITHUB_ACTIONS: "true", ORT_DISABLE_TELEMETRY: "1" };
  expect(launchEnvironment({}, parent)).toEqual({});
});

test("the launch's own values win, and one left undefined is not set", () => {
  const parent = { HOME: "/home/tester", OPENAI_API_KEY: "sk-proj-planted" };
  expect(
    launchEnvironment(
      { HOME: "/tmp/home", OPENAI_API_KEY: "sk-proj-made-up", INCARNAMIND_FAKE_CHAT: undefined },
      parent,
    ),
  ).toEqual({ HOME: "/tmp/home", OPENAI_API_KEY: "sk-proj-made-up" });
});

// Every smoke spec launches through launchApp with this environment unless it asks for a real engine (#534).
test("a launch stands in for all three engines by default, and reaches no model host", () => {
  expect(launchEnvironment(standIns(), {})).toEqual({
    INCARNAMIND_TEST_EMBEDDER: "fake",
    INCARNAMIND_TEST_OCR: "fake",
    INCARNAMIND_TEST_TRANSCRIBER: "fake",
  });
});

test("a launch that keeps one engine real leaves out that engine's flag alone and opens the model hosts", () => {
  expect(launchEnvironment(standIns(["ocr"]), {})).toEqual({
    INCARNAMIND_TEST_EMBEDDER: "fake",
    INCARNAMIND_TEST_TRANSCRIBER: "fake",
    INCARNAMIND_TEST_MODEL_HOSTS: "1",
  });
  expect(launchEnvironment(standIns(["embedder"]), {})).toEqual({
    INCARNAMIND_TEST_OCR: "fake",
    INCARNAMIND_TEST_TRANSCRIBER: "fake",
    INCARNAMIND_TEST_MODEL_HOSTS: "1",
  });
  expect(launchEnvironment(standIns(["transcriber"]), {})).toEqual({
    INCARNAMIND_TEST_EMBEDDER: "fake",
    INCARNAMIND_TEST_OCR: "fake",
    INCARNAMIND_TEST_MODEL_HOSTS: "1",
  });
  expect(launchEnvironment(standIns(ENGINES), {})).toEqual({ INCARNAMIND_TEST_MODEL_HOSTS: "1" });
});
