import { readFigures } from "../../../shared/figures";
import { readStatedPeriods } from "../../../shared/statedPeriods";
import { normaliseText, normaliseWithOffsets } from "../../../shared/text";
import type { CitationAttributes, ClaimFacet, ClaimPartSpan } from "../../api";

type NamedSource = { id: string; name: string };

export interface SourceAttributionInput {
  words: string;
  sourceName: string;
  selectedDocumentId?: string;
  documents: readonly (NamedSource & { title?: string | null })[];
  evidence: readonly CitationAttributes[];
}

export interface SourceAttribution {
  facet: Extract<ClaimFacet, { kind: "source" }>;
  outcome: "ambiguous" | "missing" | "other" | "choose-again" | null;
  candidates: NamedSource[];
  document: NamedSource | null;
  named?: ClaimPartSpan;
}

const titleKey = (name: string) => normaliseText(name).toLocaleLowerCase();

const TOKEN_START = /^[\p{Script=Latin}\p{N}]/u;
const TOKEN_END = /[\p{Script=Latin}\p{N}]\p{M}*$/u;

function* sourceNamesIn(words: string, name: string): Generator<ClaimPartSpan> {
  const key = titleKey(name);
  if (key.length === 0) return;
  const normalized = normaliseWithOffsets(words);
  const text = normalized.text.toLocaleLowerCase();
  const offsets = normalized.units
    .filter((unit) => !unit.removed)
    .flatMap((unit) => Array.from({ length: unit.char.toLocaleLowerCase().length }, () => unit));
  if (offsets.length !== text.length) return;
  for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + 1)) {
    const first = offsets[at];
    const last = offsets[at + key.length - 1];
    if (!first || !last) continue;
    const before = offsets[at - 1];
    const after = offsets[at + key.length];
    if (
      (before?.start === first.start && before.end === first.end) ||
      (after?.start === last.start && after.end === last.end)
    )
      continue;
    if (TOKEN_START.test(key) && TOKEN_END.test(words.slice(0, first.start))) continue;
    if (TOKEN_END.test(key) && TOKEN_START.test(words.slice(last.end))) continue;
    yield { start: first.start, end: last.end };
  }
}

export function sourceNameIn(words: string, name: string): boolean {
  return sourceNamesIn(words, name).next().done === false;
}

export function sourceNameSpan(words: string, name: string): ClaimPartSpan | null {
  const matches = [...sourceNamesIn(words, name)];
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function sourceDetailsIn(words: string, fields: readonly string[]): boolean {
  const numbers = readFigures(words, { dates: true, midLine: true });
  const stated = fields.flatMap((field) => readFigures(field, { dates: true, midLine: true }));
  if (numbers.some((number) => number.ambiguous.length > 0)) return false;
  if (
    !numbers.every((number) =>
      stated.some(
        (found) =>
          found.ambiguous.length === 0 &&
          found.value === number.value &&
          found.rangeTo === number.rangeTo &&
          JSON.stringify(found.unit) === JSON.stringify(number.unit),
      ),
    )
  )
    return false;
  const periods = readStatedPeriods(normaliseText(words));
  const statedPeriods = fields.flatMap((field) => readStatedPeriods(normaliseText(field)));
  return periods.every((period) =>
    statedPeriods.some(
      (found) =>
        found.start === period.start &&
        found.end === period.end &&
        found.precision === period.precision,
    ),
  );
}

export function sourceAttribution(input: SourceAttributionInput): SourceAttribution | null {
  const named = sourceNameSpan(input.words, input.sourceName);
  if (!named) return null;
  const name = titleKey(input.sourceName);
  const candidates = input.documents
    .filter((document) => titleKey(document.name) === name)
    .map(({ id, name }) => ({ id, name }));
  const facet: SourceAttribution["facet"] = { kind: "source" };
  let document: NamedSource | undefined;
  if (input.selectedDocumentId !== undefined) {
    document = candidates.find((candidate) => candidate.id === input.selectedDocumentId);
    if (!document) return { named, facet, outcome: "choose-again", candidates, document: null };
    facet.selectedDocumentId = document.id;
  } else {
    if (candidates.length > 1)
      return { named, facet, outcome: "ambiguous", candidates, document: null };
    if (candidates.length === 1) document = candidates[0];
    else {
      if (input.evidence.length === 0)
        return { named, facet, outcome: "missing", candidates, document: null };
      const ids = new Set(input.evidence.map((citation) => citation.documentId));
      if (
        ids.size !== 1 ||
        input.evidence.some((citation) => citation.check !== "found" || !citation.quote?.trim())
      )
        return null;
      const bound = input.documents.find((candidate) => ids.has(candidate.id));
      if (!bound) return null;
      document = { id: bound.id, name: bound.name };
      const quotes = input.evidence.flatMap((citation) => (citation.quote ? [citation.quote] : []));
      if (
        !sourceDetailsIn(input.words, [
          document.name,
          ...(bound.title ? [bound.title] : []),
          ...quotes,
        ])
      )
        return { named, facet, outcome: "other", candidates, document };
    }
  }
  if (!document) return { named, facet, outcome: "missing", candidates, document: null };
  const chosenId = document.id;
  const wrong = input.evidence.find((citation) => citation.documentId !== chosenId);
  if (wrong) {
    const actual = input.documents.find((candidate) => candidate.id === wrong.documentId);
    return {
      named,
      facet,
      outcome: "other",
      candidates,
      document: actual ? { id: actual.id, name: actual.name } : null,
    };
  }
  return { named, facet, outcome: null, candidates, document };
}
