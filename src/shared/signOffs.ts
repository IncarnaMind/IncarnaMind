/**
 * The User's own "Checked by me" (#1933): one record per item a person checked, a
 * Citation, a figure or a comparison cell, kept apart from the app's check, in the Note's own
 * document so it goes and syncs with the Note and Undo takes it back. A record is never
 * deleted: removing it sets `deletedAt`, and a change to what it checked shows it as changed.
 */
import type * as Y from "yjs";
import {
  type CheckFigure,
  type Citation,
  type CitationAttributes,
  type FigureFinding,
  type FigureInput,
  MIND_SIGN_OFFS_FIELD,
  type SignOffNow,
  type SignOffTarget,
} from "../core/api";
import { isRecord } from "../core/errors";
import { targetHash } from "./proposals";
import { comparableSentence } from "./sentences";

export type { SignOffTarget };

type SignOffKind = SignOffTarget["kind"];

export interface SignOffRecord {
  id: string;
  target: SignOffTarget;
  /** When it was checked (ISO 8601, UTC). */
  at: string;
  /** What was checked, as `signOffBasis` hashes it: a change to it shows the mark as changed. */
  contentHash: string;
  /** When the person took it off (ISO 8601, UTC); null while it stands. */
  deletedAt: string | null;
  /** The person's name as Settings gave it when they checked it: a sign-off is evidence, so a later rename keeps it. */
  name?: string;
  /** The person, the same on every device they use. */
  personId?: string;
  /** Each source Document's version when they checked it, by id: a newer one since changes it. */
  versions?: Readonly<Record<string, string>>;
}

/** How a person's mark on an item shows now. */
export type SignOffShown =
  | { state: "checked"; record: SignOffRecord }
  | { state: "changed"; record: SignOffRecord };

const KINDS: readonly SignOffKind[] = ["citation", "figure", "cell"];

const isKind = (value: unknown): value is SignOffKind => KINDS.some((kind) => kind === value);

const text = (value: unknown): value is string => typeof value === "string" && value !== "";

export function readSignOff(value: unknown): SignOffRecord | null {
  if (!isRecord(value) || !text(value.id) || !text(value.at) || !text(value.contentHash))
    return null;
  const target = value.target;
  if (
    !isRecord(target) ||
    !isKind(target.kind) ||
    !text(target.id) ||
    (value.deletedAt !== null && !text(value.deletedAt))
  )
    return null;
  return {
    id: value.id,
    target: { kind: target.kind, id: target.id },
    at: value.at,
    contentHash: value.contentHash,
    deletedAt: value.deletedAt,
    ...(text(value.name) && { name: value.name }),
    ...(text(value.personId) && { personId: value.personId }),
    ...(isVersions(value.versions) && { versions: value.versions }),
  };
}

const isVersions = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every(text);

/** The source Documents' versions now, for a mark made now: what a newer one is newer than. */
export const versionsOf = (
  sources: readonly { documentId?: string | null }[],
  versions: ReadonlyMap<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    sources.flatMap(({ documentId }) => {
      const now = typeof documentId === "string" ? versions.get(documentId) : undefined;
      return documentId && now ? [[documentId, now] as const] : [];
    }),
  );

const keyOf = (target: SignOffTarget) => `${target.kind}:${target.id}`;

