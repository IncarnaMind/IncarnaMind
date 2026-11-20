import {
  lineKey,
  numberedVoice,
  partsOf,
  SPEAKER_ME,
  SPEAKER_UNKNOWN,
  speakerOf,
} from "../../shared/speakers";
import type { VoiceTurn } from "../adapters";
import type { MeetingSpeakerSuggestion, TranscriptSpeakers } from "../api";
import type { Cue } from "../documents/formats/vtt";
import { matchReviewVoices } from "./reviewSuggestions";
import { isCall } from "./speakerPass";

export function roomReviewLines(cues: readonly Cue[], speakers: TranscriptSpeakers | null) {
  const parts = cues.flatMap((cue) =>
    cue.speaker ? partsOf(speakers, { ...cue, label: cue.speaker }) : [],
  );
  const known = new Set(parts.map((part) => speakerOf(speakers, part.startMs, part.label)));
  known.delete(SPEAKER_UNKNOWN);
  const reason = isCall(cues) ? "transcript" : known.size > 4 ? "people" : null;
  return { parts, known, reason } as const;
}

export function roomReviewSuggestions(
  lines: ReturnType<typeof roomReviewLines>,
  speakers: TranscriptSpeakers | null,
  turns: readonly VoiceTurn[],
): MeetingSpeakerSuggestion[] | null {
  const { parts, known } = lines;
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  const rows = parts
    .flatMap((part) => {
      const key = lineKey(part.startMs, part.label);
      if (seen.has(key)) ambiguous.add(key);
      seen.add(key);
      const current = speakerOf(speakers, part.startMs, part.label);
      const duration = part.endMs - part.startMs;
      const shared = new Map<number, number>();
      for (const turn of turns) {
        const ms = Math.min(part.endMs, turn.endMs) - Math.max(part.startMs, turn.startMs);
        if (ms > 0) shared.set(turn.voice, (shared.get(turn.voice) ?? 0) + ms);
      }
      const [best, next] = [...shared].sort((a, b) => b[1] - a[1]);
      // A silent gap or two voices covering the same line offer no reliable correction.
      if (!best || best[1] <= duration / 2 || (next && next[1] > duration * 0.2)) return [];
      return [{ part, key, voice: numberedVoice(best[0] + 1), current, coveredMs: best[1] }];
    })
    .filter((row) => !ambiguous.has(row.key));
  const mapping = matchReviewVoices(rows.filter((row) => known.has(row.current)));
  if (!rows.length || mapping.size !== known.size) return null;
  const reserved = new Set([...known, ...Object.keys(speakers?.labels ?? {})]);
  let number = 1;
  for (const { voice } of rows) {
    if (mapping.has(voice)) continue;
    while (reserved.has(numberedVoice(number))) number++;
    mapping.set(voice, numberedVoice(number++));
  }
  return rows.flatMap(({ part, voice, current }) => {
    const suggested = mapping.get(voice);
    return suggested && suggested !== current && suggested !== SPEAKER_ME && current !== SPEAKER_ME
      ? [
          {
            startMs: part.startMs,
            endMs: part.endMs,
            text: part.text,
            fileLabel: part.label,
            currentLabel: current,
            suggestedLabel: suggested,
          },
        ]
      : [];
  });
}
