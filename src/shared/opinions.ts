import type * as Y from "yjs";
import {
  type ClaimCheckPart,
  type ClaimPartSpan,
  MIND_SETTINGS_FIELD,
  type OpinionSentence,
} from "../core/api";
import { readClaimParts } from "./claimParts";

const KEY = "opinionSentences";
export type OpinionLocation = Pick<OpinionSentence, "blockId" | "text" | "occurrence">;
export type OpinionOwner = OpinionLocation & { id: string; parts?: readonly ClaimCheckPart[] };
export type OmittedOpinion<T extends OpinionLocation = OpinionLocation> = T & {
  id: string;
  span: ClaimPartSpan;
  part: ClaimCheckPart;
};

const identity = (sentence: OpinionLocation) =>
  JSON.stringify([sentence.blockId, sentence.text, sentence.occurrence]);

function readSentences(value: unknown): OpinionSentence[] {
  if (!Array.isArray(value)) return [];
  const entries: OpinionSentence[] = [];
  const ids = new Set<string>();
  const locations = new Set<string>();
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof entry.blockId !== "string" ||
      !entry.blockId ||
      typeof entry.text !== "string" ||
      typeof entry.occurrence !== "number" ||
      !Number.isInteger(entry.occurrence) ||
      entry.occurrence < 0
    )
      continue;
    const parts = readClaimParts(entry.parts, entry.text);
    if (!parts?.length || parts.some((part) => part.kind !== "opinion" || part.verdict !== null))
      continue;
    const sentence = {
      id: entry.id,
      blockId: entry.blockId,
      text: entry.text,
      occurrence: entry.occurrence,
      parts,
    };
    const key = identity(sentence);
    if (ids.has(sentence.id) || locations.has(key)) continue;
    ids.add(sentence.id);
    locations.add(key);
    entries.push(sentence);
  }
  return entries;
}

export function readOpinionSentences(doc: Y.Doc): OpinionSentence[] {
  return readSentences(doc.getMap(MIND_SETTINGS_FIELD).get(KEY));
}

export function writeOpinionSentences<T extends OpinionSentence>(
  doc: Y.Doc,
  sentences: readonly T[],
): void {
  const valid = readSentences(sentences);
  if (valid.length !== sentences.length)
    throw new Error("An opinion inventory must contain distinct omitted-opinion sentences.");
  const settings = doc.getMap(MIND_SETTINGS_FIELD);
  const previous = settings.get(KEY);
  if (previous === undefined && valid.length === 0) return;
  const current = readSentences(previous);
  if (
    Array.isArray(previous) &&
    previous.length === current.length &&
    JSON.stringify(current) === JSON.stringify(valid)
  )
    return;
  settings.set(KEY, valid);
}

export function resolveOpinions<T extends OpinionLocation>(
  current: readonly T[],
  stored: readonly OpinionSentence[],
): (T & OpinionSentence)[] {
  const byLocation = new Map(readSentences(stored).map((entry) => [identity(entry), entry]));
  const seen = new Set<string>();
  return current.flatMap((sentence) => {
    const entry = byLocation.get(identity(sentence));
    if (!entry || seen.has(entry.id)) return [];
    seen.add(entry.id);
    return [{ ...sentence, ...entry }];
  });
}

export function omittedOpinions<T extends OpinionLocation>(
  current: readonly T[],
  marks: readonly OpinionOwner[],
  stored: readonly OpinionSentence[],
): OmittedOpinion<T>[] {
  const marked = new Map(marks.map((mark) => [identity(mark), mark]));
  const unmarked = new Map(
    resolveOpinions(current, stored).map((entry) => [identity(entry), entry]),
  );
  const seen = new Set<string>();
  return current.flatMap((sentence) => {
    const key = identity(sentence);
    if (seen.has(key)) return [];
    seen.add(key);
    const owner = marked.get(key) ?? unmarked.get(key);
    if (!owner?.parts) return [];
    const parts = readClaimParts(owner.parts, sentence.text, "checking");
    if (!parts) return [];
    return parts.flatMap((part) =>
      part.kind === "opinion" && part.verdict === null
        ? [{ ...sentence, id: owner.id, span: { ...part.span }, part }]
        : [],
    );
  });
}
