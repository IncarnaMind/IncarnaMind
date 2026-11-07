/**
 * How the OS sandbox's Executor measures its programs against their memory and folder limits
 * (ADR-0025): one listing a tick for every program it watches, resident memory judged from it before
 * anything slower, and each run's folder walk and read of its open files on its own, with the rule
 * for a read that fails or is slow. Most cases read a computer of their own, through commands that
 * answer as macOS's would or a made-up Linux `/proc`; the last ones read this computer's processes.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type { ProgramUse } from "../../src/core/execution";
import {
  type AdoptedFinder,
  createMeters,
  folderSize,
  footprints,
  heldBytes,
  type MeterCommand,
  type Meters,
  type ProcReader,
  procReader,
  readListing,
  runCommand,
  statOf,
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

/** A /proc/<pid>/stat line, with the fields the meter reads where `statOf` finds them. */
const statLine = ({
  comm = "made up",
  state = "R",
  flags = 0,
  started = 500,
  vsize = 4096,
}: {
  comm?: string;
  state?: string;
  flags?: number;
  started?: number;
  vsize?: number;
} = {}) =>
  `600 (${comm}) ${state} 1 600 600 0 -1 ${flags} ${Array(12).fill(0).join(" ")} ${started} ${vsize} 0`;

test("a stat line's state, flags, start and size, whatever its name holds", () => {
  expect(
    statOf(statLine({ comm: "a (b) c", state: "D", flags: 0x404044, started: 731, vsize: 0 })),
  ).toEqual({ comm: "a (b) c", state: "D", flags: 0x404044, started: 731, vsize: 0 });
});

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

/** A computer the meter reads through commands (macOS's): `state` is what each says now. */
function computer(state: {
  ps: () => string;
  footprint?: () => string | Promise<string>;
  lsof?: (pids: string) => string;
}) {
  const calls: string[] = [];
  const lsofPids: string[] = [];
  const command: MeterCommand = async (file, args) => {
    calls.push(file);
    if (file === "ps") return state.ps();
    if (file === "/usr/bin/footprint") return (await state.footprint?.()) ?? "";
    if (file === "/usr/sbin/lsof") {
      const pids = String(args[args.indexOf("-p") + 1]);
      lsofPids.push(pids);
      return state.lsof?.(pids) ?? "";
    }
    throw new Error(`The meter ran ${file}, which nothing here answers.`);
  };
  return { command, calls, lsofPids };
}

const footprintOf = (pid: number, bytes: number) =>
  [
    `perl [${pid}]: 64-bit    Footprint: ${bytes} B (16384 bytes per page)`,
    `    phys_footprint: ${bytes} B`,
  ].join("\n");

const lsofOf = (pid: number, device: number, inode: number, bytes: number) =>
  [`p${pid}`, "f3", "tREG", `D0x${device.toString(16)}`, `s${bytes}`, `i${inode}`, "k0", ""].join(
    "\n",
  );

const killedLsof = () => {
  throw Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" });
};

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

/** Ticks `n` times, settling each tick's reads and moving the clock on `ms` after it. */
async function run(meters: Meters, c: ReturnType<typeof clock>, n: number, ms: number) {
  for (let i = 0; i < n; i++) {
    await meters.tick();
    await meters.settle();
    c.advance(ms);
  }
}

