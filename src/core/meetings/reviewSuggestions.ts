import { isTheirs, lineKey, partsOf, speakerOf } from "../../shared/speakers";
import type { MeetingSpeakerSuggestion, TranscriptSpeakers } from "../api";
import type { Cue } from "../documents/formats/vtt";
import type { ReviewToken } from "../transcription/cloud/sonioxReview";

const units = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .match(/\p{Script=Han}|[[\p{L}\p{N}]--\p{Script=Han}]+/gv) ?? [];

function wordsAgree(left: string, right: string): boolean {
  const a = units(left);
  const b = units(right);
  if (Math.min(a.length, b.length) < 3) return false;
  const counts = new Map<string, number>();
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);
  let matches = 0;
  for (const word of b) {
    const left = counts.get(word) ?? 0;
    if (left > 0) {
      matches++;
      counts.set(word, left - 1);
    }
  }
  return 2 * matches >= 0.8 * (a.length + b.length);
}

type Span = Pick<ReviewToken, "startMs" | "endMs" | "speaker">;

/** Soniox splits words into pieces. Count a voice once over a span, including its short pauses. */
function voiceSpans(tokens: readonly ReviewToken[]) {
  const spans: Span[] = [];
  for (const { startMs, endMs, speaker } of tokens) {
    const tail = spans.at(-1);
    if (tail?.speaker === speaker && startMs <= tail.endMs + 400) {
      tail.endMs = Math.max(tail.endMs, endMs);
    } else spans.push({ startMs, endMs, speaker });
  }
  return spans;
}

function windowOf<T extends Span>(spans: readonly T[]) {
  let first = 0;
  return (start: number, end: number) => {
    while (first < spans.length && (spans[first]?.endMs ?? 0) < start) first++;
    const hits: T[] = [];
    for (let i = first; i < spans.length; i++) {
      const span = spans[i];
      if (!span || span.startMs > end) break;
      if (span.endMs >= start) hits.push(span);
    }
    return hits;
  };
}

export function reviewSuggestions(
  cues: readonly Cue[],
  speakers: TranscriptSpeakers | null,
  tokens: readonly ReviewToken[],
): MeetingSpeakerSuggestion[] {
  const parts = cues
    .flatMap((cue) =>
      cue.speaker && isTheirs(cue.speaker) ? partsOf(speakers, { ...cue, label: cue.speaker }) : [],
    )
    .sort((a, b) => a.startMs - b.startMs);
  const ordered = tokens.toSorted((a, b) => a.startMs - b.startMs);
  const spans = windowOf(voiceSpans(ordered));
  const words = windowOf(ordered);
  const anchors = new Map<string, Map<string, number>>();
  const keys = new Set<string>();
  const duplicates = new Set<string>();
  const candidates = [];
  for (const part of parts) {
    const key = lineKey(part.startMs, part.label);
    if (keys.has(key)) duplicates.add(key);
    keys.add(key);
    const current = speakerOf(speakers, part.startMs, part.label);
    if (!isTheirs(current)) continue;
    const byVoice = new Map<string, number>();
    for (const span of spans(part.startMs, part.endMs)) {
      const ms = Math.min(span.endMs, part.endMs) - Math.max(span.startMs, part.startMs);
      if (ms > 0) byVoice.set(span.speaker, (byVoice.get(span.speaker) ?? 0) + ms);
    }
    for (const [voice, ms] of byVoice) {
      const totals = anchors.get(voice) ?? new Map<string, number>();
      totals.set(current, (totals.get(current) ?? 0) + ms);
      anchors.set(voice, totals);
    }
    const [best, runner] = [...byVoice].sort((a, b) => b[1] - a[1]);
    const duration = part.endMs - part.startMs;
    if (!best || duration <= 0 || best[1] < 0.75 * duration || (runner?.[1] ?? 0) > 0.15 * duration)
      continue;
    const from = part.startMs - 120;
    const to = part.endMs + 120;
    const heard = words(from, to).filter((token) => {
      const middle = (token.startMs + token.endMs) / 2;
      return token.speaker === best[0] && middle >= from && middle <= to;
    });
    if (wordsAgree(part.text, heard.map((token) => token.text).join(""))) {
      candidates.push({ part, key, current, voice: best[0] });
    }
  }
  // Speaker numbers are local to each transcription. Pair only voices with a clear, mutual anchor.
  const mapping = new Map<string, string>();
  const weights = [...anchors].flatMap(([voice, totals]) =>
    [...totals].map(([label, ms]) => ({ voice, label, ms })),
  );
  for (const pair of weights) {
    if (
      !weights.some(
        (other) =>
          other !== pair &&
          (other.voice === pair.voice || other.label === pair.label) &&
          other.ms >= pair.ms * 0.9,
      )
    ) {
      mapping.set(pair.voice, pair.label);
    }
  }
  return candidates.flatMap(({ part, key, current, voice }) => {
    const suggested = mapping.get(voice);
    return suggested && suggested !== current && !duplicates.has(key)
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
