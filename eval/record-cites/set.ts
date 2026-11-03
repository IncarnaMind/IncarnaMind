import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CitationLocation, DocumentKind, RecordCiteResult } from "../../src/core";
import { depositionMapper } from "../../src/core/documents/deposition";
import { processFile } from "../../src/core/documents/processing";
import { resolverInput, sentenceRecordCites } from "../../src/core/recordCites/referents";
import {
  type RecordCiteDocument,
  type ResolvableRecordCiteResult,
  resolveRecordCites,
} from "../../src/core/recordCites/resolver";
import { normaliseText } from "../../src/shared/text";

export const RECORD_CITE_SET = "eval/record-cites/set.json";

export interface RecordSetDocument {
  key: string;
  name: string;
  title: string;
  publisher: string;
  path: string;
  kind: DocumentKind;
  units: number;
  source?: string;
  fileSource?: string;
  licence: string;
  basis: string;
  retrieved?: string;
  created?: string;
  generated?: boolean;
  sha256: string;
}

export interface ExpectedNearby {
  location: CitationLocation;
  passageContains: string;
}

export interface ExpectedRecordCite {
  raw: string;
  outcome: RecordCiteResult["outcome"];
  document?: string;
  location?: CitationLocation;
  passageContains?: string;
  candidates?: string[];
  nearby?: ExpectedNearby;
  parts?: boolean;
}

export interface RecordSetCase {
  id: string;
  language: "en" | "zh-CN";
  claim: string;
  /**
   * The Note the claim is a sentence of, one paragraph each: then the run checks the Note as the
   * User does, and an `Id.` can refer to a cite in an earlier sentence.
   */
  note?: string[];
  documents: string[];
  cites: ExpectedRecordCite[];
  checked: string;
}

export interface RecordCiteSet {
  set: string;
  version: number;
  documents: RecordSetDocument[];
  cases: RecordSetCase[];
}

export interface RecordSetReport {
  documents: number;
  cases: number;
  cites: number;
  failures: string[];
}

