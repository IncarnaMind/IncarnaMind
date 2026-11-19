import type { VoiceTurn } from "../../src/core/adapters";
import type { Cue } from "../../src/core/documents/formats/vtt";
import { speakerLabels } from "../../src/core/meetings/speakerPass";
import {
  numberedVoice,
  partsOf,
  SPEAKER_THEM,
  SPEAKER_UNKNOWN,
  speakerOf,
} from "../../src/shared/speakers";
import type { Hypothesis } from "../meetings/types";

export function transcriptCues(hypothesis: Hypothesis, call: boolean, untilSeconds: number): Cue[] {
  const untilMs = untilSeconds * 1000;
  const cues = hypothesis.segments
    .filter((segment) => segment.start < untilSeconds)
    .flatMap((segment) => {
      const cutoff =
        segment.end > untilSeconds ? segment.words?.find((word) => word.ms >= untilMs) : undefined;
      const words = cutoff ? segment.words?.filter((word) => word.at < cutoff.at) : segment.words;
      const text = cutoff ? segment.text.slice(0, cutoff.at).trimEnd() : segment.text;
      if (cutoff && !text) return [];
      return [
        {
          startMs: Math.round(segment.start * 1000),
          endMs: Math.round(Math.min(segment.end, untilSeconds) * 1000),
          text,
          speaker: segment.speaker ?? (call ? SPEAKER_THEM : SPEAKER_UNKNOWN),
          ...(words?.length && { words }),
        },
      ];
    });
  const providerLabel = call ? /^system:/ : /^(?:room|conversation):/;
  const numbers = new Map<string, number>();
  for (const { speaker } of cues) {
    if (providerLabel.test(speaker) && !numbers.has(speaker))
      numbers.set(speaker, numbers.size + 1);
  }
  for (const cue of cues) {
    const number = numbers.get(cue.speaker);
    if (number !== undefined)
      cue.speaker = call && numbers.size === 1 ? SPEAKER_THEM : numberedVoice(number);
  }
  return cues;
}

export function afterCallLines(cues: readonly Cue[], turns: readonly VoiceTurn[], call: boolean) {
  const labels = speakerLabels(cues, turns, call);
  return cues.flatMap((cue) => {
    const line = { ...cue, label: cue.speaker ?? SPEAKER_UNKNOWN };
    return partsOf(labels, line).map((part) => ({
      startMs: part.startMs,
      endMs: part.endMs,
      text: part.text,
      speaker: speakerOf(labels, part.startMs, part.label),
    }));
  });
}
