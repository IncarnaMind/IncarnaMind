import type { ChooseRecordCiteSourceInput, RecordCiteResult } from "../../../core/api";
import { formatLocation, type Translate } from "../../../shared/locations";
import { core } from "../core";

interface DocumentName {
  id: string;
  name: string;
}

export interface RecordCiteCandidateOption {
  id: string;
  label: string;
  detail?: string;
  data: Record<string, string>;
}

export function recordCiteDocumentName(
  cite: Pick<RecordCiteResult, "documentId" | "documentName" | "contentHash">,
  documents: readonly DocumentName[],
): string | undefined {
  const current = cite.documentId
    ? documents.find((document) => document.id === cite.documentId)?.name
    : undefined;
  return current ?? cite.documentName;
}

export function recordCiteCandidateOptions(
  cite: RecordCiteResult,
  documents: readonly DocumentName[],
  t: Translate,
): RecordCiteCandidateOption[] {
  const location = cite.location ? formatLocation(cite.location, t) : "";
  return (cite.candidates ?? []).map((candidate) => ({
    id: candidate.id,
    label: documents.find((document) => document.id === candidate.id)?.name ?? candidate.name,
    ...(candidate.detail || location ? { detail: candidate.detail ?? location } : {}),
    data: { "data-document-id": candidate.id },
  }));
}

export async function chooseRecordCite(
  input: ChooseRecordCiteSourceInput,
): Promise<RecordCiteResult> {
  return (await core.chooseRecordCiteSource(input)).cite;
}
