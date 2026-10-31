import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, watch } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../core/errors";
import {
  type Identity,
  identity,
  missing,
  readJson,
  remove,
  same,
  writeJson,
} from "./instanceFiles";
import { heldByAnotherCopy, type InstanceLock, lockInstance } from "./instanceLock";
import { type InstancePhase, InstanceProgress } from "./instanceProgress";
import { completeUpdate, updateAccess } from "./instanceUpdate";

export interface SecondStart {
  args: string[];
  cwd: string;
}

type Report = (what: string, error: unknown) => void;
const startedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
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
  private phase: InstancePhase = "starting";
  private progress = 0;
  private installReopens = false;
  private onStart: ((start: SecondStart) => boolean) | null = null;
  private readonly requests: string;

  /**
   * How the run before this one ended, when the User should hear of it (#2309): while in use
   * without quitting (a crash, a force quit, a power cut), as its `instance-info.json` still says
   * "ready"; or ended by the system with changes it couldn't store (`sessionEnded`).
   */
  readonly lastRunEnd: LastRunEnd | null;
  private unsavedAtEnd = 0;

  constructor(
    private readonly folder: string,
    private readonly lock: InstanceLock,
    private readonly report: Report,
    readonly previousOwner: boolean,
    private readonly acceptedUpdate?: { record: { id: string }; pendingTarget: string | null },
  ) {
    this.lastRunEnd = this.lastRunEnded();
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
    // File watches can lose an event; a pending start still needs a reply (#2022).
    setInterval(() => this.receive(), 1_000).unref();
  }

  private lastRunEnded(): LastRunEnd | null {
    let last: unknown;
    try {
      last = readJson(join(this.folder, "instance-info.json"));
    } catch (error) {
      this.report("app.lastRunUnreadable", error);
      return null;
    }
    if (!identity(last) || !isRecord(last)) return null;
    const run = { pid: last.pid, startedAt: last.startedAt };
    if (last.phase === "ready") return { ...run, kind: "app" };
    const unsaved = last.unsavedAtEnd;
    return last.phase === "quitting" && Number.isSafeInteger(unsaved) && Number(unsaved) > 0
      ? { ...run, kind: "session", unsaved: Number(unsaved) }
      : null;
  }

  get pendingUpdate(): string | null {
    return this.acceptedUpdate?.pendingTarget ?? null;
  }

  starting(): void {
    if (this.phase !== "starting") return;
    this.progress += 1;
    this.publishState();
  }

  ready(onStart: (start: SecondStart) => boolean): void {
    this.onStart = onStart;
    this.phase = "ready";
    this.publishState();
    if (this.acceptedUpdate && !this.acceptedUpdate.pendingTarget) {
      try {
        if (!completeUpdate(this.folder, this.acceptedUpdate.record.id))
          throw new Error("The accepted update handoff changed before startup completed.");
      } catch (error) {
        this.report("app.updateHandoffCleanupFailed", error);
      }
    }
    this.receive();
  }

  quitting(prevented = false): void {
    if (this.phase === "installing") return;
    const next = prevented ? "ready" : "quitting";
    if (this.phase === next) return;
    this.phase = next;
    this.publishState();
    if (prevented) this.receive();
  }

  /** The system ends the session, and the process with it, with `unsaved` changes not stored. */
  sessionEnded(unsaved: number): void {
    if (this.phase === "installing") return;
    this.phase = "quitting";
    this.unsavedAtEnd = unsaved;
    this.publishState();
  }

  installing(reopens = true): void {
    this.phase = "installing";
    this.installReopens = reopens;
    this.publishState();
  }

  private publish(): void {
    writeJson(join(this.folder, "instance-info.json"), {
      ...this.identity,
      phase: this.phase,
      progress: this.progress,
      ...(this.phase === "installing" && { reopens: this.installReopens }),
      ...(this.phase === "quitting" &&
        this.unsavedAtEnd > 0 && { unsavedAtEnd: this.unsavedAtEnd }),
    });
  }

  private publishState(): void {
    try {
      this.publish();
    } catch (error) {
      this.report("app.instanceStateFailed", error);
    }
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

/** How the run before ended, for the next start to say (`InstanceOwner.lastRunEnd`). */
export type LastRunEnd = Identity & ({ kind: "app" } | { kind: "session"; unsaved: number });

export type Instance =
  | { kind: "owner"; owner: InstanceOwner }
  | { kind: "forwarded" }
  | { kind: "installing" }
  | { kind: "update"; currentVersion: string; targetVersion?: string }
  | { kind: "busy"; phase: InstancePhase | null };

/** SQLite owns the folder until process exit; PID/start-time-bound requests never take Electron's lock. */
export function acquireInstance(
  folder: string,
  input: SecondStart,
  report: Report,
  {
    waitMs = 10_000,
    currentVersion = "0.0.0",
    recoveryId,
  }: { waitMs?: number; currentVersion?: string; recoveryId?: string } = {},
): Instance {
  const id = randomUUID();
  const requests = join(folder, "instance-requests");
  const requestFile = join(requests, `${id}.request.json`);
  const replyFile = join(requests, `${id}.reply.json`);
  const waiting = new InstanceProgress(waitMs, performance.now());
  let phase: InstancePhase | null = null;
  let sentTo: Identity | null = null;
  let previousOwner = false;
  let invalidUpdateReported = false;
  const readUpdate = (): ReturnType<typeof updateAccess> => {
    try {
      const update = updateAccess(folder, currentVersion, recoveryId);
      if (update.kind === "invalid" && !invalidUpdateReported) {
        invalidUpdateReported = true;
        report(
          "app.updateHandoffInvalid",
          new Error("The pending update metadata could not be read."),
        );
      }
      return update;
    } catch (error) {
      if (!invalidUpdateReported) {
        invalidUpdateReported = true;
        report("app.updateHandoffReadFailed", error);
      }
      return { kind: "invalid" };
    }
  };
  const observe = (info: unknown): info is Identity => {
    if (!identity(info) || !alive(info.pid)) return false;
    previousOwner = true;
    if (isRecord(info)) {
      phase =
        info.phase === "starting" ||
        info.phase === "ready" ||
        info.phase === "quitting" ||
        info.phase === "installing"
          ? info.phase
          : null;
      if (phase)
        waiting.observe(
          `${info.pid}:${info.startedAt}`,
          phase,
          typeof info.progress === "number" &&
            Number.isSafeInteger(info.progress) &&
            info.progress >= 0
            ? info.progress
            : null,
          performance.now(),
        );
    }
    return true;
  };
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > 32_768) return { kind: "busy", phase };
    for (;;) {
      const update = readUpdate();
      const pending =
        update.kind === "blocked" || (update.kind === "allowed" && update.pendingTarget)
          ? update.record
          : null;
      if (pending?.reopens) {
        const info = readJson(join(folder, "instance-info.json"));
        if (
          identity(info) &&
          same(info, pending.owner) &&
          alive(info.pid) &&
          heldByAnotherCopy(folder, report)
        )
          return { kind: "installing" };
      }
      if (update.kind === "blocked") {
        if (update.record.reopens) observe(readJson(join(folder, "instance-info.json")));
        if (!update.record.reopens || waiting.expired(performance.now()))
          return { kind: "update", currentVersion, targetVersion: update.record.targetVersion };
        pause();
        continue;
      }
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
      if (failed) return { kind: "busy", phase };
      if (lock.held) {
        // The installer can publish its target after our first read, before its owner exits (#2022).
        let confirmed: ReturnType<typeof updateAccess>;
        try {
          confirmed = readUpdate();
        } catch (error) {
          lock.release();
          throw error;
        }
        if (confirmed.kind === "blocked") {
          lock.release();
          continue;
        }
        return {
          kind: "owner",
          owner: new InstanceOwner(
            folder,
            lock,
            report,
            previousOwner,
            confirmed.kind === "allowed" ? confirmed : undefined,
          ),
        };
      }
      const info = readJson(join(folder, "instance-info.json"));
      if (observe(info)) {
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
      if (waiting.expired(performance.now())) return { kind: "busy", phase };
      pause();
    }
  } catch (error) {
    report("app.instanceLockFailed", error);
    return { kind: "busy", phase };
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
