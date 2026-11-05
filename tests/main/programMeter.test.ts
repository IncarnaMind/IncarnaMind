/**
 * How the OS sandbox's Executor measures its programs against their memory and folder limits
 * (ADR-0025): one listing a tick for every program it watches, footprints and unlinked files in
 * turn, and no limit caught more than one tick late. Most cases read a computer of their own,
 * through commands that answer as macOS's would; the last ones read this computer's processes.
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
  readListing,
  runCommand,
  treeMemory,
  unlinkedFiles,
  unlinkedMappings,
} from "../../src/main/programMeter";
import { createTempDataFolder } from "../helpers/core";

const MB = 1_000_000;
const MiB = 1024 * 1024;

describe("a program's memory, as its limit counts it", () => {
  // pid ppid pgid uid rss(KiB): 100 is the program; bubblewrap's child 200 has a session of its own.
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
    // 101 holds 3 GB of which 2 MB is resident; 201's footprint is under its resident memory.
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
    // lsof -F pftDisk: 4101 holds an unlinked file twice and a named one; 4102 holds the first too.
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
    // Once however many hold it, and only on the working folder's device where it is known.
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
      // makedev(8, 1) and makedev(259, 2), as Node's stat gives a file's device.
      { pid: 4101, device: 2049, inode: "1234", bytes: 0x300000 },
      { pid: 4101, device: 66306, inode: "77", bytes: 0x1000 },
      { pid: 4101, device: 1, inode: "5", bytes: 0x1000 },
    ]);
  });
});

/** A computer the meter reads through commands: `state` is what each command says now. */
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

const footprintOf = (pid: number, bytes: number) =>
  [
    `perl [${pid}]: 64-bit    Footprint: ${bytes} B (16384 bytes per page)`,
    `    phys_footprint: ${bytes} B`,
  ].join("\n");

const lsofOf = (pid: number, device: number, inode: number, bytes: number) =>
  [`p${pid}`, "f3", "tREG", `D0x${device.toString(16)}`, `s${bytes}`, `i${inode}`, "k0", ""].join(
    "\n",
  );

/** A working folder of the test's own, and its device as lsof names it. */
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
  };
}

