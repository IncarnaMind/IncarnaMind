import { useEffect, useState } from "react";
import { checkedCitation } from "../../../shared/claimParts";
import { useChecks } from "../checks";
import { chooseCitationIn, requestCitationPicker, useCitationPick } from "../citationPick";
import { DocumentOrFolderPicker } from "../components/DocumentOrFolderPicker";
import { useT } from "../i18n";
import { useTurnWall } from "../turnWall";
import type { ShownClaim } from "./claimChecks";

/**
 * Choose the Citation… (#1554) on the card of a sentence the check didn't find: the Document of the
 * close Passage its check found, or one from the shared picker, found by its name, pinyin or
 * initials, opens beside the Note, where the User selects the words to cite. `onChosen`: the card
 * goes, as for Open.
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
  const choose = (documentId: string, page?: number) => {
    chooseCitationIn(
      { mindId, checkId: claim.check.id, documentId, sentence: claim.sentence.text },
      page,
    );
    onChosen();
  };
  // A sentence whose check found a close Passage opens that Passage's Document at its page.
  const close = checkedCitation(claim.check.evidence ?? undefined);
  const start = () =>
    close ? choose(close.documentId, close.pageFrom ?? undefined) : setPicking(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `start` reads the latest check.
  useEffect(() => {
    if (!asked) return;
    requestCitationPicker(null);
    start();
  }, [asked]);
  return (
    <>
      <button
        ref={setButton}
        type="button"
        data-testid="claim-choose-citation"
        className="citation-card-action"
        disabled={running}
        onClick={start}
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
            if (documentId) choose(documentId);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