describe("the meter's ticks (macOS)", () => {
  test("one listing a tick for every run; memory before the slower reads; footprint and one lsof for every run in turn", async () => {
    const { folder, device } = await workingFolder();
    const listing = [600, 700, 800].map((pid) => `${pid} 1 ${pid} 501 1024`).join("\n");
    const { command, calls, lsofPids } = computer({
      ps: () => listing,
      footprint: () => footprintOf(700, 5 * MB),
      lsof: () => lsofOf(800, device, 42, 7 * MB),
    });
    const meters = createMeters({ command, platform: "darwin", interval: false });
    const programs = [600, 700, 800].map((root) => {
      const each = watcher();
      meters.meter().watch(root, folder, each.use, each.unmeasured);
      return each;
    });
    for (let n = 0; n < 3; n++) {
      await meters.tick();
      await meters.settle();
    }
    expect(calls).toEqual([
      "ps",
      "/usr/bin/footprint",
      "ps",
      "/usr/sbin/lsof",
      "ps",
      "/usr/bin/footprint",
    ]);
    expect(lsofPids).toEqual(["600,700,800"]);
    expect(programs[0]?.peak().memory).toBe(1024 * 1024);
    expect(programs[1]?.peak().memory).toBe(5 * MB);
    expect(programs[2]?.uses.map((u) => u.folder)).toContain(7 * MB);
    expect(programs.flatMap((each) => each.reports)).toEqual([]);
  });

  test("memory is judged every tick though another run's folder walk is slow", async () => {
    const { folder } = await workingFolder();
    const { command } = computer({ ps: () => "600 1 600 501 2048\n700 1 700 501 1024" });
    let release = () => {};
    const slow = new Promise<number>((resolve) => {
      release = () => resolve(0);
    });
    const meters = createMeters({
      command,
      platform: "darwin",
      interval: false,
      folder: (f) => (f === folder ? Promise.resolve(0) : slow),
    });
    const fast = watcher();
    const slowRun = watcher();
    meters.meter().watch(600, folder, fast.use, fast.unmeasured);
    meters.meter().watch(700, join(folder, "other"), slowRun.use, slowRun.unmeasured);
    for (let n = 0; n < 3; n++) await meters.tick();
    expect(fast.uses.filter((u) => u.memory === 2048 * 1024).length).toBeGreaterThanOrEqual(3);
    expect(slowRun.uses.filter((u) => u.memory === 1024 * 1024).length).toBeGreaterThanOrEqual(3);
    release();
    await meters.settle();
  });

  test.each([
    ["an adopted lookup", "adopted"],
    ["the footprint", "footprint"],
  ] as const)("resident memory is reported every tick while %s hangs", async (_name, hung) => {
    const { folder } = await workingFolder();
    let release = () => {};
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { command } = computer({
      ps: () => "600 1 600 501 2048\n700 1 700 501 1024",
      footprint: async () => {
        if (hung === "footprint") await hanging;
        return "";
      },
    });
    const meters = createMeters({ command, platform: "darwin", interval: false });
    const a = watcher();
    const b = watcher();
    const finder: AdoptedFinder = async () => {
      if (hung === "adopted") await hanging;
      return [];
    };
    meters.meter(finder).watch(600, folder, a.use, a.unmeasured);
    meters.meter().watch(700, join(folder, "b"), b.use, b.unmeasured);
    for (let n = 0; n < 3; n++) await meters.tick();
    expect(a.uses.filter((u) => u.memory === 2048 * 1024)).toHaveLength(3);
    expect(b.uses.filter((u) => u.memory === 1024 * 1024)).toHaveLength(3);
    release();
    await meters.settle();
  });

  test("when the shared lsof fails, each run reads its own: one whose own read fails is stopped at once, the other isn't and hears why", async () => {
    const { folder, device } = await workingFolder();
    const tooBig = () => {
      throw Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
    };
    const { command } = computer({
      ps: () => "600 1 600 501 1024\n700 1 700 501 1024",
      lsof: (pids) => (pids === "700" ? lsofOf(700, device, 7, 9 * MB) : tooBig()),
    });
    const meters = createMeters({ command, platform: "darwin", interval: false });
    const a = watcher();
    const b = watcher();
    meters.meter().watch(600, folder, a.use, a.unmeasured);
    meters.meter().watch(700, join(folder, "b"), b.use, b.unmeasured);
    for (let n = 0; n < 3; n++) {
      await meters.tick();
      await meters.settle();
    }
    // The shared read is on the second tick, so its end is acted on at the third.
    expect(a.uses.at(-1)?.folder).toBe("unknown");
    expect(a.reports).toEqual([
      "DiskReadError: A disk read for process 600 failed (ERR_CHILD_PROCESS_STDIO_MAXBUFFER): lsof",
    ]);
    expect(b.peak().unknown).toBe(false);
    expect(b.uses.at(-1)?.folder).toBe(9 * MB);
    expect(b.reports).toEqual(["Error: The open files of every run couldn't be read at once."]);
  });

  test("lsof's answer when a pid it was given has ended is counted, and says nothing", async () => {
    const { folder, device } = await workingFolder();
    const { command } = computer({ ps: () => "600 1 600 501 1024" });
    const ended: MeterCommand = async (file, args) => {
      if (file !== "/usr/sbin/lsof") return command(file, args);
      throw Object.assign(new Error("lsof exited with 1"), {
        code: 1,
        stdout: lsofOf(600, device, 42, 9 * MB),
      });
    };
    const meters = createMeters({ command: ended, platform: "darwin", interval: false });
    const each = watcher();
    meters.meter().watch(600, folder, each.use, each.unmeasured);
    for (let n = 0; n < 3; n++) {
      await meters.tick();
      await meters.settle();
    }
    expect(each.uses.at(-1)?.folder).toBe(9 * MB);
    expect(each.reports).toEqual([]);
  });

  test("a footprint that can't be read is reported, and resident memory still counts; one with no process left isn't", async () => {
    const { folder } = await workingFolder();
    let footprints = 0;
    const { command } = computer({
      ps: () => "600 1 600 501 2048",
      footprint: () => {
        footprints += 1;
        throw Object.assign(new Error(footprints === 1 ? "footprint failed" : "none left"), {
          code: footprints === 1 ? 1 : 66,
        });
      },
    });
    const meters = createMeters({ command, platform: "darwin", interval: false });
    const each = watcher();
    meters.meter().watch(600, folder, each.use, each.unmeasured);
    for (let n = 0; n < 3; n++) {
      await meters.tick();
      await meters.settle();
    }
    expect(footprints).toBe(2);
    expect(each.peak().memory).toBe(2048 * 1024);
    expect(each.reports).toEqual(["Error: footprint failed"]);
  });

  test("the run's processes launchd took over are told from the tick's listing, with one start-time lookup for all runs, and counted, with every process under them, in its memory and its open files", async () => {
    const { folder } = await workingFolder();
    const listing = [
      "600 1 600 501 1024",
      "650 1 640 501 2048",
      "651 650 640 501 4096",
      "700 1 700 501 8192",
    ].join("\n");
    const { command, lsofPids } = computer({ ps: () => listing });
    const meters = createMeters({ command, platform: "darwin", interval: false });
    const started: Map<number, number | null>[] = [];
    const finder =
      (adoptedPids: number[]): AdoptedFinder =>
      async (_group, _listed, s) => {
        started.push(s);
        return adoptedPids;
      };
    const a = watcher();
    const b = watcher();
    meters.meter(finder([650])).watch(600, folder, a.use, a.unmeasured);
    meters.meter(finder([])).watch(700, join(folder, "b"), b.use, b.unmeasured);
    for (let n = 0; n < 2; n++) {
      await meters.tick();
      await meters.settle();
    }
    expect(a.peak().memory).toBe((1024 + 2048 + 4096) * 1024);
    expect(b.peak().memory).toBe(8192 * 1024);
    expect(started).toHaveLength(4);
    expect(started[0]).toBe(started[1]);
    expect(lsofPids).toEqual(["600,650,651,700"]);
  });

  test("adopted processes that can't be told are reported, and the program's own still count", async () => {
    const { folder } = await workingFolder();
    const { command } = computer({ ps: () => "600 1 600 501 1024" });
    const meters = createMeters({ command, platform: "darwin", interval: false });
    const each = watcher();
    meters
      .meter(async () => {
        throw new Error("sandbox_check didn't answer in time.");
      })
      .watch(600, folder, each.use, each.unmeasured);
    await meters.tick();
    await meters.settle();
    expect(each.peak().memory).toBe(1024 * 1024);
    expect(each.reports).toEqual(["Error: sandbox_check didn't answer in time."]);
  });

  test("a listing that fails is reported to every program, and the next tick measures again", async () => {
    const { folder } = await workingFolder();
    let listings = 0;
    const { command } = computer({
      ps: () => {
        listings += 1;
        if (listings === 1) throw new Error("ps didn't answer in time.");
        return "600 1 600 501 1024\n700 1 700 501 1024";
      },
    });
    const meters = createMeters({ command, platform: "darwin", interval: false });
    const programs = [600, 700].map((root) => {
      const each = watcher();
      meters.meter().watch(root, folder, each.use, each.unmeasured);
      return each;
    });
    for (let n = 0; n < 2; n++) {
      await meters.tick();
      await meters.settle();
    }
    for (const each of programs) {
      expect(each.reports).toEqual(["Error: ps didn't answer in time."]);
      expect(each.peak().memory).toBe(1024 * 1024);
    }
  });

  test("a program no longer watched is measured no more", async () => {
    const { folder } = await workingFolder();
    const { command, calls } = computer({ ps: () => "600 1 600 501 1024" });
    const meters = createMeters({ command, platform: "darwin", interval: false });
    const each = watcher();
    const stop = meters.meter().watch(600, folder, each.use, each.unmeasured);
    await meters.tick();
    await meters.settle();
    const after = each.uses.length;
    stop();
    await meters.tick();
    await meters.settle();
    expect(each.uses.length).toBe(after);
    expect(calls).toEqual(["ps", "/usr/bin/footprint"]);
  });

  test("a folder read that never returns doesn't wedge the meter: it keeps measuring", async () => {
    const { folder } = await workingFolder();
    const { command } = computer({ ps: () => "600 1 600 501 4096" });
    const meters = createMeters({
      command,
      platform: "darwin",
      interval: false,
      folder: () => new Promise<number>(() => {}),
    });
    const each = watcher();
    meters.meter().watch(600, folder, each.use, each.unmeasured);
    for (let n = 0; n < 3; n++) await meters.tick();
    expect(each.uses.filter((u) => u.memory === 4096 * 1024)).toHaveLength(3);
  });

  test("a folder walk that stops returning keeps its last count, the open files read since still add to it, and the run goes on", async () => {
    const { folder, device } = await workingFolder();
    let walks = 0;
    const { command } = computer({
      ps: () => "600 1 600 501 1024",
      lsof: () => lsofOf(600, device, 42, 5 * MB),
    });
    const meters = createMeters({
      command,
      platform: "darwin",
      interval: false,
      folder: () => (walks++ === 0 ? Promise.resolve(2 * MB) : new Promise<number>(() => {})),
    });
    const each = watcher();
    meters.meter().watch(600, folder, each.use, each.unmeasured);
    await meters.tick();
    await meters.settle();
    await vi.waitFor(async () => {
      await meters.tick();
      expect(each.uses.at(-1)?.folder).toBe(7 * MB);
    });
    expect(walks).toBe(2);
    expect(each.peak().unknown).toBe(false);
  });

  test("a killed lsof leaves the disk unknown while memory is still judged, and the run is stopped once unknown more than 10 s", async () => {
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
    // lsof runs on every other tick from the second, at 500 ms, where the clock starts.
    await run(meters, c, 21, 500);
    expect(each.peak().unknown).toBe(false);
    expect(each.uses.filter((u) => u.memory === 1024 * 1024).length).toBe(21);
    await run(meters, c, 2, 500);
    expect(each.peak().unknown).toBe(true);
  });
});

