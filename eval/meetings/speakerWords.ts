import { type ErrorRate, editDistance } from "../transcription/scoring";
import { bestMatching } from "./der";
import type { Hypothesis } from "./types";

type Segments = Readonly<Hypothesis["segments"]>;

export function speakerErrorRate(
  reference: Segments,
  hypothesis: Segments,
  split: (text: string) => string[],
): ErrorRate | null {
  function streams(segments: Segments) {
    const speakers = new Map<string | undefined, string[]>();
    for (const { speaker, text } of segments) {
      const stream = speakers.get(speaker);
      if (stream) stream.push(text);
      else speakers.set(speaker, [text]);
    }
    return new Map([...speakers].map(([speaker, texts]) => [speaker, split(texts.join(" "))]));
  }

  const ref = [...streams(reference).values()];
  const bySpeaker = streams(hypothesis);
  const hyp = [...bySpeaker.values()];
  const total = ref.reduce((sum, units) => sum + units.length, 0);
  const heard = hyp.reduce((sum, units) => sum + units.length, 0);
  if (heard > 0 && bySpeaker.get(undefined)?.length === heard) return null;

  // Start with every reference unit deleted and every hypothesis unit inserted.
  // Pair speakers once per recording to save the most edits, including unequal speaker counts.
  const savings = ref.map((r) => hyp.map((h) => r.length + h.length - editDistance(r, h)));
  const saved = bestMatching(savings).reduce(
    (sum, column, row) => sum + (savings[row]?.[column] ?? 0),
    0,
  );
  const errors = total + heard - saved;
  return { total, errors, rate: total === 0 ? 0 : errors / total };
}
