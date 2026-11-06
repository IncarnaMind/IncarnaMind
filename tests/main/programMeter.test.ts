/**
 * How the OS sandbox's Executor measures its programs against their memory and folder limits
 * (ADR-0025): one listing a tick for every program it watches, memory judged from it before the
 * slower reads, footprints and unlinked files in turn, no limit caught more than one tick late, and
 * a run whose own disk use stays unreadable stopped on its own. Most cases read a computer of their
 * own through commands that answer as macOS's would; the last ones read this computer's processes.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import type { ProgramUse } from "../../src/core/execution";
import {
  createMeters,
  folderSize,
  footprints,
  heldBytes,
  type MeterCommand,
  type Meters,
  type ProcReader,
  readListing,
  runCommand,
  treeMemory,
  unlinkedFiles,
  unlinkedMappings,
} from "../../src/main/programMeter";
import { createTempDataFolder } from "../helpers/core";

const MB = 1_000_000;

describe("a program's memory, as its limit counts it", () => {
  const LISTING = readListing(
    [
      "  1     0     1    0   9000",
      "100     1   100  501   1000",
      "101   100   100  501   2000",
      "200   100   200  501   4000",
      "201   200   200  501   8000",
      "300     1   300  501  16000",
      "",
    ].join("\n"),
  );

  test("counts its group and every process under it, in a session of its own or not", () => {
    expect(treeMemory(LISTING, [100])).toBe((1000 + 2000 + 4000 + 8000) * 1024);
  });

  test("counts nothing of another program's", () => {
    expect(treeMemory(LISTING, [300])).toBe(16000 * 1024);
    expect(treeMemory(LISTING, [999])).toBe(0);
  });

  test("counts a process of the run's that launchd took over, with every process under it", () => {
    const adopted = [
      ...LISTING,
      ...readListing("400     1   350  501  32000\n401   400   350  501  64000\n"),
    ];
    expect(treeMemory(adopted, [100, 400])).toBe(
      (1000 + 2000 + 4000 + 8000 + 32000 + 64000) * 1024,
    );
    expect(treeMemory(adopted, [100])).toBe((1000 + 2000 + 4000 + 8000) * 1024);
  });

  test("counts what macOS swapped or compressed, by each process's footprint where it is larger", () => {
    const held = new Map([
      [101, 3_000_000_000],
      [201, 1024],
      [300, 5_000_000_000],
    ]);
    expect(treeMemory(LISTING, [100], held)).toBe(
      1000 * 1024 + 3_000_000_000 + 4000 * 1024 + 8000 * 1024,
    );
  });

  test("reads each process's footprint from macOS's report", () => {
    const report = [
      "======================================================================",
      "python3.12 [4101]: 64-bit    Footprint: 3000000000 B (16384 bytes per page)",
      "======================================================================",
      "",
      "Auxiliary data:",
      "    phys_footprint: 3000016384 B",
      "    phys_footprint_peak: 3100000000 B",
      "",
      "======================================================================",
      "a [name] with brackets [4102]: 64-bit    Footprint: 2015568 B (16384 bytes per page)",
      "======================================================================",
      "",
      "Auxiliary data:",
      "    phys_footprint: 2031952 B",
      "    phys_footprint_peak: 2031952 B",
      "",
      "======================================================================",
      "Summary Footprint: 3002031952 B",
      "======================================================================",
    ].join("\n");
    expect([...footprints(report)]).toEqual([
      [4101, 3000016384],
      [4102, 2031952],
    ]);
  });
});

test("a folder the program made unreadable counts as more than any folder limit", async () => {
  const folder = await createTempDataFolder();
  await mkdir(join(folder, "hide"));
  await writeFile(join(folder, "hide", "a"), "x".repeat(1000));
  await writeFile(join(folder, "seen"), "x".repeat(10));
  expect(await folderSize(folder)).toBe(1010);
  await chmod(join(folder, "hide"), 0o300);
  onTestFinished(() => chmod(join(folder, "hide"), 0o700));
  expect(await folderSize(folder)).toBe(Number.POSITIVE_INFINITY);
});

describe("files held open with no name left", () => {
  test("lsof's are each regular file with no link, by device and inode; one with a link, or no file, isn't", () => {
    const listing = [
      "p4101",
      ...["f3", "tREG", "D0x1000011", "s30000000", "i884122529", "k0"],
      ...["f4", "tREG", "D0x1000011", "s30000000", "i884122529", "k0"],
      ...["f5", "tREG", "D0x1000011", "s7000", "i884122530", "k1"],
      ...["f6", "tPIPE", "s0", "k0"],
      "p4102",
      ...["ftxt", "tREG", "D0x1000011", "s30000000", "i884122529", "k0"],
      ...["f7", "tREG", "D0x1000012", "s5000", "i12", "k0"],
      "",
    ].join("\n");
    const files = unlinkedFiles(listing);
    expect(files).toEqual([
      { pid: 4101, device: 0x1000011, inode: "884122529", bytes: 30000000 },
      { pid: 4101, device: 0x1000011, inode: "884122529", bytes: 30000000 },
      { pid: 4102, device: 0x1000011, inode: "884122529", bytes: 30000000 },
      { pid: 4102, device: 0x1000012, inode: "12", bytes: 5000 },
    ]);
    expect(heldBytes(files, new Set([4101, 4102]), 0x1000011)).toBe(30000000);
    expect(heldBytes(files, new Set([4101, 4102]), undefined)).toBe(30005000);
    expect(heldBytes(files, new Set([4102]), 0x1000012)).toBe(5000);
    expect(heldBytes(files, new Set([4103]), 0x1000011)).toBe(0);
  });

  test("a Linux process's mappings of files with no link, by the device stat gives, each to the most a mapping reaches", () => {
    const maps = [
      "55d0c0000000-55d0c0001000 r--p 00000000 08:01 393 /usr/bin/perl",
      "7f1a00000000-7f1a00100000 rw-s 00000000 08:01 1234 /work/gone (deleted)",
      "7f1a00200000-7f1a00300000 r--s 00200000 08:01 1234 /work/gone (deleted)",
      "7f1a00400000-7f1a00401000 rw-s 00000000 103:02 77 /work/other (deleted)",
      "7f1a00500000-7f1a00600000 rw-p 00000000 00:00 0 ",
      "7f1a00600000-7f1a00601000 rw-s 00000000 00:01 5 /dev/zero (deleted)",
      "",
    ].join("\n");
    expect(unlinkedMappings(4101, maps)).toEqual([
      { pid: 4101, device: 2049, inode: "1234", bytes: 0x300000 },
      { pid: 4101, device: 66306, inode: "77", bytes: 0x1000 },
      { pid: 4101, device: 1, inode: "5", bytes: 0x1000 },
    ]);
  });
});

// A clock a test advances, so the 10 s unknown rule is driven without waiting.
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const err = (code: string) => Object.assign(new Error(code), { code });

/** A computer the meter reads through commands: `state` is what each command says now (macOS). */
function computer(state: { ps: () => string; footprint?: () => string; lsof?: () => string }) {
  const calls: string[] = [];
  const command: MeterCommand = async (file) => {
    calls.push(file);
    if (file === "ps") return state.ps();
    if (file === "/usr/bin/footprint") return state.footprint?.() ?? "";
    if (file === "/usr/sbin/lsof") return state.lsof?.() ?? "";
    throw new Error(`The meter ran ${file}, which nothing here answers.`);
  };
  return { command, calls };
}