/** A thread's or a leader's `/proc` as the fake shows it. */
interface ProcNode {
  fds?: string[];
  fdsErr?: string;
  /** The fd folder's read waits on it. */
  hold?: Promise<void>;
  links?: Record<string, string | Error>;
  sizes?: Record<string, { device: number; inode: string; bytes: number } | Error>;
  maps?: string | (() => AsyncIterable<Uint8Array>);
  mapsErr?: string;
  stat?: string;
  statErr?: string;
}

interface PidSpec {
  leader: ProcNode;
  tasks?: number[];
  tasksErr?: string;
  threads?: Record<number, ProcNode>;
  /** Its /proc/<pid>/status: by default one of the User's, two PID namespaces below the app's. */
  status?: string;
  statusErr?: string;
}

/**
 * A status whose NSpid puts the process `below` PID namespaces under an app that is in `app` of
 * them, with the pid `innermost` in its deepest.
 */
const nested = (below: number, innermost = 7, app = 1) =>
  `Name:\tmade-up\nNSpid:\t${[...Array(app + below - 1).keys()]
    .map((n) => 9000 - n)
    .concat(innermost)
    .join("\t")}\n`;

/** The seccomp helper's inner half: the first process of the run's own PID namespace. */
const HELPER = 699;

/** The listing's time since boot, in clock ticks: a process started later than it isn't listed. */
const LISTED_AT = 1_000;

