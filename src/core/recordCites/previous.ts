import { citedCases } from "../../shared/caseCitations";
import type {
  RecordCiteChoice,
  RecordCitePlace,
  RecordCiteSentence,
} from "../../shared/recordCiteChoices";
import { scanRecordCites } from "./parser";
import type { RecordCiteDocument, RecordCiteHistoryItem, ResolveDeposition } from "./resolver";
import { resolveRecordCites } from "./resolver";

export interface DerivedRecordCiteHistory {
  previous: RecordCiteChoice | null;
  history: RecordCiteHistoryItem[];
}

const empty: DerivedRecordCiteHistory = { previous: null, history: [] };

const choiceOf = (item: RecordCiteHistoryItem): RecordCiteChoice => ({
  documentId: item.document.id,
  contentHash: item.document.contentHash,
  location: item.location,
});

export function deriveRecordCiteHistory(
  sentences: readonly RecordCiteSentence[],
  current: RecordCitePlace | undefined,
  currentClaim: string,
  documents: readonly RecordCiteDocument[],
  choices: Record<string, RecordCiteChoice>,
  resolveDeposition?: ResolveDeposition,
): DerivedRecordCiteHistory {
  const positioned = current
    ? sentences.findIndex(
        (sentence) =>
          sentence.place.blockId === current.blockId && sentence.place.from === current.from,
      )
    : -1;
  const matches =
    positioned >= 0
      ? []
      : sentences.flatMap((sentence, index) => (sentence.text === currentClaim ? [index] : []));
  const now = positioned >= 0 ? positioned : matches.length === 1 ? (matches[0] ?? -1) : -1;
  if (now < 0) return empty;

  let previous: RecordCiteChoice | null = null;
  let history: RecordCiteHistoryItem[] = [];
  for (const sentence of sentences.slice(0, now)) {
    const decisions = citedCases(sentence.text);
    if (decisions.length > 0) {
      previous = null;
      history = [];
    }
    const occurrences = recordOccurrences(sentence.text, previous !== null);
    if (occurrences.length === 0) continue;
    const resolved = resolveRecordCites({
      cites: occurrences,
      documents,
      choices: { previous, choices },
      history,
      resolveDeposition,
    });
    const lastDecision = decisions.at(-1);
    const afterDecision = lastDecision
      ? resolved.filter((result) => (result.from ?? -1) > lastDecision.from)
      : resolved;
    const resolvedItems = afterDecision.flatMap((result) => {
      if (result.outcome !== "found" || !result.documentId || !result.location) return [];
      const document = documents.find((each) => each.id === result.documentId);
      return document ? [{ document, location: result.location }] : [];
    });
    const last = afterDecision.at(-1);
    if (last?.outcome !== "found") {
      previous = null;
    } else {
      history = lastDecision ? resolvedItems : [...history, ...resolvedItems];
      const lastHistory = history.at(-1);
      previous = lastHistory ? choiceOf(lastHistory) : null;
    }
  }
  return { previous, history };
}

const recordOccurrences = (claim: string, hasPrevious: boolean) =>
  scanRecordCites(claim, { hasPrevious }).map((occurrence) => ({
    ...occurrence.result,
    raw: occurrence.raw,
    from: occurrence.from,
    to: occurrence.to,
  }));
