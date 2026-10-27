export type InstancePhase = "starting" | "ready" | "quitting" | "installing";

const STARTING_GRACE_MS = 60_000;

export class InstanceProgress {
  private owner = "";
  private progress: number | null = null;
  private phase: InstancePhase | null = null;
  private deadline: number;

  constructor(
    private readonly waitMs: number,
    now: number,
  ) {
    this.deadline = now + waitMs;
  }

  observe(owner: string, phase: InstancePhase, progress: number | null, now: number): void {
    if (owner === this.owner && phase === this.phase && progress === this.progress) return;
    this.owner = owner;
    this.phase = phase;
    this.progress = progress;
    // A migration can occupy the main thread; its next progress report needs more than a quit's grace.
    this.deadline =
      now + (phase === "starting" ? Math.max(this.waitMs, STARTING_GRACE_MS) : this.waitMs);
  }

  expired(now: number): boolean {
    return now >= this.deadline;
  }
}
