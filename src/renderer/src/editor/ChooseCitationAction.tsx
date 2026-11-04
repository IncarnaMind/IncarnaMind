import { useEffect, useState } from "react";
import { useChecks } from "../checks";
import { chooseCitationIn, requestCitationPicker, useCitationPick } from "../citationPick";
import { DocumentOrFolderPicker } from "../components/DocumentOrFolderPicker";
import { useT } from "../i18n";
import { useTurnWall } from "../turnWall";
import type { ShownClaim } from "./claimChecks";

/**
 * Choose the Citation… (#1554) on the card of a sentence the check didn't find: one Document from
 * the shared picker, found by its name, pinyin or initials, opens beside the Note, where the User
 * selects the words to cite. `onChosen`: the card goes, as for Open.
 */
export function ChooseCitationAction({
  mindId,
  claim,
  onChosen,
}: {
  mindId: string;
  claim: ShownClaim;
  onChosen(): void;
}) {
  const t = useT();
  const wall = useTurnWall({ mindId, conversationId: null });
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [picking, setPicking] = useState(false);
  const running = useChecks((state) => state.running[mindId] !== undefined);
  const asked = useCitationPick((state) => state.asked === claim.check.id);
  useEffect(() => {
    if (!asked) return;
    requestCitationPicker(null);
    setPicking(true);
  }, [asked]);
  return (
    <>
      <button
        ref={setButton}
        type="button"
        data-testid="claim-choose-citation"
        className="citation-card-action"
        disabled={running}
        onClick={() => setPicking(true)}
      >
        {t("claim.chooseCitation")}
      </button>
      {picking && button && wall !== undefined && !running && (
        <DocumentOrFolderPicker
          anchor={button}
          wall={wall}
          documentsOnly
          labels={{
            title: t("claim.chooseCitation"),
            search: t("scope.picker.label"),
            noMatch: t("scope.picker.empty"),
          }}
          testId="citation-document"
          onChoose={(scope) => {
            setPicking(false);
            const [documentId] = scope.documentIds;
            if (!documentId) return;
            chooseCitationIn({ mindId, checkId: claim.check.id, documentId });
            onChosen();
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
