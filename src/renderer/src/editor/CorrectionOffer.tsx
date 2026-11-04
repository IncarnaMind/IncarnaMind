import type { ClaimCorrection } from "../../../core/api";
import { shownDocumentName } from "../../../shared/citations";
import { useT } from "../i18n";
import { useAppStore } from "../store";

/** Past this many characters, the Document's wording doesn't fit on a button. */
const BUTTON_WORDING = 40;

/** "Change to 38.6%": a contradicted sentence's or part's correction from the Documents (#1481). */
export function CorrectButton({
  correction,
  onCorrect,
  testId,
}: {
  correction: ClaimCorrection;
  onCorrect(): void;
  testId: string;
}) {
  const t = useT();
  const wording = correction.choices[0]?.wording ?? "";
  return (
    <button
      type="button"
      data-testid={testId}
      className="citation-card-action citation-card-action--primary"
      onClick={onCorrect}
    >
      {wording.length > BUTTON_WORDING
        ? t("claim.useDocumentWording")
        : t("claim.correction", { wording })}
    </button>
  );
}

/** When two Documents disagree, both, the newer first: the correction uses the newer one. */
export function CorrectionConflict({ correction }: { correction: ClaimCorrection }) {
  const t = useT();
  const documents = useAppStore((store) => store.documents);
  const [newer, older] = correction.choices;
  if (!newer || !older) return null;
  return (
    <p data-testid="claim-correction-conflict" className="claim-card-says">
      {t("claim.correction.conflict", {
        newerDocument: shownDocumentName(newer.evidence, documents) ?? "",
        newerWording: newer.wording,
        olderDocument: shownDocumentName(older.evidence, documents) ?? "",
        olderWording: older.wording,
      })}
    </p>
  );
}