/** A made-up `/proc` for the Linux read path. A node is a leader's or a task's fd/maps view. */
interface ProcNode {
  fdsErr?: string;
  fds?: string[];
  links?: Record<string, string | Error>;
  sizes?: Record<string, { device: number; inode: string; bytes: number } | Error>;
  maps?: string;
  mapsErr?: string;
}
interface PidSpec {
  leader: ProcNode;
  stat?: string;
  statErr?: string;
  tasks?: number[];
  taskNodes?: Record<number, ProcNode>;
}
// A /proc/<pid>/stat line whose state is `after[0]` and start time `after[19]`, as the code reads.
const statLine = (state: string, started: number) =>
  `600 (prog) ${state} ${Array(18).fill(0).join(" ")} ${started} 0 0`;
const STAT_R = statLine("R", 500);

function fakeProc(byPid: Record<number, PidSpec>): ProcReader {
  const node = (pid: number, tid: number | null): ProcNode => {
    const spec = byPid[pid];
    if (!spec) throw err("ESRCH");
    return tid === null ? spec.leader : (spec.taskNodes?.[tid] ?? { fdsErr: "ESRCH" });
  };
  return {
    async fds(pid, tid) {
      const n = node(pid, tid);
      if (n.fdsErr) throw err(n.fdsErr);
      return n.fds ?? [];
    },
    async readlink(pid, tid, fd) {
      const link = node(pid, tid).links?.[fd];
      if (link instanceof Error) throw link;
      return link ?? "/x";
    },
    async size(pid, tid, fd) {
      const size = node(pid, tid).sizes?.[fd];
      if (size instanceof Error) throw size;
      if (!size) throw err("ENOENT");
      return size;
    },
    async maps(pid, tid) {
      const n = node(pid, tid);
      if (n.mapsErr) throw err(n.mapsErr);
      return n.maps ?? "";
    },
    async tasks(pid) {
      return byPid[pid]?.tasks ?? [];
    },
    async readStat(pid) {
      const spec = byPid[pid];
      if (spec?.statErr) throw err(spec.statErr);
      return spec?.stat ?? STAT_R;
    },
  };
}

