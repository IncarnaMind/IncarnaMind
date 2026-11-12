/**
 * Electron implementations of the core's adapters. This is the only place that
 * turns Electron APIs into capabilities the core can use.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { availableParallelism, homedir, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { app, net, safeStorage, session, shell } from "electron";
import { Agent, fetch as undiciFetch } from "undici";
import {
  type AnalysisRuntime,
  type AudioCapture,
  type Browser,
  BUILT_IN_SKILLS_PACKAGED,
  BUILT_IN_SKILLS_SOURCE,
  type CoreAdapters,
  type CrashReporter,
  createOllamaModels,
  type EmbeddingModelSource,
  type Executor,
  type FileShell,
  type Keychain,
  type Logger,
  type OllamaApp,
  type Transcriber,
  type UsageDataSender,
} from "../core";
import type { SystemCalendar } from "../core/adapters";
import { runAnalysis } from "../core/analysis";
import type { SandboxProblem } from "../core/api";
import { calendarStandIns, GOOGLE_CALENDAR, MICROSOFT_CALENDAR } from "../core/calendars/endpoints";
import {
  createFakeSystemCalendar,
  type FakeSystemCalendar,
  type SystemCalendarFixture,
} from "../core/calendars/fakeSystem";
import { scansAtOnce } from "../core/documents/processor";
import type { PageFetch } from "../core/documents/web/fetch";
import { isModelHost, type ModelCopies } from "../core/embedding/modelSources";
import { createFakeCapture, type FakeCapture, wavSamples } from "../core/meetings/fakeCapture";
import type { ModelFactsLayer } from "../core/providers/capabilities";
import { DECISION_HOSTS } from "../core/providers/catalog/decisions";
import { COPILOT_PROFILES } from "../core/providers/copilot/config";
import { type LocalServers, scriptedLocalServers } from "../core/providers/localServers";
import { type Resolve, systemResolve } from "../core/tools/web/addresses";
import type { FakeTranscriberOptions } from "../core/transcription/fake";
import { SHOW_AGENT_CONNECTION } from "../shared/agentConnection";
import type { AnalysisJob } from "../shared/analysis";
import { PLOT_FONT } from "../shared/analysisWindow";
import { createElectronAnalysisRuntime } from "./analysis";
import { createCitedPageCapture } from "./citedPageCapture";
import { createSentryCrashReporter } from "./crashReports";
import { documentsFolder } from "./documentsFolder";
import { createUtilityProcessEmbedder } from "./embedder";
import { createElectronAudioCapture } from "./meetings/capture";
import { createModelRuntimeFolder } from "./modelRuntimeFolder";
import { createOfficeConverter } from "./officeConverter";
import { createFakeOllamaApp, createOllamaApp } from "./ollamaApp";
import { createPageLook } from "./pageLook";
import { decodePictureToPng } from "./pictureDecode";
import { createElectronPictures } from "./pictures";
import { createElectronPrinter } from "./printPdf";
import { createLoginShellProcesses } from "./processes";
import { createUtilityProcessCrossEncoder } from "./reranker";
import { createCodeHost } from "./runCode/host";
import { readPythonManifest, runtimePlatform } from "./runCode/manifest";
import { interpreterRoots, loadOsSandbox, readDeniedFolders } from "./sandbox";
import { createUtilityProcessTextRecognizer } from "./scanReader";
import { createFileKeychain, SECRETS_FILE, type SecretCipher } from "./secretsFile";
import { createUtilityProcessSeparator } from "./speakerSeparator";
import { createSystemCalendar } from "./systemCalendar";
import { createUtilityProcessTranscriber } from "./transcriber";
import { createPostHogSender } from "./usageData";
import { systemUserName } from "./userName";

/**
 * `safeStorage` encrypts with a key held by the OS secret store: the macOS
 * Keychain, Windows DPAPI, or GNOME Keyring / KWallet on Linux. On Linux with
 * no keyring running it falls back to "basic_text", a hard-coded key, which
 * the core treats as plain text.
 */
function createSafeStorageCipher(log: Logger): { cipher: SecretCipher; ready: Promise<void> } {
  // Asked when the adapters are built, not on the first look at protection(): the
  // window must never be told keys are protected by the system store before it answers.
  const basicText =
    process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text";
  let encryptionAvailable: boolean | undefined;
  const ready = basicText
    ? Promise.resolve()
    : safeStorage.isAsyncEncryptionAvailable().then(
        (available) => {
          encryptionAvailable = available;
        },
        (error) => {
          log.warn("secrets.encryption", {
            reason: error instanceof Error ? error.message : String(error),
          });
          encryptionAvailable = false;
        },
      );

  return {
    cipher: {
      protection() {
        if (basicText) return "plain-text";
        // Until the answer is in, refuse rather than claim the system store protects keys.
        return encryptionAvailable === true ? "os" : "unavailable";
      },
      allowPlainText() {
        // Without this, safeStorage refuses to encrypt on Linux's basic_text backend.
        if (process.platform === "linux") safeStorage.setUsePlainTextEncryption(true);
      },
      encrypt: (plainText) => safeStorage.encryptStringAsync(plainText),
      decrypt: async (cipherText) => (await safeStorage.decryptStringAsync(cipherText)).result,
    },
    ready,
  };
}

/** Secrets encrypted with `safeStorage`, kept in a secrets file in the data folder, never in SQLite. */
function createSafeStorageKeychain(dataDir: string, cipher: SecretCipher): Keychain {
  return createFileKeychain(join(dataDir, SECRETS_FILE), cipher);
}

