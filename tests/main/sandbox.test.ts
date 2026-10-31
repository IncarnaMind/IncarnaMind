/**
 * The OS sandbox (#65): what the "os" Executor confines, beyond the Executor
 * contract it also passes (tests/core/executor.test.ts). A program, and every
 * process it starts, can't read the User's home, IncarnaMind's data folder,
 * the shared temporary folder or a mounted volume (except the folders it was
 * allowed), writes only its working folder, and has no network.
 *
 * The home and data folders here are stand-ins in temporary folders, given to
 * the programs as arguments: nothing reads or writes the real home.
 *
 * The sandbox is loaded as a packaged Linux app loads it, with its seccomp
 * helper named (here the installed package's own copy; macOS has no use for
 * it); the contract suite loads it as development does.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ExecRequest } from "../../src/core";
import { WORKING_FOLDER } from "../../src/core/execution";
import { createScriptRunner } from "../../src/core/skills/scripts";
import { createProcessLauncher } from "../../src/main/processes";
import { loadOsSandbox, sharedReadDenied } from "../../src/main/sandbox";
import { createTempDataFolder } from "../helpers/core";

const runtime = dirname(
  dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime")),
);
const sandbox = await loadOsSandbox({
  seccompHelper: join(runtime, "vendor", "seccomp", process.arch, "apply-seccomp"),
});
/** Why the OS sandbox can't start here (Windows; Linux without bubblewrap), if it can't. */
const unavailable = sandbox.available ? undefined : sandbox.reason;

