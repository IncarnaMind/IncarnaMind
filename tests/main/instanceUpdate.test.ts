import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as files from "../../src/main/instanceFiles";
import {
  completeUpdate,
  failUpdate,
  prepareUpdate,
  updateAccess,
  updateRecoveryId,
} from "../../src/main/instanceUpdate";

let folder = "";
let file = "";
const owner = { pid: 123, startedAt: "2026-10-26T10:00:00.000Z" };
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "incarnamind-update-handoff-"));
  file = join(folder, "instance-update.json");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-10-26T10:01:00.000Z");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(folder, { recursive: true, force: true });
});

const prepare = (from = "1.9.0", to = "1.10.0", reopens = true) =>
  prepareUpdate(folder, owner, from, to, reopens);

test("only one complete recovery argument supplies its UUID", () => {
  const id = randomUUID();
  const arg = `--update-recovery=${id}`;
  expect(updateRecoveryId(["app", arg, "--updated"])).toBe(id);
  for (const args of [
    [],
    ["--updated", "--started-again-after-stall"],
    [id],
    ["--update-recovery="],
    ["--update-recovery=not-a-uuid"],
    [arg, arg],
    [arg, "--update-recovery=not-a-uuid"],
  ])
    expect(updateRecoveryId(args)).toBeUndefined();
});

