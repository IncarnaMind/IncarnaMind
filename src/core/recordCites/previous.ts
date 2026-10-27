import type { RecordCitePlace, RecordCiteSentence } from "../../shared/recordCiteChoices";
import { scanRecordCites } from "./parser";

export function hasImmediateRecordCitePrevious(
  sentences: readonly RecordCiteSentence[],
  previous: RecordCitePlace | undefined,
  current: RecordCitePlace | undefined,
): boolean {
  if (!previous || !current || previous.citeFrom === undefined) return false;
  const before = sentences.findIndex(
    (sentence) =>
      sentence.place.blockId === previous.blockId && sentence.place.from === previous.from,
  );
  const now = sentences.findIndex(
    (sentence) =>
      sentence.place.blockId === current.blockId && sentence.place.from === current.from,
  );
  if (before < 0 || now < 0 || before >= now) return false;
  const earlier = sentences[before];
  if (!earlier) return false;
  const last = scanRecordCites(earlier.text, { hasPrevious: true }).at(-1);
  if (last?.from !== previous.citeFrom) return false;
  return !sentences
    .slice(before + 1, now)
    .some((sentence) => scanRecordCites(sentence.text, { hasPrevious: true }).length > 0);
}