export const systemBrowser: Browser = {
  async open(url) {
    const { protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") {
      throw new Error(`Refusing to open a ${protocol} URL in the browser.`);
    }
    await shell.openExternal(url);
  },
};

/** The apps whose install links Settings → Agents opens (#351), and no others. */
const AGENT_LINK_SCHEMES = new Set(["cursor:"]);

/** Opens an agent's install link in its app: its app shows what it installs, and asks. */
async function openAgentLink(url: string): Promise<void> {
  const { protocol } = new URL(url);
  if (!AGENT_LINK_SCHEMES.has(protocol)) throw new Error(`Refusing to open a ${protocol} link.`);
  await shell.openExternal(url);
}

/**
 * Documents' files, opened in their default app or shown in the file
 * manager, where the User keeps them. `shell` is looked up at each call, so
 * the smoke tests can stand in for it.
 */
const fileShell: FileShell = {
  async openPath(path) {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  },
  showItemInFolder(path) {
    shell.showItemInFolder(path);
  },
};

/**
 * Test-only launch flag ("installed" or "missing"). Without it, the scripted chat model's
 * Ollama always runs, so a test that saves an Ollama provider needs no server.
 */
const testOllamaApp =
  import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_OLLAMA_APP : undefined;

function ollamaApp(): OllamaApp {
  if (import.meta.env.MODE === "test") {
    return createFakeOllamaApp(testOllamaApp === "installed" ? "installed" : "missing");
  }
  return createOllamaApp({
    platform: process.platform,
    home: app.getPath("home"),
    localAppData: process.env.LOCALAPPDATA,
    exists: existsSync,
    async openPath(path) {
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
    },
  });
}

/**
 * Local Connectors and Skill scripts start with the User's login-shell
 * environment, read once (see ./processes).
 */
const loginShellProcesses = createLoginShellProcesses({
  reportError: (error) =>
    console.warn("Couldn't read the login shell's environment; using the app's own.", error),
});

/**
 * In a packaged Linux app, sandbox-runtime's seccomp helper outside app.asar
 * (electron-builder.yml unpacks it), where bubblewrap can run it.
 */
export function seccompHelper(): string | undefined {
  if (process.platform !== "linux" || !app.isPackaged) return undefined;
  const runtime = join("node_modules", "@anthropic-ai", "sandbox-runtime");
  return join(
    process.resourcesPath,
    "app.asar.unpacked",
    runtime,
    "vendor",
    "seccomp",
    process.arch,
    "apply-seccomp",
  );
}

/**
 * The Executor Skill scripts run on (#65): the OS sandbox's, at level "os",
 * where it can start (macOS; Linux with bubblewrap). Elsewhere none is
 * given, and the core runs them at level "none", where each run asks first.
 * Found out once, at startup: the log says which, and why not "os". Call
 * once `userData` is set.
 */
