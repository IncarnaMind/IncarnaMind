import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "../core/errors";
import { type InstanceLock, lockInstance } from "./instanceLock";

interface Identity {
  pid: number;
  startedAt: string;
}

export interface SecondStart {
  args: string[];
  cwd: string;
}

type Phase = "starting" | "ready" | "quitting";
type Report = (what: string, error: unknown) => void;
const startedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    remove(temporary);
  }
}

function remove(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function identity(value: unknown): value is Identity {
  return (
    isRecord(value) &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startedAt === "string" &&
    Number.isFinite(Date.parse(value.startedAt))
  );
}

function same(one: Identity, other: Identity): boolean {
  return one.pid === other.pid && one.startedAt === other.startedAt;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

function secondStart(value: unknown): value is SecondStart {
  return (
    isRecord(value) &&
    Array.isArray(value.args) &&
    value.args.every((arg) => typeof arg === "string") &&
    typeof value.cwd === "string"
  );
}

export class InstanceOwner {
  readonly identity: Identity = { pid: process.pid, startedAt };
  private phase: Phase = "starting";
  private onStart: ((start: SecondStart) => boolean) | null = null;
  private readonly requests: string;

  constructor(
    private readonly folder: string,
    private readonly lock: InstanceLock,
    private readonly report: Report,
    readonly previousOwner: boolean,
  ) {
    this.requests = join(folder, "instance-requests");
    mkdirSync(this.requests, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.requests))
      if (name.endsWith(".processing") || name.endsWith(".reply.json"))
        remove(join(this.requests, name));
    this.publish();
    // The watcher keeps this owner and its SQLite handles alive through native quit cleanup.
    watch(this.requests, () => this.receive())
      .on("error", (error) => this.report("app.secondStartFailed", error))
      .unref();
  }

  ready(onStart: (start: SecondStart) => boolean): void {
    this.onStart = onStart;
    this.phase = "ready";
    this.publish();
    this.receive();
  }

  quitting(prevented = false): void {
    this.phase = prevented ? "ready" : "quitting";
    this.publish();
    if (prevented) this.receive();
  }

  private publish(): void {
    writeJson(join(this.folder, "instance-info.json"), { ...this.identity, phase: this.phase });
  }

  private receive(): void {
    if (!this.lock.held || this.phase !== "ready" || !this.onStart) return;
    try {
      for (const name of readdirSync(this.requests)) {
        if (!name.endsWith(".request.json")) continue;
        const file = join(this.requests, name);
        const claimed = `${file}.${randomUUID()}.processing`;
        try {
          renameSync(file, claimed);
          const request = readJson(claimed);
          if (
            !isRecord(request) ||
            typeof request.id !== "string" ||
            name !== `${request.id}.request.json` ||
            !identity(request.owner) ||
            !same(request.owner, this.identity) ||
            !secondStart(request.input)
          )
            continue;
          if (!this.onStart(request.input)) {
            this.quitting();
            return;
          }
          writeJson(join(this.requests, `${request.id}.reply.json`), {
            id: request.id,
            owner: this.identity,
          });
        } catch (error) {
          if (!missing(error)) this.report("app.secondStartFailed", error);
        } finally {
          remove(claimed);
        }
      }
    } catch (error) {
      this.report("app.secondStartFailed", error);
    }
  }
}

export type Instance =
  | { kind: "owner"; owner: InstanceOwner }
  | { kind: "forwarded" }
  | { kind: "busy" };

/** SQLite owns the folder until process exit; PID/start-time-bound requests never take Electron's lock. */
export function acquireInstance(
  folder: string,
  input: SecondStart,
  report: Report,
  { waitMs = 10_000 } = {},
): Instance {
  const id = randomUUID();
  const requests = join(folder, "instance-requests");
  const requestFile = join(requests, `${id}.request.json`);
  const replyFile = join(requests, `${id}.reply.json`);
  const deadline = performance.now() + waitMs;
  let sentTo: Identity | null = null;
  let previousOwner = false;
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > 32_768) return { kind: "busy" };
    for (;;) {
      const reply = readJson(replyFile);
      if (
        sentTo &&
        isRecord(reply) &&
        reply.id === id &&
        identity(reply.owner) &&
        same(reply.owner, sentTo)
      )
        return { kind: "forwarded" };
      let failed = false;
      const lock = lockInstance(
        folder,
        (what, error) => {
          failed = true;
          report(what, error);
        },
        { giveUpAfterMs: 0 },
      );
      if (failed) return { kind: "busy" };
      if (lock.held)
        return { kind: "owner", owner: new InstanceOwner(folder, lock, report, previousOwner) };
      const info = readJson(join(folder, "instance-info.json"));
      if (identity(info) && alive(info.pid)) {
        previousOwner = true;
        if (!sentTo || !same(info, sentTo)) {
          mkdirSync(requests, { recursive: true, mode: 0o700 });
          writeJson(requestFile, {
            id,
            owner: { pid: info.pid, startedAt: info.startedAt },
            input,
          });
          sentTo = info;
        }
      }
      if (performance.now() >= deadline) return { kind: "busy" };
      pause();
    }
  } catch (error) {
    report("app.instanceLockFailed", error);
    return { kind: "busy" };
  } finally {
    for (const file of [requestFile, replyFile]) {
      try {
        remove(file);
      } catch (error) {
        report("app.secondStartCleanupFailed", error);
      }
    }
  }
}
