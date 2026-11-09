/**
 * Voices clustered apart joined by voiceprint (#138): the windows of a long recording, and during
 * a call what was recorded so far with what came after it (#2839).
 */
import type { ClusteredVoices, VoiceTurn } from "../adapters";

/**
 * Voices whose voiceprints are at least this alike are taken for one person afterwards: over a
 * long meeting the engine's clustering splits people into several voices.
 */
export const SAME_PERSON = 0.6;
/** A voice with less of the speech than this is someone else's stray stretch: it joins the voice most like it. */
const STRAY_SHARE = 0.02;
/**
 * The engine clusters at most this much audio at once; a longer recording is cut into windows
 * whose voices are then joined by voiceprint. Its clustering compares every stretch with every
 * other, so its memory grows with the square of the length: 2.1 GB for two hours at once.
 */
export const WINDOW_SECONDS = 60 * 60;

const cosine = (a: Float32Array, b: Float32Array) => {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
};

interface Group {
  ids: number[];
  print: Float32Array;
  seconds: number;
}

function join(into: Group, from: Group): void {
  const total = into.seconds + from.seconds || 1;
  into.print = into.print.map(
    (value, i) => (value * into.seconds + (from.print[i] ?? 0) * from.seconds) / total,
  );
  into.seconds += from.seconds;
  into.ids.push(...from.ids);
}

/**
 * Which voice each voice becomes once alike voices are one person: the two most alike join
 * while they are at least `samePerson` alike; then each voice with less than `STRAY_SHARE` of
 * the speech joins the voice most like it.
 */
export function joinedVoices(
  voices: ReadonlyMap<number, { print: Float32Array; seconds: number }>,
  samePerson = SAME_PERSON,
): Map<number, number> {
  let groups: Group[] = [...voices].map(([id, voice]) => ({
    ids: [id],
    print: Float32Array.from(voice.print),
    seconds: voice.seconds,
  }));
  for (;;) {
    let best: { into: Group; from: Group; alike: number } | null = null;
    for (const [at, a] of groups.entries()) {
      for (const b of groups.slice(at + 1)) {
        const alike = cosine(a.print, b.print);
        if (alike >= samePerson && (!best || alike > best.alike))
          best = { into: a, from: b, alike };
      }
    }
    if (!best) break;
    join(best.into, best.from);
    const gone = best.from;
    groups = groups.filter((group) => group !== gone);
  }
  const speech = groups.reduce((sum, group) => sum + group.seconds, 0);
  const kept = groups.filter((group) => group.seconds >= STRAY_SHARE * speech);
  for (const stray of groups.filter((group) => !kept.includes(group))) {
    const nearest = kept.reduce<Group | null>(
      (most, group) =>
        !most || cosine(stray.print, group.print) > cosine(stray.print, most.print) ? group : most,
      null,
    );
    if (nearest) join(nearest, stray);
  }
  const joined = new Map<number, number>();
  for (const group of kept.length > 0 ? kept : groups) {
    for (const id of group.ids) joined.set(id, group.ids[0] ?? id);
  }
  return joined;
}

/**
 * The turns of stretches of one recording clustered apart, given in time order, with their
 * voices joined by voiceprint and numbered from 0 in the order first heard. Turns of one voice
 * that meet become one, so a stretch clustered whole gives the turns its windows' join did.
 */
export function joinedTurns(
  stretches: readonly ClusteredVoices[],
  samePerson = SAME_PERSON,
): VoiceTurn[] {
  const voices = new Map<number, { print: Float32Array; seconds: number }>();
  const turns: VoiceTurn[] = [];
  let base = 0;
  for (const stretch of stretches) {
    let most = -1;
    for (const voice of stretch.voices) {
      voices.set(base + voice.voice, { print: voice.print, seconds: voice.seconds });
      most = Math.max(most, voice.voice);
    }
    for (const turn of stretch.turns) {
      turns.push({ ...turn, voice: base + turn.voice });
      most = Math.max(most, turn.voice);
    }
    base += most + 1;
  }
  const joined = joinedVoices(voices, samePerson);
  const order = new Map<number, number>();
  const out: VoiceTurn[] = [];
  for (const turn of turns) {
    const id = joined.get(turn.voice) ?? turn.voice;
    const voice = order.get(id) ?? order.size;
    order.set(id, voice);
    const last = out.at(-1);
    if (last && last.voice === voice && Math.abs(last.endMs - turn.startMs) < 1) {
      last.endMs = turn.endMs;
    } else out.push({ startMs: turn.startMs, endMs: turn.endMs, voice });
  }
  return out;
}
