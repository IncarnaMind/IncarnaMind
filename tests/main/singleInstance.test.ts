import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { isRecord } from "../../src/core/errors";
import { identity } from "../../src/main/instanceFiles";
import { heldByAnotherCopy } from "../../src/main/instanceLock";
import { failUpdate, prepareUpdate } from "../../src/main/instanceUpdate";

const root = fileURLToPath(new URL("../..", import.meta.url));
let bundleFolder = "";
let bundle = "";
beforeAll(async () => {
  bundleFolder = await mkdtemp(join(tmpdir(), "incarnamind-owner-module-"));
  await build({
    configFile: false,
    root,
    logLevel: "warn",
    ssr: { noExternal: true },
    build: {
      ssr: fileURLToPath(new URL("../helpers/singleInstanceChild.ts", import.meta.url)),
      outDir: bundleFolder,
      emptyOutDir: false,
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "owner.mjs" } },
    },
  });
  bundle = join(bundleFolder, "owner.mjs");
});
afterAll(() => rm(bundleFolder, { recursive: true, force: true }));

const children: ChildProcessWithoutNullStreams[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const tempFolder = async () => {
  const folder = await mkdtemp(join(tmpdir(), "incarnamind-owner-"));
  folders.push(folder);
  return folder;
};

function start(folder: string, mode = "owner", wait = 10000, recoveryId?: string) {
  const child = spawn(
    process.execPath,
    [
      ...(mode === "missed-watch" ? ["-r", join(root, "e2e/instanceWatch.cjs")] : []),
      ...(mode === "unreadable-update" ? ["-r", join(root, "e2e/instanceUpdateRead.cjs")] : []),
      bundle,
      mode,
      folder,
      String(wait),
      ...(recoveryId ? [recoveryId] : []),
    ],
    { stdio: "pipe" },
  );
  children.push(child);
  const messages: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const waiters = new Set<{
    kind: string;
    resolve(message: Record<string, unknown>): void;
    reject(error: Error): void;
  }>();
  const completion = Promise.withResolvers<void>();
  let failure: Error | null = null;
  let stdoutEnded = false;
  let closed = false;
  let pending = "";
  const absent = (kind: string) =>
    new Error(
      `The ${mode} child ${closed ? "closed" : "ended stdout"} without reporting “${kind}” (code ${child.exitCode}, signal ${child.signalCode}). Received: ${messages.map((row) => row.kind).join(", ")}. ${errors.join("")}`,
    );
  const rejectMissing = () => {
    for (const waiter of waiters) waiter.reject(failure ?? absent(waiter.kind));
    waiters.clear();
  };
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    rejectMissing();
  };
  const receive = (line: string) => {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) throw new Error("The child reported a non-object state.");
      messages.push(value);
      for (const waiter of waiters) {
        if (waiter.kind !== value.kind) continue;
        waiters.delete(waiter);
        waiter.resolve(value);
      }
    } catch (error) {
      fail(error);
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) receive(line);
  });
  child.stdout.on("end", () => {
    receive(pending);
    pending = "";
    stdoutEnded = true;
    rejectMissing();
  });
  child.stdout.on("error", fail);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => errors.push(chunk));
  child.stderr.on("error", fail);
  child.stderr.pipe(process.stderr);
  child.on("error", fail);
  child.on("close", () => {
    closed = true;
    rejectMissing();
    completion.resolve();
  });
  return {
    child,
    errors,
    messages,
    message(kind: string): Promise<Record<string, unknown>> {
      if (failure) return Promise.reject(failure);
      const received = messages.find((row) => row.kind === kind);
      if (received) return Promise.resolve(received);
      if (stdoutEnded || closed) return Promise.reject(absent(kind));
      return new Promise((resolve, reject) => waiters.add({ kind, resolve, reject }));
    },
    async done() {
      await completion.promise;
      if (failure) throw failure;
      return child.exitCode;
    },
  };
}

async function waitingStart(folder: string) {
  const requests = join(folder, "instance-requests");
  const request = Promise.withResolvers<void>();
  const inspect = () => {
    void readdir(requests).then((names) => {
      if (names.some((name) => name.endsWith(".request.json"))) request.resolve();
    }, request.reject);
  };
  const watcher = watch(requests, inspect);
  watcher.on("error", request.reject);
  try {
    const next = start(folder, "take");
    inspect();
    await Promise.race([
      request.promise,
      next.done().then(() => {
        throw new Error(
          `The waiting child closed before publishing its request: ${JSON.stringify(next.messages)}. ${next.errors.join("")}`,
        );
      }),
    ]);
    return next;
  } finally {
    watcher.close();
  }
}

