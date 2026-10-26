import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { gt, gte, valid } from "semver";
import { isRecord } from "../core/errors";
import { type Identity, identity, readJson, remove, writeJson } from "./instanceFiles";

export interface UpdateHandoff {
  readonly id: string;
  readonly owner: Readonly<Identity>;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly startedAt: string;
  readonly status: "installing" | "failed";
  readonly reopens: boolean;
}

export type UpdateAccess =
  | { kind: "empty" }
  | { kind: "allowed"; record: UpdateHandoff; pendingTarget: string | null }
  | { kind: "blocked"; record: UpdateHandoff }
  | { kind: "invalid" };

const FILE = "instance-update.json";
export const UPDATE_RECOVERY_PREFIX = "--update-recovery=";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isVersion = (value: unknown): value is string =>
  typeof value === "string" && valid(value) !== null;
const isUtc = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function updateRecoveryId(args: readonly string[]): string | undefined {
  const values = args
    .filter((arg) => arg.startsWith(UPDATE_RECOVERY_PREFIX))
    .map((arg) => arg.slice(UPDATE_RECOVERY_PREFIX.length));
  return values.length === 1 && isUuid(values[0]) ? values[0] : undefined;
}

function handoff(value: unknown): value is UpdateHandoff {
  return (
    isRecord(value) &&
    isUuid(value.id) &&
    identity(value.owner) &&
    isUtc(value.owner.startedAt) &&
    isVersion(value.fromVersion) &&
    isVersion(value.targetVersion) &&
    gt(value.targetVersion, value.fromVersion) &&
    isUtc(value.startedAt) &&
    (value.status === "installing" || value.status === "failed") &&
    typeof value.reopens === "boolean"
  );
}

function stored(folder: string): UpdateHandoff | "invalid" | null {
  const file = join(folder, FILE);
  let value: unknown;
  try {
    value = readJson(file);
  } catch (error) {
    if (error instanceof SyntaxError) return "invalid";
    throw error;
  }
  if (value === null) {
    try {
      statSync(file);
      return "invalid";
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }
  return handoff(value) ? value : "invalid";
}

/** Called by the data owner before invoking the installer; persistence failures propagate. */
export function prepareUpdate(
  folder: string,
  ownerIdentity: Identity,
  currentVersion: string,
  targetVersion: string,
  reopens: boolean,
): UpdateHandoff {
  if (!identity(ownerIdentity) || !isUtc(ownerIdentity.startedAt))
    throw new Error("The update handoff owner is invalid.");
  if (!isVersion(currentVersion) || !isVersion(targetVersion) || !gt(targetVersion, currentVersion))
    throw new Error("The update handoff needs a newer valid target version.");
  const record: UpdateHandoff = {
    id: randomUUID(),
    owner: { ...ownerIdentity },
    fromVersion: currentVersion,
    targetVersion,
    startedAt: new Date().toISOString(),
    status: "installing",
    reopens,
  };
  writeJson(join(folder, FILE), record);
  return record;
}

/** The installer failed in the owning copy; an older callback cannot change a later handoff. */
export function failUpdate(folder: string, id: string): boolean {
  const record = stored(folder);
  if (!record || record === "invalid" || record.id !== id) return false;
  if (record.status !== "failed") writeJson(join(folder, FILE), { ...record, status: "failed" });
  return true;
}

export function updateAccess(
  folder: string,
  currentVersion: string,
  recoveryId?: string,
): UpdateAccess {
  if (!isVersion(currentVersion)) return { kind: "invalid" };
  const record = stored(folder);
  if (record === null) return { kind: "empty" };
  if (record === "invalid") return { kind: "invalid" };
  if (
    record.status === "installing" ||
    gte(currentVersion, record.targetVersion) ||
    (record.status === "failed" && isUuid(recoveryId) && recoveryId === record.id)
  )
    return {
      kind: "allowed",
      record,
      pendingTarget: gte(currentVersion, record.targetVersion)
        ? null
        : record.status === "installing"
          ? record.targetVersion
          : null,
    };
  return { kind: "blocked", record };
}

/** Caller must hold the data gate and be ready before retiring its accepted handoff. */
export function completeUpdate(folder: string, id: string): boolean {
  const record = stored(folder);
  if (!record || record === "invalid" || record.id !== id) return false;
  remove(join(folder, FILE));
  return true;
}
