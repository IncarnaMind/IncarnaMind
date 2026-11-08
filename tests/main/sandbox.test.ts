/**
 * The OS sandbox (#65): what the "os" Executor confines, beyond the Executor
 * contract it also passes (tests/core/executor.test.ts). A program, and every
 * process it starts, can't read the User's home, IncarnaMind's data folder,
 * the shared and per-user temporary folders or a mounted volume (except the
 * folders it was allowed), writes only its working folder, and has no
 * network.
 *
 * The home and data folders here are stand-ins in temporary folders, given to
 * the programs as arguments: nothing reads or writes the real home.
 *
 * The sandbox is loaded as a packaged Linux app loads it, with its seccomp
 * helper named (here the installed package's own copy; macOS has no use for
 * it); the contract suite loads it as development does.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, onTestFinished, test } from "vitest";
import type { ExecRequest } from "../../src/core";
import { WORKING_FOLDER } from "../../src/core/execution";
import { createScriptRunner } from "../../src/core/skills/scripts";
import { createProcessLauncher } from "../../src/main/processes";
import {
  bwrapScript,
  bwrapSizesTmpfs,
  canonicalPath,
  installFolders,
  interpreterRoots,
  loadOsSandbox,
  MAC_DENIED,
  type OsExecutorOptions,
  readDeniedFolders,
  sizedBwrap,
  withMacDenials,
} from "../../src/main/sandbox";
import { createTempDataFolder } from "../helpers/core";
import { createSweepGuard } from "../helpers/sweepGuard";

const runtime = dirname(
  dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime")),
);
const guard = createSweepGuard();
// Outside each case's folders, which the cases list and remove.
const runRecords = guard.records(await mkdtemp(join(tmpdir(), "incarnamind-test-runs-")));
afterAll(() => rm(runRecords, { recursive: true, force: true }));
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
 * `denyAlso` adds folders it denies, `tempDir` is where each run gets its
 * working folder (the shared temporary folder, as in the app), and `readDenied`
 * denies what the app denies, through the function the app builds it with.
 */
/** An Executor in the OS sandbox with this file's run records and sweep, as the app makes one. */
function osExecutor(
  options: Pick<OsExecutorOptions, "tempDir" | "denyRead" | "interpreterRoots"> &
    Partial<Pick<OsExecutorOptions, "reportError">> & {
      env: Record<string, string>;
    },
) {
  if (!sandbox.available) throw new Error(sandbox.reason);
  const { env, ...rest } = options;
  return sandbox.createExecutor({
    processes: createProcessLauncher(async () => env),
    environment: async () => env,
    reportError: (error) => {
      throw error;
    },
    runRecords,
    sweep: { stopper: guard.stopper },
    ...rest,
  });
}

/** What the app denies, for a home and data folder of a test's own. */
const deniedFor = (home: string, dataDir: string, temporaryFolder = tmpdir()) =>
  readDeniedFolders({
    platform: process.platform,
    home,
    dataDir,
    temporaryFolder,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  });

/** `sh -c script`, found on the PATH, as a request a Skill script's would be. */
const shell = (script: string, allow: ExecRequest["allow"]["read"] = [WORKING_FOLDER]) => ({
  command: "sh",
  args: ["-c", script],
  env: {},
  allow: { read: allow, write: [WORKING_FOLDER], network: "none" as const },
  timeoutMs: 20_000,
  maxOutputBytes: 50_000,
  signal: new AbortController().signal,
});

async function setUp(
  options: {
    denyAlso?: string[];
    tempDir?: string;
    readDenied?: boolean;
    interpreterRoots?: string[];
  } = {},
) {
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
    denyRead: options.readDenied
      ? readDeniedFolders({
          platform: process.platform,
          home,
          dataDir: data,
          temporaryFolder: tempDir,
          uid: typeof process.getuid === "function" ? process.getuid() : undefined,
        })
      : [home, data, ...(options.denyAlso ?? [])],
    ...(options.interpreterRoots && { interpreterRoots: options.interpreterRoots }),
    reportError: (error) => {
      throw error;
    },
    runRecords,
    sweep: { stopper: guard.stopper },
  });
  return { root, executor, home, canary, data, database, skillDir, outside, tempDir };
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
  // Each pid a run's sweep signalled was a member of one of this file's own runs.
  expect(guard.refused).toEqual([]);
});

test("a bubblewrap that can size a tmpfs is told from one that can't, by its help", () => {
  // As bubblewrap 0.7's help lists it, and 0.6's, which has no --size.
  const seven = [
    "    --tmpfs DEST                 Mount new tmpfs on DEST",
    "    --size BYTES                 Set size of next tmpfs (in bytes)",
  ].join("\n");
  const six = [
    "    --tmpfs DEST                 Mount new tmpfs on DEST",
    "    --perms OCTAL",
  ].join("\n");
  expect([bwrapSizesTmpfs(seven), bwrapSizesTmpfs(six), bwrapSizesTmpfs("")]).toEqual([
    true,
    false,
    false,
  ]);
});

test("macOS's denials go after sandbox-runtime's profile, and a profile that lets programs reach the network doesn't run", () => {
  const wrapped = (profile: string) =>
    `cd /x && SANDBOX=1 /usr/bin/sandbox-exec -p '${profile}' /bin/bash -c 'true'`;
  const run = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const stricter = withMacDenials(wrapped("(version 1)(deny default)"), run);
  expect(stricter).toContain(MAC_DENIED);
  expect(stricter).toContain(`(allow mach-lookup (global-name "com.incarnamind.run.${run}"))`);
  expect(stricter).not.toContain("(deny ipc-posix-shm-write-create)");
  // A program held to a memory limit can't make shared memory, which no limit counts.
  expect(withMacDenials(wrapped("(version 1)(deny default)"), run, true)).toContain(
    "(deny ipc-posix-shm-write-create)",
  );
  expect(() =>
    withMacDenials(
      wrapped('(version 1)(deny default)(allow network-outbound (remote ip "localhost:*"))'),
      run,
    ),
  ).toThrow("lets programs reach the network");
  expect(() => withMacDenials("/bin/bash -c true", run)).toThrow(
    "isn't the one IncarnaMind adds to",
  );
});