test("a missing child state rejects after completion while reported states stay available", async () => {
  const copy = start(await tempFolder(), "take");
  const missing = expect(copy.message("received")).rejects.toThrow("without reporting “received”");
  expect(await copy.done()).toBe(0);
  await missing;
  expect(await copy.message("owner")).toMatchObject({ kind: "owner" });
  await expect(copy.message("received")).rejects.toThrow("closed without reporting “received”");
});

test("a live ready owner receives the second start's arguments and remains the only data owner", async () => {
  const folder = await tempFolder();
  const owner = start(folder);
  await owner.message("owner");
  const next = start(folder, "take");
  expect(await next.done()).toBe(0);
  expect(await next.message("forwarded")).toEqual({ kind: "forwarded" });
  expect(await owner.message("received")).toMatchObject({
    input: { args: ["synthetic-app", "--open=synthetic"], cwd: process.cwd() },
  });
  expect(
    heldByAnotherCopy(folder, (what, error) => {
      throw new Error(what, { cause: error });
    }),
  ).toBe(true);
});

test("a broken leftover request cannot block a later valid second start", async () => {
  const folder = await tempFolder();
  const owner = start(folder);
  await owner.message("owner");
  await writeFile(join(folder, "instance-requests", "!broken.request.json"), "{broken");
  const next = start(folder, "take", 400);
  expect(await next.done()).toBe(0);
  expect(next.messages).toContainEqual({ kind: "forwarded" });
  expect(await owner.message("received")).toMatchObject({
    input: { args: ["synthetic-app", "--open=synthetic"] },
  });
});

test("a ready owner receives a second start even when the file-watch event is lost", async () => {
  const folder = await tempFolder();
  const owner = start(folder, "missed-watch");
  await owner.message("owner");
  await owner.message("ready");
  expect(JSON.parse(await readFile(join(folder, "instance-info.json"), "utf8"))).toMatchObject({
    phase: "ready",
  });
  const next = start(folder, "take", 2000);
  expect(await next.done()).toBe(0);
  expect(next.messages).toContainEqual({ kind: "forwarded" });
  expect(await owner.message("received")).toMatchObject({
    input: { args: ["synthetic-app", "--open=synthetic"] },
  });
});

test("a start during initialization waits for the owner's ready state before forwarding", async () => {
  const folder = await tempFolder();
  const owner = start(folder, "starting");
  await owner.message("owner");
  const next = await waitingStart(folder);
  expect(next.child.exitCode).toBeNull();
  expect(owner.messages.some((message) => message.kind === "received")).toBe(false);
  owner.child.stdin.write("ready\n");
  expect(await next.done()).toBe(0);
  expect(await next.message("forwarded")).toEqual({ kind: "forwarded" });
});

test("a quitting owner keeps SQLite until its actual exit, then the waiting start takes over", async () => {
  const folder = await tempFolder();
  const owner = start(folder);
  await owner.message("owner");
  owner.child.stdin.write("quitting\n");
  await owner.message("quitting");
  const next = await waitingStart(folder);
  expect(next.child.exitCode).toBeNull();
  expect(
    heldByAnotherCopy(folder, (what, error) => {
      throw new Error(what, { cause: error });
    }),
  ).toBe(true);
  owner.child.stdin.write("exit\n");
  expect(await owner.done()).toBe(0);
  expect(await next.done()).toBe(0);
  expect(await next.message("owner")).toMatchObject({ previousOwner: true });
  expect(owner.messages.some((message) => message.kind === "received")).toBe(false);
});

test("a failed state-file write cannot interrupt quitting or release the data gate", async () => {
  const folder = await tempFolder();
  const owner = start(folder);
  await owner.message("owner");
  await owner.message("ready");
  const file = join(folder, "instance-info.json");
  await rm(file);
  await mkdir(file);
  owner.child.stdin.write("quitting\n");
  await owner.message("quitting");
  expect(owner.child.exitCode).toBeNull();
  expect(
    heldByAnotherCopy(folder, (what, error) => {
      throw new Error(what, { cause: error });
    }),
  ).toBe(true);
  expect(await owner.message("reported")).toMatchObject({ what: "app.instanceStateFailed" });
});

