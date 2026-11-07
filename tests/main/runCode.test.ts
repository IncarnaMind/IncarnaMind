/**
 * `run_code` in the OS sandbox (ADR-0025), through its Tool as an Answer calls it, on the
 * Executor the app makes, denying what the app denies (`readDeniedFolders`). The home and data
 * folders are stand-ins; the shared temporary folder is the real one, as the app's is.
 *
 * bash runs wherever the sandbox starts. Python runs in IncarnaMind's own runtime when the run
 * gives one (`INCARNAMIND_TEST_PYTHON_RUNTIME`: the folder `npm run python:native` wrote the
 * archive to, with its manifest in resources/python-native): it is downloaded from a stand-in
 * release on this computer, checked, unpacked and imported as the app does, once for the file.
 * CI's "run_code with its real Python (Linux)" job gives one; without one the Python cases skip.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import {
  type AddressInfo,
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ProcessLauncher } from "../../src/core";
import { createAnalysisRecorder } from "../../src/core/analysis/recorder";
import type { AnswerAnalysis, CalculatedFigure } from "../../src/core/api";
import type { CitationSource } from "../../src/core/documents";
import { WORKING_FOLDER } from "../../src/core/execution";
import type { CodeDocument } from "../../src/core/runCode";
import { runCodeTool } from "../../src/core/runCode/tool";
import { createScriptRunner } from "../../src/core/skills/scripts";
import { createProcessLauncher } from "../../src/main/processes";
import { readPythonManifest, runtimePlatform } from "../../src/main/runCode/manifest";
import {
  createPythonRuntime,
  type PythonRuntime,
  pythonRuntimeFolder,
} from "../../src/main/runCode/python";
import { createCodeRunner } from "../../src/main/runCode/runner";
import { loadOsSandbox, readDeniedFolders } from "../../src/main/sandbox";
import { sandboxCheck } from "../../src/main/sandboxCheck";
import { PLOT_FONT } from "../../src/shared/analysisWindow";
import analysisHelper from "../../src/shared/incarnamind.py?raw";
import { LOCAL_FETCH } from "../helpers/core";
import { createSweepGuard } from "../helpers/sweepGuard";

const seccomp = join(
  dirname(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime"))),
  "vendor",
  "seccomp",
  process.arch,
  "apply-seccomp",
);
const sandbox = await loadOsSandbox({ seccompHelper: seccomp });
const unavailable = sandbox.available ? undefined : sandbox.reason;
const guard = createSweepGuard();
const runtimeFolder = process.env.INCARNAMIND_TEST_PYTHON_RUNTIME;
const repository = join(import.meta.dirname, "..", "..");
const font = join(repository, "resources", "fonts", PLOT_FONT);

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

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** The folders a test's runs see: stand-ins for the home and data folders, each with a canary. */
let root = "";
let home = "";
let data = "";
let homeCanary = "";
let dataCanary = "";
let tempCanary = "";
let server: Server | null = null;
let python: PythonRuntime | null = null;
/** A server on this computer the tests can reach, which the code must not. */
let listener: NetServer | null = null;
let loopbackPort = 0;
let pythonPrepared = 0;

/** The pid of each program the Executors here started, in order. */
const launched: number[] = [];
const recorded = (launcher: ProcessLauncher): ProcessLauncher => ({
  async spawn(command, args, options) {
    const child = await launcher.spawn(command, args, options);
    if (child.pid !== undefined) launched.push(child.pid);
    return child;
  },
});

/** A process of a run, as Linux's /proc shows it to the app. */
interface RunProcess {
  pid: number;
  ppid: number;
  name: string;
  /** Its pid in each PID namespace it is in, from the app's outward in. */
  nspid: string[];
  /** "readable", or why its fd folder isn't. */
  fds: string;
}

/** `root` and every process under it, by pid and parent alone; one gone meanwhile is left out. */
async function runProcesses(root: number): Promise<RunProcess[]> {
  const parents = new Map<number, number>();
  for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).split(
    "\n",
  )) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && ppid !== undefined && pid > 0) parents.set(pid, ppid);
  }
  const under = (pid: number) => {
    for (let at = pid, hops = 0; at > 1 && hops < 64; at = parents.get(at) ?? 0, hops++) {
      if (at === root) return true;
    }
    return false;
  };
  const rows: RunProcess[] = [];
  for (const pid of [...parents.keys()].filter(under)) {
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    const field = (name: string) => new RegExp(`^${name}:\\s+(.*)$`, "m").exec(status)?.[1]?.trim();
    const nspid = field("NSpid");
    if (nspid === undefined) continue;
    const fds = await readdir(`/proc/${pid}/fd`).then(
      () => "readable",
      (error: NodeJS.ErrnoException) => error.code ?? "unknown",
    );
    rows.push({
      pid,
      ppid: parents.get(pid) ?? 0,
      name: field("Name") ?? "",
      nspid: nspid.split(/\s+/),
      fds,
    });
  }
  return rows;
}

/** The data and temporary folders the runs here use, unless a test gives its own. */
const folders = () => ({ data, temp: join(root, "temp") });

/**
 * The app's OS sandbox Executor; `login`: more of the login environment than the tests' own.
 * What it reports it couldn't measure or sweep fails the test, unless `report` takes it.
 */
