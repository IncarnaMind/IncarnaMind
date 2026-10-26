import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { heldByAnotherCopy, lockInstance } from "../../src/main/instanceLock";

const CHILD = fileURLToPath(new URL("../helpers/instanceLockChild.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

let bundleDir = "";
let bundle = "";
beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "incarnamind-lock-"));
  await build({
    configFile: false,
    root: ROOT,
    logLevel: "warn",
    build: {
      ssr: CHILD,
      outDir: bundleDir,
      emptyOutDir: false,
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "instanceLockChild.mjs" } },
    },
  });
  bundle = join(bundleDir, "instanceLockChild.mjs");
}, 60_000);
afterAll(() => rm(bundleDir, { recursive: true, force: true }));

const folders: string[] = [];
const folder = async () => {
  const made = await mkdtemp(join(tmpdir(), "incarnamind-instance-"));
  folders.push(made);
  return made;
};
afterEach(async () => {
  for (const each of folders.splice(0)) await rm(each, { recursive: true, force: true });
});

const report = (what: string, error: unknown) => {
  throw new Error(`${what}: ${String(error)}`);
};

describe("one copy of the app holds a data folder", () => {
  test("the first has it; a second, while the first runs, doesn't; once it lets go, a start has it", async () => {
    const where = await folder();
    const first = lockInstance(where, report);
    expect(first.held).toBe(true);
    expect(lockInstance(where, report).held).toBe(false);
    first.release();
    const next = lockInstance(where, report);
    expect(next.held).toBe(true);
    next.release();
  });

  test("two data folders are held side by side", async () => {
    const [one, other] = [await folder(), await folder()];
    const both = [lockInstance(one, report), lockInstance(other, report)];
    expect(both.map((each) => each.held)).toEqual([true, true]);
    for (const each of both) each.release();
  });

  test("tells whether another copy holds the folder, without taking it", async () => {
    const where = await folder();
    expect(heldByAnotherCopy(where, report)).toBe(false);
    const first = lockInstance(where, report);
    expect(heldByAnotherCopy(where, report)).toBe(true);
    first.release();
    expect(heldByAnotherCopy(where, report)).toBe(false);
    await writeFile(join(where, "instance.owner"), "not a database, only text ".repeat(8));
    expect(heldByAnotherCopy(where, report)).toBe(false);
    const next = lockInstance(where, report);
    expect(next.held).toBe(true);
    next.release();
  });

  test("letting go twice is harmless", async () => {
    const lock = lockInstance(await folder(), report);
    lock.release();
    lock.release();
  });

  test("a copy killed outright lets the folder go, with nothing left to clean up", async () => {
    const where = await folder();
    const child: ChildProcess = spawn(process.execPath, [bundle, "hold", where], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const [line] = (await once(child.stdout as NodeJS.ReadableStream, "data")) as [Buffer];
    expect(JSON.parse(line.toString())).toEqual({ held: true });
    expect(lockInstance(where, report).held).toBe(false);

    child.kill("SIGKILL");
    await once(child, "exit");

    const next = lockInstance(where, report);
    expect(next.held).toBe(true);
    next.release();
  });

  test("a folder whose lock is busy with nobody holding it is waited for, and a held one is refused at once", async () => {
    const where = await folder();
    const hold = (file: string) => {
      const db = new DatabaseSync(join(where, file));
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      return db;
    };
    const ask = (mode = "try", sawItHeld?: () => void) =>
      new Promise<{ held: boolean; timedOut: boolean; after: number }>((resolve, reject) => {
        const began = Date.now();
        const child = spawn(process.execPath, [bundle, mode, where], {
          stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        let toldHeld = false;
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          if (toldHeld || !out.includes("sawItHeld")) return;
          toldHeld = true;
          sawItHeld?.();
        });
        child.on("error", reject);
        // On its exit: it has let the folder go by then.
        child.on("exit", () => {
          const last = out.trim().split("\n").at(-1) ?? "";
          resolve({ ...JSON.parse(last), after: Date.now() - began });
        });
      });

    // Another copy's try: it holds instance.lock for a moment and not instance.owner.
    const trying = hold("instance.lock");
    const waited = ask();
    await new Promise((done) => setTimeout(done, 700));
    trying.close();
    expect(await waited).toMatchObject({ held: true, after: expect.any(Number) });

    // A copy that holds the folder holds both files.
    const [lock, owner] = [hold("instance.lock"), hold("instance.owner")];
    const refused = await ask();
    expect(refused.held).toBe(false);
    expect(refused.after).toBeLessThan(5_000);

    expect(await ask("leaving")).toMatchObject({ held: false, timedOut: true });
    const waiting = ask("leaving", () => {
      lock.close();
      owner.close();
    });
    expect((await waiting).held).toBe(true);
  });

  test("a folder busy with nobody holding it past the deadline is not started on, and says so", async () => {
    const where = await folder();
    const stopped = new DatabaseSync(join(where, "instance.lock"));
    stopped.exec("PRAGMA locking_mode = EXCLUSIVE");
    stopped.exec("BEGIN EXCLUSIVE");
    const began = performance.now();
    const lock = lockInstance(where, report, { giveUpAfterMs: 300 });
    stopped.close();
    expect(lock).toMatchObject({ held: false, timedOut: true });
    expect(performance.now() - began).toBeGreaterThanOrEqual(300);
  });

  test("a lock file that isn't a database is emptied and taken, and the next copy finds it held", async () => {
    const where = await folder();
    const text = "not a database, only text that is long enough ".repeat(8);
    await writeFile(join(where, "instance.lock"), text);
    await writeFile(join(where, "instance.owner"), text);
    const lock = lockInstance(where, report);
    expect(lock.held).toBe(true);
    expect(lockInstance(where, report, { giveUpAfterMs: 50 })).toMatchObject({
      held: false,
      timedOut: false,
    });
    lock.release();
  });

  /**
   * `copies` processes asking for the folder together at the start of each of `rounds` rounds;
   * `garbage`: with text in its lock files first. The rounds in which two held it at once, and
   * those in which none did.
   */
  async function race(copies: number, rounds: number, garbage: boolean) {
    type Result = { held: boolean; from?: string; to?: string };
    const where = await folder();
    const run = (index: number) =>
      new Promise<Result[]>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            bundle,
            "race",
            where,
            String(rounds),
            "40",
            String(copies),
            String(index),
            garbage && index === 0 ? "garbage" : "clean",
          ],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(`A copy exited with ${code}.`));
          else resolve(JSON.parse(out));
        });
      });
    const results = await Promise.all(Array.from({ length: copies }, (_, copy) => run(copy)));
    rmSync(`${where}-sync`, { recursive: true, force: true });

    const overlapping: number[] = [];
    const nobody: number[] = [];
    for (let round = 0; round < rounds; round++) {
      const holders = results.flatMap((each) => (each[round]?.held ? [each[round]] : []));
      if (holders.length === 0) nobody.push(round);
      const together = holders.some((a, at) =>
        holders
          .slice(at + 1)
          .some(
            (b) =>
              BigInt(a?.from ?? 0) < BigInt(b?.to ?? 0) &&
              BigInt(b?.from ?? 0) < BigInt(a?.to ?? 0),
          ),
      );
      if (together) overlapping.push(round);
    }
    return { overlapping, nobody };
  }

  // protects=two copies asking in the same instant never both hold the folder, and one always does; fails_when=two holders overlap, or none holds it; no_claim=Electron's own lock.
  test("two copies asking in the same instant, 400 times: one holds it each time", async () => {
    expect(await race(2, 400, false)).toEqual({ overlapping: [], nobody: [] });
  }, 120_000);

  // protects=files that aren't databases are emptied and asked for again, and three copies racing over them still have one holder each time; fails_when=a garbage file turns the lock off, so two copies hold the folder; no_claim=Electron's own lock.
  test("three copies racing over lock files full of text, 300 times: one holds it each time", async () => {
    expect(await race(3, 300, true)).toEqual({ overlapping: [], nobody: [] });
  }, 120_000);
});
