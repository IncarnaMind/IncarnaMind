import type {
  RecordCiteChoice,
  RecordCitePlace,
  RecordCiteSentence,
} from "../../shared/recordCiteChoices";
import { scanRecordCites } from "./parser";

export function hasImmediateRecordCitePrevious(
  sentences: readonly RecordCiteSentence[],
  previous: RecordCiteChoice | null | undefined,
  current: RecordCitePlace | undefined,
  currentClaim?: string,
): boolean {
  const place = previous?.place;
  if (
    !previous ||
    !current ||
    !place ||
    place.citeFrom === undefined ||
    previous.raw === undefined ||
    previous.claim === undefined
  ) {
    return false;
  }
  const before = sentences.findIndex(
    (sentence) => sentence.place.blockId === place.blockId && sentence.place.from === place.from,
  );
  const positioned = sentences.findIndex(
    (sentence) =>
      sentence.place.blockId === current.blockId && sentence.place.from === current.from,
  );
  const matches =
    positioned >= 0 || currentClaim === undefined
      ? []
      : sentences.flatMap((sentence, index) => (sentence.text === currentClaim ? [index] : []));
  const now = positioned >= 0 ? positioned : matches.length === 1 ? (matches[0] ?? -1) : -1;
  if (before < 0 || now < 0 || before >= now) return false;
  const earlier = sentences[before];
  if (!earlier || earlier.text !== previous.claim) return false;
  const last = scanRecordCites(earlier.text, { hasPrevious: true }).at(-1);
  if (last?.from !== place.citeFrom || last.raw !== previous.raw) return false;
  return !sentences
    .slice(before + 1, now)
    .some((sentence) => scanRecordCites(sentence.text, { hasPrevious: true }).length > 0);
}
