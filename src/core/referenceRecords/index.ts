/**
 * Reference records (#286): what a citation style needs to cite a Document.
 * Each is read from the Document's file as it is processed (./read, by the
 * processing worker; ../documents writes it), edited by the User in the
 * "Cite as" panel, and, when the User asks, filled from Crossref or arXiv by
 * the Document's DOI or arXiv id (./lookup), with consent, never in local
 * mode. ./store keeps the rules for which of these may change a field.
 */
import {
  emptyReferenceFields,
  lookupIdentifier,
  normalizeDoi,
  parseIssued,
} from "../../shared/references";
import type {
  DataKind,
  Document,
  ReferenceField,
  ReferenceFields,
  ReferenceLookupResult,
  ReferenceName,
  ReferenceRecord,
} from "../api";
import type { Consent } from "../consent";
import {
  ConsentDeclinedError,
  ConsentRevokedError,
  InvalidInputError,
  isRecord,
  LocalModeError,
} from "../errors";
import { createSendGate } from "../sendGate";
import type { Pace } from "../sources/pace";
import { ARXIV_INTERVAL_MS, ARXIV_LANE } from "../sources/providers/arxiv";
import type { Database } from "../storage";
import { ARXIV, CROSSREF, LookupError, lookUpArxiv, lookUpDoi } from "./lookup";
import {
  confirmReference,
  editReference,
  fillReference,
  isFieldValue,
  isReferenceField,
  isReferenceSource,
  restoreReference,
} from "./store";

export { createReferenceImport } from "./import";
export { ARXIV, CROSSREF } from "./lookup";
export { referenceOf, writeFileReference } from "./store";

/** What the "reference-lookup" flow sends: the identifier, and nothing else. */
export const REFERENCE_LOOKUP_SENDS: readonly DataKind[] = ["identifiers"];

/** Where Crossref's and arXiv's APIs are, unless the host says otherwise (tests). */
export const REFERENCE_SERVICE_URLS = {
  crossref: "https://api.crossref.org",
  arxiv: "https://export.arxiv.org",
};

/** The longest text a field takes: far more than any title or name list needs. */
const MAX_LENGTH = 5000;

export interface ReferencesOptions {
  db: Database;
  now: () => string;
  consent: Consent;
  /** Local mode is on: Look up sends nothing. */
  localOnly(): boolean;
  /** Where Crossref's and arXiv's APIs are. */
  urls: { crossref: string; arxiv: string };
  /** The live Document; throws NotFoundError for an unknown or deleted one. */
  document(id: unknown): Document;
  /** Pushes "references.changed". */
  changed(documents: Document[]): void;
  /** Aborted when the core closes. */
  signal: AbortSignal;
  /** Keeps requests to arXiv apart, with Find sources' (see ../sources/pace). */
  pace: Pace;
}

const tidyName = (name: ReferenceName): ReferenceName | null => {
  if ("literal" in name) {
    const literal = name.literal.trim();
    return literal ? { literal } : null;
  }
  const family = name.family.trim();
  const given = name.given.trim();
  if (!family) return given ? { literal: given } : null;
  return { family, given };
};

/** One field's value as the User typed it, checked and tidied. */
function parseValue(field: ReferenceField, value: unknown): ReferenceFields[ReferenceField] {
  if (!isFieldValue(field, value)) {
    throw new InvalidInputError(`That isn't a value for the reference's ${field}.`);
  }
  if (field === "type") return value;
  if (Array.isArray(value)) {
    return value.map(tidyName).filter((name): name is ReferenceName => name !== null);
  }
  const text = (value as string).replace(/\s+/g, " ").trim();
  if (text.length > MAX_LENGTH) {
    throw new InvalidInputError({ key: "error.reference.tooLong", values: { max: MAX_LENGTH } });
  }
  if (text === "") return text;
  if (field === "issued") {
    const issued = parseIssued(text);
    if (!issued) throw new InvalidInputError({ key: "error.reference.notYear", values: { text } });
    return issued;
  }
  if (field === "doi") {
    const doi = normalizeDoi(text);
    if (!doi) throw new InvalidInputError({ key: "error.reference.notDoi", values: { text } });
    return doi;
  }
  // An address typed without its scheme ("arxiv.org/abs/1706.03762").
  if (field === "url" && !/^[a-z][a-z0-9+.-]*:/i.test(text)) return `https://${text}`;
  return text;
}

