import { normaliseText, normaliseWithOffsets } from "../../../shared/text";
import type { CitationAttributes, ClaimFacet } from "../../api";

type NamedSource = { id: string; name: string };

export interface SourceAttributionInput {
  words: string;
  sourceName: string;
  selectedDocumentId?: string;
  documents: readonly NamedSource[];
  evidence: readonly CitationAttributes[];
}

export interface SourceAttribution {
  facet: Extract<ClaimFacet, { kind: "source" }>;
  outcome: "ambiguous" | "missing" | "other" | "choose-again" | null;
  candidates: NamedSource[];
  document: NamedSource | null;
}

const titleKey = (name: string) => normaliseText(name).toLocaleLowerCase();

const TOKEN_START = /^[\p{Script=Latin}\p{N}]/u;
const TOKEN_END = /[\p{Script=Latin}\p{N}]\p{M}*$/u;

export function sourceNameIn(words: string, name: string): boolean {
  const key = titleKey(name);
  if (key.length === 0) return false;
  const normalized = normaliseWithOffsets(words);
  const text = normalized.text.toLocaleLowerCase();
  const offsets = normalized.units
    .filter((unit) => !unit.removed)
    .flatMap((unit) => Array.from({ length: unit.char.toLocaleLowerCase().length }, () => unit));
  if (offsets.length !== text.length) return false;
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
    return true;
  }
  return false;
}

export function sourceAttribution(input: SourceAttributionInput): SourceAttribution | null {
  if (!sourceNameIn(input.words, input.sourceName)) return null;
  const name = titleKey(input.sourceName);
  const candidates = input.documents
    .filter((document) => titleKey(document.name) === name)
    .map(({ id, name }) => ({ id, name }));
  const facet: SourceAttribution["facet"] = { kind: "source" };
  let document: NamedSource | undefined;
  if (input.selectedDocumentId !== undefined) {
    document = candidates.find((candidate) => candidate.id === input.selectedDocumentId);
    if (!document) return { facet, outcome: "choose-again", candidates, document: null };
    facet.selectedDocumentId = document.id;
  } else {
    if (candidates.length !== 1)
      return {
        facet,
        outcome: candidates.length > 1 ? "ambiguous" : "missing",
        candidates,
        document: null,
      };
    document = candidates[0];
  }
  if (!document) return { facet, outcome: "missing", candidates, document: null };
  const chosenId = document.id;
  const wrong = input.evidence.find((citation) => citation.documentId !== chosenId);
  if (wrong) {
    const actual = input.documents.find((candidate) => candidate.id === wrong.documentId);
    return {
      facet,
      outcome: "other",
      candidates,
      document: actual ? { id: actual.id, name: actual.name } : null,
    };
  }
  return { facet, outcome: null, candidates, document };
}
