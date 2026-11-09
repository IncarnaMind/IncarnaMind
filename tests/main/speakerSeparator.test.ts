import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A speaker process that can't be killed until it has spawned, as Electron's can't. */
class Child extends EventEmitter {
  spawned = false;
  killed = false;
  posted: unknown[] = [];
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  kill() {
    if (!this.spawned) return false;
    this.killed = true;
    return true;
  }
  spawn() {
    this.spawned = true;
    this.emit("spawn");
  }
}

const children: Child[] = vi.hoisted(() => []);

vi.mock("../../src/main/engineProcess", () => ({
  startEngineProcess: () => {
    const child = new Child();
    children.push(child);
    return child;
  },
}));
vi.mock("../../src/main/speakerProcess?modulePath", () => ({ default: "speaker.js" }));

const { createUtilityProcessSeparator } = await import("../../src/main/speakerSeparator");

const request = { parts: [], model: { segmentation: "", embedding: "", threads: 2 } };
const clustered = { turns: [{ startMs: 0, endMs: 1000, voice: 0 }], voices: [] };

describe("The speaker process (#2839)", () => {
  beforeEach(() => {
    children.length = 0;
  });

  // protects=a run during a call stopped before its process has spawned still ends that process, so two passes never run at once; fails_when=the process goes on clustering after the abort, or the abort doesn't reject; no_claim=Electron's own process handling.
  it("stops a process aborted before it has spawned, once it has", async () => {
    const stop = new AbortController();
    const run = createUtilityProcessSeparator().cluster(request, stop.signal);
    const child = children[0] as Child;
    stop.abort(new DOMException("Stopped.", "AbortError"));
    await expect(run).rejects.toThrow("Stopped.");
    expect(child.killed).toBe(false);
    child.spawn();
    expect(child.killed).toBe(true);
  });

  // protects=a process that answers is ended, after an abort too; fails_when=a process that answered after its run was stopped stays alive; no_claim=a process that never answers, which its exit covers.
  it("ends a process that answers, also after its run was stopped", async () => {
    const separator = createUtilityProcessSeparator();
    const answered = separator.cluster(request);
    const first = children[0] as Child;
    first.spawn();
    first.emit("message", { clustered });
    await expect(answered).resolves.toEqual(clustered);
    expect(first.killed).toBe(true);

    const stop = new AbortController();
    const stopped = separator.cluster(request, stop.signal);
    const second = children[1] as Child;
    second.spawn();
    second.killed = false;
    stop.abort(new DOMException("Stopped.", "AbortError"));
    await expect(stopped).rejects.toThrow("Stopped.");
    second.killed = false;
    second.emit("message", { clustered });
    expect(second.killed).toBe(true);
  });

  // protects=a request already stopped starts no process; fails_when=a process starts for it; no_claim=a request stopped later, which the tests above cover.
  it("starts no process for a request already stopped", async () => {
    const stop = new AbortController();
    stop.abort(new DOMException("Stopped.", "AbortError"));
    await expect(createUtilityProcessSeparator().cluster(request, stop.signal)).rejects.toThrow(
      "Stopped.",
    );
    expect(children).toHaveLength(0);
  });
});