function executor(
  where = folders(),
  login: Record<string, string> = {},
  report: (error: unknown) => void = (error) => {
    throw error;
  },
) {
  if (!sandbox.available) throw new Error(sandbox.reason);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GITHUB_TOKEN: "ghp_made_up_secret",
    PLAIN_SETTING: "kept",
    ...login,
  };
  return sandbox.createExecutor({
    processes: recorded(createProcessLauncher(async () => env)),
    environment: async () => env,
    tempDir: where.temp,
    denyRead: readDeniedFolders({
      platform: process.platform,
      home,
      dataDir: where.data,
      temporaryFolder: tmpdir(),
      ...(typeof process.getuid === "function" && { uid: process.getuid() }),
    }),
    reportError: report,
    runRecords: guard.records(join(where.data, "runs")),
    sweep: { stopper: guard.stopper },
  });
}

beforeAll(async () => {
  if (unavailable !== undefined) return;
  root = await realpath(
    await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(join(tmpdir(), "incarnamind-run-code-")),
    ),
  );
  home = join(root, "home");
  data = join(root, "data");
  homeCanary = join(home, ".ssh", "id_canary");
  dataCanary = join(data, "incarnamind.db");
  tempCanary = join(tmpdir(), `incarnamind-canary-${process.pid}.txt`);
  await mkdir(dirname(homeCanary), { recursive: true });
  await mkdir(data, { recursive: true });
  await mkdir(join(root, "temp"), { recursive: true });
  await writeFile(homeCanary, "HOME CANARY");
  await writeFile(dataCanary, "DATA CANARY");
  await writeFile(tempCanary, "TEMP CANARY");
  listener = createNetServer((socket) => socket.end("LOOPBACK CANARY\n"));
  await new Promise<void>((resolve) => listener?.listen(0, "127.0.0.1", resolve));
  loopbackPort = (listener.address() as AddressInfo).port;
  if (!runtimeFolder) return;
  const manifest = readPythonManifest(
    join(repository, "resources", "python-native", "runtime.json"),
    runtimePlatform(process.platform, process.arch),
    (reason) => {
      throw new Error(reason);
    },
    { standIn: true },
  );
  if (!manifest)
    throw new Error("INCARNAMIND_TEST_PYTHON_RUNTIME names no runtime for this platform.");
  const archive = await readFile(join(runtimeFolder, manifest.file));
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": archive.byteLength });
    response.end(archive);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  python = createPythonRuntime({
    dataDir: data,
    manifest: { ...manifest, url: `http://127.0.0.1:${port}/${manifest.file}` },
    executor: executor(),
    fetch: LOCAL_FETCH,
    emitStatus: () => {},
  });
  const started = performance.now();
  const ready = await python.ensure(new AbortController().signal);
  pythonPrepared = performance.now() - started;
  if (!ready.ok) throw new Error(`The runtime didn't get ready: ${ready.error.message}`);
}, 20 * 60_000);

