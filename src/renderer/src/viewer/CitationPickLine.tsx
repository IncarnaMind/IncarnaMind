import { useRef } from "react";
import { dropCitationPick, usePickIn } from "../citationPick";
import { buttonStyle } from "../components/ui";
import { useDismissOnEscape } from "../escapeDismiss";
import { useT } from "../i18n";
import { useFade } from "../motion";

/**
 * While a sentence waits for its Citation in this Document (#1554): one line over the page saying
 * what to do, with Cancel, and the sentence it is for. Esc ends the wait too.
 */
export function CitationPickLine({ documentId }: { documentId: string }) {
  const pick = usePickIn(documentId);
  return pick ? <PickLine sentence={pick.sentence} /> : null;
}

function PickLine({ sentence }: { sentence: string }) {
  const t = useT();
  const line = useRef<HTMLDivElement>(null);
  useFade(line);
  // Esc closes the newest thing on screen first: a problem line shown since, then this.
  useDismissOnEscape(true, dropCitationPick);
  return (
    <div ref={line} role="status" data-testid="citation-pick-line" className="citation-pick-line">
      <div className="citation-pick-line-row">
        <b>{t("claim.chooseCitation.hint")}</b>
        <button
          type="button"
          data-testid="citation-pick-cancel"
          className={buttonStyle("ghost", "sm")}
          onClick={dropCitationPick}
        >
          {t("claim.chooseCitation.cancel")}
        </button>
      </div>
      <p className="citation-pick-line-sentence">{t("claim.sentence", { sentence })}</p>
    </div>
  );
}