describe("the meter's ticks", () => {
  test("one listing a tick for every program it watches; footprints and unlinked files in turn, once each for all of them", async () => {
    const { folder, device } = await workingFolder();
    const listing = [600, 700, 800].map((pid) => `${pid} 1 ${pid} 501 1024`).join("\n");
    const { command, calls } = computer({
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

    await meters.tick();
    await meters.tick();
    await meters.tick();

    expect(calls).toEqual([
      "ps",
      "/usr/bin/footprint",
      "ps",
      "/usr/sbin/lsof",
      "ps",
      "/usr/bin/footprint",
    ]);
    expect(programs.map((each) => each.uses.map((use) => [use.memory, use.folder]))).toEqual([
      [
        [1024 * 1024, 0],
        [1024 * 1024, 0],
        [1024 * 1024, 0],
      ],
      [
        [5 * MB, 0],
        [5 * MB, 0],
        [5 * MB, 0],
      ],
      [
        [1024 * 1024, 0],
        [1024 * 1024, 7 * MB],
        [1024 * 1024, 7 * MB],
      ],
    ]);
    expect(programs.flatMap((each) => each.reports)).toEqual([]);
  });

  // The program grows by 10 MiB a tick, from tick `from`, past a 45 MiB limit: it holds more than
  // that from tick `from` + 5.
  test.each([
    ["resident memory", "memory", 0],
    ["resident memory", "memory", 1],
    ["footprint", "memory", 0],
    ["footprint", "memory", 1],
    ["files in its folder", "folder", 0],
    ["files in its folder", "folder", 1],
    ["unlinked files", "folder", 0],
    ["unlinked files", "folder", 1],
  ] as const)(
    "a program growing in %s past its %s limit from tick %i is caught at most one tick late, and not before",
    async (kind, limit, from) => {
      const { folder, device } = await workingFolder();
      let tick = 0;
      const grown = () => 10 * MiB * Math.max(0, tick - from);
      const { command } = computer({
        ps: () => {
          tick += 1;
          return `600 1 600 501 ${kind === "resident memory" ? grown() / 1024 : 1}`;
        },
        footprint: () => footprintOf(600, kind === "footprint" ? grown() : 0),
        lsof: () => (kind === "unlinked files" ? lsofOf(600, device, 42, grown()) : ""),
      });
      const meters = createMeters({
        command,
        platform: "darwin",
        interval: false,
        folder: async () => (kind === "files in its folder" ? grown() : 0),
      });
      const each = watcher();
      meters.meter().watch(600, folder, each.use, each.unmeasured);
      const caught: number[] = [];
      for (let at = 0; at < 10; at++) {
        await meters.tick();
        const use = each.uses.at(-1);
        if (use && use[limit] > 45 * MiB) caught.push(tick);
      }

      const crossed = from + 5;
      const late = (caught[0] ?? Number.POSITIVE_INFINITY) - crossed;
      expect(late).toBeGreaterThanOrEqual(0);
      expect(late).toBeLessThanOrEqual(
        kind === "resident memory" || kind === "files in its folder" ? 0 : 1,
      );
      expect(each.reports).toEqual([]);
    },
  );

  test("lsof's answer when a pid it was given has ended is counted, and says nothing", async () => {
    const { folder, device } = await workingFolder();
    const listing = "600 1 600 501 1024\n601 600 600 501 1024";
    const { command } = computer({ ps: () => listing });
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
    await meters.tick();
    await meters.tick();
    expect(each.uses.map((use) => use.folder)).toEqual([0, 9 * MB]);
    expect(each.reports).toEqual([]);
  });

  test("an lsof that fails or runs out of time is reported and counts nothing, stopping nothing, not even what the last one counted; the next one counts again", async () => {
    const { folder, device } = await workingFolder();
    let lsofs = 0;
    const { command } = computer({
      ps: () => "600 1 600 501 1024",
      lsof: () => {
        lsofs += 1;
        if (lsofs === 2) {
          throw Object.assign(new Error("Command failed: lsof"), {
            killed: true,
            signal: "SIGTERM",
            code: null,
          });
        }
        return lsofOf(600, device, 42, 9 * MB);
      },
    });
    const meters = createMeters({
      command,
      platform: "darwin",
      interval: false,
      folder: async () => 3 * MB,
    });
    const each = watcher();
    meters.meter().watch(600, folder, each.use, each.unmeasured);
    for (let at = 0; at < 6; at++) await meters.tick();
    expect(each.uses.map((use) => use.folder)).toEqual([
      3 * MB,
      12 * MB,
      12 * MB,
      3 * MB,
      3 * MB,
      12 * MB,
    ]);
    expect(each.reports).toEqual(["Error: Command failed: lsof"]);
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
    for (let at = 0; at < 3; at++) await meters.tick();
    expect(each.uses.map((use) => use.memory)).toEqual([2048 * 1024, 2048 * 1024, 2048 * 1024]);
    expect(each.reports).toEqual(["Error: footprint failed"]);
  });

  test("the run's processes launchd took over are told from the tick's own listing, and counted with every process under them", async () => {
    const { folder } = await workingFolder();
    const listing = [
      "600 1 600 501 1024",
      "650 1 640 501 2048",
      "651 650 640 501 4096",
      "700 1 700 501 8192",
    ].join("\n");
    const { command, calls } = computer({ ps: () => listing });
    const meters = createMeters({ command, platform: "darwin", interval: false });
    const given: number[][] = [];
    const each = watcher();
    meters
      .meter(async (group, listed) => {
        given.push([group, ...listed.map((row) => row.pid)]);
        return [650];
      })
      .watch(600, folder, each.use, each.unmeasured);
    await meters.tick();
    expect(each.uses.map((use) => use.memory)).toEqual([(1024 + 2048 + 4096) * 1024]);
    expect(given).toEqual([[600, 600, 650, 651, 700]]);
    expect(calls.filter((file) => file === "ps")).toHaveLength(1);
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
    expect(each.uses.map((use) => use.memory)).toEqual([1024 * 1024]);
    expect(each.reports).toEqual(["Error: sandbox_check didn't answer in time."]);
  });

  test("a listing that fails is reported to every program and measures none; the next tick measures again", async () => {
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
    await meters.tick();
    await meters.tick();
    expect(programs.map((each) => [each.reports, each.uses.length])).toEqual([
      [["Error: ps didn't answer in time."], 1],
      [["Error: ps didn't answer in time."], 1],
    ]);
  });

  test("a program stopped while a tick reads is told nothing more by it", async () => {
    const { folder } = await workingFolder();
    const { command } = computer({ ps: () => "600 1 600 501 1024\n700 1 700 501 1024" });
    const meters = createMeters({ command, platform: "darwin", interval: false });
    const second = watcher();
    let stopSecond = () => {};
    const first = watcher();
    meters.meter().watch(
      600,
      folder,
      (use) => {
        first.use(use);
        stopSecond();
      },
      first.unmeasured,
    );
    stopSecond = meters.meter().watch(700, folder, second.use, second.unmeasured);
    await meters.tick();
    expect([first.uses.length, second.uses.length]).toEqual([1, 0]);
  });

  test("a program no longer watched is measured no more", async () => {
    const { folder } = await workingFolder();
    const { command, calls } = computer({ ps: () => "600 1 600 501 1024" });
    const meters = createMeters({ command, platform: "darwin", interval: false });
    const each = watcher();
    const stop = meters.meter().watch(600, folder, each.use, each.unmeasured);
    await meters.tick();
    stop();
    await meters.tick();
    expect(each.uses).toHaveLength(1);
    expect(calls).toEqual(["ps", "/usr/bin/footprint"]);
  });
});

test("each of the meter's commands is stopped after 2 s", async () => {
  await expect(runCommand("/bin/sleep", ["30"])).rejects.toMatchObject({
    killed: true,
    signal: "SIGTERM",
  });
});

describe("on this computer", () => {
  /** Starts `code` in `folder` and waits for it to say it is ready. */
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

  async function measured(child: ChildProcess, folder: string) {
    const meters = createMeters({ interval: false });
    const each = watcher();
    meters.meter().watch(child.pid ?? 0, folder, each.use, each.unmeasured);
    // Both turns: footprints, then unlinked files.
    await meters.tick();
    await meters.tick();
    return each;
  }

  test("a file a process holds after unlinking it counts with its folder, once; a file it holds with its name counts once too", async () => {
    const { folder } = await workingFolder();
    const child = await holding(
      "perl",
      [
        "-e",
        'open(my $g, ">", "gone") or die; print $g "x" x 3_000_000; close $g; open(my $h, "<", "gone") or die; unlink "gone"; open(my $k, ">", "kept") or die; print $k "y" x 1_000_000; close $k; open(my $o, "<", "kept") or die; $| = 1; print "ready\\n"; sleep 60',
      ],
      folder,
    );
    const each = await measured(child, folder);
    expect(each.uses.at(-1)?.folder).toBe(4_000_000);
    expect(each.reports).toEqual([]);
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
    const each = await measured(child, folder);
    // A whole number of pages, so a mapping reaches all of it on Linux too.
    expect(each.uses.at(-1)?.folder).toBe(3_145_728);
    expect(each.reports).toEqual([]);
  });
});