test("bubblewrap's folders over denied ones and its /dev/shm hold 1 MB, and /dev is read-only once mounted", async () => {
  const folder = await createTempDataFolder();
  // A stand-in bubblewrap that prints what it was given, a word a line.
  const real = join(folder, "bwrap");
  await writeFile(real, '#!/bin/sh\nfor a do echo "$a"; done\n', { mode: 0o700 });
  const wrapper = join(folder, "sized");
  await writeFile(wrapper, bwrapScript(real), { mode: 0o700 });
  const given = [
    "--ro-bind",
    "/",
    "/",
    "--tmpfs",
    "/home",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--",
    "sh",
    "-c",
    "--tmpfs",
  ];
  const { stdout } = await promisify(execFile)(wrapper, given);
  expect(stdout.trimEnd().split("\n")).toEqual([
    "--ro-bind",
    "/",
    "/",
    "--size",
    "1048576",
    "--tmpfs",
    "/home",
    "--dev",
    "/dev",
    "--size",
    "1048576",
    "--tmpfs",
    "/dev/shm",
    "--proc",
    "/proc",
    "--remount-ro",
    "/dev",
    "--",
    "sh",
    "-c",
    "--tmpfs",
  ]);
});

describe.skipIf(process.platform === "win32")("the sized bubblewrap script", () => {
  /**
   * A made-up bubblewrap of this test's own, first on the PATH for the rest of the test, which
   * says what `help` makes it say to `--help`.
   */
  async function theirBwrap(help: string) {
    const root = await mkdtemp(join(tmpdir(), "incarnamind-bwrap-test-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    const bwrap = join(bin, "bwrap");
    await writeFile(bwrap, `#!/bin/sh\n${help}\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    onTestFinished(async () => {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
      await rm(root, { recursive: true, force: true });
    });
    return { bwrap, temp: join(root, "tmp") };
  }

  test("two probes starting at once both get the sized script", async () => {
    const { bwrap, temp } = await theirBwrap("echo '    --size BYTES  Set size of next tmpfs'");

    const [first, second] = await Promise.all([sizedBwrap(temp), sizedBwrap(temp)]);

    const script = join(temp, `incarnamind-bwrap-${process.getuid?.() ?? 0}`, "bwrap");
    expect([first, second]).toEqual([
      { kind: "sized", script },
      { kind: "sized", script },
    ]);
    expect(await readFile(script, "utf8")).toBe(bwrapScript(bwrap));
    expect(await readdir(dirname(script))).toEqual(["bwrap"]);
  });

  test("a bubblewrap that can't size a tmpfs runs as it is, not as missing", async () => {
    // As bubblewrap 0.6 answers --help.
    const { temp } = await theirBwrap(
      [
        "echo 'usage: bwrap [OPTIONS...] [--] COMMAND [ARGS...]'",
        "echo '    --tmpfs DEST                 Mount new tmpfs'",
      ].join("\n"),
    );

    expect(await sizedBwrap(temp)).toEqual({ kind: "unsized" });
  });

  test("a probe that says nothing is reported, never taken for an old bubblewrap", async () => {
    const { temp } = await theirBwrap("exit 1");

    await expect(sizedBwrap(temp)).rejects.toThrow(/bwrap/);
  });

  test("a probe that dies with an error is reported, not taken for an old bubblewrap", async () => {
    const { temp } = await theirBwrap(
      "echo 'bwrap: error while loading shared libraries: libcap.so.2: cannot open shared object file' >&2\nexit 127",
    );

    await expect(sizedBwrap(temp)).rejects.toThrow(/libcap/);
  });

  test("help that comes with a nonzero exit is still help", async () => {
    const { temp } = await theirBwrap(
      [
        "echo 'usage: bwrap [OPTIONS...] [--] COMMAND [ARGS...]' >&2",
        "echo '    --tmpfs DEST                 Mount new tmpfs' >&2",
        "exit 1",
      ].join("\n"),
    );

    expect(await sizedBwrap(temp)).toEqual({ kind: "unsized" });
  });

  test("a rename that fails removes its own .new file", async () => {
    const { temp } = await theirBwrap(
      "echo 'usage: bwrap [OPTIONS...] [COMMAND]'\necho '    --size BYTES'",
    );
    const folder = join(temp, `incarnamind-bwrap-${process.getuid?.() ?? 0}`);
    await mkdir(join(folder, "bwrap"), { recursive: true, mode: 0o700 });

    await expect(sizedBwrap(temp)).rejects.toThrow(/bwrap/);
    expect(await readdir(folder)).toEqual(["bwrap"]);
  });

  test("no bubblewrap on the PATH is told apart from a failing probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "incarnamind-bwrap-test-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    const path = process.env.PATH;
    process.env.PATH = bin;
    onTestFinished(async () => {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
      await rm(root, { recursive: true, force: true });
    });

    expect(await sizedBwrap(join(root, "tmp"))).toEqual({ kind: "missing" });
  });
});

describe("the folders no program may read", () => {
  const user = { home: "/Users/Ada", dataDir: "/home/Ada/data", uid: 501 };

  test("on macOS: every account's home, the shared temporary folders, and the roots volumes are mounted under", () => {
    expect(
      readDeniedFolders({ ...user, platform: "darwin", temporaryFolder: "/var/folders/xy/abc/T" }),
    ).toEqual([
      "/Users/Ada",
      "/home/Ada/data",
      "/var/folders/xy/abc/T",
      "/tmp",
      "/var/folders/xy/abc",
      "/Users",
      "/private/tmp",
      "/var/tmp",
      "/private/var/tmp",
      "/Volumes",
    ]);
  });

  test("on macOS with a TMPDIR elsewhere, the folder holding it is not denied", () => {
    expect(
      readDeniedFolders({ ...user, platform: "darwin", temporaryFolder: "/Users/Ada/tmp" }),
    ).toEqual([
      "/Users/Ada",
      "/home/Ada/data",
      "/Users/Ada/tmp",
      "/tmp",
      "/Users",
      "/private/tmp",
      "/var/tmp",
      "/private/var/tmp",
      "/Volumes",
    ]);
  });

  test("on Linux: the same, and this User's runtime folder (session bus, systemd, keyring, agents, mounts)", () => {
    expect(readDeniedFolders({ ...user, platform: "linux", temporaryFolder: "/tmp" })).toEqual([
      "/Users/Ada",
      "/home/Ada/data",
      "/tmp",
      "/home",
      "/root",
      "/var/tmp",
      "/media",
      "/mnt",
      "/run/media",
      "/run/user/501",
    ]);
  });

  test("on Linux with TMPDIR elsewhere, /tmp too", () => {
    expect(
      readDeniedFolders({ ...user, platform: "linux", temporaryFolder: "/home/Ada/tmp" }),
    ).toEqual([
      "/Users/Ada",
      "/home/Ada/data",
      "/home/Ada/tmp",
      "/tmp",
      "/home",
      "/root",
      "/var/tmp",
      "/media",
      "/mnt",
      "/run/media",
      "/run/user/501",
    ]);
  });

  test("nowhere on Windows, which has no OS sandbox", () => {
    expect(
      readDeniedFolders({ ...user, platform: "win32", temporaryFolder: "C:\\Users\\Ada\\Temp" }),
    ).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")(
  "the one spelling of a path the sandbox is given",
  () => {
    test("follows every link on its way; for a path that isn't there, the folders that are", async () => {
      const root = await realpath(await createTempDataFolder());
      const moved = join(root, "moved");
      await mkdir(join(moved, "bin"), { recursive: true });
      await symlink(moved, join(root, "Data"));

      expect(await canonicalPath(join(root, "Data"))).toBe(moved);
      expect(await canonicalPath(join(root, "Data", "bin"))).toBe(join(moved, "bin"));
      expect(await canonicalPath(join(root, "Data", "gone", "font.ttf"))).toBe(
        join(moved, "gone", "font.ttf"),
      );
      if (process.platform === "darwin") {
        // /tmp, /var and /etc are links into /private.
        expect(await canonicalPath("/tmp")).toBe("/private/tmp");
        expect(await canonicalPath("/var/incarnamind-none-such/x")).toBe(
          "/private/var/incarnamind-none-such/x",
        );
      }
    });

    test("a path that must be there and isn't is refused, never taken as written", async () => {
      const root = await realpath(await createTempDataFolder());
      await expect(canonicalPath(join(root, "gone"), { mustExist: true })).rejects.toThrow(
        "can't be found",
      );
      expect(await canonicalPath(root, { mustExist: true })).toBe(root);
    });

    test("an interpreter outside every denied folder has nothing read back for it: it is readable already", async () => {
      const root = await realpath(await createTempDataFolder());
      const home = join(root, "home");
      await mkdir(join(home, "bin"), { recursive: true });
      const inHome = join(home, "bin", "sh");
      const denied = [home];

      expect(await installFolders("/usr/bin/env", "/usr/bin/env", denied, denied)).toEqual([]);
      expect(await installFolders(inHome, inHome, denied, denied)).toEqual([join(home, "bin")]);
    });

    test("a prefix's linked lib is handed to the sandbox by its real place and its name only when it links to a lib folder of the prefix", async () => {
      const root = await realpath(await createTempDataFolder());
      const home = join(root, "home");
      const prefixWith = async (name: string, lib: (prefix: string) => string) => {
        const prefix = join(home, name);
        await mkdir(join(prefix, "bin"), { recursive: true });
        await mkdir(join(prefix, "lib-3.12"));
        await mkdir(join(prefix, "share"));
        await writeFile(join(prefix, "bin", "python3"), "");
        await symlink(lib(prefix), join(prefix, "lib"));
        return prefix;
      };
      const inside = await prefixWith("inside", (prefix) => join(prefix, "lib-3.12"));
      const toShare = await prefixWith("to-share", (prefix) => join(prefix, "share"));
      const handed = (prefix: string) =>
        installFolders(
          join(prefix, "bin", "python3"),
          join(prefix, "bin", "python3"),
          [home],
          [home],
        );

      expect(await handed(inside)).toEqual([
        join(inside, "bin"),
        join(inside, "lib-3.12"),
        join(inside, "lib"),
      ]);
      expect(await handed(toShare)).toEqual([join(toShare, "bin")]);
    });

    test("the homes interpreters may be installed in are each account's and the volumes'", () => {
      expect(interpreterRoots({ platform: "darwin", home: "/Users/Ada" })).toEqual([
        "/Users/Ada",
        "/Users",
        "/Volumes",
      ]);
      expect(interpreterRoots({ platform: "linux", home: "/home/ada" })).toEqual([
        "/home/ada",
        "/home",
        "/root",
        "/media",
        "/mnt",
        "/run/media",
      ]);
      expect(interpreterRoots({ platform: "win32", home: "C:\\Users\\Ada" })).toEqual([]);
    });
  },
);

// The job that runs these on a Mac says it needs the sandbox: a sandbox that can't start there
// fails it, rather than skipping every test that would show it.
test.runIf(process.env.INCARNAMIND_TEST_OS_SANDBOX === "required")("the OS sandbox starts", () => {
  expect(unavailable).toBeUndefined();
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
        const { executor, skillDir } = await setUp({ tempDir: tmpdir(), readDenied: true });
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

    test("can't read the other temporary folders or the folders beside its own, and its own working folder stays readable and writable", async () => {
      const folders: string[] = [];
      const canaries: string[] = [];
      const probes: { what: string; path: string; listing?: boolean }[] = [];
      try {
        if (process.platform === "darwin" || process.platform === "linux") {
          const folder = await mkdtemp(join("/var/tmp", "incarnamind-shared-"));
          folders.push(folder);
          const canary = join(folder, "another-app.txt");
          await writeFile(canary, "VAR TMP CANARY");
          canaries.push(canary);
          probes.push({ what: "read another app's file in /var/tmp", path: canary });
        }
        if (process.platform === "darwin") {
          const folder = await mkdtemp(join("/private/tmp", "incarnamind-shared-"));
          folders.push(folder);
          const inTmp = join(folder, "another-app.txt");
          await writeFile(inTmp, "TMP CANARY");
          canaries.push(inTmp);
          probes.push({ what: "read another app's file in /private/tmp", path: inTmp });
          probes.push({
            what: "read it through /tmp",
            path: join("/tmp", basename(folder), "another-app.txt"),
          });
          const beside = await mkdtemp(join(dirname(tmpdir()), "incarnamind-shared-"));
          folders.push(beside);
          const besideCanary = join(beside, "another-app.txt");
          await writeFile(besideCanary, "BESIDE CANARY");
          canaries.push(besideCanary);
          probes.push({
            what: "read a file in a folder beside its temporary folder",
            path: besideCanary,
          });
          for (const name of ["C", "0"]) {
            const holder = join(dirname(tmpdir()), name);
            if (existsSync(holder))
              probes.push({ what: `list ${holder}`, path: holder, listing: true });
          }
        }
        const { executor, skillDir } = await setUp({ tempDir: tmpdir(), readDenied: true });
        const code = `
const fs = require("node:fs");
const results = {};
for (const probe of JSON.parse(process.argv[1])) {
  try {
    results[probe.what] = probe.listing
      ? fs.readdirSync(probe.path).join(",")
      : fs.readFileSync(probe.path, "utf8");
  } catch (error) {
    results[probe.what] = error.code ?? String(error);
  }
}
fs.writeFileSync("made-here.txt", "mine");
results["write its working folder"] = fs.readFileSync("made-here.txt", "utf8");
console.log(JSON.stringify(results));
`;

        const run = await executor.run(nodeRequest(code, [JSON.stringify(probes)], skillDir));

        expect(run).toMatchObject({ exitCode: 0, timedOut: false });
        const results = JSON.parse(run.stdout);
        for (const probe of probes) expect(results[probe.what]).toMatch(/^E[A-Z]+$/);
        expect(results["write its working folder"]).toBe("mine");
        // What it couldn't read is there, outside the sandbox.
        for (const canary of canaries) expect(await readFile(canary, "utf8")).toMatch(/CANARY$/);
      } finally {
        for (const folder of folders) await rm(folder, { recursive: true, force: true });
      }
    });

    test("an interpreter installed inside a denied folder still starts (pyenv, conda, the app in ~/Applications)", async () => {
      const installRoot = dirname(dirname(await realpath(process.execPath)));
      const around = dirname(installRoot);
      if (around === dirname(around)) return; // Installed at the top of the disk: nothing to deny around it.
      const { executor, skillDir } = await setUp({
        denyAlso: [around],
        interpreterRoots: [around],
      });

      const run = await executor.run(nodeRequest('console.log("started")', [], skillDir));

      expect(run).toMatchObject({ exitCode: 0, stdout: "started\n" });
    });

    test("an interpreter in a home reached through a link starts, and the rest of that home stays unread", async () => {
      const { root } = await setUp();
      const realHome = join(root, "real-home");
      const linkedHome = join(root, "linked-home");
      await mkdir(join(realHome, ".ssh"), { recursive: true });
      await mkdir(join(realHome, "bin"));
      await writeFile(join(realHome, ".ssh", "id"), "HOME SECRET");
      await symlink(realHome, linkedHome);
      await symlink("/bin/sh", join(realHome, "bin", "sh"));
      const executor = osExecutor({
        env: { PATH: `${join(linkedHome, "bin")}:/usr/bin:/bin` },
        tempDir: join(root, "temp"),
        denyRead: deniedFor(linkedHome, join(linkedHome, "Library", "IncarnaMind")),
        interpreterRoots: interpreterRoots({ platform: process.platform, home: linkedHome }),
      });

      const run = await executor.run(
        shell(
          [
            "echo started",
            `cat '${join(realHome, ".ssh", "id")}' 2>/dev/null || echo denied`,
            `cat '${join(linkedHome, ".ssh", "id")}' 2>/dev/null || echo denied`,
          ].join("; "),
        ),
      );

      expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({
        exitCode: 0,
        stdout: "started\ndenied\ndenied\n",
      });
    });

    test("sh and uv's python3 linked from ~/.local/bin run, uv's Python reads its own install, and the rest of ~/.local stays unread", async () => {
      const { root, home, data } = await setUp();
      const local = join(home, ".local");
      // uv's default Python: ~/.local/bin/python3, a link into ~/.local/share/uv/python/….
      const uv = join(local, "share", "uv", "python", "cpython-3.14");
      await mkdir(join(uv, "bin"), { recursive: true });
      await mkdir(join(uv, "lib"));
      await writeFile(join(uv, "lib", "own.txt"), "OWN INSTALL\n");
      await writeFile(join(uv, "bin", "python3.14"), '#!/bin/sh\nexec /bin/sh "$@"\n', {
        mode: 0o755,
      });
      await mkdir(join(local, "bin"));
      await symlink(join(uv, "bin", "python3.14"), join(local, "bin", "python3"));
      await symlink("/bin/sh", join(local, "bin", "sh"));
      await mkdir(join(local, "share", "keyrings"), { recursive: true });
      await writeFile(join(local, "share", "keyrings", "login.keyring"), "KEYRING SECRET");
      const executor = osExecutor({
        env: { PATH: `${join(local, "bin")}:/usr/bin:/bin` },
        tempDir: join(root, "temp"),
        denyRead: deniedFor(home, data),
        interpreterRoots: interpreterRoots({ platform: process.platform, home }),
      });
      const probe = [
        "echo started",
        `cat '${join(uv, "lib", "own.txt")}' 2>/dev/null || echo denied`,
        `cat '${join(local, "share", "keyrings", "login.keyring")}' 2>/dev/null || echo denied`,
      ].join("; ");

      const sh = await executor.run(shell(probe));
      const python = await executor.run({ ...shell(probe), command: "python3" });

      expect({ exitCode: sh.exitCode, stdout: sh.stdout }).toEqual({
        exitCode: 0,
        stdout: "started\ndenied\ndenied\n",
      });
      expect({ exitCode: python.exitCode, stdout: python.stdout }).toEqual({
        exitCode: 0,
        stdout: "started\nOWN INSTALL\ndenied\n",
      });
    });

    test.each([
      ["a plain python3 in ~/.local/bin", [".local"]],
      ["a pyenv Python, a plain file", [".pyenv", "versions", "3.12"]],
    ])(
      "%s runs and reads its prefix's bin and lib, and nothing else of the prefix",
      async (_what, parts) => {
        const { root, home, data } = await setUp();
        const prefix = join(home, ...parts);
        const stdlib = join(prefix, "lib", "python3.12");
        await mkdir(join(prefix, "bin"), { recursive: true });
        await mkdir(stdlib, { recursive: true });
        await mkdir(join(prefix, "share", "keyrings"), { recursive: true });
        await writeFile(join(prefix, "bin", "python3"), '#!/bin/sh\nexec /bin/sh "$@"\n', {
          mode: 0o755,
        });
        await writeFile(join(stdlib, "os.py"), "STDLIB\n");
        await writeFile(join(prefix, "share", "keyrings", "login.keyring"), "KEYRING SECRET");
        const executor = osExecutor({
          env: { PATH: `${join(prefix, "bin")}:/usr/bin:/bin` },
          tempDir: join(root, "temp"),
          denyRead: deniedFor(home, data),
          interpreterRoots: interpreterRoots({ platform: process.platform, home }),
        });

        const run = await executor.run({
          ...shell(
            [
              "echo started",
              `cat '${join(stdlib, "os.py")}' 2>/dev/null || echo denied`,
              `cat '${join(prefix, "share", "keyrings", "login.keyring")}' 2>/dev/null || echo denied`,
            ].join("; "),
          ),
          command: "python3",
        });

        expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({
          exitCode: 0,
          stdout: "started\nSTDLIB\ndenied\n",
        });
      },
    );

    test("a prefix's lib that links to a lib folder of the prefix is read where it really is; one that links anywhere else opens nothing", async () => {
      const { root, home, data, canary } = await setUp();
      await mkdir(join(home, "Library", "Keychains"), { recursive: true });
      await writeFile(join(home, "Library", "Keychains", "login.keychain-db"), "KEYCHAIN SECRET");
      const elsewhere = join(home, "elsewhere", "lib");
      await mkdir(join(elsewhere, "python3.12"), { recursive: true });
      await writeFile(join(elsewhere, "python3.12", "os.py"), "STDLIB\n");
      const roots = interpreterRoots({ platform: process.platform, home });
      const run = async (
        name: string,
        lib: (prefix: string) => Promise<string>,
        through: string,
      ) => {
        const prefix = join(home, name);
        await mkdir(join(prefix, "bin"), { recursive: true });
        await writeFile(join(prefix, "bin", "python3"), '#!/bin/sh\nexec /bin/sh "$@"\n', {
          mode: 0o755,
        });
        await symlink(await lib(prefix), join(prefix, "lib"));
        const ran = await osExecutor({
          tempDir: join(root, "temp"),
          denyRead: deniedFor(home, data),
          interpreterRoots: roots,
          env: { PATH: `${join(prefix, "bin")}:/usr/bin:/bin` },
        }).run({
          ...shell(
            [
              "echo started",
              `cat '${join(prefix, "lib", through)}' 2>/dev/null || echo denied`,
              `cat '${canary}' 2>/dev/null || echo denied`,
            ].join("; "),
          ),
          command: "python3",
        });
        return { name, exitCode: ran.exitCode, stdout: ran.stdout };
      };
      const inside = async (prefix: string) => {
        await mkdir(join(prefix, "lib-3.12", "python3.12"), { recursive: true });
        await writeFile(join(prefix, "lib-3.12", "python3.12", "os.py"), "STDLIB\n");
        return join(prefix, "lib-3.12");
      };
      // The prefix itself, with a keyring in its share folder beside lib.
      const keyring = async (prefix: string) => {
        await mkdir(join(prefix, "share", "keyrings"), { recursive: true });
        await writeFile(join(prefix, "share", "keyrings", "login.keyring"), "KEYRING SECRET");
        return prefix;
      };
      const cases = [
        await run("inside", inside, join("python3.12", "os.py")),
        await run("to-elsewhere", async () => elsewhere, join("python3.12", "os.py")),
        await run("to-home", async () => home, join(".ssh", "id_canary")),
        await run("to-own-prefix", keyring, join("share", "keyrings", "login.keyring")),
        await run(
          "to-share",
          async (prefix) => join(await keyring(prefix), "share"),
          join("keyrings", "login.keyring"),
        ),
        await run("to-ssh", async () => join(home, ".ssh"), "id_canary"),
        await run(
          "to-keychains",
          async () => join(home, "Library", "Keychains"),
          "login.keychain-db",
        ),
        // APFS and HFS+ ignore letter case: another spelling of ~/.ssh is ~/.ssh.
        ...(process.platform === "darwin"
          ? [await run("to-ssh-other-case", async () => join(home, ".SSH"), "id_canary")]
          : []),
      ];

      // sandbox-runtime gives a link inside a masked folder back on Linux only where it points,
      // never at its own name, so there a lib that is a link finds nothing through it.
      const readsInside =
        process.platform === "linux" ? "started\ndenied\ndenied\n" : "started\nSTDLIB\ndenied\n";
      expect(cases).toEqual(
        cases.map(({ name }) => ({
          name,
          exitCode: 0,
          stdout: name === "inside" ? readsInside : "started\ndenied\ndenied\n",
        })),
      );
    });

    test("a prefix's lib that links in a loop stops the run with the sandbox's own words", async () => {
      const { root, home, data } = await setUp();
      const prefix = join(home, "looped");
      await mkdir(join(prefix, "bin"), { recursive: true });
      await writeFile(join(prefix, "bin", "python3"), '#!/bin/sh\nexec /bin/sh "$@"\n', {
        mode: 0o755,
      });
      await symlink(join(prefix, "lib2"), join(prefix, "lib"));
      await symlink(join(prefix, "lib"), join(prefix, "lib2"));
      const executor = osExecutor({
        tempDir: join(root, "temp"),
        denyRead: deniedFor(home, data),
        interpreterRoots: interpreterRoots({ platform: process.platform, home }),
        env: { PATH: `${join(prefix, "bin")}:/usr/bin:/bin` },
      });

      await expect(executor.run({ ...shell("echo started"), command: "python3" })).rejects.toThrow(
        "The OS sandbox couldn't start, so the program didn't run",
      );
    });

    test("a venv's python in a home runs with its site-packages, and the project beside the venv stays unread", async () => {
      const { root, home, data } = await setUp();
      const project = join(home, "project");
      const venv = join(project, ".venv");
      const sitePackages = join(venv, "lib", "python3.14", "site-packages");
      await mkdir(join(venv, "bin"), { recursive: true });
      await mkdir(sitePackages, { recursive: true });
      await writeFile(join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
      await writeFile(join(sitePackages, "package.py"), "SITE PACKAGES\n");
      await writeFile(join(project, "notes.txt"), "PROJECT SECRET");
      // A venv's python is a link to the interpreter it was made from.
      await symlink("/bin/sh", join(venv, "bin", "python"));
      const executor = osExecutor({
        env: { PATH: `${join(venv, "bin")}:/usr/bin:/bin` },
        tempDir: join(root, "temp"),
        denyRead: deniedFor(home, data),
        interpreterRoots: interpreterRoots({ platform: process.platform, home }),
      });

      const run = await executor.run({
        ...shell(
          [
            "echo started",
            `cat '${join(sitePackages, "package.py")}' 2>/dev/null || echo denied`,
            `cat '${join(project, "notes.txt")}' 2>/dev/null || echo denied`,
          ].join("; "),
        ),
        command: "python",
      });

      expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({
        exitCode: 0,
        stdout: "started\nSITE PACKAGES\ndenied\n",
      });
    });

    test.each(["a link", "a plain script"])(
      "an interpreter on the PATH in the shared temporary folder, %s, doesn't start, and from the system's own folders the same command reads nothing there",
      async (how) => {
        const { root, home, data } = await setUp();
        const shim = await mkdtemp(join(tmpdir(), "incarnamind-shim-"));
        const other = await mkdtemp(join(tmpdir(), "incarnamind-other-"));
        onTestFinished(async () => {
          await rm(shim, { recursive: true, force: true });
          await rm(other, { recursive: true, force: true });
        });
        if (how === "a link") await symlink("/bin/sh", join(shim, "sh"));
        else await writeFile(join(shim, "sh"), '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
        await writeFile(join(other, "secret.txt"), "TEMP SECRET");
        const probe = `echo started; cat '${join(other, "secret.txt")}' 2>/dev/null || echo denied`;
        const folders = {
          tempDir: join(root, "temp"),
          denyRead: deniedFor(home, data),
          interpreterRoots: interpreterRoots({ platform: process.platform, home }),
        };

        const shimmed = await osExecutor({
          ...folders,
          env: { PATH: `${shim}:/usr/bin:/bin` },
        }).run(shell(probe));
        const system = await osExecutor({ ...folders, env: { PATH: "/usr/bin:/bin" } }).run(
          shell(probe),
        );

        expect(shimmed.stdout).not.toContain("TEMP SECRET");
        expect(shimmed.stdout).not.toContain("started");
        expect(shimmed.exitCode).not.toBe(0);
        expect({ exitCode: system.exitCode, stdout: system.stdout }).toEqual({
          exitCode: 0,
          stdout: "started\ndenied\n",
        });
      },
    );

    test("a link into a folder no program may read is no way in: the home's keys, another temporary folder by either spelling, another run's folder, the volumes, this User's runtime folder", async () => {
      const shared = await mkdtemp(join(tmpdir(), "incarnamind-shared-"));
      onTestFinished(() => rm(shared, { recursive: true, force: true }));
      await writeFile(join(shared, "file.txt"), "TEMP CANARY");
      const { executor, skillDir, outside, home, tempDir } = await setUp({
        tempDir: tmpdir(),
        readDenied: true,
      });
      const otherRun = await mkdtemp(join(tempDir, "incarnamind-script-"));
      onTestFinished(() => rm(otherRun, { recursive: true, force: true }));
      await writeFile(join(otherRun, "file.txt"), "RUN CANARY");
      const probes: { what: string; path: string; listing?: boolean }[] = [];
      const linked = async (what: string, target: string, inside: string, listing = false) => {
        const link = join(outside, `to-${probes.length}`);
        await symlink(target, link);
        probes.push({ what, path: inside ? join(link, inside) : link, listing });
      };
      await linked("the home's keys", join(home, ".ssh"), "id_canary");
      await linked("another temporary folder", shared, "file.txt");
      await linked(
        "another temporary folder, by its real path",
        await realpath(shared),
        "file.txt",
      );
      await linked("another run's folder", otherRun, "file.txt");
      if (process.platform === "darwin") await linked("the volumes", "/Volumes", "", true);
      const runtimeFolder = `/run/user/${process.getuid?.() ?? 0}`;
      if (process.platform === "linux" && existsSync(runtimeFolder)) {
        await linked("this User's runtime folder", runtimeFolder, "", true);
      }
      const code = `
const fs = require("node:fs");
const results = { started: true };
for (const probe of JSON.parse(process.argv[1])) {
  try {
    const got = probe.listing ? fs.readdirSync(probe.path).join(",") : fs.readFileSync(probe.path, "utf8");
    results[probe.what] = got === "" ? "empty" : got;
  } catch (error) {
    results[probe.what] = error.code ?? String(error);
  }
}
console.log(JSON.stringify(results));
`;

      const run = await executor.run(nodeRequest(code, [JSON.stringify(probes)], skillDir));

      expect(run).toMatchObject({ exitCode: 0, timedOut: false });
      const results = JSON.parse(run.stdout);
      expect(results.started).toBe(true);
      for (const probe of probes) {
        expect({ [probe.what]: results[probe.what] }).toEqual({
          [probe.what]: expect.stringMatching(/^(E[A-Z]+|empty)$/),
        });
      }
    });

    test("an allowed folder given through a link to it is read", async () => {
      const { executor, skillDir, outside } = await setUp();
      await symlink(skillDir, join(outside, "the-skill"));

      const run = await executor.run(
        nodeRequest(
          'console.log("started"); console.log(require("node:fs").readFileSync(process.argv[1], "utf8"))',
          [join(outside, "the-skill", "SKILL.md")],
          skillDir,
          {
            allow: {
              read: [join(outside, "the-skill"), WORKING_FOLDER],
              write: [WORKING_FOLDER],
              network: "none",
            },
          },
        ),
      );

      expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({
        exitCode: 0,
        stdout: "started\nSKILL FILE\n",
      });
    });

    test("an allowed folder that is, or links to, a folder holding denied ones is refused before anything runs", async () => {
      const { executor, root, skillDir, outside } = await setUp();
      await symlink(root, join(outside, "to-everything"));
      const marker = join(outside, "ran.txt");
      const writes = (read: string) =>
        nodeRequest(
          'require("node:fs").writeFileSync(process.argv[1], "ran")',
          [marker],
          skillDir,
          {
            allow: {
              read: [read, WORKING_FOLDER],
              write: [WORKING_FOLDER, outside],
              network: "none",
            },
          },
        );

      await expect(executor.run(writes(join(outside, "to-everything")))).rejects.toThrow(
        "holds one no program may read",
      );
      await expect(executor.run(writes(root))).rejects.toThrow("holds one no program may read");
      expect(existsSync(marker)).toBe(false);
      await executor.run(writes(skillDir));
      expect(existsSync(marker)).toBe(true);
    });

    test("IncarnaMind's own runtime in a data folder reached through a link starts where its request names it, writes its temporary folder, and the data folder stays denied by either spelling", async () => {
      const root = await realpath(await createTempDataFolder());
      const home = join(root, "home");
      const moved = join(root, "moved");
      await mkdir(home);
      await mkdir(moved);
      // A data folder moved to another disk and linked back from the home, which every run is denied.
      await symlink(moved, join(home, "Data"));
      const linkedFolders = [join(home, "Data")];
      if (process.platform === "darwin") {
        // On macOS /tmp is a link into /private, and both are denied.
        const tmp = await mkdtemp("/tmp/incarnamind-linked-");
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        linkedFolders.push(tmp);
      }
      const env = { PATH: "/usr/bin:/bin" };
      for (const linked of linkedFolders) {
        const data = join(linked, "data");
        const install = join(data, "runtimes", "probe");
        await mkdir(join(install, "bin"), { recursive: true });
        await writeFile(join(install, "own.txt"), "OWN FILE\n");
        await writeFile(join(data, "incarnamind.db"), "DATA CANARY");
        const program = join(install, "bin", "probe");
        await writeFile(
          program,
          [
            "#!/bin/sh",
            'cat "$(dirname "$0")/../own.txt"',
            'echo made > "$TMPDIR/made.txt" && cat "$TMPDIR/made.txt"',
            'cat "$1" 2>/dev/null || echo "real path denied"',
            'cat "$2" 2>/dev/null || echo "linked path denied"',
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        const tempDir = join(linked, "temp");
        await mkdir(tempDir);
        if (!sandbox.available) throw new Error(sandbox.reason);
        const executor = sandbox.createExecutor({
          processes: createProcessLauncher(async () => env),
          environment: async () => env,
          tempDir,
          denyRead: readDeniedFolders({
            platform: process.platform,
            home,
            dataDir: data,
            temporaryFolder: tmpdir(),
            uid: typeof process.getuid === "function" ? process.getuid() : undefined,
          }),
          reportError: (error) => {
            throw error;
          },
          runRecords,
          sweep: { stopper: guard.stopper },
        });

        const request = async (read: ExecRequest["allow"]["read"]) => ({
          command: program,
          args: [join(await realpath(data), "incarnamind.db"), join(data, "incarnamind.db")],
          env: {},
          allow: { read, write: [WORKING_FOLDER], network: "none" as const },
          timeoutMs: 20_000,
          maxOutputBytes: 50_000,
          signal: new AbortController().signal,
        });

        const named = await executor.run(await request([install, WORKING_FOLDER]));
        // Not named, nothing in the data folder is read again: not even to start the program.
        const unnamed = await executor.run(await request([WORKING_FOLDER]));

        expect({ linked, exitCode: named.exitCode, stdout: named.stdout }).toEqual({
          linked,
          exitCode: 0,
          stdout: "OWN FILE\nmade\nreal path denied\nlinked path denied\n",
        });
        // macOS refuses the program (126); bubblewrap has nothing there to start (127).
        expect({ linked, exitCode: unnamed.exitCode, stdout: unnamed.stdout }).toEqual({
          linked,
          exitCode: process.platform === "darwin" ? 126 : 127,
          stdout: "",
        });
      }
    });

    test("a link to a denied folder is no way into it: not one outside, nor one the program makes", async () => {
      const { executor, data, database, skillDir, outside } = await setUp();
      await symlink(data, join(outside, "to-data"));
      const code = `
const fs = require("node:fs");
const [throughLink, data, skillFile] = process.argv.slice(1);
const results = {};
const attempt = (name, act) => {
  try {
    results[name] = act();
  } catch (error) {
    results[name] = error.code ?? String(error);
  }
};
attempt("through a link outside", () => fs.readFileSync(throughLink, "utf8"));
attempt("through a link it makes", () => {
  fs.symlinkSync(data, "to-data");
  return fs.readFileSync("to-data/incarnamind.db", "utf8");
});
attempt("its Skill's file through a link it makes", () => {
  fs.symlinkSync(skillFile, "skill.md");
  return fs.readFileSync("skill.md", "utf8");
});
console.log(JSON.stringify(results));
`;

      const run = await executor.run(
        nodeRequest(
          code,
          [join(outside, "to-data", "incarnamind.db"), data, join(skillDir, "SKILL.md")],
          skillDir,
        ),
      );

      expect(run).toMatchObject({ exitCode: 0, timedOut: false });
      const results = JSON.parse(run.stdout);
      expect(results["its Skill's file through a link it makes"]).toBe("SKILL FILE");
      expect(results["through a link outside"]).not.toBe("DATA CANARY");
      expect(results["through a link it makes"]).not.toBe("DATA CANARY");
      expect(await readFile(database, "utf8")).toBe("DATA CANARY");
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
          language: "en",
        });
      } catch (error) {
        if (String(error).includes("python3 not found")) {
          context.skip("python3 isn't installed here");
        }
        throw error;
      }

      expect(run).toMatchObject({ exitCode: 0, stdout: "canary denied\nTrue\n", error: null });
    });

    test("a daemon's memory, and files a daemon or the program holds open with no name left, count against its limits while it runs, run after run", async () => {
      const { tempDir, home, data } = await setUp();
      // Whatever the meter couldn't read, which a case that passes only because a count was
      // dropped would hide.
      const reports: string[] = [];
      const executor = osExecutor({
        tempDir,
        denyRead: [home, data],
        env: environment(),
        reportError: (error) => reports.push(String(error)),
      });
      const run = (script: string) =>
        executor.run({
          ...shell(script),
          timeoutMs: 30_000,
          limits: { memoryBytes: 400_000_000, folderBytes: 50_000_000 },
        });
      const random = 'open(my $r, "<", "/dev/urandom") or die;';
      const unlinked = (count: number) =>
        `my @f; for my $i (1..${count}) { open(my $f, ">", "gone$i") or die; read($r, my $b, 30_000_000); syswrite($f, $b) or die; unlink "gone$i"; push @f, $f; }`;
      const held = (count: number) =>
        `my @held; for (1..${count}) { read($r, my $b, 100_000_000); push @held, $b; }`;
      // Its parent and its parent's parent gone, in a group of its own: launchd's child, out of the
      // program's tree and group.
      const daemon = (body: string) =>
        `perl -MPOSIX -e 'defined(my $p = fork) or die; if ($p) { waitpid($p, 0); exit 0 } POSIX::setsid(); defined(my $q = fork) or die; if ($q) { POSIX::_exit(0) } open STDIN, "<", "/dev/null"; open STDOUT, ">", "/dev/null"; open STDERR, ">", "/dev/null"; ${random} ${body} open(my $ready, ">", "ready"); close $ready; sleep 600' incarnamind-daemon-2351`;
      const waitForIt = "until [ -e ready ]; do sleep 0.1; done";

      for (let round = 1; round <= 10; round++) {
        // 90 MB in three unlinked files, a 50 MB folder limit.
        expect([round, await run(`${daemon(unlinked(3))}; sleep 40`)]).toMatchObject([
          round,
          { limit: "folder", timedOut: false },
        ]);
        // 800 MB of random bytes, which macOS can't compress, against a 400 MB memory limit.
        expect([round, await run(`${daemon(held(8))}; sleep 40`)]).toMatchObject([
          round,
          { limit: "memory", timedOut: false },
        ]);
        expect([
          round,
          await run(`perl -e '${random} ${unlinked(3)} sleep 40' incarnamind-daemon-2351`),
        ]).toMatchObject([round, { limit: "folder", timedOut: false }]);
        // 30 MB unlinked and 200 MB held, under both: the program ends as it would.
        const under = await run(`${daemon(`${unlinked(1)} ${held(2)}`)}; ${waitForIt}; echo held`);
        expect([round, under]).toMatchObject([round, { exitCode: 0, stdout: "held\n" }]);
        expect(under.limit).toBeUndefined();
      }
      expect(reports).toEqual([]);
      const { execFileSync } = await import("node:child_process");
      await expect
        .poll(() =>
          execFileSync("ps", ["-A", "-ww", "-o", "command="], { encoding: "utf8" })
            .split("\n")
            .filter((line) => line.includes("incarnamind-daemon-2351")),
        )
        .toEqual([]);
    }, 600_000);

    test("the file-descriptor cap keeps a flood from hiding a run's unlinked files, so it is stopped at its folder limit", async () => {
      const { tempDir, home, data } = await setUp();
      const reports: string[] = [];
      const executor = osExecutor({
        tempDir,
        denyRead: [home, data],
        env: environment(),
        reportError: (error) => reports.push(String(error)),
      });
      const random = 'open(my $r, "<", "/dev/urandom") or die;';
      // Five helpers each duplicate an unlinked regular file far past the 1024 cap, then it writes
      // 250 MB of unlinked files against a 200 MB folder limit. Without the cap, reading their
      // descriptors outgrows what the meter allows, so the run would end unmeasured; with it the
      // read stays whole and the run is stopped at the folder limit. run_code always sets a file
      // limit, as this does.
      const flood = [
        "for i in 1 2 3 4 5; do",
        '  perl -e \'open(my $b, "+>", "base") or die; unlink "base"; my @d; for (1..120000) { open(my $c, "<&", $b) or last; push @d, $c; } sleep 40\' &',
        "done",
        `perl -e '${random} my @f; for my $i (1..5) { open(my $g, ">", "gone$i") or die; read($r, my $b, 50_000_000); syswrite($g, $b) or die; unlink "gone$i"; push @f, $g; } sleep 40'`,
      ].join("\n");
      const flooded = await executor.run({
        ...shell(flood),
        timeoutMs: 30_000,
        limits: { fileBytes: 100_000_000, folderBytes: 200_000_000 },
      });
      expect(flooded).toMatchObject({ limit: "folder", timedOut: false });
      expect(reports).toEqual([]);
    }, 600_000);

    test("a memory hog beside a run that makes 150,000 files is stopped at its memory limit, not left to its timeout", async () => {
      const { tempDir, home, data } = await setUp();
      const reports: string[] = [];
      const executor = osExecutor({
        tempDir,
        denyRead: [home, data],
        env: environment(),
        reportError: (error) => reports.push(String(error)),
      });
      const run = (script: string, limits: { memoryBytes?: number; folderBytes?: number }) =>
        executor.run({ ...shell(script), timeoutMs: 30_000, limits });
      const random = 'open(my $r, "<", "/dev/urandom") or die;';
      const [many, hog] = await Promise.all([
        run("for i in $(seq 1 150000); do : > f$i; done; sleep 20", { folderBytes: 200_000_000 }),
        run(
          `perl -e '${random} my @h; for (1..80) { read($r, my $b, 100_000_000); push @h, $b; } sleep 20'`,
          { memoryBytes: 2_000_000_000 },
        ),
      ]);
      expect(hog).toMatchObject({ limit: "memory", timedOut: false });
      expect(many.limit === undefined || many.limit === "folder").toBe(true);
      expect(reports).toEqual([]);
    }, 600_000);

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

// Last: loading the sandbox again leaves the shared configuration without a sized bubblewrap.
test.runIf(process.platform === "linux")(
  "with no bubblewrap on the PATH, the sandbox still reports the missing package",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "incarnamind-bwrap-test-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    const path = process.env.PATH;
    process.env.PATH = bin;
    onTestFinished(async () => {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
      await rm(root, { recursive: true, force: true });
    });

    expect(await loadOsSandbox()).toMatchObject({
      available: false,
      problem: { kind: "missing", packages: expect.arrayContaining(["bubblewrap"]) },
    });
  },
);