describe("an install handoff survives the old copy's exit", () => {
  test("starts empty, then persists the install identity and target", () => {
    expect(updateAccess(folder, "1.9.0")).toEqual({ kind: "empty" });
    const record = prepare("1.9.0", "1.10.0", false);
    expect(record).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      owner,
      fromVersion: "1.9.0",
      targetVersion: "1.10.0",
      startedAt: "2026-10-26T10:01:00.000Z",
      status: "installing",
      reopens: false,
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
    expect(updateAccess(folder, "1.9.0")).toEqual({
      kind: "allowed",
      record,
      pendingTarget: record.targetVersion,
    });
  });

  test.each(["1.10.0", "1.10.0+repair.1", "1.11.0", "2.0.0"])(
    "%s can take over without deleting the handoff during startup",
    (version) => {
      const record = prepare();
      expect(updateAccess(folder, version)).toEqual({
        kind: "allowed",
        record,
        pendingTarget: null,
      });
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
      expect(updateAccess(folder, "1.9.0")).toEqual({
        kind: "allowed",
        record,
        pendingTarget: record.targetVersion,
      });
    },
  );

  test.each(["1.9.0", "1.9.9", "1.10.0-alpha.20", "1.10.0-rc.1"])(
    "%s remains below a stable target",
    (version) => {
      const record = prepare();
      expect(updateAccess(folder, version)).toEqual({
        kind: "allowed",
        record,
        pendingTarget: record.targetVersion,
      });
    },
  );

  test("prerelease numeric identifiers use SemVer precedence", () => {
    const record = prepare("2.0.0-beta.2", "2.0.0-beta.10");
    expect(updateAccess(folder, "2.0.0-beta.9")).toEqual({
      kind: "allowed",
      record,
      pendingTarget: record.targetVersion,
    });
    expect(updateAccess(folder, "2.0.0-beta.10")).toEqual({
      kind: "allowed",
      record,
      pendingTarget: null,
    });
    expect(updateAccess(folder, "2.0.0")).toEqual({ kind: "allowed", record, pendingTarget: null });
  });

  test("age and routing hints never retire a pending target", () => {
    const record = prepare();
    vi.setSystemTime("2030-10-26T10:01:00.000Z");
    for (const hint of [
      undefined,
      "--updated",
      "APPIMAGE_SILENT_INSTALL=true",
      "--started-again-after-stall",
      record.id,
    ])
      expect(updateAccess(folder, "1.9.0", hint)).toEqual({
        kind: "allowed",
        record,
        pendingTarget: record.targetVersion,
      });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
  });

  test("a known failed handoff admits the old binary only with its exact recovery id", () => {
    const record = prepare();
    expect(failUpdate(folder, randomUUID())).toBe(false);
    expect(updateAccess(folder, "1.9.0", record.id)).toEqual({
      kind: "allowed",
      record,
      pendingTarget: record.targetVersion,
    });
    expect(failUpdate(folder, record.id)).toBe(true);
    const failed = { ...record, status: "failed" };
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(failed);
    for (const hint of [
      undefined,
      randomUUID(),
      "--updated",
      "--started-again-after-stall",
      `--update-recovery=${record.id}`,
    ])
      expect(updateAccess(folder, "1.9.0", hint)).toEqual({ kind: "blocked", record: failed });
    expect(updateAccess(folder, "1.9.0", record.id)).toEqual({
      kind: "allowed",
      record: failed,
      pendingTarget: null,
    });
    expect(failUpdate(folder, record.id)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(failed);
  });

  test("a ready owner removes only its matching handoff", () => {
    const first = prepare();
    expect(completeUpdate(folder, randomUUID())).toBe(false);
    expect(completeUpdate(folder, first.id)).toBe(true);
    expect(updateAccess(folder, "1.10.0")).toEqual({ kind: "empty" });
    const second = prepare("1.10.0", "1.11.0");
    expect(completeUpdate(folder, first.id)).toBe(false);
    expect(failUpdate(folder, first.id)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(second);
    expect(completeUpdate(folder, second.id)).toBe(true);
    expect(completeUpdate(folder, second.id)).toBe(false);
  });
});

describe("invalid state never becomes an empty or accepted handoff", () => {
  test.each([
    { pid: 0, startedAt: owner.startedAt },
    { pid: 1.5, startedAt: owner.startedAt },
    { pid: owner.pid, startedAt: "yesterday" },
  ])("rejects invalid owner identity %j", (invalidOwner) => {
    expect(() => prepareUpdate(folder, invalidOwner, "1.9.0", "1.10.0", true)).toThrow(
      "owner is invalid",
    );
    expect(updateAccess(folder, "1.9.0")).toEqual({ kind: "empty" });
  });

  test.each(["", "1", "1.2", "1.2.3.4", "1.2.3-beta.01", "latest"])(
    "rejects invalid version %j without writing a marker",
    (version) => {
      expect(() => prepare(version, "2.0.0")).toThrow("valid target version");
      expect(() => prepare("1.0.0", version)).toThrow("valid target version");
      expect(updateAccess(folder, version)).toEqual({ kind: "invalid" });
      expect(updateAccess(folder, "1.0.0")).toEqual({ kind: "empty" });
    },
  );

  test.each(["1.9.0", "1.9.0+another-build", "1.8.9"])(
    "cannot prepare a same-version or downgrade install to %s",
    (target) => {
      expect(() => prepare("1.9.0", target)).toThrow("newer valid target version");
      expect(updateAccess(folder, "1.9.0")).toEqual({ kind: "empty" });
    },
  );

  test.each(["null", "[]", "{}", "{broken"])(
    "retains malformed marker %j until a real downloaded target replaces it",
    (text) => {
      writeFileSync(file, text);
      expect(updateAccess(folder, "9.0.0")).toEqual({ kind: "invalid" });
      expect(failUpdate(folder, randomUUID())).toBe(false);
      expect(completeUpdate(folder, randomUUID())).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(text);
      const replacement = prepare();
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(replacement);
    },
  );

  test.each([
    { id: "not-a-uuid" },
    { owner: { pid: 0, startedAt: owner.startedAt } },
    { owner: { pid: owner.pid, startedAt: "yesterday" } },
    { startedAt: "2026-02-30T00:00:00.000Z" },
    { startedAt: "2026-10-26" },
    { fromVersion: "broken" },
    { targetVersion: "broken" },
    { targetVersion: "1.9.0" },
    { targetVersion: "1.8.0" },
    { status: "ready" },
    { reopens: "true" },
  ])("rejects invalid stored fields %j", (change) => {
    const record = prepare();
    writeFileSync(file, JSON.stringify({ ...record, ...change }));
    expect(updateAccess(folder, "99.0.0", record.id)).toEqual({ kind: "invalid" });
    expect(failUpdate(folder, record.id)).toBe(false);
    expect(completeUpdate(folder, record.id)).toBe(false);
  });

  test("the next owned quit refreshes a pending target without accepting an older callback", () => {
    const first = prepare();
    const nextOwner = { pid: 456, startedAt: "2026-10-26T10:02:00.000Z" };
    const next = prepareUpdate(folder, nextOwner, "1.9.0", "1.11.0", false);
    expect(next.id).not.toBe(first.id);
    expect(next).toMatchObject({ owner: nextOwner, targetVersion: "1.11.0", reopens: false });
    expect(failUpdate(folder, first.id)).toBe(false);
    expect(completeUpdate(folder, first.id)).toBe(false);
    expect(failUpdate(folder, next.id)).toBe(true);
    expect(() => prepare("1.10.0", "1.11.0")).toThrow("already pending");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...next, status: "failed" });
  });

  test("a failed prepare write throws, preserving the earlier absence", () => {
    const error = new Error("disk full");
    vi.spyOn(files, "writeJson").mockImplementationOnce(() => {
      throw error;
    });
    expect(() => prepare()).toThrow(error);
    expect(updateAccess(folder, "1.9.0")).toEqual({ kind: "empty" });
  });

  test("a failed failure-state write throws and preserves the installing record", () => {
    const record = prepare();
    const error = new Error("disk full");
    vi.spyOn(files, "writeJson").mockImplementationOnce(() => {
      throw error;
    });
    expect(() => failUpdate(folder, record.id)).toThrow(error);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
    expect(updateAccess(folder, "1.9.0", record.id)).toEqual({
      kind: "allowed",
      record,
      pendingTarget: record.targetVersion,
    });
  });

  test("I/O failures are not interpreted as an absent handoff", () => {
    mkdirSync(file);
    expect(() => updateAccess(folder, "1.9.0")).toThrow();
    expect(() => prepare()).toThrow();
  });
});