async function workingFolder() {
  const folder = await realpath(await createTempDataFolder());
  return { folder, device: (await stat(folder)).dev };
}

function watcher() {
  const uses: ProgramUse[] = [];
  const reports: string[] = [];
  return {
    uses,
    reports,
    use: (use: ProgramUse) => uses.push(use),
    unmeasured: (error: unknown) => reports.push(String(error)),
    peak(from = 0) {
      const since = uses.slice(from);
      const folders = since.map((u) => u.folder).filter((f): f is number => typeof f === "number");
      return {
        memory: Math.max(0, ...since.map((u) => u.memory)),
        folder: folders.length ? Math.max(...folders) : 0,
        unknown: since.some((u) => u.folder === "unknown"),
      };
    },
  };
}

/** Runs `n` ticks, advancing the clock `ms` between each and settling the disk reads. */
async function run(meters: Meters, c: ReturnType<typeof clock>, n: number, ms = 300) {
  for (let i = 0; i < n; i++) {
    await meters.tick();
    await meters.settle();
    c.advance(ms);
  }
}

describe("the meter, on a made-up computer", () => {
  const killedLsof = () => {
    throw Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" });
  };

  test("resident memory is reported every tick, apart from a slower disk read", async () => {
    const { folder } = await workingFolder();
    const c = clock();
    const { command } = computer({ ps: () => "600 1 600 501 2048\n700 1 700 501 1024" });
    // 700's folder walk hangs on one shared promise; 600's returns at once.
    let release = () => {};
    const slow = new Promise<number>((r) => {
      release = () => r(0);
    });
    const meters = createMeters({
      command,
      platform: "darwin",
      interval: false,
      now: c.now,
      folder: (f) => (f === folder ? Promise.resolve(0) : slow),
    });
    const fast = watcher();
    const slowRun = watcher();
    meters.meter().watch(600, folder, fast.use, fast.unmeasured);
    meters.meter().watch(700, join(folder, "x"), slowRun.use, slowRun.unmeasured);
    for (let i = 0; i < 3; i++) {
      await meters.tick();
      c.advance(300);
    }
    // 700's read is stuck, yet both runs' memory is reported on every tick.
    expect(fast.uses.filter((u) => u.memory === 2048 * 1024).length).toBeGreaterThanOrEqual(3);
    expect(slowRun.uses.filter((u) => u.memory === 1024 * 1024).length).toBeGreaterThanOrEqual(3);
    release();
    await meters.settle();
  });

  test("an open file read on Linux is counted with the named folder, kept apart", async () => {
    const c = clock();
    const { command } = computer({ ps: () => "600 1 600 501 1024" });
    const reader = fakeProc({
      600: {
        leader: {
          fds: ["3"],
          links: { 3: "/work/gone (deleted)" },
          sizes: { 3: { device: 9, inode: "42", bytes: 5 * MB } },
          maps: "",
        },
      },
    });
    const meters = createMeters({
      command,
      platform: "linux",
      interval: false,
      now: c.now,
      reader,
      folder: async () => 2 * MB,
    });
    const each = watcher();
    meters.meter().watch(600, "/work", each.use, each.unmeasured);
    await run(meters, c, 3);
    // 2 MB named + 5 MB open-with-no-name; never stopped.
    expect(each.uses.some((u) => u.folder === 7 * MB)).toBe(true);
    expect(each.peak().unknown).toBe(false);
  });

  test("a read error stops that run at once, named with its errno, path and pid", async () => {
    const c = clock();
    const { command } = computer({ ps: () => "600 1 600 501 1024" });
    // A live, non-dumpable process: fd gives EACCES, stat says running, no other task.
    const reader = fakeProc({ 600: { leader: { fdsErr: "EACCES" }, stat: STAT_R, tasks: [600] } });
    const meters = createMeters({
      command,
      platform: "linux",
      interval: false,
      now: c.now,
      reader,
    });
    const each = watcher();
    meters.meter().watch(600, "/w", each.use, each.unmeasured);
    await run(meters, c, 3);
    expect(each.peak().unknown).toBe(true);
    expect(each.reports.some((r) => r.includes("EACCES") && r.includes("600"))).toBe(true);
  });

  test("an exiting or zombie process (EACCES, state Z) is gone, not an error; a reused pid is gone", async () => {
    const c = clock();
    const { command } = computer({ ps: () => "600 1 600 501 1024" });
    const spec: PidSpec = { leader: { fdsErr: "EACCES" }, stat: statLine("Z", 500), tasks: [600] };
    const reader = fakeProc({ 600: spec });
    const meters = createMeters({
      command,
      platform: "linux",
      interval: false,
      now: c.now,
      reader,
      folder: async () => 0,
    });
    const each = watcher();
    meters.meter().watch(600, "/w", each.use, each.unmeasured);
    await run(meters, c, 3);
    // The pid is reused by another process: a different start time, still gone (not an error).
    spec.stat = statLine("R", 900);
    await run(meters, c, 3);
    expect(each.peak().unknown).toBe(false);
    expect(each.reports).toEqual([]);
  });

  test("a zombie leader whose live thread still holds an unlinked file: the file is counted", async () => {
    const c = clock();
    const { command } = computer({ ps: () => "600 1 600 501 1024" });
    const reader = fakeProc({
      600: {
        leader: { fdsErr: "EACCES", maps: "" },
        stat: statLine("Z", 500),
        tasks: [600, 777],
        taskNodes: {
          777: {
            fds: ["3"],
            links: { 3: "/work/gone (deleted)" },
            sizes: { 3: { device: 9, inode: "9", bytes: 8 * MB } },
            maps: "",
          },
        },
      },
    });
    const meters = createMeters({
      command,
      platform: "linux",
      interval: false,
      now: c.now,
      reader,
      folder: async () => 0,
    });
    const each = watcher();
    meters.meter().watch(600, "/w", each.use, each.unmeasured);
    await run(meters, c, 3);
    expect(each.uses.some((u) => u.folder === 8 * MB)).toBe(true);
    expect(each.peak().unknown).toBe(false);
  });

  test("one fd's ENOENT skips only that fd; the process's other fds are still counted", async () => {
    const c = clock();
    const { command } = computer({ ps: () => "600 1 600 501 1024" });
    const reader = fakeProc({
      600: {
        leader: {
          fds: ["3", "4"],
          links: { 3: err("ENOENT"), 4: "/work/kept (deleted)" },
          sizes: { 4: { device: 9, inode: "4", bytes: 6 * MB } },
          maps: "",
        },
      },
    });
    const meters = createMeters({
      command,
      platform: "linux",
      interval: false,
      now: c.now,
      reader,
      folder: async () => 0,
    });
    const each = watcher();
    meters.meter().watch(600, "/w", each.use, each.unmeasured);
    await run(meters, c, 3);
    expect(each.uses.some((u) => u.folder === 6 * MB)).toBe(true);
    expect(each.peak().unknown).toBe(false);
  });

  test("a pid whose maps pass the byte cap is unknown for the turn, not stopped before 10 s", async () => {
    const c = clock();
    const { command } = computer({ ps: () => "600 1 600 501 1024" });
    const huge = "7f00-7f01 rw-s 0 09:00 1 /x (deleted)\n".repeat(200_000);
    const reader = fakeProc({ 600: { leader: { fds: [], maps: huge } } });
    const meters = createMeters({
      command,
      platform: "linux",
      interval: false,
      now: c.now,
      reader,
      folder: async () => 0,
    });
    const each = watcher();
    meters.meter().watch(600, "/w", each.use, each.unmeasured);
    await run(meters, c, 4, 1000);
    // Under 10 s of unknown: not stopped yet.
    expect(each.peak().unknown).toBe(false);
  });

  test("a read that times out leaves the disk unknown, and the run stops only after 10 s", async () => {
    const c = clock();
    const { command } = computer({ ps: () => "600 1 600 501 1024", lsof: killedLsof });
    const meters = createMeters({
      command,
      platform: "darwin",
      interval: false,
      now: c.now,
      folder: async () => 0,
    });
    const each = watcher();
    meters.meter().watch(600, "/w", each.use, each.unmeasured);
    // Nine seconds in 3 s steps: still running, memory still reported.
    await run(meters, c, 4, 3000);
    expect(each.peak().unknown).toBe(false);
    expect(each.uses.filter((u) => u.memory === 1024 * 1024).length).toBeGreaterThanOrEqual(3);
    // Past ten seconds in a row: stopped.
    await run(meters, c, 2, 3000);
    expect(each.peak().unknown).toBe(true);
  });

  test("a success resets the clock: unknown, a read, then unknown again never stops", async () => {
    const c = clock();
    let hang = true;
    const { command } = computer({
      ps: () => "600 1 600 501 1024",
      lsof: () => {
        if (hang) {
          throw Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" });
        }
        return "";
      },
    });
    const meters = createMeters({
      command,
      platform: "darwin",
      interval: false,
      now: c.now,
      folder: async () => 0,
    });
    const each = watcher();
    meters.meter().watch(600, "/w", each.use, each.unmeasured);
    await run(meters, c, 3, 3000); // ~9 s unknown
    expect(each.peak().unknown).toBe(false);
    hang = false;
    await run(meters, c, 2, 300); // a good read resets the clock
    hang = true;
    await run(meters, c, 3, 3000); // ~9 s unknown again
    expect(each.peak().unknown).toBe(false);
  });

  test("a program no longer watched is measured no more", async () => {
    const c = clock();
    const { command, calls } = computer({ ps: () => "600 1 600 501 1024", lsof: () => "" });
    const meters = createMeters({
      command,
      platform: "darwin",
      interval: false,
      now: c.now,
      folder: async () => 0,
    });
    const each = watcher();
    const stop = meters.meter().watch(600, "/w", each.use, each.unmeasured);
    await run(meters, c, 2);
    const after = each.uses.length;
    const commands = calls.length;
    stop();
    await run(meters, c, 2);
    expect(each.uses.length).toBe(after);
    expect(calls.length).toBe(commands);
  });
});