afterAll(async () => {
  // Each pid a run's sweep signalled was a member of one of this file's own runs.
  expect(guard.refused).toEqual([]);
  python?.close();
  await new Promise<void>((resolve) => (listener ? listener.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (tempCanary) await rm(tempCanary, { force: true });
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

async function sales(text = SALES): Promise<CodeDocument> {
  const path = join(home, "Reports", "sales.csv");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  const source: CitationSource = {
    passageId: "passage-sales",
    text: "region\tquarter\trevenue",
    pageFrom: null,
    pageTo: null,
    documentId: "doc-sales",
    documentName: "sales",
    documentKind: "csv",
    contentHash: sha256(SALES),
    documentDeleted: false,
    notCited: false,
    yourNoteAt: null,
  };
  return { source, path };
}

/**
 * The Tool as an Answer offers it, its runs and figures recorded as the Answer records them.
 * `own`: a runtime of a test's own, with the folders it runs in and the font it draws with;
 * `report`: takes what its Executor reports.
 */
function tool(
  documents: Record<string, CodeDocument>,
  timeLimitMs?: number,
  own?: { python: PythonRuntime; where: ReturnType<typeof folders>; font: string },
  report?: (error: unknown) => void,
) {
  const figures: CalculatedFigure[] = [];
  const analyses: AnswerAnalysis[] = [];
  const recorder = createAnalysisRecorder({
    figure: (figure) => figures.push(figure),
    language: "en",
  });
  const runner = createCodeRunner({
    executor: executor(own?.where, {}, report),
    tempDir: own?.where.temp ?? join(root, "temp"),
    python: own?.python ?? python,
    helper: analysisHelper,
    font: own?.font ?? font,
    appVersion: "0.0.0-test",
    ...(timeLimitMs !== undefined && { timeLimitMs }),
    reportError: (error) => {
      throw error;
    },
  });
  const runCode = runCodeTool({
    runner,
    document: async (id) => documents[id] ?? null,
    recorder,
    language: "en",
    now: () => new Date("2026-11-02T12:00:00Z"),
    ran: (_id, analysis) => analyses.push(analysis),
    analysisOffered: true,
  });
  let calls = 0;
  const call = (language: "python" | "bash", code: string, ids: string[] = []) =>
    runCode.call(
      { title: "Probe", language, documents: ids, code },
      { toolCallId: `call-${++calls}`, signal: new AbortController().signal },
    );
  return { call, figures, analyses };
}

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

// CI's real-runtime job gives a runtime: there a sandbox that can't start fails, rather than skips.
test.runIf(runtimeFolder !== undefined)("the OS sandbox starts where a runtime is given", () => {
  expect(unavailable).toBeUndefined();
});

describe.skipIf(unavailable !== undefined)(
  `run_code's bash in the OS sandbox${unavailable ? ` (skipped: ${unavailable})` : ""}`,
  () => {
    test("reads its copy, but no canary in the home, data or shared temporary folder, no mounted volume, no network and no secret", async () => {
      const document = await sales();
      const { call, analyses } = tool({ P1: document });
      const volumes = process.platform === "darwin" ? "/Volumes" : "/mnt";
      const homes = process.platform === "darwin" ? "/Users" : "/home";
      // bubblewrap mounts what a run must read inside a denied folder over an empty one, with the
      // folders on its way: CI's seccomp helper is under /home, so /home lists that way's first
      // folder and nothing else. macOS refuses the listing.
      const homesListed =
        process.platform === "linux" && seccomp.startsWith("/home/")
          ? `${seccomp.split("/")[2]},`
          : "";
      const report = await call(
        "bash",
        [
          `try() { if eval "$2" >/dev/null 2>&1; then echo "$1: allowed"; else echo "$1: denied"; fi; }`,
          `try home "cat '${homeCanary}'"`,
          `echo "homes: [$(ls -A '${homes}' 2>/dev/null | tr '\\n' ',')]"`,
          'try runtime-folder "ls -A /run/user/$(id -u) | grep -q ."',
          `try data "cat '${dataCanary}'"`,
          `try temp "cat '${tempCanary}'"`,
          `try volumes "ls -A '${volumes}' | grep -q ."`,
          `try system "ls /usr"`,
          `try input "wc -l < ../inputs/sales.csv"`,
          `try change-input "echo x >> ../inputs/sales.csv"`,
          `try write-home "echo x > '${home}/written.txt'"`,
          `try write-temp "echo x > '${tmpdir()}/incarnamind-written-${process.pid}.txt'"`,
          `try fill-temp "head -c 3000000 /dev/zero > '${tmpdir()}/incarnamind-fill-${process.pid}'"`,
          // bubblewrap's /dev is a tmpfs of its own: /dev/shm holds 1 MB, and /dev is read-only.
          `try fill-shm "head -c 3000000 /dev/zero > /dev/shm/incarnamind-fill-${process.pid}"`,
          `try write-dev "echo x > /dev/incarnamind-written-${process.pid}"`,
          `try write-own "echo x > out/note.txt"`,
          `try dns "getent hosts example.com || host example.com || nslookup example.com"`,
          `try internet "curl -sS -m 3 https://example.com"`,
          `try loopback "curl -sS -m 3 telnet://127.0.0.1:${loopbackPort} </dev/null"`,
          // LaunchServices reached would say no application claims the scheme.
          'echo "launch: $(open incarnamind-probe://x 2>&1 | grep -c -- -10814)"',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own variables.
          'echo "token: ${GITHUB_TOKEN:-none} setting: ${PLAIN_SETTING:-none} path: ${PATH:+set}"',
        ].join("\n"),
        ["P1"],
      );
      expect(analyses[0]?.end.kind).toBe("done");
      const printed = analyses[0]?.output.printed.split("\n") ?? [];
      expect(printed).toEqual([
        "home: denied",
        `homes: [${homesListed}]`,
        "runtime-folder: denied",
        "data: denied",
        "temp: denied",
        "volumes: denied",
        "system: allowed",
        "input: allowed",
        "change-input: denied",
        "write-home: denied",
        // bubblewrap puts an empty folder of the run's own over /tmp: what is written there never
        // reaches the real one (checked below). macOS refuses the write.
        `write-temp: ${process.platform === "linux" ? "allowed" : "denied"}`,
        // That folder holds 1 MB: on Linux it is memory, which no other limit counts.
        "fill-temp: denied",
        "fill-shm: denied",
        "write-dev: denied",
        "write-own: allowed",
        "dns: denied",
        "internet: denied",
        "loopback: denied",
        "launch: 0",
        // Of the login environment only PATH, LANG, LC_* and TZ come through.
        "token: none setting: none path: set",
      ]);
      expect(existsSync(join(home, "written.txt"))).toBe(false);
      expect(existsSync(join(tmpdir(), `incarnamind-written-${process.pid}.txt`))).toBe(false);
      expect(analyses[0]?.outFiles?.files.map((file) => file.name)).toEqual(["note.txt"]);
      expect(report).toContain("Files in ../inputs:\n- sales.csv (sales): ");
      expect(await readFile(document.path, "utf8")).toBe(SALES);
    }, 60_000);

    test.runIf(process.platform === "darwin")(
      "on macOS its profile refuses LaunchServices, the Keychain's server and nothing it needs",
      async () => {
        const stop = new AbortController();
        const running = executor().run({
          command: "/bin/sleep",
          args: ["7.2351"],
          env: {},
          environment: "minimal",
          allow: { read: [WORKING_FOLDER], write: [WORKING_FOLDER], network: "none" },
          timeoutMs: 20_000,
          maxOutputBytes: 1024,
          signal: stop.signal,
        });
        const { execFileSync } = await import("node:child_process");
        const pidOf = () =>
          execFileSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8" })
            .split("\n")
            .find((line) => line.trim().endsWith("/bin/sleep 7.2351"))
            ?.trim()
            .split(/\s+/)[0];
        await expect.poll(pidOf).toMatch(/^\d+$/);
        const pid = Number(pidOf());
        // cfprefsd serves every app's preferences, from the home the profile denies.
        const services = [
          "com.apple.coreservices.launchservicesd",
          "com.apple.lsd.mapdb",
          "com.apple.SecurityServer",
          "com.apple.securityd.xpc",
          "com.apple.cfprefsd.daemon",
          "com.apple.cfprefsd.agent",
          "com.apple.logd",
          "com.apple.system.opendirectoryd.libinfo",
        ];
        const answers = await sandboxCheck(
          services.map((value) => ({ pid, operation: "mach-lookup" as const, value })),
        );
        stop.abort();
        await running;
        expect(answers).toEqual([1, 1, 1, 1, 1, 1, 0, 0]);
      },
      30_000,
    );

    test("a Document that changed since it was read doesn't run", async () => {
      const document = await sales(`${SALES}West,Q3,1\n`);
      const { call, analyses } = tool({ P1: document });
      expect(await call("bash", "echo ran", ["P1"])).toContain("changed since IncarnaMind read it");
      expect(analyses).toEqual([]);
      const fine = await sales();
      const again = tool({ P1: fine });
      await again.call("bash", "echo ran", ["P1"]);
      expect(again.analyses[0]?.output.printed).toBe("ran");
    });

    test("a link in out/ never brings back what it points at", async () => {
      const { call, analyses } = tool({});
      await call(
        "bash",
        `ln -s '${homeCanary}' out/key.txt; ln -s /etc/hosts out/hosts.txt; echo kept > out/kept.txt`,
      );
      expect(analyses[0]?.outFiles).toEqual({
        files: [{ name: "kept.txt", bytes: 5, sha256: sha256("kept\n"), text: "kept\n" }],
        left: 2,
      });
    });

    test("an out/ or a working folder swapped for a link brings back nothing from where it points", async () => {
      const bait = join(home, "bait");
      await mkdir(join(bait, "out"), { recursive: true });
      await writeFile(join(bait, "out", "secret.txt"), "HOME BAIT");
      const { call, analyses } = tool({});
      await call("bash", `rm -rf out && ln -s '${dirname(homeCanary)}' out && echo swapped`);
      expect(analyses[0]?.output.printed).toBe("swapped");
      expect(analyses[0]?.outFiles).toEqual({ files: [], left: 0 });
      await call("bash", `rm -rf "$PWD" && ln -s '${bait}' "$PWD" && echo moved`);
      // bubblewrap mounts the working folder, which can't then be removed; macOS lets it go.
      expect(analyses[1]?.output.printed).toBe(process.platform === "linux" ? "" : "moved");
      expect(analyses[1]?.outFiles).toEqual({ files: [], left: 0 });
      await call("bash", "echo kept > out/kept.txt");
      expect(analyses[2]?.outFiles?.files.map((file) => file.name)).toEqual(["kept.txt"]);
    });

    test("what it starts in the background ends with it", async () => {
      const { call, analyses } = tool({});
      await call("bash", "sleep 2351 > /dev/null 2>&1 & echo started");
      expect(analyses[0]?.end).toEqual({ kind: "done" });
      expect(analyses[0]?.output.printed).toBe("started");
      // Holding the output open, it would keep the run until its time limit.
      await call("bash", "sleep 2351 & echo holding");
      expect(analyses[1]?.end).toEqual({ kind: "done" });
      expect(analyses[1]?.output.printed).toBe("holding");
      // A daemon: a session of its own, out of the run's group, holding the output, and a system
      // program, whose environment macOS doesn't show.
      await call("bash", "perl -MPOSIX -e 'POSIX::setsid(); sleep 2354' & echo daemon");
      expect(analyses[2]?.end).toEqual({ kind: "done" });
      expect(analyses[2]?.output.printed).toBe("daemon");
      const { execFileSync } = await import("node:child_process");
      await expect
        .poll(() =>
          execFileSync("ps", ["-A", "-o", "command="], { encoding: "utf8" })
            .split("\n")
            .filter((line) => line.trim() === "sleep 2351" || line.includes("sleep 2354")),
        )
        .toEqual([]);
    });

    test("a folder it makes unreadable counts as over its folder limit, and its run's folder still goes", async () => {
      const { call, analyses } = tool({}, 20_000);
      await call(
        "bash",
        "mkdir hide && head -c 1000 /dev/zero > hide/a && chmod 300 hide && sleep 15",
      );
      expect(analyses[0]?.end.kind === "error" && analyses[0].end.message).toContain("200 MB");
      await call("bash", "mkdir locked && echo x > locked/a && chmod 000 locked && echo locked");
      expect(analyses[1]?.output.printed).toBe("locked");
      const left = (await readdir(join(root, "temp"))).filter((name) =>
        name.startsWith("incarnamind-code-"),
      );
      expect(left).toEqual([]);
    }, 60_000);

    test("is stopped at its file and process limits, and leaves nothing running", async () => {
      const { call, analyses } = tool({}, 4000);
      await call("bash", "head -c 120000000 /dev/zero > big.bin; echo exit=$?");
      expect(analyses[0]?.output.printed).toMatch(/File too large|exit=1|exit=153/);
      await call("bash", "bomb() { bomb | bomb & }; bomb; sleep 200");
      expect(analyses[1]?.end).toEqual({ kind: "timed-out", limitMs: 4000 });
      const { execFileSync } = await import("node:child_process");
      // Killed processes leave the list as their parents collect them, a moment later.
      await expect
        .poll(() =>
          execFileSync("ps", ["-A", "-ww", "-o", "command="], { encoding: "utf8" })
            .split("\n")
            .filter((line) => line.includes(join(root, "temp"))),
        )
        .toEqual([]);
    }, 60_000);

    test("a fork bomb that outlasts the 10 s a run's disk may stay unknown ends at its time limit, with no disk read it couldn't make", async () => {
      const reports: string[] = [];
      const { call, analyses } = tool({}, 14_000, undefined, (error) =>
        reports.push(String(error)),
      );
      await call("bash", "bomb() { bomb | bomb & }; bomb; sleep 200");
      expect(analyses[0]?.end).toEqual({ kind: "timed-out", limitMs: 14_000 });
      // On macOS the bomb can hold footprint past its 2 s, and resident memory counts that turn.
      expect(reports.filter((report) => !report.includes("/usr/bin/footprint "))).toEqual([]);
    }, 60_000);

    test("an ordinary run of 20 s, past the 10 s a run's disk may stay unknown, ends as it would", async () => {
      const reports: string[] = [];
      const { call, analyses } = tool({}, 30_000, undefined, (error) =>
        reports.push(String(error)),
      );
      await call("bash", "sleep 20; echo done");
      expect(analyses[0]?.end).toEqual({ kind: "done" });
      expect(analyses[0]?.output.printed).toBe("done");
      expect(reports).toEqual([]);
    }, 60_000);

    test.runIf(process.platform === "linux")(
      "on Linux the User's code runs two PID namespaces below the app's, as the one child of the seccomp helper's inner half, whose halves its read never needs",
      async () => {
        const { call, analyses } = tool({}, 20_000);
        const before = launched.length;
        const ran = call("bash", "sleep 4; echo laid");
        await expect.poll(() => launched.length).toBeGreaterThan(before);
        const root = launched[before] ?? 0;
        let rows: RunProcess[] = [];
        await expect
          .poll(async () => {
            rows = await runProcesses(root);
            return rows.some((row) => row.name === "sleep");
          })
          .toBe(true);
        await ran;
        expect(analyses[0]?.output.printed).toBe("laid");
        const app = (await readFile("/proc/self/status", "utf8")).match(/^NSpid:\s+(.*)$/m)?.[1];
        const below = (row: RunProcess) =>
          row.nspid.length - (app?.trim().split(/\s+/).length ?? 0);
        // The helper's halves, the outer in bubblewrap's namespace and the inner as the first
        // process of the run's own, both hide their fds.
        const inner = rows.filter((row) => below(row) === 2 && row.nspid.at(-1) === "1");
        expect(inner.map((row) => [row.name, row.fds])).toEqual([["apply-seccomp", "EACCES"]]);
        expect(
          rows
            .filter((row) => below(row) === 1 && row.name === "apply-seccomp")
            .map((row) => row.fds),
        ).toEqual(["EACCES"]);
        // Everything else at that depth is the User's: never PID 1, readable, under the inner half.
        const user = rows.filter((row) => below(row) >= 2 && row !== inner[0]);
        expect(user.map((row) => [below(row), row.fds])).toEqual(user.map(() => [2, "readable"]));
        const command = user.filter((row) => row.ppid === inner[0]?.pid);
        expect(command).toHaveLength(1);
        expect(command[0]?.nspid.at(-1)).not.toBe("1");
        expect(rows.filter((row) => below(row) < 0)).toEqual([]);
      },
      60_000,
    );

    test("the loopback server the probes knock on answers this test", async () => {
      const { connect } = await import("node:net");
      const said = await new Promise<string>((resolve, reject) => {
        const socket = connect(loopbackPort, "127.0.0.1");
        let text = "";
        socket.on("data", (chunk) => {
          text += chunk;
        });
        socket.on("end", () => resolve(text));
        socket.on("error", reject);
      });
      expect(said).toBe("LOOPBACK CANARY\n");
    });
  },
);

describe.skipIf(unavailable !== undefined || !runtimeFolder)(
  `run_code's Python in the OS sandbox${unavailable ? ` (skipped: ${unavailable})` : runtimeFolder ? "" : " (skipped: no INCARNAMIND_TEST_PYTHON_RUNTIME)"}`,
  () => {
    test("analyses a 50,000-row CSV: a table, a picture and figures worked out again from the cells", async () => {
      const rows = ["region,month,revenue"];
      for (let row = 0; row < 50_000; row++) {
        // In blocks of a region, as an export sorted by region has them: a figure names its rows
        // as runs, at most 2,000 of them.
        rows.push(
          `${["North", "South", "East", "West"][Math.floor(row / 12_500)]},${1 + (row % 12)},${(row % 997) + 0.25}`,
        );
      }
      const big = rows.join("\n");
      const path = join(home, "Reports", "big.csv");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, big);
      const document: CodeDocument = {
        path,
        source: {
          passageId: "passage-big",
          text: "region\tmonth\trevenue",
          pageFrom: null,
          pageTo: null,
          documentId: "doc-big",
          documentName: "big",
          documentKind: "csv",
          contentHash: sha256(big),
          documentDeleted: false,
          notCited: false,
          yourNoteAt: null,
        },
      };
      const { call, analyses, figures } = tool({ P1: document });
      const started = performance.now();
      const report = await call(
        "python",
        `
import matplotlib.pyplot as plt
df = read_table("big.csv")
figure("total", df["revenue"], "sum", "Total revenue", "EUR")
north = df.loc[df["region"] == "North", "revenue"]
figure("north", north, "mean", "North's average", "EUR")
figure("rows", df["revenue"], "count", "Rows")
result("inflated", float(df["revenue"].sum()) * 1.1, "Inflated", "EUR")
by_region = df.groupby("region", as_index=False)["revenue"].sum()
result("by_region", by_region, "Revenue by region", "EUR")
by_region.plot(kind="bar", x="region", y="revenue", title="Revenue by region")
by_region.to_csv("out/by_region.csv", index=False)
`,
        ["P1"],
      );
      const ms = performance.now() - started;
      const run = analyses[0];
      expect(run?.end).toEqual({ kind: "done" });
      const expected = rows.slice(1).reduce((sum, line) => sum + Number(line.split(",")[2]), 0);
      expect(run?.recalculations?.map((each) => [each.result, each.check.kind])).toEqual([
        ["total", "same"],
        ["north", "same"],
        ["rows", "same"],
      ]);
      expect(run?.recalculations?.[0]?.check).toEqual({
        kind: "same",
        value: expect.closeTo(expected, 6),
      });
      expect(run?.recalculations?.[2]?.check).toEqual({ kind: "same", value: 50_000 });
      expect(run?.markers.figures.map((each) => each.result)).toEqual([
        "total",
        "north",
        "rows",
        "inflated",
      ]);
      expect(run?.markers.tables).toEqual([{ result: "by_region", marker: 1 }]);
      expect(run?.markers.pictures).toEqual([1]);
      expect(figures).toHaveLength(4);
      expect(run?.inputs).toEqual([
        expect.objectContaining({
          kind: "range",
          name: "big.csv",
          rows: 50_000,
          cut: false,
          range: "A1:C50001",
          citation: expect.objectContaining({
            documentId: "doc-big",
            location: { kind: "rows", sheet: null, from: 1, to: 50_001 },
          }),
        }),
      ]);
      expect(run?.versions).toMatchObject({
        language: "python",
        languageVersion: expect.stringMatching(/^3\.14\./),
      });
      expect(run?.outFiles?.files.map((file) => file.name)).toEqual(["by_region.csv"]);
      expect(report).toContain("[=1] Total revenue");
      console.info(
        `run_code: the runtime got ready in ${Math.round(pythonPrepared)} ms; the 50,000-row run took ${Math.round(ms)} ms (code ${run?.ms} ms).`,
      );
    }, 180_000);

    test(
      "runs from a data folder reached through a link: its first import, its font cache, and a plot with the font",
      async () => {
        if (!python) throw new Error("No runtime.");
        // A data folder moved to another disk and linked back from the home, which every run is denied.
        const moved = join(root, "moved");
        await mkdir(join(moved, "temp"), { recursive: true });
        await mkdir(join(moved, "fonts"));
        await copyFile(font, join(moved, "fonts", PLOT_FONT));
        const linked = join(home, "Data");
        await symlink(moved, linked);
        const where = { data: linked, temp: join(linked, "temp") };
        const own = createPythonRuntime({
          dataDir: linked,
          manifest: python.manifest,
          executor: executor(where),
          fetch: LOCAL_FETCH,
          emitStatus: () => {},
        });
        try {
          const ready = await own.ensure(new AbortController().signal);
          expect(ready).toMatchObject({ ok: true });
          const cache = join(pythonRuntimeFolder(moved, python.manifest.sha256), "matplotlib");
          expect((await readdir(cache)).some((name) => name.startsWith("fontlist-"))).toBe(true);

          const { call, analyses } = tool({ P1: await sales() }, undefined, {
            python: own,
            where,
            font: join(linked, "fonts", PLOT_FONT),
          });
          await call(
            "python",
            [
              "import matplotlib.pyplot as plt",
              'df = read_table("sales.csv")',
              'figure("total", df["revenue"], "sum", "Total revenue")',
              'df.plot(kind="bar", x="region", y="revenue", title="收入")',
            ].join("\n"),
            ["P1"],
          );
          expect(analyses[0]?.end).toEqual({ kind: "done" });
          expect(analyses[0]?.recalculations?.[0]?.check).toEqual({ kind: "same", value: 1134 });
          expect(analyses[0]?.markers.pictures).toEqual([1]);
        } finally {
          own.close();
        }
      },
      15 * 60_000,
    );

    test("a plot font that can't be found stops only a run that draws, which says so; once it is there, plots draw with it", async () => {
      if (!python) throw new Error("No runtime.");
      const fonts = join(root, "fonts-later");
      const missing = join(fonts, PLOT_FONT);
      const { call, analyses } = tool({ P1: await sales() }, undefined, {
        python,
        where: folders(),
        font: missing,
      });
      const draws = [
        "import matplotlib.pyplot as plt",
        'df = read_table("sales.csv")',
        'df.plot(kind="bar", x="region", y="revenue", title="收入")',
      ].join("\n");

      await call("python", 'figure("rows", read_table("sales.csv")["revenue"], "count", "Rows")', [
        "P1",
      ]);
      await call("python", draws, ["P1"]);
      await mkdir(fonts);
      await copyFile(font, missing);
      await call("python", draws, ["P1"]);

      expect(analyses.map((each) => each.end.kind)).toEqual(["done", "error", "done"]);
      expect(analyses[1]?.end).toMatchObject({ message: expect.stringContaining(PLOT_FONT) });
      expect(analyses[2]?.markers.pictures).toEqual([1]);
    }, 180_000);

    test("n_jobs runs in threads of the run, and a process in a session of its own ends with it", async () => {
      const { call, analyses } = tool({});
      await call(
        "python",
        [
          "import os, subprocess, sys",
          "from joblib import Parallel, delayed",
          "pids = Parallel(n_jobs=2)(delayed(os.getpid)() for _ in range(8))",
          "print(f'other processes: {len(set(pids) - {os.getpid()})}')",
          'subprocess.Popen([sys.executable, "-c", "import time; time.sleep(2355)"], start_new_session=True)',
        ].join("\n"),
      );
      expect(analyses[0]?.end).toEqual({ kind: "done" });
      expect(analyses[0]?.output.printed).toBe("other processes: 0\n");
      const { execFileSync } = await import("node:child_process");
      const left = execFileSync("ps", ["-A", "-ww", "-o", "command="], { encoding: "utf8" })
        .split("\n")
        .filter((line) => line.includes("time.sleep(2355)"));
      expect(left).toEqual([]);
    }, 60_000);

    test("a figure from rows a merge renumbered is refused, not passed", async () => {
      const document = await sales();
      const { call, analyses } = tool({ P1: document });
      await call(
        "python",
        `
df = read_table("sales.csv")
targets = pd.DataFrame({"region": ["North", "South", "East"], "target": [100, 100, 100]})
merged = df.merge(targets, on="region")
figure("total", merged["revenue"], "sum", "Total")
`,
        ["P1"],
      );
      expect(analyses[0]?.end.kind).toBe("error");
      expect(analyses[0]?.end.kind === "error" && analyses[0].end.message).toContain("row number");
      expect(analyses[0]?.markers.figures).toEqual([]);
      await call(
        "python",
        'df = read_table("sales.csv")\nfigure("total", df["revenue"], "sum", "Total")',
        ["P1"],
      );
      expect(analyses[1]?.recalculations).toEqual([
        { result: "total", check: { kind: "same", value: 1134 } },
      ]);
    }, 60_000);

    test("can't read a canary, change its input, write outside its folder, reach the network or see a secret", async () => {
      const document = await sales();
      const { call, analyses } = tool({ P1: document });
      const volumes = process.platform === "darwin" ? "/Volumes" : "/mnt";
      await call(
        "python",
        `
import json, os, socket
seen = {}
def attempt(name, work):
    try:
        work()
        seen[name] = "allowed"
    except Exception as error:
        seen[name] = type(error).__name__
attempt("home", lambda: open(${JSON.stringify(homeCanary)}).read())
attempt("data", lambda: open(${JSON.stringify(dataCanary)}).read())
attempt("temp", lambda: open(${JSON.stringify(tempCanary)}).read())
def listed(folder):
    if not os.listdir(folder):
        raise FileNotFoundError(folder)
attempt("volumes", lambda: listed(${JSON.stringify(volumes)}))
attempt("system", lambda: os.listdir("/usr"))
attempt("input", lambda: open("../inputs/sales.csv").read())
attempt("change input", lambda: open("../inputs/sales.csv", "a").write("x"))
attempt("write home", lambda: open(${JSON.stringify(join(home, "py.txt"))}, "w").write("x"))
attempt("write own", lambda: open("out/py.txt", "w").write("x"))
attempt("dns", lambda: socket.getaddrinfo("example.com", 443))
attempt("internet", lambda: socket.create_connection(("1.1.1.1", 443), timeout=3))
attempt("loopback", lambda: socket.create_connection(("127.0.0.1", ${loopbackPort}), timeout=3))
def shared():
    from multiprocessing import shared_memory
    block = shared_memory.SharedMemory(create=True, size=1 << 20)
    block.close()
    block.unlink()
if ${process.platform === "darwin" ? "True" : "False"}:
    attempt("shared memory", shared)
seen["secret"] = "GITHUB_TOKEN" in os.environ
print(json.dumps(seen))
`,
        ["P1"],
      );
      const seen = JSON.parse(lastLine(analyses[0]?.output.printed ?? "{}"));
      // bubblewrap puts an empty folder over each denied one, where nothing is found; macOS refuses.
      const hidden = process.platform === "linux" ? "FileNotFoundError" : "PermissionError";
      expect(seen).toEqual({
        home: hidden,
        data: hidden,
        temp: hidden,
        volumes: hidden,
        system: "allowed",
        input: "allowed",
        "change input": "PermissionError",
        "write home": hidden,
        "write own": "allowed",
        dns: expect.not.stringMatching(/^allowed$/),
        internet: expect.not.stringMatching(/^allowed$/),
        loopback: expect.not.stringMatching(/^allowed$/),
        // On macOS a program held to a memory limit can't make shared memory, which no limit counts.
        ...(process.platform === "darwin" && {
          "shared memory": expect.not.stringMatching(/^allowed$/),
        }),
        secret: false,
      });
      expect(existsSync(join(home, "py.txt"))).toBe(false);
    }, 60_000);

    test("a folder it makes unreadable counts as over its folder limit, and its run's folder still goes", async () => {
      const { call, analyses } = tool({}, 20_000);
      await call(
        "python",
        "import os, time\nos.mkdir('hide')\nopen('hide/a', 'wb').write(b'x' * 1000)\nos.chmod('hide', 0o300)\ntime.sleep(15)",
      );
      expect(analyses[0]?.end.kind === "error" && analyses[0].end.message).toContain("200 MB");
      await call(
        "python",
        "import os\nos.mkdir('locked')\nopen('locked/a', 'w').write('x')\nos.chmod('locked', 0)\nprint('locked')",
      );
      expect(analyses[1]?.output.printed.trim()).toBe("locked");
      const left = (await readdir(join(root, "temp"))).filter((name) =>
        name.startsWith("incarnamind-code-"),
      );
      expect(left).toEqual([]);
    }, 60_000);

    test.runIf(process.platform === "linux")(
      "a program that hides its open files from the meter, by making itself not dumpable, is stopped at once as unmeasured",
      async () => {
        const reports: string[] = [];
        const { call, analyses } = tool({}, 30_000, undefined, (error) =>
          reports.push(String(error)),
        );
        const started = performance.now();
        await call(
          "python",
          [
            "import ctypes, os, time",
            "f = open('held', 'wb'); f.write(b'x' * 1_000_000); f.flush(); os.unlink('held')",
            "ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)",
            "time.sleep(20)",
          ].join("\n"),
        );
        expect(analyses[0]?.end).toEqual({ kind: "disk-unmeasured" });
        // At once: before the 10 s an unknown disk is allowed.
        expect(performance.now() - started).toBeLessThan(10_000);
        // Through the leader, or a thread of it once the leader's is denied too.
        expect(reports[0]).toMatch(
          /failed \(EACCES\): \/proc\/\d+\/(task\/\d+\/)?fd .*NSpid \d+ \d+ \d+\)$/,
        );
      },
      60_000,
    );

    test("is stopped at its time, memory and folder limits, and its output is cut", async () => {
      const { call, analyses } = tool({}, 15_000);
      await call("python", "import os\nos.write(1, b'x' * 10_000_000)");
      expect(analyses[0]?.output.printed.length).toBe(20_000);
      expect(analyses[0]?.output.printed.startsWith("xxxx")).toBe(true);
      await call(
        "python",
        "import time\nfor n in range(30):\n    open(f'fill{n}.bin', 'wb').write(b'x' * 10_000_000)\n    time.sleep(0.05)",
      );
      expect(analyses[1]?.end.kind === "error" && analyses[1].end.message).toContain("200 MB");
      await call("python", "while True: pass");
      expect(analyses[2]?.end).toEqual({ kind: "timed-out", limitMs: 15_000 });
      // Memory has its own run, with the full 120 s: a loaded computer allocates 3 GB slowly,
      // and the run must end at its memory limit, never at its time.
      const roomy = tool({});
      await roomy.call(
        "python",
        // Random bytes: macOS compresses a run of one byte to almost nothing, which isn't memory
        // used. Held until stopped: the limit is measured every 250 ms, not at each allocation.
        "import time\nheld = []\nfor n in range(60):\n    held.append(np.random.default_rng(n).bytes(50_000_000))\ntime.sleep(300)",
      );
      expect(roomy.analyses[0]?.end).toEqual({ kind: "out-of-memory" });
    }, 240_000);
  },
);

describe.skipIf(unavailable !== undefined || !runtimeFolder)(
  `A Skill's Python script on run_code's Python in the OS sandbox${unavailable ? ` (skipped: ${unavailable})` : runtimeFolder ? "" : " (skipped: no INCARNAMIND_TEST_PYTHON_RUNTIME)"}`,
  () => {
    test("runs on it, with its packages and none of the PATH's, and still can't read the home canary", async () => {
      const own = python?.installed() ?? null;
      if (!own) throw new Error("The runtime is ready, so it is installed.");
      const skillDir = join(data, "skills", "toolbox-id");
      await mkdir(join(skillDir, "scripts"), { recursive: true });
      await writeFile(
        join(skillDir, "scripts", "where.py"),
        [
          "import sys, numpy",
          "print(sys.executable)",
          "print(numpy.__version__)",
          "print(sys.flags.ignore_environment)",
          "try:",
          "    open(sys.argv[1]).read()",
          "    print('home: allowed')",
          "except OSError:",
          "    print('home: denied')",
          "",
        ].join("\n"),
      );
      // macOS's CPython reads PYTHONEXECUTABLE even with -E: the User's own is never handed on.
      const scripts = createScriptRunner({
        executor: executor(folders(), {
          PYTHONEXECUTABLE: "/bin/echo",
          PYTHONPATH: join(home, "site-packages"),
        }),
        python: () => own,
      });

      const run = await scripts.run({
        skillDir,
        script: "scripts/where.py",
        args: [homeCanary],
        timeoutMs: 60_000,
        signal: new AbortController().signal,
        language: "en",
      });

      expect(run).toMatchObject({ exitCode: 0, error: null });
      expect(run.stdout.trim().split("\n")).toEqual([
        join(await realpath(dirname(own.command)), "python3"),
        python?.manifest.packages.numpy,
        "1",
        "home: denied",
      ]);

      await writeFile(
        join(skillDir, "scripts", "forecast.py"),
        "import numpy\nprint('Read 12 rows.')\nimport zorblax_quant.models\n",
      );
      await expect(
        scripts.run({
          skillDir,
          script: "scripts/forecast.py",
          args: [],
          timeoutMs: 60_000,
          signal: new AbortController().signal,
          language: "en",
        }),
      ).rejects.toMatchObject({
        message:
          "This Skill needs the Python package “zorblax_quant”, which isn’t included in IncarnaMind.",
      });

      // A line about a package the runtime has, which the script wrote itself, is the script's own.
      await writeFile(
        join(skillDir, "scripts", "wrote_itself.py"),
        "import sys\nprint('rows: 0')\nsys.stderr.write(\"ModuleNotFoundError: No module named 'numpy'\\n\")\nsys.exit(1)\n",
      );
      expect(
        await scripts.run({
          skillDir,
          script: "scripts/wrote_itself.py",
          args: [],
          timeoutMs: 60_000,
          signal: new AbortController().signal,
          language: "en",
        }),
      ).toMatchObject({ exitCode: 1, stdout: "rows: 0\n", error: null });
    }, 120_000);
  },
);
