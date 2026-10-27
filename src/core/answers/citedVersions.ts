/**
 * Which versions of which Documents the Citations in Minds and conversations
 * quote, for the garbage collection of old versions' text (see
 * `collectOldVersions` in ../documents), and which of their Units, for the text
 * kept when a Linked folder is unlinked. Citations live in Minds' Yjs documents,
 * anywhere: in Answers, or copied into Notes, at any depth (exports read them
 * the same way, ../mindText), and with each value of a chart (#436), which
 * keeps the Citation it was charted with; and in the Answers of the
 * assistant's conversations (ADR-0017).
 */
import * as Y from "yjs";
import { readChartData } from "../../shared/charts";
import { calculatedFiguresIn, figureRunsFor } from "../../shared/figureRuns";
import {
  CHART_NODE,
  CITATION_NODE,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_SETTINGS_FIELD,
} from "../api";
import { readContentVersion } from "../mindAccess";
import { nodeOf, topLevelBlocks } from "./blocks";

/**
 * What a Citation's check reads: the stored text of one version of a
 * Document, Units `pageFrom` to `pageTo` (see `pageTexts` in ../documents).
 */
export interface CitedUnits {
  documentId: string;
  /** The version it quotes; null for a Citation that doesn't say, which means every version. */
  contentHash: string | null;
  /** The cited Units, from 1; both null for a whole TXT or Markdown file, cited before Units: all of them. */
  pageFrom: number | null;
  pageTo: number | null;
}

/** A Citation's attributes, wherever they are kept: on a node in a Mind, or with an Answer of a conversation. */
export type CitationFields = Readonly<Record<string, unknown>>;

const unitNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;

/** Adds the Units one Citation points to to `cited`, if it is of one of these Documents. */
export function addCitedUnit(
  citation: CitationFields,
  documentIds: ReadonlySet<string>,
  cited: CitedUnits[],
): void {
  const { documentId, contentHash } = citation;
  if (typeof documentId !== "string" || !documentIds.has(documentId)) return;
  const from = unitNumber(citation.pageFrom);
  // Without a first Unit, it points at all of them.
  const to = from === null ? null : (unitNumber(citation.pageTo) ?? from);
  cited.push({
    documentId,
    contentHash: typeof contentHash === "string" && contentHash !== "" ? contentHash : null,
    pageFrom: from === null || to === null ? null : Math.min(from, to),
    pageTo: from === null || to === null ? null : Math.max(from, to),
  });
}

function chartCitations(chart: Y.XmlElement): CitationFields[] {
  return readChartData(chart.getAttribute("data")).rows.flatMap((row) =>
    row.values.flatMap((value) =>
      value?.citation ? [value.citation as unknown as CitationFields] : [],
    ),
  );
}

export function figureCitations(fragment: Y.XmlFragment | Y.XmlElement): CitationFields[] {
  if (
    fragment.doc &&
    readContentVersion(fragment.doc.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY)) >
      CONTENT_SCHEMA_VERSION
  )
    return [];
  const blocks =
    fragment instanceof Y.XmlElement ? [nodeOf(fragment)] : topLevelBlocks(fragment).map(nodeOf);
  const figures = calculatedFiguresIn(blocks);
  const inputs = figures.flatMap(({ figure }) => figure.inputs);
  const cited: CitationFields[] = [];
  if (fragment.doc) {
    for (const run of figureRunsFor(fragment.doc, blocks)) {
      for (const input of run.inputs) {
        if (input.kind === "figure") inputs.push(input.input);
        else cited.push({ ...input.citation });
      }
    }
  }
  for (const input of inputs) {
    cited.push({ ...input.citation });
    if (input.unitStatement) cited.push({ ...input.unitStatement.citation });
  }
  return cited;
}

/** Adds the Units that the Citations under `fragment` point to in these Documents to `cited`. */
export function addCitedUnits(
  fragment: Y.XmlFragment | Y.XmlElement,
  documentIds: ReadonlySet<string>,
  cited: CitedUnits[],
): void {
  eachCitation(fragment, (citation) => addCitedUnit(citation, documentIds, cited), {
    charts: true,
  });
  for (const citation of figureCitations(fragment)) addCitedUnit(citation, documentIds, cited);
}

/** The versions Citations quote: each Document's cited content hashes, or "any" for every version. */
export type CitedVersions = Map<string, Set<string> | "any">;

/** Adds the version one Citation quotes to `cited`. */
export function addCitedVersion(citation: CitationFields, cited: CitedVersions): void {
  const { documentId, contentHash } = citation;
  if (typeof documentId !== "string" || documentId === "") return;
  const versions = cited.get(documentId);
  // A Citation that doesn't say which version it quotes keeps every version.
  if (typeof contentHash !== "string" || contentHash === "") cited.set(documentId, "any");
  else if (versions === undefined) cited.set(documentId, new Set([contentHash]));
  else if (versions !== "any") versions.add(contentHash);
}

/** Adds the versions the Citations under `fragment` quote to `cited`. */
export function addCitedVersions(fragment: Y.XmlFragment | Y.XmlElement, cited: CitedVersions) {
  eachCitation(fragment, (citation) => addCitedVersion(citation, cited), { charts: true });
  for (const citation of figureCitations(fragment)) addCitedVersion(citation, cited);
}

/** Calls `visit` with each Citation's attributes under `fragment`, at any depth, in order; `charts`: a chart's values' too. */
export function eachCitation(
  fragment: Y.XmlFragment | Y.XmlElement,
  visit: (citation: CitationFields) => void,
  { charts = false }: { charts?: boolean } = {},
): void {
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === CITATION_NODE) visit(child.getAttributes());
    else if (charts && child.nodeName === CHART_NODE)
      for (const each of chartCitations(child)) visit(each);
    else eachCitation(child, visit, { charts });
  }
}

/** Whether a Citation in `cited` quotes this version of this Document. */
export function isCited(cited: CitedVersions, documentId: string, contentHash: string): boolean {
  const versions = cited.get(documentId);
  return versions === "any" || (versions?.has(contentHash) ?? false);
}