/** The test process's PATH and temporary folders, a variable that looks like a secret, and one that doesn't. */
function environment(): Record<string, string> {
  const env: Record<string, string> = { GITHUB_TOKEN: "ghp_secret", PLAIN_SETTING: "kept" };
  for (const name of ["PATH", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * A stand-in home with an SSH key canary, and a stand-in data folder holding
 * a database and a Skill, and an Executor in the OS sandbox that denies both.
 * `denyAlso` adds folders it denies, and `tempDir` is where each run gets its
 * working folder (the shared temporary folder, as in the app).
 */
async function setUp(options: { denyAlso?: string[]; tempDir?: string } = {}) {
  const root = await realpath(await createTempDataFolder());
  const home = join(root, "home");
  const canary = join(home, ".ssh", "id_canary");
  await mkdir(dirname(canary), { recursive: true });
  await writeFile(canary, "HOME CANARY");
  const data = join(root, "data");
  const database = join(data, "incarnamind.db");
  const skillDir = join(data, "skills", "toolbox-id");
  await mkdir(join(skillDir, "scripts"), { recursive: true });
  await writeFile(database, "DATA CANARY");
  await writeFile(join(skillDir, "SKILL.md"), "SKILL FILE");
  const outside = join(root, "outside");
  await mkdir(outside);
  const tempDir = options.tempDir ?? join(root, "temp");
  await mkdir(tempDir, { recursive: true });
  if (!sandbox.available) throw new Error(sandbox.reason);
  const env = environment();
  const executor = sandbox.createExecutor({
    processes: createProcessLauncher(async () => env),
    environment: async () => env,
    tempDir,
    denyRead: [home, data, ...(options.denyAlso ?? [])],
    reportError: (error) => {
      throw error;
    },
  });
  return { executor, home, canary, data, database, skillDir, outside, tempDir };
}

/** A request for `code` run by this Node.js, as a Skill script's would be: its Skill's folder to read. */
function nodeRequest(
  code: string,
  args: string[],
  skillDir: string,
  overrides: Partial<ExecRequest> = {},
): ExecRequest {
  return {
    command: process.execPath,
    args: ["-e", code, "--", ...args],
    env: {},
    allow: { read: [skillDir, WORKING_FOLDER], write: [WORKING_FOLDER], network: "none" },
    timeoutMs: 20_000,
    maxOutputBytes: 50_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/**
 * Tries each thing a script might, and prints what came of each: what it
 * read, "written", or the error's code. Its arguments: the Skill's file, the
 * database, the home canary, the home folder, the data folder, a folder
 * outside, and the port of a listener on this computer.
 *
 * What counts is what reaches the real folders: on Linux a denied folder is
 * an empty one inside the sandbox, which may even take writes that vanish.
 */
const PROBE = `
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [skillFile, database, canary, home, data, outside, port] = process.argv.slice(1);
const results = {};
const attempt = (name, act) => {
  try {
    results[name] = act() ?? "written";
  } catch (error) {
    results[name] = error.code ?? String(error);
  }
};
const child = (command, args) => spawnSync(command, args, { encoding: "utf8" }).stdout;
attempt("read the Skill's folder", () => fs.readFileSync(skillFile, "utf8"));
attempt("read the data folder", () => fs.readFileSync(database, "utf8"));
attempt("read the home canary", () => fs.readFileSync(canary, "utf8"));
attempt("list the home folder", () => fs.readdirSync(home).join(","));
attempt("write the working folder", () => fs.writeFileSync("made-here.txt", "x"));
attempt("write outside", () => fs.writeFileSync(path.join(outside, "escaped.txt"), "x"));
attempt("write the home folder", () => fs.writeFileSync(path.join(home, ".zshrc"), "x"));
attempt("write the data folder", () => fs.writeFileSync(path.join(data, "planted.txt"), "x"));
results["a child reads the home canary"] = child("/bin/cat", [canary]);
results["a child reads the data folder"] = child("/bin/cat", [database]);
child("/bin/sh", ["-c", 'echo x > "$1"', "sh", path.join(outside, "child.txt")]);
child("/bin/sh", ["-c", "echo x > child-here.txt"]);
results.secret = process.env.GITHUB_TOKEN ?? null;
results.plain = process.env.PLAIN_SETTING ?? null;
results.files = fs.readdirSync(".").sort().join(",");
const socket = net.connect(Number(port), "127.0.0.1");
const report = (outcome) => {
  results["connect to a listener on this computer"] = outcome;
  socket.destroy();
  console.log(JSON.stringify(results));
};
socket.on("connect", () => report("connected"));
socket.on("error", (error) => report(error.code ?? String(error)));
`;

/** A listener on this computer that counts the connections it gets. */
async function listener(): Promise<{ server: Server; port: number; connections: () => number }> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port.");
  return { server, port: address.port, connections: () => connections };
}

let servers: Server[] = [];
afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
});

describe("what is denied reading beyond the User's own folders", () => {
  test("is the shared temporary folder and the roots this system mounts volumes under", () => {
    const temporary = "/var/folders/ab/cdefgh/T";

    expect(sharedReadDenied("darwin", temporary)).toEqual([temporary, "/Volumes"]);
    expect(sharedReadDenied("linux", "/tmp")).toEqual(["/tmp", "/media", "/mnt"]);
    expect(sharedReadDenied("win32", "C:\\Users\\Someone\\AppData\\Local\\Temp")).toEqual([]);
  });
});

describe.skipIf(unavailable !== undefined)(
  `The OS sandbox${unavailable === undefined ? "" : ` (skipped: ${unavailable})`}`,
  { timeout: 60_000 },
  () => {
    test('its Executor is at level "os", so run_skill_script declares what scripts are allowed, and no network', async () => {
      const { executor, skillDir } = await setUp();

      expect(executor.level).toBe("os");
      expect(createScriptRunner({ executor }).access(skillDir)).toEqual({
        confined: true,
        read: [skillDir, WORKING_FOLDER],
        write: [WORKING_FOLDER],
        network: "none",
      });
    });

    test("a program and the processes it starts can't read the home or data folder, write outside the working folder, or reach the network", async () => {
      const { executor, home, canary, data, database, skillDir, outside } = await setUp();
      const { server, port, connections } = await listener();
      servers.push(server);
      const args = [
        join(skillDir, "SKILL.md"),
        database,
        canary,
        home,
        data,
        outside,
        String(port),
      ];

      const run = await executor.run(nodeRequest(PROBE, args, skillDir));

      expect(run).toMatchObject({ exitCode: 0, timedOut: false });
      const results = JSON.parse(run.stdout);
      expect(results).toMatchObject({
        "read the Skill's folder": "SKILL FILE",
        "write the working folder": "written",
        // Its own, and its child's.
        files: "child-here.txt,made-here.txt",
        "a child reads the home canary": "",
        "a child reads the data folder": "",
        secret: null,
        plain: "kept",
      });
      expect(results["read the home canary"]).not.toBe("HOME CANARY");
      expect(results["read the data folder"]).not.toBe("DATA CANARY");
      expect(results["list the home folder"]).not.toContain(".ssh");
      expect(results["connect to a listener on this computer"]).not.toBe("connected");
      expect(connections()).toBe(0);
      // Nothing it, or its child, wrote outside the working folder is there.
      expect(await readdir(outside)).toEqual([]);
      expect(await readdir(home)).toEqual([".ssh"]);
      expect((await readdir(data)).sort()).toEqual(["incarnamind.db", "skills"]);
      expect(await readFile(canary, "utf8")).toBe("HOME CANARY");
    });

    test("its temporary folder is its working folder", async () => {
      const { executor, skillDir, tempDir } = await setUp();
      const code =
        'console.log(JSON.stringify({ tmp: require("node:os").tmpdir(), cwd: process.cwd() }))';

      const run = await executor.run(nodeRequest(code, [], skillDir));

      const { tmp, cwd } = JSON.parse(run.stdout);
      expect(tmp).toBe(cwd);
      expect(cwd.startsWith(tempDir)).toBe(true);
    });

    test("can't read another app's file in the shared temporary folder, and its own working folder inside it stays readable and writable", async () => {
      const shared = await mkdtemp(join(tmpdir(), "incarnamind-shared-"));
      try {
        const otherAppsFile = join(shared, "another-app.txt");
        await writeFile(otherAppsFile, "SHARED CANARY");
        const { executor, skillDir } = await setUp({
          tempDir: tmpdir(),
          denyAlso: sharedReadDenied(process.platform, tmpdir()),
        });
        const code = `
const fs = require("node:fs");
const os = require("node:os");
const [otherAppsFile, realPath, shared] = process.argv.slice(1);
const results = {};
const attempt = (name, act) => {
  try {
    results[name] = act();
  } catch (error) {
    results[name] = error.code ?? String(error);
  }
};
attempt("read another app's file", () => fs.readFileSync(otherAppsFile, "utf8"));
attempt("read it through its real path", () => fs.readFileSync(realPath, "utf8"));
attempt("list the shared folder", () => fs.readdirSync(shared).join(","));
attempt("write its working folder", () => {
  fs.writeFileSync("made-here.txt", "mine");
  return fs.readFileSync("made-here.txt", "utf8");
});
results.tempIsItsWorkingFolder = fs.realpathSync(os.tmpdir()) === fs.realpathSync(process.cwd());
console.log(JSON.stringify(results));
`;

        const run = await executor.run(
          nodeRequest(code, [otherAppsFile, await realpath(otherAppsFile), shared], skillDir),
        );

        expect(run).toMatchObject({ exitCode: 0, timedOut: false });
        const results = JSON.parse(run.stdout);
        expect(results["read another app's file"]).not.toBe("SHARED CANARY");
        expect(results["read it through its real path"]).not.toBe("SHARED CANARY");
        expect(results["list the shared folder"]).not.toContain("another-app.txt");
        expect(results["write its working folder"]).toBe("mine");
        expect(results.tempIsItsWorkingFolder).toBe(true);
        // The file the script couldn't read is there, outside the sandbox.
        expect(await readFile(otherAppsFile, "utf8")).toBe("SHARED CANARY");
      } finally {
        await rm(shared, { recursive: true, force: true });
      }
    });

    test("an interpreter installed inside a denied folder still starts (pyenv, conda, the app in ~/Applications)", async () => {
      const installRoot = dirname(dirname(await realpath(process.execPath)));
      const around = dirname(installRoot);
      if (around === dirname(around)) return; // Installed at the top of the disk: nothing to deny around it.
      const { executor, skillDir } = await setUp({ denyAlso: [around] });

      const run = await executor.run(nodeRequest('console.log("started")', [], skillDir));

      expect(run).toMatchObject({ exitCode: 0, stdout: "started\n" });
    });

    test("a Python Skill script runs through python3 on the PATH (Xcode's shim on macOS), confined like any other", async (context) => {
      const { executor, skillDir, canary } = await setUp();
      const scripts = createScriptRunner({ executor });
      await writeFile(
        join(skillDir, "scripts", "probe.py"),
        [
          "import os, sys",
          "open('made-here.txt', 'w').write('x')",
          "try:",
          "    open(sys.argv[1]).read()",
          "    print('read the canary')",
          "except OSError:",
          "    print('canary denied')",
          "print(os.path.isfile(os.path.join(os.environ['SKILL_DIR'], 'SKILL.md')))",
        ].join("\n"),
      );

      let run: Awaited<ReturnType<typeof scripts.run>>;
      try {
        run = await scripts.run({
          skillDir,
          script: "scripts/probe.py",
          args: [canary],
          timeoutMs: 20_000,
          signal: new AbortController().signal,
        });
      } catch (error) {
        if (String(error).includes("python3 not found")) {
          context.skip("python3 isn't installed here");
        }
        throw error;
      }

      expect(run).toMatchObject({ exitCode: 0, stdout: "canary denied\nTrue\n", error: null });
    });

    test("a program that asks for the network is refused before it runs, never run unconfined", async () => {
      const { executor, skillDir, outside } = await setUp();
      const marker = join(outside, "ran.txt");

      await expect(
        executor.run(
          nodeRequest(
            'require("node:fs").writeFileSync(process.argv[1], "ran")',
            [marker],
            skillDir,
            {
              allow: { read: [WORKING_FOLDER], write: [WORKING_FOLDER, outside], network: "any" },
            },
          ),
        ),
      ).rejects.toThrow(/network/);

      expect(existsSync(marker)).toBe(false);
    });
  },
);
