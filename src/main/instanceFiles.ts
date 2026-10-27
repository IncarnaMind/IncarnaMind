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
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    remove(temporary);
  }
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
