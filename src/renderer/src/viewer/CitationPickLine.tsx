import { useRef, useState } from "react";
import { type CitationPick, chooseCitationIn, dropCitationPick, usePickIn } from "../citationPick";
import { buttonStyle } from "../components/ui";
import { CitationDocumentPicker } from "../editor/ChooseCitationAction";
import { useDismissOnEscape } from "../escapeDismiss";
import { useT } from "../i18n";
import { useFade } from "../motion";

/**
 * While a sentence waits for its Citation in this Document (#1554): one line at the top of the
 * page saying what to do, with Choose another Document… and Cancel, and the sentence it is for.
 * Esc ends the wait too.
 */
export function CitationPickLine({ documentId }: { documentId: string }) {
  const pick = usePickIn(documentId);
  return pick ? <PickLine pick={pick} /> : null;
}

function PickLine({ pick }: { pick: CitationPick }) {
  const t = useT();
  const line = useRef<HTMLDivElement>(null);
  const [other, setOther] = useState<HTMLButtonElement | null>(null);
  const [picking, setPicking] = useState(false);
  useFade(line);
  // Esc closes the newest thing on screen first: a problem line shown since, then this.
  useDismissOnEscape(true, dropCitationPick);
  return (
    <div ref={line} role="status" data-testid="citation-pick-line" className="citation-pick-line">
      <div className="citation-pick-line-row">
        <b>{t("claim.chooseCitation.hint")}</b>
        <button
          ref={setOther}
          type="button"
          data-testid="citation-pick-other"
          className={buttonStyle("ghost", "sm")}
          onClick={() => setPicking(true)}
        >
          {t("claim.chooseCitation.other")}
        </button>
        <button
          type="button"
          data-testid="citation-pick-cancel"
          className={buttonStyle("ghost", "sm")}
          onClick={dropCitationPick}
        >
          {t("claim.chooseCitation.cancel")}
        </button>
      </div>
      <p className="citation-pick-line-sentence">
        {t("claim.sentence", { sentence: pick.sentence })}
      </p>
      {picking && other && (
        <CitationDocumentPicker
          anchor={other}
          mindId={pick.mindId}
          onChoose={(documentId) => {
            setPicking(false);
            chooseCitationIn({ ...pick, documentId });
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