test.each(["pid", "startedAt"])(
  "a stale %s never forwards a request to the wrong process generation",
  async (field) => {
    const folder = await tempFolder();
    const owner = start(folder);
    await owner.message("owner");
    await owner.message("ready");
    const file = join(folder, "instance-info.json");
    const info: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(info)) throw new Error("The owner did not write its identity.");
    await writeFile(
      file,
      JSON.stringify({
        ...info,
        [field]: field === "pid" ? process.pid : "2000-01-01T00:00:00.000Z",
      }),
    );
    const next = start(folder, "take", 400);
    expect(await next.done()).toBe(0);
    expect(await next.message("busy")).toEqual({ kind: "busy", phase: "ready" });
    expect(owner.messages.some((message) => message.kind === "received")).toBe(false);
  },
);

test("a dead owner leaves no stale gate, even while its PID and start time remain on disk", async () => {
  const folder = await tempFolder();
  const owner = start(folder);
  const old = await owner.message("owner");
  const exited = once(owner.child, "exit");
  owner.child.kill("SIGKILL");
  await exited;
  const next = start(folder, "take");
  expect(await next.done()).toBe(0);
  const current = await next.message("owner");
  expect(current).toMatchObject({ previousOwner: false });
  expect(current?.identity).not.toEqual(old?.identity);
});

test.each([true, false])(
  "a committed update deflects a start before the native install event (reopens %s)",
  async (reopens) => {
    const folder = await tempFolder();
    const owner = start(folder);
    const message = await owner.message("owner");
    if (!identity(message?.identity)) throw new Error("The owner did not publish its identity.");
    prepareUpdate(folder, message.identity, "0.0.0", "0.1.0", reopens);
    owner.child.stdin.write("quitting\n");
    await owner.message("quitting");
    const next = start(folder, "take", 400);
    expect(await next.done()).toBe(0);
    expect(next.messages).toEqual([
      reopens ? { kind: "installing" } : { kind: "busy", phase: "quitting" },
    ]);
    expect(owner.messages.some((row) => row.kind === "received")).toBe(false);
    expect(
      heldByAnotherCopy(folder, (what, error) => {
        throw new Error(what, { cause: error });
      }),
    ).toBe(true);
  },
);

test("corrupt pending update metadata cannot block the real data-folder owner", async () => {
  const folder = await tempFolder();
  await writeFile(join(folder, "instance-update.json"), "{broken");
  const owner = start(folder);
  await owner.message("owner");
  expect(owner.child.exitCode).toBeNull();
  expect(
    heldByAnotherCopy(folder, (what, error) => {
      throw new Error(what, { cause: error });
    }),
  ).toBe(true);
  expect(await owner.message("reported")).toMatchObject({ what: "app.updateHandoffInvalid" });
  expect(await readFile(join(folder, "instance-update.json"), "utf8")).toBe("{broken");
});

test("an unreadable update sidecar cannot block a writable SQLite data folder", async () => {
  const folder = await tempFolder();
  await writeFile(join(folder, "instance-update.json"), "{}");
  const owner = start(folder, "unreadable-update");
  await owner.message("owner");
  expect(owner.child.exitCode).toBeNull();
  expect(
    heldByAnotherCopy(folder, (what, error) => {
      throw new Error(what, { cause: error });
    }),
  ).toBe(true);
  expect(await owner.message("reported")).toMatchObject({
    what: "app.updateHandoffReadFailed",
    code: "EACCES",
  });
});

test("a second start waits for the scheduled failed-install recovery after the original owner exits", async () => {
  const folder = await tempFolder();
  const old = start(folder);
  const previous = await old.message("owner");
  if (!identity(previous?.identity)) throw new Error("The owner did not publish its identity.");
  const record = prepareUpdate(folder, previous.identity, "0.0.0", "0.1.0", true);
  expect(failUpdate(folder, record.id)).toBe(true);
  old.child.stdin.write("exit\n");
  await old.done();
  const second = start(folder, "wait-recovery");
  await second.message("starting");
  const recovery = start(folder, "owner", 2000, record.id);
  await recovery.message("owner");
  expect(await second.done()).toBe(0);
  expect(second.messages).toContainEqual({ kind: "forwarded" });
  expect(second.messages.some((row) => row.kind === "update" || row.kind === "owner")).toBe(false);
  expect(await recovery.message("received")).toMatchObject({
    input: { args: ["synthetic-app", "--open=synthetic"] },
  });
});