export async function loadRecordCiteSet(root: string): Promise<RecordCiteSet> {
  const parsed: unknown = JSON.parse(await readFile(join(root, RECORD_CITE_SET), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${RECORD_CITE_SET} must hold "documents" and "cases" arrays.`);
  }
  const { documents, cases } = parsed as { documents?: unknown; cases?: unknown };
  if (!Array.isArray(documents) || !Array.isArray(cases)) {
    throw new Error(`${RECORD_CITE_SET} must hold "documents" and "cases" arrays.`);
  }
  return parsed as RecordCiteSet;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const includesText = (text: string | undefined, expected: string | undefined) =>
  expected === undefined ||
  (text !== undefined && normaliseText(text).includes(normaliseText(expected)));

function compareResolved(
  expected: ExpectedRecordCite,
  actual: ResolvableRecordCiteResult | undefined,
  keyOf: (id: string | undefined) => string | undefined,
): string[] {
  if (!actual) return [`${expected.raw}: no result`];
  const failures: string[] = [];
  if (actual.raw !== expected.raw) failures.push(`raw ${actual.raw} instead of ${expected.raw}`);
  if (expected.outcome === "choose") {
    if (actual.outcome !== "choose") failures.push(`${actual.outcome} instead of choose`);
    const candidates = (actual.candidates ?? []).map((candidate) => keyOf(candidate.id)).sort();
    if (!sameJson(candidates, [...(expected.candidates ?? [])].sort())) {
      failures.push(
        `candidates ${candidates.join(", ")} instead of ${expected.candidates?.join(", ")}`,
      );
    }
  } else if (expected.document) {
    if (actual.outcome !== "found") failures.push(`resolution ${actual.outcome} instead of found`);
    if (keyOf(actual.documentId) !== expected.document) {
      failures.push(
        `Document ${keyOf(actual.documentId) ?? "missing"} instead of ${expected.document}`,
      );
    }
    if (expected.location && !sameJson(actual.location, expected.location)) {
      failures.push(
        `Location ${JSON.stringify(actual.location)} instead of ${JSON.stringify(expected.location)}`,
      );
    }
    if (!includesText(actual.passage, expected.passageContains)) {
      failures.push(`Passage does not contain ${expected.passageContains}`);
    }
  } else if (actual.outcome !== "not-found") {
    failures.push(`${actual.outcome} instead of not-found`);
  }
  if (expected.nearby) {
    const { location, passageContains } = expected.nearby;
    // The check judges each nearby candidate in turn; the key names the one that should back it.
    const candidate = (actual.nearbyCandidates ?? []).find((each) =>
      sameJson(each.location, location),
    );
    if (!candidate) failures.push(`no nearby candidate at ${JSON.stringify(location)}`);
    else if (!includesText(candidate.passage, passageContains)) {
      failures.push(`nearby Passage does not contain ${passageContains}`);
    }
  }
  return failures;
}

export async function checkRecordCiteSet(root: string): Promise<RecordSetReport> {
  const set = await loadRecordCiteSet(root);
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);
  if (set.version !== 1) fail(`unknown set version ${set.version}`);
  const ids = new Set<string>();
  for (const document of set.documents) {
    if (ids.has(document.key)) fail(`${document.key}: duplicate Document key`);
    ids.add(document.key);
    if (
      !document.generated &&
      (!document.source?.startsWith("https://") || !document.fileSource?.startsWith("https://"))
    ) {
      fail(`${document.key}: missing public https source`);
    }
    if (document.generated && (document.kind !== "transcript" || !document.created)) {
      fail(`${document.key}: generated test-only material must be a dated Transcript`);
    }
    if (!document.licence || !document.basis || (!document.generated && !document.retrieved)) {
      fail(`${document.key}: missing licence, basis or source date`);
    }
    const bytes = await readFile(join(root, document.path));
    if (sha256(bytes) !== document.sha256) fail(`${document.key}: SHA-256 differs from the file`);
  }

  const documents: RecordCiteDocument[] = [];
  for (const document of set.documents) {
    const processed = await processFile({
      task: "process",
      documentId: document.key,
      kind: document.kind,
      file: join(root, document.path),
    });
    if (processed.outcome !== "ready") {
      fail(`${document.key}: processing ${processed.outcome}`);
      continue;
    }
    if (processed.pages.length !== document.units) {
      fail(`${document.key}: ${processed.pages.length} Units instead of ${document.units}`);
    }
    documents.push({
      id: document.key,
      name: document.name,
      contentHash: document.sha256,
      units: processed.pages,
    });
  }

  const caseIds = new Set<string>();
  for (const test of set.cases) {
    if (caseIds.has(test.id)) fail(`${test.id}: duplicate case id`);
    caseIds.add(test.id);
    if (!test.checked || !test.claim || test.cites.length === 0) {
      fail(`${test.id}: missing claim, cites or second-reader date`);
      continue;
    }
    const note = test.note?.map((text, index) => ({ blockId: `paragraph-${index}`, text }));
    if (note && !note.some((paragraph) => paragraph.text.includes(test.claim))) {
      fail(`${test.id}: the claim is not in its Note`);
    }
    const { cites, own } = sentenceRecordCites(test.claim, undefined, note && (() => note));
    const occurrences = cites.slice(cites.length - own);
    if (occurrences.length !== test.cites.length) {
      fail(`${test.id}: scanner finds ${occurrences.length} cites instead of ${test.cites.length}`);
      continue;
    }
    occurrences.forEach((occurrence, index) => {
      if (test.claim.slice(occurrence.from, occurrence.to) !== occurrence.raw) {
        fail(`${test.id}: ${occurrence.raw} has the wrong span`);
      }
      if (occurrence.raw !== test.cites[index]?.raw) {
        fail(`${test.id}: ${occurrence.raw} is out of raw order`);
      }
    });
    const requested = Array.isArray(test.documents) ? test.documents : [];
    if (requested.length === 0) fail(`${test.id}: no available Documents`);
    if (new Set(requested).size !== requested.length) {
      fail(`${test.id}: duplicate available Document key`);
    }
    const available = requested.flatMap((key) => {
      if (!ids.has(key)) {
        fail(`${test.id}: unknown Document ${key}`);
        return [];
      }
      const document = documents.find((each) => each.id === key);
      return document ? [document] : [];
    });
    const resolved = resolveRecordCites({
      cites: cites.map(resolverInput),
      documents: available,
      choices: {},
      deposition: depositionMapper,
      own,
    }).slice(cites.length - own);
    test.cites.forEach((expected, index) => {
      for (const failure of compareResolved(expected, resolved[index], (id) => id)) {
        fail(`${test.id}/${expected.raw}: ${failure}`);
      }
      if (expected.parts && expected.outcome !== "partly") {
        fail(`${test.id}/${expected.raw}: parts key on ${expected.outcome}`);
      }
    });
  }
  return {
    documents: set.documents.length,
    cases: set.cases.length,
    cites: set.cases.reduce((total, test) => total + test.cites.length, 0),
    failures,
  };
}