/** The Note's sign-offs that stand, newest last. */
export function signOffsOf(doc: Y.Doc): SignOffRecord[] {
  const map = doc.getMap<unknown>(MIND_SIGN_OFFS_FIELD);
  return [...map.values()]
    .flatMap((value) => {
      const record = readSignOff(value);
      return record && record.deletedAt === null ? [record] : [];
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** The Citations any mark names, taken off or not, as Undo can bring one back. */
export function markedCitations(doc: Y.Doc): Set<string> {
  return new Set(
    [...doc.getMap<unknown>(MIND_SIGN_OFFS_FIELD).values()].flatMap((value) => {
      const record = readSignOff(value);
      return record?.target.kind === "citation" ? [record.target.id] : [];
    }),
  );
}

/**
 * The id a Citation without one of its own goes by when it is first marked: its element's, which
 * every version of the Note that holds it shares, so the mark finds it in a version kept before.
 */
export const citationElementId = (element: Y.XmlElement): string | null => {
  const id = element._item?.id;
  return id ? `${id.client}-${id.clock}` : null;
};

/** Writes a person's sign-off; call it inside the transaction that also makes any id it needs. */
export function addSignOff(doc: Y.Doc, record: SignOffRecord): void {
  doc.getMap<unknown>(MIND_SIGN_OFFS_FIELD).set(record.id, record);
}

/**
 * Takes the person's own standing sign-offs on `target` off, kept with the time they were taken
 * off: each person takes off only their own.
 */
export function removeSignOff(
  doc: Y.Doc,
  target: SignOffTarget,
  at: string,
  personId: string | null,
): void {
  const map = doc.getMap<unknown>(MIND_SIGN_OFFS_FIELD);
  for (const [key, value] of map.entries()) {
    const record = readSignOff(value);
    if (
      record &&
      record.deletedAt === null &&
      keyOf(record.target) === keyOf(target) &&
      isMine(record, personId)
    )
      map.set(key, { ...record, deletedAt: at });
  }
}

/** The mark on `target` to show: the User's own, else the newest of another person's. */
export const signOffOn = (
  records: readonly SignOffRecord[],
  target: SignOffTarget,
  personId: string | null,
): SignOffRecord | null =>
  shownOf(
    records.filter((record) => keyOf(record.target) === keyOf(target)),
    personId,
  );

/** Of the marks on one item, the one to show: the User's own, else the newest of another person's. */
const shownOf = (on: readonly SignOffRecord[], personId: string | null): SignOffRecord | null =>
  on.findLast((record) => isMine(record, personId)) ?? on.at(-1) ?? null;

/** What a sign-off rests on, as one hash: the sentence's words and what each source says now. */
export function signOffBasis(parts: {
  sentence: string;
  item: string;
  sources: readonly {
    documentId: string | null;
    contentHash: string | null;
    quote: string | null;
  }[];
}): string {
  return targetHash(
    JSON.stringify([
      comparableSentence(parts.sentence),
      parts.item,
      parts.sources.map((source) => [source.documentId, source.contentHash, source.quote]),
    ]),
  );
}

/** A Citation's: its sentence as checks read it, and what it quotes from which version. */
export const citationSignOffBasis = (
  sentence: string,
  citation: Pick<CitationAttributes, "documentId" | "contentHash" | "quote">,
): string =>
  signOffBasis({
    sentence,
    item: citation.quote ?? "",
    sources: [
      {
        documentId: citation.documentId ?? null,
        contentHash: citation.contentHash ?? null,
        quote: citation.quote ?? null,
      },
    ],
  });

const citationEvidence = (citation: Citation) => [
  citation.documentId,
  citation.contentHash,
  citation.quote,
];

const inputEvidence = (input: FigureInput) => [
  input.name,
  input.label,
  input.number.chars,
  citationEvidence(input.citation),
  input.cell,
  input.unitStatement && [
    citationEvidence(input.unitStatement.citation),
    input.unitStatement.scale,
    input.unitStatement.scaleWord,
    input.unitStatement.currency,
  ],
];

/**
 * A figure's: what its check reads it against (its sentence's words and, in a table, its row's and
 * column's headings and units), what it shows, and the evidence shown for it: the Citation and
 * reading it was found in, or a calculated one's formula, inputs and Analysis. Its sources' newer versions
 * are compared as it shows (`signOffShown`).
 */
export const figureSignOffBasis = (
  figure: Pick<CheckFigure, "id" | "calculated" | "context"> & {
    reading: { chars: string };
    source?: FigureFinding["source"];
    sourceInput?: FigureFinding["sourceInput"];
  },
): string =>
  signOffBasis({
    sentence: figure.context ?? "",
    item: JSON.stringify([
      figure.id,
      figure.calculated?.figure.shown ?? figure.reading.chars,
      figure.calculated
        ? [
            figure.calculated.figure.formula,
            figure.calculated.figure.inputs.map(inputEvidence),
            figure.calculated.analysisId,
          ]
        : [
            figure.source ? citationEvidence(figure.source) : null,
            figure.sourceInput ? inputEvidence(figure.sourceInput) : null,
          ],
    ]),
    sources: [],
  });

/**
 * The Citations a figure rests on, whose newer versions change the User's check: a calculated
 * figure's inputs, or the Citation its check read it from.
 */
export const figureSignOffSources = (
  figure: Pick<FigureFinding, "source" | "sourceInput" | "calculated">,
): Citation[] =>
  figure.calculated
    ? figure.calculated.figure.inputs.map((input) => input.citation)
    : [
        ...(figure.source ? [figure.source] : []),
        ...(figure.sourceInput ? [figure.sourceInput.citation] : []),
      ];

/**
 * How a sign-off shows: checked while what it rests on is as it was, else changed. `versions`
 * are each live Document's version now: one newer than when the person checked it changes it
 * (than the version quoted, where the mark kept none), and one not known yet doesn't.
 */
export function signOffShown(
  record: SignOffRecord,
  basisNow: string,
  sources: readonly { documentId?: string | null; contentHash?: string | null }[],
  versions: ReadonlyMap<string, string> | null,
): SignOffShown {
  const newer = sources.some(({ documentId, contentHash }) => {
    const now = typeof documentId === "string" ? versions?.get(documentId) : undefined;
    if (!documentId || now === undefined) return false;
    return now !== (record.versions?.[documentId] ?? contentHash);
  });
  return record.contentHash === basisNow && !newer
    ? { state: "checked", record }
    : { state: "changed", record };
}

/** Whether a mark is the User's own: theirs on any device, or made before they had an id. */
export const isMine = (record: SignOffRecord, personId: string | null): boolean =>
  record.personId === undefined || record.personId === personId;

/** Whether "Checked by me" shows ticked: the User's own mark stands on the item as it is now. */
export const checkedByMe = (now: SignOffNow | null): boolean =>
  now?.mine === true && now.state === "checked";

export const signOffNow = (
  { state, record }: SignOffShown,
  personId: string | null,
): SignOffNow => ({
  state,
  at: record.at,
  name: record.name ?? null,
  mine: isMine(record, personId),
  target: record.target,
});

/**
 * What of a figure's id an edit keeps, loosest last: its Block and its words, then its Block and
 * where it starts; a chart's value keeps its row and series.
 */
function figureKins(id: string): string[] {
  let parts: unknown;
  try {
    parts = JSON.parse(id);
  } catch {
    return [];
  }
  if (!Array.isArray(parts)) return [];
  if (parts[0] === "text")
    return [
      JSON.stringify(["text", parts[1], parts[5]]),
      JSON.stringify(["text", parts[1], parts[3]]),
    ];
  if (parts[0] === "chart") return [JSON.stringify(["chart", parts[1], parts[2], parts[3]])];
  return [];
}

/**
 * Each figure's sign-off, by figure id: its own, or, once an edit gave it a new id, the one left
 * on the figure it was, so the mark stays on it as changed rather than going. A mark goes to one
 * figure at most, and never to a figure that has its own.
 */
export function figureSignOffs(
  records: readonly SignOffRecord[],
  figureIds: readonly string[],
  personId: string | null,
): Map<string, SignOffRecord> {
  const figures = records.filter((record) => record.target.kind === "figure");
  const found = new Map<string, SignOffRecord>();
  const used = new Set<SignOffRecord>();
  for (const id of figureIds) {
    const own = signOffOn(figures, { kind: "figure", id }, personId);
    if (own) {
      found.set(id, own);
      for (const record of figures) if (record.target.id === id) used.add(record);
    }
  }
  const current = new Set(figureIds);
  const left = figures.filter((record) => !used.has(record) && !current.has(record.target.id));
  for (const level of [0, 1]) {
    for (const id of figureIds) {
      if (found.has(id)) continue;
      const kin = figureKins(id)[level];
      if (kin === undefined) continue;
      const record = shownOf(
        left.filter((each) => !used.has(each) && figureKins(each.target.id)[level] === kin),
        personId,
      );
      if (!record) continue;
      found.set(id, record);
      used.add(record);
    }
  }
  return found;
}