export async function chooseExecutor(
  log: Logger,
): Promise<{ executor?: Executor; problem?: SandboxProblem }> {
  try {
    const sandbox = await loadOsSandbox({ seccompHelper: seccompHelper() });
    if (!sandbox.available) {
      log.info("scripts.sandbox", { level: "none", reason: sandbox.reason });
      return sandbox.problem ? { problem: sandbox.problem } : {};
    }
    log.info("scripts.sandbox", { level: "os" });
    const executor = sandbox.createExecutor({
      processes: loginShellProcesses,
      environment: () => loginShellProcesses.environment(),
      tempDir: tmpdir(),
      denyRead: readDeniedFolders({
        platform: process.platform,
        home: app.getPath("home"),
        dataDir: app.getPath("userData"),
        temporaryFolder: tmpdir(),
        uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      }),
      interpreterRoots: interpreterRoots({ platform: process.platform, home: app.getPath("home") }),
      reportError: (error) => console.error(error),
      runRecords: join(app.getPath("userData"), "runs"),
      log,
    });
    return { executor };
  } catch (error) {
    log.error("scripts.sandbox", {
      level: "none",
      reason: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * Test-only launch flags, one for each engine: the smoke tests run a deterministic fake
 * embedding model (and reranking model) and a fake text recognition model in the utility
 * processes, so no model is downloaded. An engine whose flag is left out runs for real (#534).
 * Only a test build (`electron-vite build --mode test`) honours them.
 */
const fakeEmbedder =
  import.meta.env.MODE === "test" && process.env.INCARNAMIND_TEST_EMBEDDER === "fake";
const fakeRecognizer =
  import.meta.env.MODE === "test" && process.env.INCARNAMIND_TEST_OCR === "fake";

/** With the fake text recognition model, what it reads on each scanned page (#397). */
const fakeScans = fakeRecognizer ? (process.env.INCARNAMIND_TEST_SCANS ?? null) : null;
/** With it, how many scans are read at once (#1502), whatever the computer. */
const testScansAtOnce = fakeRecognizer
  ? Number(process.env.INCARNAMIND_TEST_SCANS_AT_ONCE ?? 0)
  : 0;
/**
 * With the fake models, the search model's (and the speech model's) files at a stand-in and
 * IncarnaMind's copies at others (#1578), as JSON, so a smoke test can fail a download at every source.
 */
const testModelDownloads: {
  source: EmbeddingModelSource;
  copies: ModelCopies;
  speech?: { model: EmbeddingModelSource; vad: EmbeddingModelSource };
} | null =
  fakeEmbedder && process.env.INCARNAMIND_TEST_MODEL_DOWNLOADS
    ? JSON.parse(process.env.INCARNAMIND_TEST_MODEL_DOWNLOADS)
    : null;

// A test build reaches no model source but the stand-ins on this computer, not even the probe's;
// a launch that keeps an engine real (#534) also reaches the model hosts, to download its model.
const modelHostsOpen =
  import.meta.env.MODE === "test" && process.env.INCARNAMIND_TEST_MODEL_HOSTS === "1";
const modelFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (import.meta.env.MODE === "test") {
    const { hostname, host } = new URL(url);
    if (hostname !== "127.0.0.1" && !(modelHostsOpen && isModelHost(hostname))) {
      return Promise.reject(new TypeError(`A test build reaches no ${host}.`));
    }
  }
  if (init?.redirect === "manual") return unfollowed(url, init);
  return net.fetch(input instanceof URL ? input.href : input, { ...init, credentials: "omit" });
};

// A Response with a body throws for these statuses.
const NULL_BODY = new Set([204, 205, 304]);

// The core follows a model download's redirects itself, to keep it to the source's own hosts,
// but net.fetch cancels a redirect it is told not to follow: net.request hands it back.
function unfollowed(url: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = net.request({
      url,
      method: init.method ?? "GET",
      redirect: "manual",
      credentials: "omit",
    });
    for (const [name, value] of new Headers(init.headers)) request.setHeader(name, value);
    const { signal } = init;
    const abort = () => {
      request.abort();
      reject(signal?.reason);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    request.on("redirect", (status, _method, location) => {
      request.abort();
      resolve(new Response(null, { status, headers: { location } }));
    });
    request.on("response", (message) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(message.headers)) {
        for (const each of Array.isArray(value) ? value : [value]) headers.append(name, each);
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          message.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          message.on("end", () => {
            signal?.removeEventListener("abort", abort);
            controller.close();
          });
          message.on("aborted", () => controller.error(signal?.reason ?? new Error("Aborted")));
          message.on("error", (error: Error) => controller.error(error));
        },
        cancel() {
          request.abort();
        },
      });
      const status = message.statusCode;
      resolve(new Response(NULL_BODY.has(status) ? null : body, { status, headers }));
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * Test-only launch flags: the smoke tests transcribe Meetings with a fake
 * speech-to-text engine in the utility process, so no model is downloaded
 * (#136), slow, failing to read stretches or failing over as
 * INCARNAMIND_TEST_TRANSCRIBER_OPTIONS (JSON) asks (#161), and a pretend cloud
 * service instead of OpenAI's or Soniox's (#141). Only a test build honours them.
 */
const fakeTranscriber: FakeTranscriberOptions | undefined =
  import.meta.env.MODE === "test" && process.env.INCARNAMIND_TEST_TRANSCRIBER === "fake"
    ? JSON.parse(process.env.INCARNAMIND_TEST_TRANSCRIBER_OPTIONS ?? "{}")
    : undefined;

/**
 * A test build never asks the LM Studio or Unsloth Studio on this computer:
 * INCARNAMIND_TEST_LOCAL_SERVERS (JSON) names the models each one lists, and
 * one it doesn't name isn't running. Only a test build honours it.
 */
const scriptedServers: LocalServers | undefined =
  import.meta.env.MODE === "test"
    ? scriptedLocalServers(JSON.parse(process.env.INCARNAMIND_TEST_LOCAL_SERVERS ?? "{}"))
    : undefined;

/**
 * The built-in Skills: in a packaged app, where electron-builder copied them
 * into its resources (`extraResources` in electron-builder.yml); otherwise
 * (development, the smoke tests) in the repository.
 */
function builtInSkillsFolder(): string {
  return app.isPackaged
    ? join(process.resourcesPath, BUILT_IN_SKILLS_PACKAGED)
    : join(app.getAppPath(), BUILT_IN_SKILLS_SOURCE);
}

/**
 * The example Documents for the example Mind, found like the built-in Skills.
 * The smoke tests start without them (each would otherwise begin with the
 * example Mind), unless one asks for them with INCARNAMIND_TEST_EXAMPLES=1.
 */
function examplesFolder(): string | undefined {
  if (import.meta.env.MODE === "test" && process.env.INCARNAMIND_TEST_EXAMPLES !== "1") {
    return undefined;
  }
  return app.isPackaged
    ? join(process.resourcesPath, "examples")
    : join(app.getAppPath(), "resources", "examples");
}

/**
 * The citation-style engine, styles and locales (ADR-0016), found like the built-in Skills: in
 * the packaged app's resources, otherwise in the repository.
 */
function citationStylesFolder(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "citation-styles")
    : join(app.getAppPath(), "resources", "citation-styles");
}

/**
 * Pyodide and the packages Analyses run with (ADR-0023), found like the
 * built-in Skills: in the packaged app's resources, otherwise where the build
 * fetched them into the repository.
 */
function pythonFolder(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "python")
    : join(app.getAppPath(), "resources", "python");
}

/**
 * Test-only: facts laid over every model's, as JSON (`INCARNAMIND_TEST_MODEL_FACTS`), as a smoke
 * test turns on run_code, which the catalog offers to no model yet (#2351). Only a test build
 * (`electron-vite build --mode test`) honours it.
 */
function testModelFacts(): Pick<CoreAdapters, "modelFacts"> {
  const given =
    import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_MODEL_FACTS : undefined;
  if (!given) return {};
  const facts = JSON.parse(given) as ModelFactsLayer;
  return { modelFacts: () => facts };
}

/**
 * What `run_code` runs with (ADR-0025): the manifest of IncarnaMind's own Python this build was
 * made with, beside the app's other resources (in a test build, the one the test names), and
 * the plot font Analyses bundle. None on Windows, where code has no OS sandbox to run in.
 */
function codeRuntime(log: Logger): CoreAdapters["codeRuntime"] {
  if (process.platform === "win32") return undefined;
  const testManifest =
    import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_PYTHON_RUNTIME : undefined;
  const manifest =
    testManifest ||
    (app.isPackaged
      ? join(process.resourcesPath, "python-native", "runtime.json")
      : join(app.getAppPath(), "resources", "python-native", "runtime.json"));
  return createCodeHost({
    python: readPythonManifest(
      manifest,
      runtimePlatform(process.platform, process.arch),
      (reason) => log.warn("pythonRuntime.manifest", { reason }),
      { standIn: import.meta.env.MODE === "test" },
    ),
    font: join(pythonFolder(), PLOT_FONT),
    appVersion: app.getVersion(),
  });
}

export function analysisRuntime(log: Logger): AnalysisRuntime {
  const runtime = createElectronAnalysisRuntime({
    log,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    folder: pythonFolder(),
  });
  if (import.meta.env.MODE === "test") {
    (globalThis as { incarnamindAnalysis?: unknown }).incarnamindAnalysis = {
      run: (job: AnalysisJob, stopAfterMs?: number) =>
        runAnalysis(
          runtime,
          job,
          stopAfterMs === undefined
            ? new AbortController().signal
            : AbortSignal.timeout(stopAfterMs),
        ),
      close: () => runtime.close(),
    };
  }
  return runtime;
}

/**
 * The home folder the core gets. Node's, not `app.getPath("home")`: on macOS
 * that ignores HOME, which the smoke tests point at a temporary folder, and
 * their agents' settings would land in the real one.
 */
export const homeFolder = (): string => homedir();

/**
 * Where crash reports go: the Sentry DSN this copy was built with
 * (`MAIN_VITE_SENTRY_DSN`), if any. A test build ignores it, so the smoke
 * tests never reach Sentry; they may point it at a local server instead.
 */
function crashReportDsn(): string | undefined {
  const dsn =
    import.meta.env.MODE === "test"
      ? process.env.INCARNAMIND_TEST_SENTRY_DSN
      : import.meta.env.MAIN_VITE_SENTRY_DSN;
  return dsn?.trim() || undefined;
}

/** Sentry crash reports, if this copy can send them. The core starts them only once the User opts in. */
function createCrashReporter(dataDir: string): CrashReporter | undefined {
  const dsn = crashReportDsn();
  if (!dsn) return undefined;
  return createSentryCrashReporter({
    dsn,
    paths: {
      homeDir: app.getPath("home"),
      dataDir,
      others: [app.getPath("temp")],
    },
  });
}

/**
 * The PostHog project this copy sends usage data to, if any: its key and host
 * (`MAIN_VITE_POSTHOG_KEY`, `MAIN_VITE_POSTHOG_HOST`), both needed, the host
 * over https; and whether it is a test build (`MAIN_VITE_TESTER_BUILD=1`, the
 * alpha). A smoke-test build ignores them, so the smoke tests never reach
 * PostHog; they may point it at a local server instead
 * (`INCARNAMIND_TEST_POSTHOG_KEY`, `INCARNAMIND_TEST_POSTHOG_HOST`,
 * `INCARNAMIND_TEST_TESTER_BUILD`).
 */
function usageDataProject(): { key: string; host: string; testerBuild: boolean } | undefined {
  const test = import.meta.env.MODE === "test";
  const key = (
    test ? process.env.INCARNAMIND_TEST_POSTHOG_KEY : import.meta.env.MAIN_VITE_POSTHOG_KEY
  )?.trim();
  const host = (
    test ? process.env.INCARNAMIND_TEST_POSTHOG_HOST : import.meta.env.MAIN_VITE_POSTHOG_HOST
  )?.trim();
  const tester = test
    ? process.env.INCARNAMIND_TEST_TESTER_BUILD
    : import.meta.env.MAIN_VITE_TESTER_BUILD;
  if (!key || !host) return undefined;
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return undefined;
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(test && local && url.protocol === "http:")) return undefined;
  return { key, host, testerBuild: tester?.trim() === "1" };
}

/**
 * Sends usage data, if this copy was built to. The core starts it only while the User agrees.
 * A test build lets a test wait for what was captured so far to reach the server
 * (`globalThis.incarnamindUsageData.flush`), instead of waiting a while and hoping.
 */
function createUsageDataSender(): UsageDataSender | undefined {
  const project = usageDataProject();
  if (!project) return undefined;
  const test = import.meta.env.MODE === "test";
  const sender = createPostHogSender({
    projectKey: project.key,
    host: project.host,
    testerBuild: project.testerBuild,
    appVersion: app.getVersion(),
    // The smoke tests don't wait half a minute for events.
    ...(test && { flushIntervalMs: 500 }),
  });
  if (test) {
    (globalThis as { incarnamindUsageData?: unknown }).incarnamindUsageData = {
      flush: async () => {
        await sender.settled();
        await sender.flush();
      },
    };
  }
  return sender;
}

/**
 * Test-only launch flag: where Look up asks Crossref and arXiv (#286), a
 * local server standing in for both, so the smoke tests reach neither. Only
 * a test build honours it.
 */
const referenceLookupUrl =
  import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_REFERENCE_LOOKUP : undefined;

/**
 * Test-only launch flag: where requests to TypeSafe's hosted Jev go, a local server standing in
 * for it, so the smoke tests set Jev up as the User does and reach no one. Only a test build
 * honours it.
 */
const jevHostedUrl = import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_JEV : undefined;

/**
 * Test-only launch flag: where every decision model host's requests go (#1907), one local server
 * standing in for them all. Only a test build honours it.
 */
const decisionHostsUrl =
  import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_DECISIONS : undefined;

/**
 * Test-only launch flag: where Find sources asks its providers (#296), a
 * local server standing in for each provider (OpenAlex, arXiv, PubMed, Crossref, openFDA, DailyMed, ClinicalTrials.gov, the eCFR and GovInfo), each
 * under its own path, so the smoke tests reach none of them. Only a test
 * build honours it.
 */
const sourceProvidersUrl =
  import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_SOURCES : undefined;

/**
 * Test-only launch flag: how long after a new version of a Document
 * contradiction watch checks its Folder's Minds (#112), so the smoke tests
 * needn't wait the 30 seconds. Only a test build honours it.
 */
const contradictionWatchDelay =
  import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_CONTRADICTION_DELAY_MS : undefined;

/**
 * Test-only launch flag: a JSON file of Connectors directory entries (#148)
 * in place of the list that ships with the app, so the smoke tests connect
 * an entry served by a local stand-in. Only a test build honours it.
 */
function testConnectorDirectory(): unknown {
  const file =
    import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_CONNECTOR_DIRECTORY : undefined;
  return file ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/**
 * Test-only launch flag: where the Connectors search asks the MCP Registry
 * (#148), a local stand-in, so the smoke tests reach no registry. Only a
 * test build honours it.
 */
const connectorRegistryUrl =
  import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_CONNECTOR_REGISTRY : undefined;

/**
 * Test-only launch flag: the port of a local server standing in for the web
 * (#128). Web search's fetcher resolves every host to a public address and
 * connects there, its guard still deciding which hosts it reaches, so the
 * smoke tests reach no site. Only a test build honours it.
 */
function standInPort(): number | undefined {
  const port =
    import.meta.env.MODE === "test" ? Number(process.env.INCARNAMIND_TEST_WEB) : Number.NaN;
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * Every host is public there, but a name under "loopback.test", which is this
 * computer, as a name could resolve to: for the smoke tests of the guard.
 */
const standInResolve: Resolve = async (hostname) =>
  hostname.endsWith(".loopback.test")
    ? [{ address: "127.0.0.1", family: 4 }]
    : [{ address: "93.184.215.14", family: 4 }];

function webStandIn(): CoreAdapters["web"] {
  const port = standInPort();
  if (port === undefined) return undefined;
  return {
    resolve: standInResolve,
    connector: (lookup) => (options, callback) => {
      lookup(options.hostname, {}, (error) => {
        if (error) {
          callback(error, null);
          return;
        }
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => callback(null, socket));
        socket.once("error", (failure) => callback(failure, null));
      });
    },
  };
}

/** Test builds: a page saved by its address is fetched from the stand-in too, whatever its host. */
function standInPageFetch(port: number): PageFetch {
  const agent = new Agent({
    connect: (_options, callback) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => callback(null, socket));
      socket.once("error", (failure) => callback(failure, null));
    },
  });
  return (address, init) => undiciFetch(address, { ...init, dispatcher: agent });
}

/**
 * Test-only launch flag: how long keeping a page as it looks may take, in
 * milliseconds, so the smoke tests see a page that never loads closed within
 * seconds. Only a test build honours it.
 */
function lookLimit(): { limitMs?: number } {
  const limit =
    import.meta.env.MODE === "test" ? Number(process.env.INCARNAMIND_TEST_LOOK_LIMIT) : Number.NaN;
  return Number.isInteger(limit) && limit > 0 ? { limitMs: limit } : {};
}

/**
 * Test-only launch flag: a local server standing in for OpenAI (#122), at
 * this origin, where the ChatGPT plan signs in and asks, so the smoke tests
 * can sign in and reach neither OpenAI's sign-in nor its API. Only a test
 * build honours it.
 */
function chatGptStandIn(): CoreAdapters["chatGptPlan"] {
  const origin = import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_CHATGPT : undefined;
  if (!origin) return undefined;
  return {
    issuer: origin,
    authorizeUrl: `${origin}/api/accounts/authorize`,
    tokenUrl: `${origin}/api/accounts/oauth/token`,
    revokeUrl: `${origin}/api/accounts/oauth/revoke`,
    jwksUrl: `${origin}/.well-known/jwks.json`,
    apiBaseUrl: `${origin}/v1`,
  };
}

/**
 * Test-only launch flags: a local server standing in for Anthropic (#872), at
 * this origin, where the Claude account signs in and asks
 * (tests/helpers/fakeAnthropic.ts), and how long its sign-in waits, in
 * milliseconds. Only a test build honours them.
 */
function claudeStandIn(): CoreAdapters["claudeAccount"] {
  const origin = import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_CLAUDE : undefined;
  if (!origin) return undefined;
  const timeout = Number(process.env.INCARNAMIND_TEST_CLAUDE_SIGN_IN_MS);
  return {
    ...(Number.isInteger(timeout) && timeout > 0 && { signInTimeoutMs: timeout }),
    experimental: true,
    clientId: "test-client",
    authorizeUrl: `${origin}/oauth/authorize`,
    tokenUrl: `${origin}/v1/oauth/token`,
    scopes: ["user:profile", "user:inference"],
    authorizeParams: { code: "true" },
    redirect: { kind: "page", uri: `${origin}/oauth/code/callback` },
    tokenRequest: { format: "json", stateInExchange: true },
    stateBytes: 32,
    apiBaseUrl: `${origin}/v1`,
  };
}

/**
 * Test-only launch flag: a local server standing in for GitHub and Copilot, at this origin. Each
 * profile this build offers keeps its client ID, scopes and headers; only its endpoints move, so
 * the smoke tests reach neither GitHub nor Copilot. Only a test build honours it.
 */
function copilotStandIn(): CoreAdapters["copilotProfiles"] {
  const origin = import.meta.env.MODE === "test" ? process.env.INCARNAMIND_TEST_COPILOT : undefined;
  if (!origin) return undefined;
  const profiles: NonNullable<CoreAdapters["copilotProfiles"]> = {};
  for (const id of ["own", "editor"] as const) {
    const profile = COPILOT_PROFILES[id];
    if (!profile) continue;
    profiles[id] = {
      ...profile,
      deviceCodeUrl: `${origin}/login/device/code`,
      tokenUrl: `${origin}/login/oauth/access_token`,
      apiBaseUrl: origin,
      accountUrl: `${origin}/user`,
      ...(profile.tokenExchange && {
        tokenExchange: { ...profile.tokenExchange, url: `${origin}/copilot_internal/v2/token` },
      }),
    };
  }
  return profiles;
}

// The smoke tests read when each stream's audio went to the fake transcriber, to check that none
// goes for a microphone the User paused.
function recordingSent(transcriber: Transcriber): Transcriber {
  const sent: { stream: string; at: number }[] = [];
  (globalThis as { incarnamindTranscribed?: typeof sent }).incarnamindTranscribed = sent;
  return {
    ...transcriber,
    push(stream, samples) {
      sent.push({ stream, at: Date.now() });
      transcriber.push(stream, samples);
    },
  };
}

/**
 * Google Calendar's and Microsoft 365's clients (#190), from the build (#209): a service the
 * build has no client for isn't offered, and Google needs its secret too. Test-only launch flag:
 * a local stand-in for both at INCARNAMIND_TEST_CALENDARS's origin
 * (tests/helpers/fakeCalendars.ts), with made-up clients. A test build reaches neither service.
 */
function calendarServices(): CoreAdapters["calendarServices"] {
  if (import.meta.env.MODE === "test") {
    const origin = process.env.INCARNAMIND_TEST_CALENDARS;
    if (!origin) return {};
    const standIns = calendarStandIns(origin);
    return {
      google: {
        ...standIns.google,
        clientId: "test-google-client",
        clientSecret: "test-google-secret",
      },
      microsoft: { ...standIns.microsoft, clientId: "test-microsoft-client" },
    };
  }
  const google = import.meta.env.MAIN_VITE_GOOGLE_CALENDAR_CLIENT_ID;
  const googleSecret = import.meta.env.MAIN_VITE_GOOGLE_CALENDAR_CLIENT_SECRET;
  const microsoft = import.meta.env.MAIN_VITE_MICROSOFT_CALENDAR_CLIENT_ID;
  return {
    ...(google &&
      googleSecret && {
        google: { ...GOOGLE_CALENDAR, clientId: google, clientSecret: googleSecret },
      }),
    ...(microsoft && { microsoft: { ...MICROSOFT_CALENDAR, clientId: microsoft } }),
  };
}

/**
 * The Mac's calendars (#190), through the calendar helper. Test-only launch flags: a stand-in
 * holding INCARNAMIND_TEST_SYSTEM_CALENDAR's `SystemCalendarFixture`, on any system, which the
 * smoke tests reach as `globalThis.incarnamindFakeCalendar`; and how often calendars are read,
 * INCARNAMIND_TEST_CALENDAR_SYNC_MS. A test build never runs the helper: nothing on the
 * computer is read.
 */
function calendarAdapters(log: Logger): Pick<CoreAdapters, "systemCalendar" | "calendarSync"> {
  if (import.meta.env.MODE !== "test") {
    const systemCalendar = createSystemCalendar(log);
    return systemCalendar ? { systemCalendar } : {};
  }
  const fixture = process.env.INCARNAMIND_TEST_SYSTEM_CALENDAR;
  const intervalMs = Number(process.env.INCARNAMIND_TEST_CALENDAR_SYNC_MS);
  let systemCalendar: SystemCalendar | undefined;
  if (fixture) {
    const parsed: SystemCalendarFixture = JSON.parse(fixture);
    const fake = createFakeSystemCalendar(parsed);
    (globalThis as { incarnamindFakeCalendar?: FakeSystemCalendar }).incarnamindFakeCalendar = fake;
    systemCalendar = fake;
  }
  return {
    ...(systemCalendar && { systemCalendar }),
    ...(Number.isInteger(intervalMs) && intervalMs > 0 && { calendarSync: { intervalMs } }),
  };
}

/**
 * What records Meetings: the hidden capture window (ADR-0015). Test-only
 * launch flags: the smoke tests record a fake that makes a tone in real time,
 * so no device is ever opened (INCARNAMIND_TEST_AUDIO=fake), its computer's
 * sound allowed, denied or silent (INCARNAMIND_TEST_AUDIO_SYSTEM), or a
 * recording played once (INCARNAMIND_TEST_AUDIO_FILE, a 16 kHz mono 16-bit WAV),
 * with the microphone's beside it (INCARNAMIND_TEST_AUDIO_MICROPHONE_FILE), for
 * checking transcription by hand. They reach it as
 * `globalThis.incarnamindFakeAudio`, e.g. to change the microphone.
 * INCARNAMIND_TEST_AUDIO=none is a copy with no capture at all.
 */
function audioCapture(log: Logger): AudioCapture | undefined {
  if (import.meta.env.MODE === "test" && process.env.INCARNAMIND_TEST_AUDIO === "none") {
    return undefined;
  }
  if (import.meta.env.MODE === "test" && process.env.INCARNAMIND_TEST_AUDIO === "fake") {
    const system = process.env.INCARNAMIND_TEST_AUDIO_SYSTEM;
    const recording = process.env.INCARNAMIND_TEST_AUDIO_FILE;
    const microphoneRecording = process.env.INCARNAMIND_TEST_AUDIO_MICROPHONE_FILE;
    const fake = createFakeCapture({
      realTime: 100,
      system: system === "denied" || system === "silent" ? system : "allowed",
      ...(recording && { recording: wavSamples(readFileSync(recording)) }),
      ...(recording &&
        microphoneRecording && {
          microphoneRecording: wavSamples(readFileSync(microphoneRecording)),
        }),
      microphone:
        process.env.INCARNAMIND_TEST_AUDIO_MICROPHONE === "denied"
          ? "denied"
          : process.env.INCARNAMIND_TEST_AUDIO_MICROPHONE === "waiting"
            ? "waiting"
            : process.env.INCARNAMIND_TEST_AUDIO_MICROPHONE === "silent"
              ? "silent"
              : "allowed",
    });
    (globalThis as { incarnamindFakeAudio?: FakeCapture }).incarnamindFakeAudio = fake;
    return fake;
  }
  return createElectronAudioCapture({ log, rendererUrl: process.env.ELECTRON_RENDERER_URL });
}

/**
 * A development or test build may keep the ChatGPT sign-in in a ChatGPT test
 * profile, the folder in INCARNAMIND_CHATGPT_PROFILE, instead of the data
 * folder: the owner signs in there once, and coding agents running with
 * temporary data folders use the same sign-in for checks by hand
 * (docs/agents/testing.md). Its tokens stay encrypted by safeStorage, in that
 * folder only, and a lock file keeps the processes' refreshes apart. A
 * release build never reads the variable.
 */
function chatGptTestProfile(log: Logger, cipher: SecretCipher): CoreAdapters["chatGptStore"] {
  const folder = process.env.INCARNAMIND_CHATGPT_PROFILE;
  if (import.meta.env.MODE === "production" || !folder) return undefined;
  const dir = resolve(folder);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  log.info("chatgpt.testProfile", { folder: dir });
  return {
    keychain: createFileKeychain(join(dir, SECRETS_FILE), cipher),
    lockFile: join(dir, "refresh.lock"),
  };
}

/** Builds the core's adapters, with the log the core writes to. Call after `app` is ready. */
export async function createElectronAdapters(log: Logger): Promise<CoreAdapters> {
  const dataDir = app.getPath("userData");
  const { cipher: safeStorageCipher, ready: secretsReady } = createSafeStorageCipher(log);
  // The page's calls wait for `served`: nothing it can ask about secrets runs before the answer.
  log.info("secrets.encryption.waiting");
  await secretsReady;
  log.info("secrets.encryption.ready", { protection: safeStorageCipher.protection() });
  const crashReporter = createCrashReporter(dataDir);
  const usageData = createUsageDataSender();
  const chatGptStore = chatGptTestProfile(log, safeStorageCipher);
  const chatGptPlan = chatGptStandIn();
  const claudeAccount = claudeStandIn();
  const copilotProfiles = copilotStandIn();
  const web = webStandIn();
  const standIn = standInPort();
  const connectorDirectory = testConnectorDirectory();
  const scriptedOllama =
    import.meta.env.MODE === "test" &&
    process.env.INCARNAMIND_FAKE_CHAT === "1" &&
    testOllamaApp === undefined
      ? { ...createOllamaModels(), running: async () => true }
      : undefined;
  return {
    ...(connectorDirectory !== undefined && { connectorDirectory }),
    ...(connectorRegistryUrl && { connectorRegistryUrl }),
    ...(chatGptStore && { chatGptStore }),
    ...(chatGptPlan && { chatGptPlan }),
    ...(claudeAccount && { claudeAccount }),
    ...(copilotProfiles && { copilotProfiles }),
    ...(web && { web }),
    ...(standIn !== undefined && { webPages: { fetch: standInPageFetch(standIn) } }),
    ...(crashReporter && { crashReporter }),
    ...(usageData && { usageData }),
    ...(jevHostedUrl && { jevHostedUrl }),
    ...(decisionHostsUrl && {
      decisionOrigins: Object.fromEntries(DECISION_HOSTS.map((host) => [host, decisionHostsUrl])),
    }),
    ...(referenceLookupUrl && {
      referenceLookup: {
        crossref: referenceLookupUrl,
        arxiv: referenceLookupUrl,
        openalex: referenceLookupUrl,
      },
    }),
    ...(contradictionWatchDelay && {
      contradictionWatch: { delayMs: Number(contradictionWatchDelay) },
    }),
    ...(sourceProvidersUrl && {
      sourceProviders: {
        openalex: `${sourceProvidersUrl}/openalex`,
        arxiv: `${sourceProvidersUrl}/arxiv`,
        pubmed: `${sourceProvidersUrl}/pubmed`,
        crossref: `${sourceProvidersUrl}/crossref`,
        openfda: `${sourceProvidersUrl}/openfda`,
        dailymed: `${sourceProvidersUrl}/dailymed`,
        clinicaltrials: `${sourceProvidersUrl}/clinicaltrials`,
        ecfr: `${sourceProvidersUrl}/ecfr`,
        govinfo: `${sourceProvidersUrl}/govinfo`,
      },
    }),
    log,
    audioCapture: audioCapture(log),
    calendarServices: calendarServices(),
    ...calendarAdapters(log),
    capturePage: createCitedPageCapture({ rendererUrl: process.env.ELECTRON_RENDERER_URL, log }),
    analysisRuntime: analysisRuntime(log),
    codeRuntime: codeRuntime(log),
    ...testModelFacts(),
    paths: {
      dataDir,
      builtInSkills: builtInSkillsFolder(),
      examples: examplesFolder(),
      citationStyles: citationStylesFolder(),
      home: homeFolder(),
      get documents() {
        return import.meta.env.MODE === "test"
          ? join(dataDir, "Documents")
          : documentsFolder(() => app.getPath("documents"), homeFolder(), log);
      },
    },
    systemLanguages: () => app.getPreferredSystemLanguages(),
    systemRegion: () => app.getLocaleCountryCode(),
    // Chromium's network stack follows the system proxy, which is how many Users reach
    // Hugging Face at all (#1578); Node's own fetch doesn't.
    modelDownloads: {
      fetch: modelFetch,
      proxy: () => session.defaultSession.resolveProxy("https://huggingface.co/"),
      ...(testModelDownloads && { copies: testModelDownloads.copies }),
    },
    systemUserName: () => systemUserName(log),
    keychain: createSafeStorageKeychain(dataDir, safeStorageCipher),
    browser: systemBrowser,
    shell: fileShell,
    modelRuntimeFolder: createModelRuntimeFolder({
      platform: process.platform,
      home: homeFolder(),
      env: process.env,
    }),
    ollamaApp: ollamaApp(),
    ...(scriptedOllama && { ollamaModels: scriptedOllama }),
    ...(scriptedServers && { localServers: scriptedServers }),
    printer: createElectronPrinter({ log, rendererUrl: process.env.ELECTRON_RENDERER_URL }),
    pageLook: createPageLook({
      log,
      resolve: web?.resolve ?? systemResolve,
      ...(standIn !== undefined && { standIn }),
      ...lookLimit(),
    }),
    pictures: createElectronPictures(log),
    processes: loginShellProcesses,
    // JavaScript Skill scripts run on Electron's own Node, as plain Node: nothing to install.
    scriptRuntimes: {
      node: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } },
    },
    // An outside agent starts the shim (#351) the same way: this app's binary, as plain Node,
    // running the shim built beside this file (inside app.asar, which Node mode reads).
    agents: {
      offered: SHOW_AGENT_CONNECTION,
      launcher: {
        command: process.execPath,
        args: [join(__dirname, "agentShim.js")],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
      shimScript: join(__dirname, "agentShim.js"),
      version: app.getVersion(),
      openLink: openAgentLink,
    },
    embedder: createUtilityProcessEmbedder({ fake: fakeEmbedder }),
    transcriber: fakeTranscriber
      ? recordingSent(createUtilityProcessTranscriber({ fake: fakeTranscriber }))
      : createUtilityProcessTranscriber(),
    // The fake engine's audio is tones: there are no voices to tell apart.
    ...(!fakeTranscriber && { speakerSeparator: createUtilityProcessSeparator() }),
    ...(fakeTranscriber && {
      transcriptionModelSource: testModelDownloads?.speech ?? {
        model: { baseUrl: "http://localhost/", files: [] },
        vad: { baseUrl: "http://localhost/", files: [] },
      },
      // The pretend cloud service takes any key but one that says it's wrong.
      transcriptionKeyFetch: async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(null, {
          status: new Headers(init?.headers).get("Authorization")?.includes("wrong") ? 401 : 200,
        }),
    }),
    crossEncoder: createUtilityProcessCrossEncoder({ fake: fakeEmbedder }),
    textRecognizer: createUtilityProcessTextRecognizer(
      fakeRecognizer ? { fake: { script: fakeScans } } : {},
    ),
    decodePicture: decodePictureToPng,
    officeConverter: createOfficeConverter({
      processes: loginShellProcesses,
      home: homeFolder(),
      platform: process.platform,
      env: process.env,
      tempDir: tmpdir(),
    }),
    scansAtOnce:
      testScansAtOnce > 0 ? testScansAtOnce : scansAtOnce(availableParallelism(), totalmem()),
    // The fake models have no files to download.
    ...(fakeEmbedder && {
      embeddingModelSource: testModelDownloads?.source ?? {
        baseUrl: "http://localhost/",
        files: [],
      },
      rerankingModelSource: { baseUrl: "http://localhost/", files: [] },
    }),
    ...(fakeRecognizer && {
      textRecognitionModelSource: { baseUrl: "http://localhost/", files: [] },
    }),
  };
}
