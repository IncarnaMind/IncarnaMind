import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isRecord } from "../core/errors";

export interface Identity {
  pid: number;
  startedAt: string;
}

export const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let failure: unknown;
  let failed = false;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    try {
      renameSync(temporary, file);
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM")
        throw error;
      // Windows can briefly refuse to replace a file another process holds (#2097).
      const deadline = performance.now() + 5_000;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      let renameFailure = error;
      for (;;) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw renameFailure;
        Atomics.wait(pause, 0, 0, Math.min(250, remaining));
        if (performance.now() >= deadline) throw renameFailure;
        try {
          renameSync(temporary, file);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
          renameFailure = error;
        }
      }
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    remove(temporary);
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
}

export function remove(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

export function identity(value: unknown): value is Identity {
  return (
    isRecord(value) &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startedAt === "string" &&
    Number.isFinite(Date.parse(value.startedAt))
  );
}

export function same(one: Identity, other: Identity): boolean {
  return one.pid === other.pid && one.startedAt === other.startedAt;
}
