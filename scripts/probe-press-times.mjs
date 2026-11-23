// Probe for #3697, not for main: for each test of selectAcrossCitation.spec.ts, the time from each
// double-click to the next mouse press, and what the other worker was running at that press.
const SPEC = "selectAcrossCitation.spec.ts";

class PressTimes {
  constructor() {
    this.running = new Map();
    this.pending = new Map();
    this.presses = new Map();
  }

  onTestBegin(test, result) {
    this.running.set(result.parallelIndex, { test: test.title, file: test.location.file, step: "" });
  }

  onStepBegin(test, result, step) {
    const here = this.running.get(result.parallelIndex);
    if (here && here.test === test.title) here.step = step.title;
    if (!test.location.file.endsWith(SPEC) || step.title !== "Mouse down") return;
    const double = this.pending.get(result);
    if (!double) return;
    this.pending.delete(result);
    const at = step.startTime.getTime();
    const beside = [...this.running]
      .filter(([index]) => index !== result.parallelIndex)
      .map(([, other]) => `${other.file.split("/").pop()} › ${other.test} › ${other.step}`);
    const presses = this.presses.get(result) ?? [];
    presses.push({ fromEnd: at - double.end, fromStart: at - double.start, beside });
    this.presses.set(result, presses);
  }

  onStepEnd(test, result, step) {
    if (!test.location.file.endsWith(SPEC) || step.title !== "Double click") return;
    const start = step.startTime.getTime();
    this.pending.set(result, { start, end: start + step.duration });
  }

  onTestEnd(test, result) {
    const here = this.running.get(result.parallelIndex);
    if (here && here.test === test.title) this.running.delete(result.parallelIndex);
    if (!test.location.file.endsWith(SPEC)) return;
    const line = {
      test: test.title,
      status: result.status,
      worker: result.parallelIndex,
      presses: this.presses.get(result) ?? [],
    };
    console.log(`ZZPRESS ${JSON.stringify(line)}`);
  }
}

export default PressTimes;
