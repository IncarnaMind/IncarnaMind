import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
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
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) messages.push(value);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => errors.push(chunk));
  child.stderr.pipe(process.stderr);
  return {
    child,
    errors,
    messages,
    async message(kind: string) {
      await vi.waitFor(() => expect(messages.some((row) => row.kind === kind)).toBe(true));
      return messages.find((row) => row.kind === kind);
    },
    async done() {
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      return child.exitCode;
    },
  };
}

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
  await vi.waitFor(async () =>
    expect(JSON.parse(await readFile(join(folder, "instance-info.json"), "utf8"))).toMatchObject({
      phase: "ready",
    }),
  );
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
  const next = start(folder, "take");
  await vi.waitFor(async () =>
    expect(
      (await readdir(join(folder, "instance-requests"))).some((name) =>
        name.endsWith(".request.json"),
      ),
    ).toBe(true),
  );
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
  const next = start(folder, "take");
  await vi.waitFor(async () =>
    expect(
      (await readdir(join(folder, "instance-requests"))).some((name) =>
        name.endsWith(".request.json"),
      ),
    ).toBe(true),
  );
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
  await vi.waitFor(() => expect(owner.errors.join("")).toContain("app.instanceStateFailed"));
});

test.each(["pid", "startedAt"])(
  "a stale %s never forwards a request to the wrong process generation",
  async (field) => {
    const folder = await tempFolder();
    const owner = start(folder);
    await owner.message("owner");
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
  expect(owner.errors.join("")).toContain("app.updateHandoffInvalid");
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
  expect(owner.errors.join("")).toContain("app.updateHandoffReadFailed");
  expect(owner.errors.join("")).toContain("EACCES");
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
  const second = start(folder, "wait-recovery", 2000);
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