function fakeProc(byPid: Record<number, PidSpec>, app = nested(0, 9000)) {
  const fdReads = new Map<number, number>();
  const followed = { links: 0, maps: 0 };
  const node = (pid: number, tid: number | null): ProcNode => {
    const spec = byPid[pid];
    if (!spec) throw err("ESRCH");
    return tid === null ? spec.leader : (spec.threads?.[tid] ?? { fdsErr: "ESRCH" });
  };
  const reader: ProcReader = {
    async fds(pid, tid) {
      fdReads.set(pid, (fdReads.get(pid) ?? 0) + 1);
      const at = node(pid, tid);
      await at.hold;
      if (at.fdsErr) throw err(at.fdsErr);
      return at.fds ?? [];
    },
    async readlink(pid, tid, fd) {
      followed.links += 1;
      const link = node(pid, tid).links?.[fd];
      if (link instanceof Error) throw link;
      return link ?? "/work/named";
    },
    async size(pid, tid, fd) {
      const size = node(pid, tid).sizes?.[fd];
      if (size instanceof Error) throw size;
      if (!size) throw err("ENOENT");
      return size;
    },
    async *maps(pid, tid) {
      followed.maps += 1;
      const at = node(pid, tid);
      if (at.mapsErr) throw err(at.mapsErr);
      if (typeof at.maps === "function") yield* at.maps();
      else yield Buffer.from(at.maps ?? "");
    },
    async tasks(pid) {
      const spec = byPid[pid];
      if (!spec) throw err("ENOENT");
      if (spec.tasksErr) throw err(spec.tasksErr);
      return spec.tasks ?? [pid];
    },
    async stat(pid, tid) {
      const at = node(pid, tid);
      if (at.statErr) throw err(at.statErr);
      return at.stat ?? statLine();
    },
    async status(pid) {
      if (pid === "self") return app;
      const spec = byPid[pid];
      if (!spec) throw err("ESRCH");
      if (spec.statusErr) throw err(spec.statusErr);
      return spec.status ?? nested(2);
    },
    ticks: async () => LISTED_AT,
  };
  return { reader, fdReads, followed };
}

const deleted = (bytes: number, inode = "42") => ({
  fds: ["3"],
  links: { 3: "/work/gone (deleted)" },
  sizes: { 3: { device: 9, inode, bytes } },
});

/** A Linux run of `pids` (the first its root, the rest under it) read through a made-up `/proc`. */
/**
 * A Linux run of `byPid` (the lowest its root, the rest under it) read through a made-up `/proc`,
 * with the helper's inner half among them unless `helper` is false; the app is in `app` PID
 * namespaces.
 */
function linux(
  given: Record<number, PidSpec>,
  options: {
    folder?: () => Promise<number>;
    app?: number;
    appStatus?: string;
    helper?: false;
  } = {},
) {
  const app = options.app ?? 1;
  const byPid: Record<number, PidSpec> = { ...given };
  if (options.helper !== false) {
    byPid[HELPER] = { leader: { fdsErr: "EACCES" }, status: nested(2, 1, app) };
  }
  const c = clock();
  const [root, ...under] = Object.keys(byPid).map(Number);
  const listing = [
    `${root} 1 ${root} 501 1024`,
    ...under.map((pid) => `${pid} ${root} ${root} 501 1024`),
  ];
  const { command } = computer({ ps: () => listing.join("\n") });
  const proc = fakeProc(byPid, options.appStatus ?? nested(0, 9000, app));
  const meters = createMeters({
    command,
    platform: "linux",
    interval: false,
    now: c.now,
    reader: proc.reader,
    folder: options.folder ?? (async () => 0),
  });
  const each = watcher();
  const stop = meters.meter().watch(root ?? 0, "/w", each.use, each.unmeasured);
  return {
    c,
    meters: Object.assign(meters, { stop }),
    each,
    fdReads: proc.fdReads,
    followed: proc.followed,
  };
}

/** The tick on which the run was first told its disk is unknown, counting from 0; -1 if never. */
const stoppedAt = (each: ReturnType<typeof watcher>) =>
  each.uses.findIndex((u) => u.folder === "unknown");

const capped = () =>
  async function* () {
    const chunk = Buffer.from("7f00-7f01 rw-s 0 09:00 1 /x (deleted)\n".repeat(1680));
    for (let read = 0; read < 100 * MB; read += chunk.byteLength) yield chunk;
  };