test("each of the meter's commands is stopped after 2 s", async () => {
  await expect(runCommand("/bin/sleep", ["30"])).rejects.toMatchObject({
    killed: true,
    signal: "SIGTERM",
  });
});

describe("on this computer", () => {
  async function holding(command: string, args: string[], folder: string): Promise<ChildProcess> {
    const child = spawn(command, args, { cwd: folder, stdio: ["ignore", "pipe", "inherit"] });
    onTestFinished(() => {
      child.kill("SIGKILL");
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("ready")) resolve();
      });
    });
    return child;
  }

  async function held(child: ChildProcess, folder: string): Promise<number> {
    const meters = createMeters({ interval: false });
    const each = watcher();
    meters.meter().watch(child.pid ?? 0, folder, each.use, each.unmeasured);
    // Enough ticks that both turns read and their counts are reported a tick later.
    for (let n = 0; n < 4; n++) {
      await meters.tick();
      await meters.settle();
    }
    expect(each.reports).toEqual([]);
    return each.peak().folder;
  }

  test("a file a process holds after unlinking it counts with its folder, once; a named file counts once too", async () => {
    const { folder } = await workingFolder();
    const child = await holding(
      "perl",
      [
        "-e",
        'open(my $g, ">", "gone") or die; print $g "x" x 3_000_000; close $g; open(my $h, "<", "gone") or die; unlink "gone"; open(my $k, ">", "kept") or die; print $k "y" x 1_000_000; close $k; open(my $o, "<", "kept") or die; $| = 1; print "ready\\n"; sleep 60',
      ],
      folder,
    );
    expect(await held(child, folder)).toBe(4_000_000);
  });

  test("a file a process holds only through a mapping, after closing and unlinking it, counts", async (context) => {
    const python = (() => {
      try {
        return execFileSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    })();
    if (python === "") context.skip("python3 isn't installed here");
    const { folder } = await workingFolder();
    const child = await holding(
      python,
      [
        "-c",
        [
          "import mmap, os, sys, time",
          "f = open('mapped', 'wb+'); f.write(b'z' * 3_145_728); f.flush()",
          "m = mmap.mmap(f.fileno(), 0)",
          "f.close(); os.unlink('mapped')",
          "print('ready', flush=True)",
          "time.sleep(60)",
        ].join("\n"),
      ],
      folder,
    );
    expect(await held(child, folder)).toBe(3_145_728);
  });
});
