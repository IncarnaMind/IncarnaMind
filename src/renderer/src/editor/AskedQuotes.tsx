import type { AskedQuote } from "../../../core/api";
import { citationLocation, formatLocation, type Translate } from "../../../shared/locations";
import { quoteKey } from "../composer";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { QuoteChip } from "./QuoteChip";

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

export function AskedQuoteChips({
  quotes,
  onRemove,
}: {
  quotes: readonly AskedQuote[];
  onRemove(quote: AskedQuote): void;
}) {
  const t = useT();
  return quotes.map((quote) => (
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
  ));
}

export function AskedQuoteLines({ quotes }: { quotes: readonly AskedQuote[] }) {
  const t = useT();
  const documents = useAppStore((state) => state.documents);
  return quotes.map((quote) => {
    const where = whereOf(quote, t);
    const source = [quote.documentName, where].filter((part) => part !== "").join(" ");
    const here = documents.some((each) => each.id === quote.documentId);
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
          title={quote.quote}
          className="assistant-question-quote"
        >
          <span className="sr-only">{t("assistant.question.quote")}</span>“{quote.quote.trim()}”
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
