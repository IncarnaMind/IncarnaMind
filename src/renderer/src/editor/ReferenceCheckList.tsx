import type { ReferenceCheck, ReferenceService } from "../../../core/api";
import { formatNames } from "../../../shared/references";
import { useLanguage, useT } from "../i18n";
import type { Translate } from "../objects";

/** Each service by its name, which no language translates. */
export const SERVICE_NAMES: Readonly<Record<ReferenceService, string>> = {
  crossref: "Crossref",
  openalex: "OpenAlex",
  arxiv: "arXiv",
};

/** A checked reference, with the Block it is in. */
export type ListedCheck = ReferenceCheck & { blockId: string };

/** The order the list shows marks in: surest sign of an invented reference first. */
const ORDER: readonly ReferenceCheck["mark"][] = [
  "not-found",
  "not-listed",
  "mismatch",
  "not-checked",
  "found",
];

/** The marks that need a look: listed first, and opening the list at once. */
export const NEEDS_A_LOOK: ReadonlySet<ReferenceCheck["mark"]> = new Set(
  ORDER.filter((mark) => mark !== "found"),
);

/** How many of a found work's authors its record line names before "et al.". */
const AUTHORS_SHOWN = 3;

/** The dot each mark shows, in DESIGN.md's status colours; red is kept for a contradicted claim (#648). */
const MARK_DOT: Record<ReferenceCheck["mark"], string> = {
  found: "bg-success",
  mismatch: "bg-attention",
  "not-listed": "bg-attention",
  "not-found": "bg-attention",
  "not-checked": "bg-ink-placeholder",
};

/**
 * The record a checked reference matched, under it: for one found, its
 * title, authors and year; for any, its DOI, which opens the work.
 */
function RecordLine({
  record,
  found,
}: {
  record: NonNullable<ReferenceCheck["record"]>;
  found: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const names = formatNames(record.authors.slice(0, AUTHORS_SHOWN), language);
  const parts = found
    ? [
        record.title,
        record.authors.length > AUTHORS_SHOWN ? t("references.record.etAl", { names }) : names,
        record.year === null ? "" : String(record.year),
      ].filter(Boolean)
    : [];
  if (parts.length === 0 && !record.doi) return null;
  return (
    <p data-testid="reference-record" className="mind-reference-record">
      {parts.join(" · ")}
      {parts.length > 0 && record.doi && " · "}
      {record.doi && (
        <a
          href={`https://doi.org/${record.doi}`}
          target="_blank"
          rel="noreferrer"
          data-testid="reference-doi"
          className="mind-reference-link"
        >
          {record.doi}
        </a>
      )}
    </p>
  );
}

/** What a reference's mark says under it: how it differs, or what a miss can mean. */
function details(reference: ListedCheck, t: Translate): { text: string; title?: string }[] {
  if (reference.mark === "not-listed") {
    return [{ text: t("references.notListed.detail"), title: t("references.notListed.why") }];
  }
  const service = reference.service ? SERVICE_NAMES[reference.service] : "";
  return reference.differences.map((difference) => ({
    text:
      difference.field === "year"
        ? t("references.difference.year.cited", {
            cited: difference.cited ?? "",
            found: difference.found,
            service,
          })
        : t(
            difference.field === "title"
              ? "references.difference.title"
              : "references.difference.authors",
            { found: difference.found, service },
          ),
  }));
}

/** The mark as its line says it: which service found it, or why it wasn't checked. */
function markText(reference: ListedCheck, t: Translate): string {
  const service = reference.service ? SERVICE_NAMES[reference.service] : "";
  return reference.mark === "not-checked" && reference.reason
    ? t(`references.reason.${reference.reason}`, { service })
    : t(`references.mark.${reference.mark}`, { service });
}

/**
 * A checked reference list's entries, under its line, by mark, those
 * that need a look first: each with its mark, why, and the record it
 * matched, with the service it came from. Clicking one, or Enter on it,
 * moves to its Block.
 */
export function ReferenceCheckList({
  references,
  onShow,
}: {
  references: readonly ListedCheck[];
  onShow(blockId: string): void;
}) {
  const t = useT();
  const listed = ORDER.flatMap((mark) => references.filter((reference) => reference.mark === mark));
  return (
    <ul
      data-testid="references-list"
      aria-label={t("references.listLabel")}
      className="mind-references"
    >
      {listed.map((reference) => (
        <li key={`${reference.blockId}\n${reference.reference}`}>
          <button
            type="button"
            data-testid="reference-check"
            data-mark={reference.mark}
            className="mind-reference"
            onClick={() => onShow(reference.blockId)}
          >
            <span className="mind-reference-mark">
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${MARK_DOT[reference.mark]}`}
              />
              {markText(reference, t)}
            </span>
            <span className="mind-reference-text">{reference.reference}</span>
            {details(reference, t).map((detail) => (
              <span key={detail.text} title={detail.title} className="mind-reference-detail">
                {detail.text}
              </span>
            ))}
          </button>
          {reference.record && (
            <RecordLine record={reference.record} found={reference.mark === "found"} />
          )}
        </li>
      ))}
    </ul>
  );
}