function parsePatch(patch: unknown): Partial<ReferenceFields> {
  if (!isRecord(patch)) throw new InvalidInputError("A reference patch must be an object.");
  const parsed: Partial<Record<ReferenceField, ReferenceFields[ReferenceField]>> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (!isReferenceField(field))
      throw new InvalidInputError(`"${field}" isn't a reference field.`);
    parsed[field] = parseValue(field, value);
  }
  return parsed as Partial<ReferenceFields>;
}

function parseFields(fields: unknown): ReferenceField[] {
  if (!Array.isArray(fields) || !fields.every(isReferenceField)) {
    throw new InvalidInputError("fields must be a list of reference fields.");
  }
  return fields;
}

/**
 * The earlier record Undo puts `fields` back from, checked: each of them
 * either had no source (it was empty) or a source and a value it can hold,
 * so Undo can't store what an edit couldn't.
 */
function parseRecord(before: unknown, fields: readonly ReferenceField[]): ReferenceRecord {
  if (!isRecord(before) || !isRecord(before.fields) || !isRecord(before.sources)) {
    throw new InvalidInputError("before must be a reference record.");
  }
  for (const field of fields) {
    const source = before.sources[field];
    if (source === undefined) continue;
    if (!isReferenceSource(source) || !isFieldValue(field, before.fields[field])) {
      throw new InvalidInputError(`before has no valid ${field} to put back.`);
    }
  }
  return before as unknown as ReferenceRecord;
}

export function createReferences(options: ReferencesOptions) {
  const { db, now, consent, urls, signal, pace } = options;
  const gate = createSendGate(consent, options.localOnly);

  /** The Document as it is now, and pushed as changed if `changed` says so. */
  const settle = (documentId: string, changed: boolean) => {
    const document = options.document(documentId);
    if (changed) options.changed([document]);
    return document;
  };

  const failed = (
    reason: Extract<ReferenceLookupResult, { outcome: "failed" }>["reason"],
    message: string,
  ): ReferenceLookupResult => ({ outcome: "failed", reason, message });

  return {
    update(documentId: unknown, patch: unknown): Document {
      const fields = parsePatch(patch);
      const id = options.document(documentId).id;
      const changed = db.transaction(() => editReference(db, id, fields, now()));
      return settle(id, changed.length > 0);
    },

    confirm(documentId: unknown): Document {
      const id = options.document(documentId).id;
      const changed = db.transaction(() => confirmReference(db, id, now()));
      return settle(id, changed.length > 0);
    },

    restore(documentId: unknown, before: unknown, fields: unknown): Document {
      const list = parseFields(fields);
      const record = parseRecord(before, list);
      const id = options.document(documentId).id;
      db.transaction(() => restoreReference(db, id, record, list, now()));
      return settle(id, true);
    },

    async lookUp(documentId: unknown): Promise<ReferenceLookupResult> {
      const document = options.document(documentId);
      const identifier = lookupIdentifier(document.reference?.fields ?? emptyReferenceFields());
      if (!identifier) return failed("no-identifier", "The record has no DOI or arXiv id.");
      const local = () =>
        failed("local-mode", "Look up is off while “Keep everything on this computer” is on.");
      if (options.localOnly()) return local();
      const service = identifier.kind === "doi" ? CROSSREF : ARXIV;
      try {
        await consent.ensure("reference-lookup", service);
      } catch (error) {
        if (error instanceof ConsentDeclinedError) return failed("declined", error.message);
        if (error instanceof LocalModeError) return local();
        throw error;
      }
      let found: Partial<ReferenceFields>;
      try {
        if (identifier.kind === "doi") {
          gate.check("reference-lookup", service);
          found = await lookUpDoi(urls.crossref, identifier.id, signal);
        } else {
          // arXiv asks for "no more than one request every three seconds", from all of one's machines.
          found = await pace.run(
            ARXIV_LANE,
            ARXIV_INTERVAL_MS,
            () => {
              gate.check("reference-lookup", service);
              return lookUpArxiv(urls.arxiv, identifier.id, signal);
            },
            signal,
          );
        }
      } catch (error) {
        if (error instanceof LookupError) return failed(error.reason, error.message);
        if (error instanceof LocalModeError) return local();
        if (error instanceof ConsentRevokedError) return failed("declined", error.message);
        throw error;
      }
      const id = options.document(document.id).id;
      const filled = db.transaction(() => fillReference(db, id, found, now()));
      return { outcome: "filled", document: settle(id, true), filled, service };
    },
  };
}
