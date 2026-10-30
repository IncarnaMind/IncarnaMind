import { useEffect, useRef, useState } from "react";
import type { RecordCiteResult } from "../../../core/api";
import { citationLocation, formatLocation, openKind } from "../../../shared/locations";
import { SearchPicker } from "../components/SearchPicker";
import { errorMessage } from "../errors";
import { useT } from "../i18n";
import { openCited } from "../openCited";
import { useAppStore } from "../store";
import {
  chooseRecordCite,
  recordCiteCandidateOptions,
  recordCiteDocumentName,
} from "./recordCiteSources";

const recordCiteKey = (cite: RecordCiteResult) => `${cite.raw}:${cite.from ?? ""}:${cite.to ?? ""}`;

export function RecordCiteResults({
  mindId,
  checkId,
  cites,
  onOpen,
  onPickerChange,
}: {
  mindId: string;
  checkId: string;
  cites: readonly RecordCiteResult[];
  onOpen(): void;
  onPickerChange(open: boolean): void;
}) {
  const t = useT();
  const documents = useAppStore((store) => store.documents);
  const [picker, setPicker] = useState<{
    cite: RecordCiteResult;
    anchor: HTMLButtonElement;
  } | null>(null);
  const [replacements, setReplacements] = useState<ReadonlyMap<RecordCiteResult, RecordCiteResult>>(
    new Map(),
  );
  const [pending, setPending] = useState<RecordCiteResult | null>(null);
  const [failure, setFailure] = useState<{ cite: RecordCiteResult; error: unknown } | null>(null);
  const entries = useRef(new Map<string, HTMLElement>());
  const focusAfterChoice = useRef<RecordCiteResult | null>(null);

  useEffect(() => () => onPickerChange(false), [onPickerChange]);
  useEffect(() => {
    const cite = focusAfterChoice.current;
    if (pending || !cite) return;
    focusAfterChoice.current = null;
    const entry = entries.current.get(recordCiteKey(cite));
    const action = entry?.querySelector<HTMLButtonElement>(
      '[data-testid="record-cite-open"], [data-testid="record-cite-choose"]',
    );
    (action ?? entry)?.focus();
  });

  const closePicker = () => {
    setPicker(null);
    onPickerChange(false);
  };

  const choose = async (cite: RecordCiteResult, documentId: string) => {
    if (pending) return;
    setPending(cite);
    setFailure(null);
    try {
      const resolved = await chooseRecordCite({
        mindId,
        checkId,
        raw: cite.raw,
        ...(cite.from !== undefined && { from: cite.from }),
        ...(cite.to !== undefined && { to: cite.to }),
        documentId,
      });
      setReplacements((current) => new Map(current).set(cite, resolved));
    } catch (error) {
      setFailure({ cite, error });
    } finally {
      focusAfterChoice.current = cite;
      setPending(null);
    }
  };

  const openPassage = (cite: RecordCiteResult, nearby = false) => {
    const place = nearby ? cite.nearby : cite;
    if (!cite.documentId || !place) return;
    const location = nearby ? place.location : citationLocation(place);
    openCited(
      {
        documentId: cite.documentId,
        contentHash: cite.contentHash ?? null,
        pageFrom: place.pageFrom ?? null,
        pageTo: place.pageTo ?? place.pageFrom ?? null,
        quote: place.passage ?? "",
        ...(place.location && { location: place.location }),
      },
      {
        check: nearby || cite.outcome === "supported" ? "found" : "unsupported",
        withQuote: true,
        label: location ? formatLocation(location, t) : null,
      },
    );
    onOpen();
  };

  if (cites.length === 0) return null;
  return (
    <>
      <section className="record-cite-results" aria-label={t("claim.recordCites.label")}>
        {cites.map((base) => {
          const cite = replacements.get(base) ?? base;
          const location = citationLocation(cite);
          const where = location ? formatLocation(location, t) : null;
          const name = recordCiteDocumentName(cite, documents);
          const outcome =
            cite.outcome === "supported"
              ? t("claim.state.supported")
              : cite.outcome === "partly"
                ? t("claim.recordCites.partly")
                : cite.outcome === "unsupported"
                  ? t("aiStatement.sentences.unsupported")
                  : cite.outcome === "not-checked"
                    ? t("aiStatement.sentences.notChecked")
                    : cite.outcome === "choose"
                      ? t("claim.recordCites.choose")
                      : t("claim.recordCites.not-found");
          const busy = pending === base;
          return (
            <article
              key={recordCiteKey(base)}
              ref={(element) => {
                const key = recordCiteKey(base);
                if (element) entries.current.set(key, element);
                else entries.current.delete(key);
              }}
              data-testid="record-cite"
              data-outcome={cite.outcome}
              data-raw={base.raw}
              data-document-id={cite.documentId}
              className="record-cite"
              tabIndex={-1}
              aria-busy={busy}
            >
              <p className="record-cite-head">
                <span data-testid="record-cite-raw" className="record-cite-raw" lang="en">
                  {cite.raw}
                </span>
                <span data-testid="record-cite-outcome" className="record-cite-outcome">
                  {outcome}
                </span>
              </p>
              {(name || where) && (
                <p
                  data-testid="record-cite-source"
                  className="record-cite-source"
                  title={[name, where].filter(Boolean).join(" · ")}
                >
                  {[name, where].filter(Boolean).join(" · ")}
                </p>
              )}
              {cite.outcome === "partly" && (cite.covered || cite.uncovered) && (
                <p data-testid="record-cite-partly" className="record-cite-detail">
                  {cite.covered && cite.uncovered
                    ? t("claim.recordCites.covered", {
                        covered: cite.covered,
                        uncovered: cite.uncovered,
                      })
                    : cite.covered
                      ? t("claim.recordCites.covers", { covered: cite.covered })
                      : t("claim.recordCites.doesNotCover", {
                          uncovered: cite.uncovered ?? "",
                        })}
                </p>
              )}
              {cite.outcome === "not-checked" && (
                <p data-testid="record-cite-not-checked" className="record-cite-detail">
                  {t(`claim.reason.${cite.reason ?? "failed"}`, { detail: cite.detail ?? "" })}
                </p>
              )}
              {cite.passage && (
                <figure className="citation-card-quote record-cite-quote">
                  <figcaption className="sr-only">{t("citation.quote")}</figcaption>
                  <blockquote>
                    <span data-testid="record-cite-passage" className="citation-card-wash">
                      {cite.passage}
                    </span>
                  </blockquote>
                </figure>
              )}
              {cite.nearby && (
                <div data-testid="record-cite-nearby" className="record-cite-nearby">
                  <p data-testid="record-cite-nearby-location" className="record-cite-detail">
                    {t("claim.recordCites.nearby", {
                      location: formatLocation(cite.nearby.location, t),
                    })}
                  </p>
                  <figure className="citation-card-quote record-cite-quote">
                    <blockquote>
                      <span data-testid="record-cite-nearby-passage">{cite.nearby.passage}</span>
                    </blockquote>
                  </figure>
                  {cite.documentId && (
                    <div className="citation-card-actions record-cite-actions">
                      <button
                        type="button"
                        data-testid="record-cite-open-nearby"
                        className="citation-card-action"
                        onClick={() => openPassage(cite, true)}
                      >
                        {t(`citation.open.${openKind(cite.nearby.location)}`)}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {failure?.cite === base && (
                <p data-testid="record-cite-problem" className="record-cite-problem" role="alert">
                  {errorMessage(failure.error, t)}
                </p>
              )}
              {busy && (
                <p data-testid="record-cite-choosing" className="record-cite-detail" role="status">
                  {t("claim.recordCites.choosing")}
                </p>
              )}
              <div className="citation-card-actions record-cite-actions">
                {cite.documentId && (cite.passage || location) && (
                  <button
                    type="button"
                    data-testid="record-cite-open"
                    className="citation-card-action"
                    onClick={() => openPassage(cite)}
                  >
                    {t(`citation.open.${openKind(location)}`)}
                  </button>
                )}
                {cite.outcome === "choose" && (cite.candidates?.length ?? 0) > 0 && (
                  <button
                    type="button"
                    data-testid="record-cite-choose"
                    className="citation-card-action citation-card-action--primary"
                    aria-haspopup="dialog"
                    aria-expanded={picker?.cite === base}
                    disabled={pending !== null}
                    onClick={(event) => {
                      onPickerChange(true);
                      setFailure(null);
                      setPicker({ cite: base, anchor: event.currentTarget });
                    }}
                  >
                    {t("claim.recordCites.chooseAction")}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </section>
      <SearchPicker<string>
        anchor={picker?.anchor ?? null}
        title={picker ? t("claim.recordCites.chooseTitle", { raw: picker.cite.raw }) : ""}
        searchLabel={t("claim.recordCites.search")}
        noMatch={(query) => t("claim.recordCites.noMatch", { query })}
        options={picker ? recordCiteCandidateOptions(picker.cite, documents, t) : []}
        current={undefined}
        currentLabel={t("claim.recordCites.current")}
        onChoose={(documentId) => {
          const cite = picker?.cite;
          if (cite) void choose(cite, documentId);
        }}
        onClose={closePicker}
        testId="record-cite-source"
        widthClass="w-[320px] max-w-[calc(100vw-16px)]"
      />
    </>
  );
}
