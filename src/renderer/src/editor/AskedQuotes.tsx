import { useEffect } from "react";
import type * as Y from "yjs";
import type { AskedQuote } from "../../../core/api";
import {
  badgeMessage,
  type CitationState,
  citedSpeakers,
  type LiveDocument,
} from "../../../shared/citations";
import { citationLocation, formatLocation, type Translate } from "../../../shared/locations";
import { useAnswers } from "../answers";
import { TableLineIcon } from "../components/lineIcons";
import { quoteKey } from "../composer";
import { areaCheck, areaLabel } from "../editor/areaWords";
import { RemoveIcon } from "../editor/icons";
import { QuoteChip } from "../editor/QuoteChip";
import { useT } from "../i18n";
import { useModelInUse } from "../modelInUse";
import { useAppStore } from "../store";

const whereOf = (quote: AskedQuote, t: Translate, documents: readonly LiveDocument[]): string => {
  const location = citationLocation(quote);
  return location
    ? formatLocation(location, t, {
        speakers: citedSpeakers(quote, documents),
        quote: quote.quote,
      })
    : "";
};

export function showQuote(quote: AskedQuote): void {
  const area = citationLocation(quote)?.area;
  useAppStore.getState().openDocument({
    documentId: quote.documentId,
    ...(quote.pageFrom !== null && { pageFrom: quote.pageFrom }),
    ...(quote.pageTo !== null && { pageTo: quote.pageTo }),
    quote: quote.quote,
    ...(area && { area }),
  });
}

/** What a picked quote is called: its cells' rows, its slide, or its figure. Null for words. */
function pickLabel(quote: AskedQuote, t: Translate): string | null {
  const location = citationLocation(quote);
  switch (quote.pick) {
    case "rows": {
      if (location?.kind !== "rows") return quote.documentName;
      const range = span(location.from, location.to);
      return location.sheet
        ? t("composer.chip.rowsWithSheet", { sheet: location.sheet, range })
        : t("composer.chip.rowsOnly", { range });
    }
    case "slide":
      return location?.kind === "slide"
        ? t("composer.chip.slide", {
            document: quote.documentName,
            range: span(location.from, location.to),
          })
        : quote.documentName;
    case "area":
      return areaLabel(quote, t).label;
    default:
      return null;
  }
}

/** A chip's two buttons: the pick's name, which shows it, and × which takes it out. */
function ChipButtons({
  kind,
  label,
  onShow,
  onRemove,
}: {
  kind: "table" | "slide" | "area";
  label: string;
  onShow(): void;
  onRemove(): void;
}) {
  const t = useT();
  return (
    <>
      <button
        type="button"
        data-testid={`composer-${kind}-chip-show`}
        onClick={onShow}
        className="quote-chip-show"
      >
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        data-testid={`composer-${kind}-chip-remove`}
        aria-label={t("composer.selection.drop")}
        title={t("composer.selection.drop")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
        className="scope-chip-remove"
      >
        <RemoveIcon className="size-2.5" />
      </button>
    </>
  );
}

/** "12–14": a Location's range, as its labels word it. */
const span = (from: number, to: number) => (to !== from ? `${from}–${to}` : `${from}`);

/** A sheet range's chip: "Revenue · rows 12–14", with a preview of its cells and header row on hover. */
function RowsChip({ quote, onRemove }: { quote: AskedQuote; onRemove(): void }) {
  const t = useT();
  const label = pickLabel(quote, t) ?? quote.documentName;
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
      <ChipButtons kind="table" label={label} onShow={() => showQuote(quote)} onRemove={onRemove} />
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
                  {table.rowLabels && <th />}
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
                  {table.rowLabels && (
                    <td className="row-name">{table.rowLabels[rowIndex] ?? ""}</td>
                  )}
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

/** Whether the model the Note will use can't read a picture, as a Note's picture chip says (#118, #1937). */
function usePictureUnreadable(doc: Y.Doc | null, picture: AskedQuote["picture"]): boolean {
  const model = useModelInUse(doc);
  const groups = useAnswers((state) => state.models);
  useEffect(() => {
    if (picture) useAnswers.getState().loadModels();
  }, [picture]);
  const group = model ? groups?.find((each) => each.provider.id === model.providerId) : undefined;
  const reads = model ? group?.about[model.modelId]?.readsImages : undefined;
  return model !== null && groups !== null && reads !== true;
}

/** A whole slide's chip: "Board pack, October · slide 5". */
function SlideChip({
  quote,
  doc,
  onRemove,
}: {
  quote: AskedQuote;
  doc: Y.Doc | null;
  onRemove(): void;
}) {
  const t = useT();
  const unreadable = usePictureUnreadable(doc, quote.picture);
  const label = pickLabel(quote, t) ?? quote.documentName;
  const state: CitationState = {
    check: quote.check ?? "not-checked",
    reason: quote.checkReason ?? null,
    documentId: quote.documentId,
    changedAfterCited: false,
  };
  const message = badgeMessage(state, quote, t);
  const check = quote.check ? t(message.key, message.params) : "";
  const tip = [
    label,
    check,
    quote.picture && unreadable ? t("composer.picture.unreadableModel") : "",
  ].filter((part) => part !== "");
  return (
    <span
      data-testid="composer-slide-chip"
      data-check={quote.check}
      title={tip.join("\n")}
      className="question-skill composer-quote composer-quote--rows"
    >
      {quote.picture && (
        <img
          src={quote.picture.src}
          alt=""
          data-testid="composer-slide-thumbnail"
          className="composer-quote-thumb"
        />
      )}
      <ChipButtons kind="slide" label={label} onShow={() => showQuote(quote)} onRemove={onRemove} />
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
  const { where, label } = areaLabel(quote, t);
  const unreadable = usePictureUnreadable(doc, quote.picture);
  const tip = [
    label,
    quote.documentName,
    areaCheck(quote, where, t),
    unreadable ? t("composer.picture.unreadableModel") : "",
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
      <ChipButtons kind="area" label={label} onShow={() => showQuote(quote)} onRemove={onRemove} />
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
  const documents = useAppStore((state) => state.documents);
  return quotes.map((quote) => {
    if (quote.pick === "rows") {
      return <RowsChip key={quoteKey(quote)} quote={quote} onRemove={() => onRemove(quote)} />;
    }
    if (quote.pick === "slide") {
      return (
        <SlideChip key={quoteKey(quote)} quote={quote} doc={doc} onRemove={() => onRemove(quote)} />
      );
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
        where={whereOf(quote, t, documents)}
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
    const where = whereOf(quote, t, documents);
    const source = [quote.documentName, where].filter((part) => part !== "").join(" ");
    const here = documents.some((each) => each.id === quote.documentId);
    const picked = pickLabel(quote, t);
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
          title={quote.quote || picked || ""}
          className="assistant-question-quote"
        >
          <span className="sr-only">{t("assistant.question.quote")}</span>
          {quote.pick ? (picked ?? "") : `“${quote.quote.trim()}”`}
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