describe("the meter, on Linux's /proc", () => {
  test("only the User's processes are read: never the sandbox's own above the run's PID namespace, nor the helper's inner half in it, denied as they are", async () => {
    const { c, meters, each, fdReads } = linux(
      {
        600: { leader: { ...deleted(1 * MB, "1") }, status: nested(0) },
        601: { leader: { ...deleted(1 * MB, "2") }, status: nested(1) },
        602: {
          leader: { fdsErr: "EACCES", stat: statLine({ comm: "helper" }) },
          status: nested(1),
        },
        603: {
          leader: { fdsErr: "EACCES", stat: statLine({ comm: "helper" }) },
          status: nested(2, 1),
        },
        604: { leader: { ...deleted(6 * MB, "3") }, status: nested(2, 2) },
        605: { leader: { ...deleted(2 * MB, "4") }, status: nested(3, 1) },
      },
      { helper: false },
    );
    await run(meters, c, 3, 250);
    expect(each.uses.at(-1)?.folder).toBe(8 * MB);
    expect(each.reports).toEqual([]);
    expect([600, 601, 602, 603].map((pid) => fdReads.get(pid) ?? 0)).toEqual([0, 0, 0, 0]);
    expect(fdReads.get(604)).toBe(3);
  });

  test.each([
    ["one of the User's at the run's own depth", nested(2, 7)],
    ["the first process of a namespace the User made below the run's", nested(3, 1)],
  ])("%s, denied, stops the run at once, named with its namespaces", async (_name, status) => {
    const { c, meters, each } = linux({
      600: { leader: {}, status: nested(0) },
      601: { leader: { fdsErr: "EACCES" }, status },
    });
    await run(meters, c, 2, 250);
    expect(each.uses.at(-1)?.folder).toBe("unknown");
    expect(each.reports).toHaveLength(1);
    expect(each.reports[0]).toContain("(EACCES): /proc/601/fd");
    expect(each.reports[0]).toContain(
      `NSpid ${status.split("NSpid:\t")[1]?.trim().split("\t").join(" ")}`,
    );
  });

  test.each([
    ["has no NSpid line", { status: "Name:\tmade-up\n" }, "(no NSpid line): /proc/601/status"],
    ["can't be read", { statusErr: "EIO" }, "(EIO): /proc/601/status"],
    ["is shallower than the app's", { status: "NSpid:\t5\n" }, "(NSpid shallower than the app's)"],
  ])("a process whose status %s stops the run, named", async (_name, status, named) => {
    const { c, meters, each } = linux(
      { 600: { leader: {}, status: nested(0, 7, 2) }, 601: { leader: {}, ...status } },
      { app: 2 },
    );
    await run(meters, c, 2, 250);
    expect(each.uses.at(-1)?.folder).toBe("unknown");
    expect(each.reports).toHaveLength(1);
    expect(each.reports[0]).toContain(named);
  });

  test("the app's own status without an NSpid line stops the run", async () => {
    const { c, meters, each } = linux({ 600: { leader: {} } }, { appStatus: "Name:\tapp\n" });
    await run(meters, c, 2, 250);
    expect(each.uses.at(-1)?.folder).toBe("unknown");
    expect(each.reports).toEqual([
      "DiskReadError: A disk read for process 0 failed (no NSpid line): /proc/self/status",
    ]);
  });

  test("depth counts from the app's own namespaces, so an app in a container reads the same processes", async () => {
    const { c, meters, each, fdReads } = linux(
      {
        600: { leader: {}, status: nested(0, 7, 3) },
        601: { leader: { fdsErr: "EACCES" }, status: nested(1, 7, 3) },
        602: { leader: { ...deleted(4 * MB) }, status: nested(2, 7, 3) },
      },
      { app: 3 },
    );
    await run(meters, c, 3, 250);
    expect(each.uses.at(-1)?.folder).toBe(4 * MB);
    expect(each.reports).toEqual([]);
    expect(fdReads.get(601) ?? 0).toBe(0);
  });

  test("a turn that doesn't find the helper's inner half is unknown, its sandbox processes still never read; stopped once that lasts more than 10 s", async () => {
    const missing = linux(
      {
        600: { leader: {}, status: nested(0) },
        601: { leader: { fdsErr: "EACCES" }, status: nested(1) },
        602: { leader: { ...deleted(3 * MB) }, status: nested(1) },
      },
      { helper: false },
    );
    await run(missing.meters, missing.c, 42, 250);
    expect(missing.each.uses[40]?.folder).not.toBe("unknown");
    expect(stoppedAt(missing.each)).toBe(41);
    expect(missing.each.reports).toEqual([]);
    expect(missing.fdReads.get(602) ?? 0).toBe(0);
    // Until the helper starts its namespace its inner half is above it; then the User's code is in it.
    const helper: PidSpec = { leader: {}, status: nested(1) };
    const user: PidSpec = { leader: { ...deleted(3 * MB) }, status: nested(1) };
    const starting = linux(
      { 600: { leader: {}, status: nested(0) }, 601: helper, 602: user },
      { helper: false },
    );
    await run(starting.meters, starting.c, 4, 250);
    helper.status = nested(2, 1);
    user.status = nested(2, 2);
    await run(starting.meters, starting.c, 44, 250);
    expect(starting.each.peak().unknown).toBe(false);
    expect(starting.each.uses.at(-1)?.folder).toBe(3 * MB);
  });

  test("8,192 descriptors across a run's processes are read; at 8,193 none is followed and the turn is unknown; a run over that for more than 10 s is stopped", async () => {
    const fds = (count: number) => Array.from({ length: count }, (_, n) => String(n + 3));
    const eight: Record<number, PidSpec> = {};
    for (let pid = 600; pid < 608; pid++) eight[pid] = { leader: { fds: fds(1024) } };
    // One of the 8,192 is a file with no name left.
    eight[600] = { leader: { ...deleted(5 * MB), fds: fds(1024) } };
    const under = linux(eight);
    await run(under.meters, under.c, 2, 250);
    expect(under.each.uses.at(-1)?.folder).toBe(5 * MB);
    // Two turns of 8,192.
    expect(under.followed.links).toBe(16_384);
    const over = linux({ ...eight, 608: { leader: { fds: fds(1) } } });
    await run(over.meters, over.c, 42, 250);
    expect(over.followed).toEqual({ links: 0, maps: 0 });
    expect(over.each.uses[40]?.folder).not.toBe("unknown");
    expect(stoppedAt(over.each)).toBe(41);
    expect(over.each.reports).toEqual([]);
  });

  test("a file held open with no name counts with the named folder, kept apart", async () => {
    const { c, meters, each } = linux(
      { 600: { leader: { ...deleted(5 * MB) } } },
      { folder: async () => 2 * MB },
    );
    await run(meters, c, 3, 250);
    expect(each.uses.at(-1)?.folder).toBe(7 * MB);
    expect(each.reports).toEqual([]);
  });

  test("a process that hides its open files is stopped on the tick after the read, told its errno, path, pid and state", async () => {
    const { c, meters, each } = linux({
      600: { leader: { fdsErr: "EACCES", stat: statLine({ comm: "probe" }) } },
    });
    await run(meters, c, 2, 250);
    expect(each.uses.map((u) => u.folder)).toEqual([0, "unknown"]);
    expect(each.reports).toEqual([
      "DiskReadError: A disk read for process 600 failed (EACCES): /proc/600/fd (probe: state R, flags 0x0, vsize 4096; NSpid 9000 8999 7)",
    ]);
  });

  test.each([
    ["running with PF_EXITING set", { state: "R", flags: 0x4, vsize: 4096 }],
    ["in disk sleep with PF_EXITING among its flags", { state: "D", flags: 0x40044c, vsize: 4096 }],
    ["running with no memory left", { state: "R", flags: 0, vsize: 0 }],
    ["a zombie", { state: "Z", flags: 0x4, vsize: 0 }],
    ["dead", { state: "X", flags: 0x4, vsize: 0 }],
  ])(
    "a process whose fd folder is denied as it exits, %s, is gone, not an error",
    async (_name, fields) => {
      const { c, meters, each } = linux({
        600: { leader: { fdsErr: "EACCES", stat: statLine(fields) } },
        601: { leader: { ...deleted(6 * MB) } },
      });
      await run(meters, c, 3, 250);
      expect(each.uses.at(-1)?.folder).toBe(6 * MB);
      expect(each.reports).toEqual([]);
    },
  );

  test("a denied pid that started after the listing is another process's, so gone; one that started by then is an error", async () => {
    const reused = linux({
      600: { leader: { fdsErr: "EACCES", stat: statLine({ started: LISTED_AT + 1 }) } },
    });
    await run(reused.meters, reused.c, 3, 250);
    expect(reused.each.peak().unknown).toBe(false);
    expect(reused.each.reports).toEqual([]);
    const listed = linux({
      600: { leader: { fdsErr: "EACCES", stat: statLine({ started: LISTED_AT }) } },
    });
    await run(listed.meters, listed.c, 2, 250);
    expect(listed.each.uses.at(-1)?.folder).toBe("unknown");
  });

  test("a zombie leader whose thread lives on is read through that thread, skipping one on its way out", async () => {
    const { c, meters, each } = linux({
      600: {
        leader: { fdsErr: "EACCES", stat: statLine({ state: "Z", flags: 0x4, vsize: 0 }) },
        tasks: [600, 777, 778],
        threads: {
          777: { fdsErr: "EACCES", stat: statLine({ flags: 0x4, vsize: 0 }) },
          778: { ...deleted(8 * MB, "9") },
        },
      },
    });
    await run(meters, c, 3, 250);
    expect(each.uses.at(-1)?.folder).toBe(8 * MB);
    expect(each.reports).toEqual([]);
  });

  test("a live thread that hides its fd folder, or threads that can't be listed, stop the run", async () => {
    const hidden = linux({
      600: {
        leader: { fdsErr: "EACCES", stat: statLine({ state: "Z", flags: 0x4, vsize: 0 }) },
        tasks: [600, 777],
        threads: { 777: { fdsErr: "EACCES", stat: statLine() } },
      },
    });
    await run(hidden.meters, hidden.c, 2, 250);
    expect(hidden.each.uses.at(-1)?.folder).toBe("unknown");
    expect(hidden.each.reports[0]).toContain("/proc/600/task/777/fd");
    const unlisted = linux({
      600: { leader: { fdsErr: "EACCES", stat: statLine({ state: "Z" }) }, tasksErr: "EIO" },
    });
    await run(unlisted.meters, unlisted.c, 2, 250);
    expect(unlisted.each.uses.at(-1)?.folder).toBe("unknown");
    expect(unlisted.each.reports).toEqual([
      "DiskReadError: A disk read for process 600 failed (EIO): /proc/600/task (NSpid 9000 8999 7)",
    ]);
  });

  const races: [string, (code: string) => PidSpec][] = [
    ["its fd folder", (code) => ({ leader: { fdsErr: code } })],
    [
      "one fd's link",
      (code) => ({
        leader: {
          fds: ["3", "4"],
          links: { 3: err(code), 4: "/work/kept (deleted)" },
          sizes: { 4: { device: 9, inode: "4", bytes: 5 * MB } },
        },
      }),
    ],
    [
      "one fd's size",
      (code) => ({
        leader: {
          fds: ["3", "4"],
          links: { 3: "/work/a (deleted)", 4: "/work/kept (deleted)" },
          sizes: { 3: err(code), 4: { device: 9, inode: "4", bytes: 5 * MB } },
        },
      }),
    ],
    ["its maps", (code) => ({ leader: { mapsErr: code } })],
    ["its stat", (code) => ({ leader: { fdsErr: "EACCES", statErr: code } })],
    [
      "its threads",
      (code) => ({ leader: { fdsErr: "EACCES", stat: statLine({ state: "Z" }) }, tasksErr: code }),
    ],
  ];
  test.each(
    races.flatMap(([where, spec]) =>
      ["ENOENT", "ESRCH"].map((code) => [where, code, spec] as const),
    ),
  )(
    "a process gone part way through reading %s (%s) counts as nothing, not an error; the run's others still count",
    async (_where, code, spec) => {
      const { c, meters, each } = linux({
        600: spec(code),
        601: { leader: { ...deleted(6 * MB) } },
      });
      await run(meters, c, 3, 250);
      expect(each.peak().unknown).toBe(false);
      expect(each.reports).toEqual([]);
      expect(each.uses.at(-1)?.folder).toBeGreaterThanOrEqual(6 * MB);
    },
  );

  test("an fd denied part way through, as the process exits, is no error; one denied by a live process is", async () => {
    const node = (): ProcNode => ({
      fds: ["3", "4"],
      links: { 3: err("EACCES"), 4: "/work/kept (deleted)" },
      sizes: { 4: { device: 9, inode: "4", bytes: 5 * MB } },
    });
    const exiting = linux({
      600: { leader: { ...node(), stat: statLine({ flags: 0x4, vsize: 0 }) } },
      601: { leader: { ...deleted(6 * MB) } },
    });
    await run(exiting.meters, exiting.c, 3, 250);
    expect(exiting.each.uses.at(-1)?.folder).toBe(6 * MB);
    expect(exiting.each.reports).toEqual([]);
    const live = linux({ 600: { leader: node() } });
    await run(live.meters, live.c, 2, 250);
    expect(live.each.uses.at(-1)?.folder).toBe("unknown");
    expect(live.each.reports[0]).toContain("(EACCES): /proc/600/fd/3");
  });

  test("maps past the cap are read no further and leave the disk unknown, not stopped, that turn", async () => {
    let chunks = 0;
    const counted = () =>
      (async function* () {
        for await (const chunk of capped()()) {
          chunks += 1;
          yield chunk;
        }
      })();
    const { c, meters, each } = linux({ 600: { leader: { maps: counted } } });
    await run(meters, c, 1, 250);
    // 6 MiB in chunks of 63,840 bytes: the 99th passes the cap.
    expect(chunks).toBe(99);
    await run(meters, c, 1, 250);
    expect(each.peak().unknown).toBe(false);
  });

  test("a file growing through one fd while reads are slow is counted in full at the next good read", async () => {
    const leader: ProcNode = { ...deleted(5 * MB) };
    const { c, meters, each } = linux({ 600: { leader } });
    await run(meters, c, 2, 250);
    expect(each.uses.at(-1)?.folder).toBe(5 * MB);
    let release = () => {};
    leader.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    leader.sizes = { 3: { device: 9, inode: "42", bytes: 60 * MB } };
    for (let n = 0; n < 4; n++) {
      await meters.tick();
      c.advance(250);
    }
    expect(each.uses.at(-1)?.folder).toBe(5 * MB);
    release();
    leader.hold = undefined;
    await meters.settle();
    await run(meters, c, 1, 250);
    expect(each.uses.at(-1)?.folder).toBe(60 * MB);
  });

  test("an fd pointed at a bigger file is counted at the new file's size", async () => {
    const leader: ProcNode = { ...deleted(5 * MB, "1") };
    const { c, meters, each } = linux({ 600: { leader } });
    await run(meters, c, 2, 250);
    expect(each.uses.at(-1)?.folder).toBe(5 * MB);
    leader.sizes = { 3: { device: 9, inode: "2", bytes: 80 * MB } };
    await run(meters, c, 2, 250);
    expect(each.uses.at(-1)?.folder).toBe(80 * MB);
  });

  test("a read that never returns: no second read starts, memory is judged every tick, and the run is stopped once unknown more than 10 s", async () => {
    const { c, meters, each, fdReads } = linux({
      600: { leader: { hold: new Promise<void>(() => {}) } },
    });
    for (let n = 0; n <= 41; n++) {
      await meters.tick();
      c.advance(250);
    }
    // Begun at 0 ms: over its 2 s deadline it is unknown, and 10,250 ms in it is past 10 s.
    expect(stoppedAt(each)).toBe(41);
    // The run and the helper's inner half, 1,024 KiB each.
    expect(each.uses.filter((u) => u.memory === 2048 * 1024)).toHaveLength(42);
    await expect.poll(() => fdReads.get(600)).toBe(1);
  });

  test("one run's read that never returns stops only that run", async () => {
    const c = clock();
    const { command } = computer({
      ps: () =>
        ["600 1 600", "601 600 600", "700 1 700", "701 700 700"]
          .map((row) => `${row} 501 1024`)
          .join("\n"),
    });
    const { reader, fdReads } = fakeProc({
      600: { leader: { hold: new Promise<void>(() => {}) } },
      601: { leader: {}, status: nested(2, 1) },
      700: { leader: { ...deleted(4 * MB) } },
      701: { leader: {}, status: nested(2, 1) },
    });
    const meters = createMeters({
      command,
      platform: "linux",
      interval: false,
      now: c.now,
      reader,
      folder: async () => 0,
    });
    const stuck = watcher();
    const other = watcher();
    meters.meter().watch(600, "/w", stuck.use, stuck.unmeasured);
    meters.meter().watch(700, "/w2", other.use, other.unmeasured);
    for (let n = 0; n <= 12; n++) {
      await meters.tick();
      // Its first read waits on this computer for the folder's device; the rest are made up.
      await expect.poll(() => fdReads.get(700)).toBeGreaterThanOrEqual(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      c.advance(1000);
    }
    expect(stoppedAt(stuck)).toBe(11);
    expect(fdReads.get(700)).toBe(13);
    expect(other.peak().unknown).toBe(false);
    expect(other.uses.at(-1)?.folder).toBe(4 * MB);
  });

  test("a read past the cap never lowers the count below the last good read's", async () => {
    const leader: ProcNode = { ...deleted(5 * MB) };
    const { c, meters, each } = linux({ 600: { leader } });
    await run(meters, c, 2, 250);
    expect(each.uses.at(-1)?.folder).toBe(5 * MB);
    leader.fds = [];
    leader.maps = capped();
    await run(meters, c, 2, 250);
    expect(each.uses.at(-1)?.folder).toBe(5 * MB);
  });

  test("a read that ends after its run is no longer watched tells it nothing", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { meters, each } = linux({ 600: { leader: { fdsErr: "EACCES", hold } } });
    await meters.tick();
    meters.stop();
    release();
    await meters.settle();
    expect(each.uses).toHaveLength(1);
    expect(each.reports).toEqual([]);
  });

  test("the folder limit keeps counting the named files while the open-file read is stuck", async () => {
    let named = 0;
    const { c, meters, each } = linux(
      { 600: { leader: { hold: new Promise<void>(() => {}) } } },
      {
        folder: async () => {
          named += 10 * MB;
          return named;
        },
      },
    );
    for (let n = 0; n < 6; n++) {
      await meters.tick();
      await vi.waitFor(() => expect(named).toBe((n + 1) * 10 * MB));
      c.advance(250);
    }
    await meters.tick();
    expect(each.uses.at(-1)?.folder).toBe(60 * MB);
  });
});

