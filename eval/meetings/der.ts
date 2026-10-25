/**
 * Diarisation error rate (#85), as NIST's md-eval scores it: the time of speech missed, of
 * non-speech given a speaker, and of speech given to the wrong speaker, over the time the
 * reference has speech.
 * - Time is cut into 10 ms frames; a turn covers the frames from its start to its end, rounded.
 * - Overlapped speech is scored: with two speakers in a frame, two are expected.
 * - No frame within `collar` seconds of a reference turn's start or end is scored, so a boundary
 *   placed a little early or late costs nothing. The collar is part of the number: say it.
 * - Speakers are matched one to one, for the whole recording, so that the most time agrees
 *   (the Hungarian method): the engine's names for its speakers mean nothing.
 */

export interface Turn {
  speaker: string;
  /** Seconds. */
  start: number;
  end: number;
}

export interface Der {
  /** Seconds of reference speech scored, counting each speaker of an overlap. */
  speech: number;
  missed: number;
  falseAlarm: number;
  confusion: number;
  /** (missed + falseAlarm + confusion) / speech; 0 when the reference has no speech. */
  rate: number;
  collar: number;
}

export const FRAMES_PER_SECOND = 100;
export const DEFAULT_COLLAR = 0.25;

function activity(turns: readonly Turn[], frames: number): Map<string, Uint8Array> {
  const bySpeaker = new Map<string, Uint8Array>();
  for (const turn of turns) {
    let row = bySpeaker.get(turn.speaker);
    if (!row) {
      row = new Uint8Array(frames);
      bySpeaker.set(turn.speaker, row);
    }
    const from = Math.max(0, Math.round(turn.start * FRAMES_PER_SECOND));
    const to = Math.min(frames, Math.round(turn.end * FRAMES_PER_SECOND));
    row.fill(1, from, Math.max(from, to));
  }
  return bySpeaker;
}

/**
 * The assignment of rows to columns that gives the largest total weight, as a column for each
 * row or -1 where a row has none.
 */
export function bestMatching(weights: readonly (readonly number[])[]): number[] {
  const rows = weights.length;
  const columns = weights.reduce((most, row) => Math.max(most, row.length), 0);
  const size = Math.max(rows, columns);
  if (size === 0) return [];
  const cost = (row: number, column: number) => -(weights[row - 1]?.[column - 1] ?? 0);
  const rowPotential = new Float64Array(size + 1);
  const columnPotential = new Float64Array(size + 1);
  const matchOfColumn = new Int32Array(size + 1);
  const previousColumn = new Int32Array(size + 1);
  for (let row = 1; row <= size; row++) {
    matchOfColumn[0] = row;
    let column0 = 0;
    const slack = new Float64Array(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Uint8Array(size + 1);
    do {
      used[column0] = 1;
      const matched = matchOfColumn[column0] as number;
      let delta = Number.POSITIVE_INFINITY;
      let column1 = 0;
      for (let column = 1; column <= size; column++) {
        if (used[column]) continue;
        const reduced =
          cost(matched, column) -
          (rowPotential[matched] as number) -
          (columnPotential[column] as number);
        if (reduced < (slack[column] as number)) {
          slack[column] = reduced;
          previousColumn[column] = column0;
        }
        if ((slack[column] as number) < delta) {
          delta = slack[column] as number;
          column1 = column;
        }
      }
      for (let column = 0; column <= size; column++) {
        if (used[column]) {
          rowPotential[matchOfColumn[column] as number] =
            (rowPotential[matchOfColumn[column] as number] as number) + delta;
          columnPotential[column] = (columnPotential[column] as number) - delta;
        } else {
          slack[column] = (slack[column] as number) - delta;
        }
      }
      column0 = column1;
    } while (matchOfColumn[column0] !== 0);
    do {
      const column1 = previousColumn[column0] as number;
      matchOfColumn[column0] = matchOfColumn[column1] as number;
      column0 = column1;
    } while (column0 !== 0);
  }
  const result = new Array<number>(rows).fill(-1);
  for (let column = 1; column <= size; column++) {
    const row = (matchOfColumn[column] as number) - 1;
    if (row < rows && column <= columns) result[row] = column - 1;
  }
  return result;
}

export function diarisationErrorRate(
  reference: readonly Turn[],
  hypothesis: readonly Turn[],
  collar = DEFAULT_COLLAR,
): Der {
  const last = Math.max(0, ...reference.map((turn) => turn.end), ...hypothesis.map((t) => t.end));
  const frames = Math.round(last * FRAMES_PER_SECOND) + 1;
  const ref = activity(reference, frames);
  const hyp = activity(hypothesis, frames);
  const refRows = [...ref.values()];
  const hypRows = [...hyp.values()];

  const scored = new Uint8Array(frames).fill(1);
  const margin = Math.round(collar * FRAMES_PER_SECOND);
  for (const turn of reference) {
    for (const edge of [turn.start, turn.end]) {
      const centre = Math.round(edge * FRAMES_PER_SECOND);
      scored.fill(0, Math.max(0, centre - margin), Math.min(frames, centre + margin));
    }
  }

  const together = refRows.map(() => new Array<number>(hypRows.length).fill(0));
  let speech = 0;
  let missed = 0;
  let falseAlarm = 0;
  let overlap = 0;
  for (let frame = 0; frame < frames; frame++) {
    if (!scored[frame]) continue;
    const wanted: number[] = [];
    const heard: number[] = [];
    for (let r = 0; r < refRows.length; r++) if ((refRows[r] as Uint8Array)[frame]) wanted.push(r);
    for (let h = 0; h < hypRows.length; h++) if ((hypRows[h] as Uint8Array)[frame]) heard.push(h);
    speech += wanted.length;
    missed += Math.max(0, wanted.length - heard.length);
    falseAlarm += Math.max(0, heard.length - wanted.length);
    overlap += Math.min(wanted.length, heard.length);
    for (const r of wanted) {
      const row = together[r] as number[];
      for (const h of heard) row[h] = (row[h] as number) + 1;
    }
  }

  const matching = bestMatching(together);
  let agreeing = 0;
  matching.forEach((h, r) => {
    if (h >= 0) agreeing += (together[r] as number[])[h] as number;
  });
  const confusion = overlap - agreeing;
  const seconds = (count: number) => count / FRAMES_PER_SECOND;
  const total = seconds(speech);
  return {
    speech: total,
    missed: seconds(missed),
    falseAlarm: seconds(falseAlarm),
    confusion: seconds(confusion),
    rate: speech === 0 ? 0 : (missed + falseAlarm + confusion) / speech,
    collar,
  };
}

/** Several recordings' errors added up, as md-eval reports a set: long recordings count for more. */
export function totalDer(parts: readonly Der[]): Der {
  const sum = (pick: (der: Der) => number) => parts.reduce((total, der) => total + pick(der), 0);
  const speech = sum((der) => der.speech);
  const missed = sum((der) => der.missed);
  const falseAlarm = sum((der) => der.falseAlarm);
  const confusion = sum((der) => der.confusion);
  return {
    speech,
    missed,
    falseAlarm,
    confusion,
    rate: speech === 0 ? 0 : (missed + falseAlarm + confusion) / speech,
    collar: parts[0]?.collar ?? DEFAULT_COLLAR,
  };
}
