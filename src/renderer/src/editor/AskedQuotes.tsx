import { useEffect } from "react";
import type * as Y from "yjs";
import type { AskedQuote } from "../../../core/api";
import { citationLocation, formatLocation, type Translate } from "../../../shared/locations";
import { useAnswers } from "../answers";
import { TableLineIcon } from "../components/lineIcons";
import { quoteKey } from "../composer";
import { RemoveIcon } from "../editor/icons";
import { QuoteChip } from "../editor/QuoteChip";
import { useT } from "../i18n";
import { useModelInUse } from "../modelInUse";
import { useAppStore } from "../store";

const whereOf = (quote: AskedQuote, t: Translate): string => {
  const location = citationLocation(quote);
  return location ? formatLocation(location, t) : "";
};

export const showQuote = (quote: AskedQuote) =>
  useAppStore.getState().openDocument({
    documentId: quote.documentId,
    ...(quote.pageFrom !== null && { pageFrom: quote.pageFrom }),
    ...(quote.pageTo !== null && { pageTo: quote.pageTo }),
    quote: quote.quote,
  });

/** "12–14": a Location's range, as its labels word it. */
const span = (from: number, to: number) => (to !== from ? `${from}–${to}` : `${from}`);

/** A sheet range's chip: "Revenue · rows 12–14", with a preview of its cells and header row on hover. */
function RowsChip({ quote, onRemove }: { quote: AskedQuote; onRemove(): void }) {
  const t = useT();
  const location = citationLocation(quote);
  const range = location?.kind === "rows" ? span(location.from, location.to) : "";
  const sheet = location?.kind === "rows" ? location.sheet : null;
  const label = sheet
    ? t("composer.chip.rowsWithSheet", { sheet, range })
    : t("composer.chip.rowsOnly", { range });
  const table = quote.table;
  const check = quote.check === "found" ? t("citation.badge.found.in", { location: label }) : "";
  return (
    <span
      data-testid="composer-table-chip"
      data-check={quote.check}
      title={[label, quote.documentName, check].filter((part) => part !== "").join("\n")}
      className="question-skill composer-quote composer-quote--rows"
    >
      <TableLineIcon className="question-skill-icon" />
      <button
        type="button"
        data-testid="composer-table-chip-show"
        onClick={() => showQuote(quote)}
        className="quote-chip-show"
      >
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        data-testid="composer-table-chip-remove"
        aria-label={t("composer.selection.drop")}
        title={t("composer.selection.drop")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
        className="scope-chip-remove"
      >
        <RemoveIcon className="size-2.5" />
      </button>
      {table && (
        <span
          data-testid="composer-table-preview"
          role="tooltip"
          className="composer-table-preview"
        >
          <span className="composer-table-preview-title">{t("composer.chip.preview")}</span>
          <table>
            {table.header && (
              <thead>
                <tr>
                  {table.header.map((cell, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a range's cells never reorder
                    <th key={index}>{cell}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {table.rows.map((row, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a range's cells never reorder
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a range's cells never reorder
                    <td key={index}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </span>
      )}
    </span>
  );
}

/** A whole slide's chip: "Board pack, October · slide 5". */
function SlideChip({ quote, onRemove }: { quote: AskedQuote; onRemove(): void }) {
  const t = useT();
  const location = citationLocation(quote);
  const range = location?.kind === "slide" ? span(location.from, location.to) : "";
  const label =
    location?.kind === "slide"
      ? t("composer.chip.slide", { document: quote.documentName, range })
      : quote.documentName;
  const check = quote.check === "found" ? t("citation.badge.found.on", { location: label }) : "";
  return (
    <span
      data-testid="composer-slide-chip"
      data-check={quote.check}
      title={[label, check].filter((part) => part !== "").join("\n")}
      className="question-skill composer-quote composer-quote--rows"
    >
      <span className="quote-chip-show">
        <span className="truncate">{label}</span>
      </span>
      <button
        type="button"
        data-testid="composer-slide-chip-remove"
        aria-label={t("composer.selection.drop")}
        title={t("composer.selection.drop")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
        className="scope-chip-remove"
      >
        <RemoveIcon className="size-2.5" />
      </button>
    </span>
  );
}

/**
 * An area of a page as a chip: "Figure · p. 7", with its thumbnail, and a
 * tooltip that says what its Citation came to, or that the model can't read
 * pictures so the figure won't be sent (#118).
 */
function AreaChip({
  quote,
  doc,
  onRemove,
}: {
  quote: AskedQuote;
  doc: Y.Doc | null;
  onRemove(): void;
}) {
  const t = useT();
  const model = useModelInUse(doc);
  const groups = useAnswers((state) => state.models);
  useEffect(() => {
    if (quote.picture) useAnswers.getState().loadModels();
  }, [quote.picture]);
  const location = citationLocation(quote);
  const where = location ? formatLocation(location, t) : "";
  const label = t("composer.chip.area", { location: where });
  const group = model ? groups?.find((each) => each.provider.id === model.providerId) : undefined;
  const reads = model ? group?.about[model.modelId]?.readsImages : undefined;
  const check =
    quote.check === "found"
      ? t("composer.chip.areaFound", { location: where })
      : quote.check === "cant-check"
        ? t("composer.chip.areaPicture")
        : "";
  const tip = [
    label,
    quote.documentName,
    check,
    reads === false ? t("composer.picture.unreadableModel") : "",
  ].filter((part) => part !== "");
  return (
    <span
      data-testid="composer-area-chip"
      data-check={quote.check}
      title={tip.join("\n")}
      className="question-skill composer-quote composer-quote--area"
    >
      <span className="sr-only">{tip.join(" · ")}</span>
      {quote.picture ? (
        <img
          src={quote.picture.src}
          alt=""
          data-testid="composer-area-thumbnail"
          className="composer-quote-thumb"
        />
      ) : (
        <span className="composer-quote-thumb composer-quote-thumb--none" />
      )}
      <button
        type="button"
        data-testid="composer-area-chip-show"
        onClick={() => showQuote(quote)}
        className="quote-chip-show"
      >
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        data-testid="composer-area-chip-remove"
        aria-label={t("composer.selection.drop")}
        title={t("composer.selection.drop")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
        className="scope-chip-remove"
      >
        <RemoveIcon className="size-2.5" />
      </button>
    </span>
  );
}

export function AskedQuoteChips({
  quotes,
  doc,
  onRemove,
}: {
  quotes: readonly AskedQuote[];
  /** The Note's document, for which model the Question will use: an area needs one that reads pictures (#118). */
  doc: Y.Doc | null;
  onRemove(quote: AskedQuote): void;
}) {
  const t = useT();
  return quotes.map((quote) => {
    if (quote.pick === "rows") {
      return <RowsChip key={quoteKey(quote)} quote={quote} onRemove={() => onRemove(quote)} />;
    }
    if (quote.pick === "slide") {
      return <SlideChip key={quoteKey(quote)} quote={quote} onRemove={() => onRemove(quote)} />;
    }
    if (quote.pick === "area") {
      return (
        <AreaChip key={quoteKey(quote)} quote={quote} doc={doc} onRemove={() => onRemove(quote)} />
      );
    }
    return (
      <QuoteChip
        key={quoteKey(quote)}
        testId="composer-quote"
        quote={quote.quote}
        from={quote.documentName}
        where={whereOf(quote, t)}
        removeLabel={t("composer.selection.drop")}
        onShow={() => showQuote(quote)}
        onRemove={() => onRemove(quote)}
      />
    );
  });
}

export function AskedQuoteLines({ quotes }: { quotes: readonly AskedQuote[] }) {
  const t = useT();
  const documents = useAppStore((state) => state.documents);
  return quotes.map((quote) => {
    const where = whereOf(quote, t);
    const location = citationLocation(quote);
    const source = [quote.documentName, where].filter((part) => part !== "").join(" ");
    const here = documents.some((each) => each.id === quote.documentId);
    const pickLabel = (() => {
      switch (quote.pick) {
        case "rows":
          if (location?.kind !== "rows") return quote.documentName;
          return location.sheet
            ? t("composer.chip.rowsWithSheet", {
                sheet: location.sheet,
                range: span(location.from, location.to),
              })
            : t("composer.chip.rowsOnly", { range: span(location.from, location.to) });
        case "slide":
          return location?.kind === "slide"
            ? t("composer.chip.slide", {
                document: quote.documentName,
                range: span(location.from, location.to),
              })
            : quote.documentName;
        case "area":
          return t("composer.chip.area", { location: where });
        default:
          return null;
      }
    })();
    const parts = (
      <>
        <span className="assistant-question-quote-name">{quote.documentName}</span>
        {where && (
          <>
            {" "}
            <span className="assistant-question-quote-where">{where}</span>
          </>
        )}
        {!here && (
          <>
            {" "}
            <span className="assistant-question-quote-where">
              {t("assistant.question.quoteGone")}
            </span>
          </>
        )}
      </>
    );
    return (
      <span key={quoteKey(quote)} className="assistant-question-asked">
        <span
          data-testid="assistant-question-quote"
          title={quote.quote || pickLabel || ""}
          className="assistant-question-quote"
        >
          <span className="sr-only">{t("assistant.question.quote")}</span>
          {quote.pick ? (pickLabel ?? "") : `“${quote.quote.trim()}”`}
        </span>
        {here ? (
          <button
            type="button"
            data-testid="assistant-question-quote-source"
            title={source}
            onClick={() => showQuote(quote)}
            className="assistant-question-quote-source"
          >
            {parts}
          </button>
        ) : (
          <span
            data-testid="assistant-question-quote-source"
            title={source}
            className="assistant-question-quote-source"
          >
            {parts}
          </span>
        )}
      </span>
    );
  });
}