describe("the 10 s clock", () => {
  test("unknown for exactly 10,000 ms isn't stopped; the next tick, past it, is", async () => {
    const { c, meters, each } = linux({ 600: { leader: { maps: capped() } } });
    // Every read passes the cap. The first began at 0 ms, so the clock starts there.
    await run(meters, c, 42, 250);
    expect(each.uses[40]?.folder).not.toBe("unknown");
    expect(stoppedAt(each)).toBe(41);
  });

  test("8 s unknown, a good read, then 8 s unknown again: never stopped", async () => {
    const leader: ProcNode = { maps: capped() };
    const { c, meters, each } = linux({ 600: { leader } });
    await run(meters, c, 33, 250);
    leader.maps = "";
    await run(meters, c, 2, 250);
    leader.maps = capped();
    await run(meters, c, 33, 250);
    expect(each.peak().unknown).toBe(false);
  });

  test("a good read that began before the disk became unknown doesn't end the unknown", async () => {
    const c = clock();
    let listings = 0;
    const { command } = computer({
      ps: () => {
        listings += 1;
        if (listings > 1) throw new Error("ps didn't answer in time.");
        return "600 1 600 501 1024\n601 600 600 501 1024";
      },
    });
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { reader } = fakeProc({
      600: { leader: { hold } },
      601: { leader: {}, status: nested(2, 1) },
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
    // The read begins at 0 ms; the listing fails from 250 ms, so the disk is unknown from there.
    for (let n = 0; n < 2; n++) {
      await meters.tick();
      c.advance(250);
    }
    release();
    await meters.settle();
    await run(meters, c, 41, 250);
    expect(stoppedAt(each)).toBe(42);
  });

  test("a listing that keeps failing stops the run once unknown more than 10 s; the named folder still counts meanwhile", async () => {
    const c = clock();
    const { command } = computer({
      ps: () => {
        throw new Error("ps didn't answer in time.");
      },
    });
    const meters = createMeters({
      command,
      platform: "linux",
      interval: false,
      now: c.now,
      folder: async () => 3 * MB,
    });
    const each = watcher();
    meters.meter().watch(600, "/w", each.use, each.unmeasured);
    await run(meters, c, 42, 250);
    expect(each.uses[40]?.folder).toBe(3 * MB);
    expect(stoppedAt(each)).toBe(41);
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
    // On Linux the meter reads only processes in a run's own PID namespace (the real layout has
    // its own case in runCode.test.ts); this process is put there, and the rest is this /proc.
    const reader: ProcReader = {
      ...procReader,
      status: async (pid) => (pid === "self" ? "NSpid:\t1\n" : "NSpid:\t1\t1\t2\n"),
    };
    const meters = createMeters({ interval: false, reader });
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
