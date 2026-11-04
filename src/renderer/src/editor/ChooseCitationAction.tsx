import { useEffect, useRef, useState } from "react";
import { checkedCitation } from "../../../shared/claimParts";
import { useChecks } from "../checks";
import { chooseCitationIn, requestCitationPicker, useCitationPick } from "../citationPick";
import { DocumentOrFolderPicker } from "../components/DocumentOrFolderPicker";
import { useT } from "../i18n";
import { readableNow } from "../readableDocuments";
import { useTurnWall } from "../turnWall";
import type { ShownClaim } from "./claimChecks";

/**
 * Choose the Citation… (#1554) on the card of a sentence the check didn't find: the Document of the
 * close Passage its check found opens beside the Note at that Passage, or, with none, one chosen
 * in the shared picker, a Document open beside the Note chosen first, where the User selects the
 * words to cite. `onChosen`: the card goes, as for Open.
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
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [picking, setPicking] = useState(false);
  const running = useChecks((state) => state.running[mindId] !== undefined);
  const asked = useCitationPick((state) => state.asked === claim.check.id);
  const pick = { mindId, checkId: claim.check.id, sentence: claim.sentence.text };
  const start = () => {
    const close = checkedCitation(claim.check.evidence ?? undefined);
    // Filed behind a Folder wall since the check, or without text now: the picker instead.
    if (!close || !readableNow(mindId, { kind: "document", id: close.documentId })) {
      setPicking(true);
      return;
    }
    chooseCitationIn({ ...pick, documentId: close.documentId }, close);
    onChosen();
  };
  const startNow = useRef(start);
  startNow.current = start;
  useEffect(() => {
    if (!asked) return;
    requestCitationPicker(null);
    startNow.current();
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
      {picking && button && !running && (
        <CitationDocumentPicker
          anchor={button}
          mindId={mindId}
          startsOnScreen
          onChoose={(documentId) => {
            setPicking(false);
            chooseCitationIn({ ...pick, documentId });
            onChosen();
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}

/**
 * The shared picker of Check against a Document… for the one Document to choose a Citation in,
 * found by its name, pinyin or initials, on the Note's side of a Folder wall.
 */
export function CitationDocumentPicker({
  anchor,
  mindId,
  startsOnScreen = false,
  onChoose,
  onClose,
}: {
  anchor: HTMLElement;
  mindId: string;
  /** A Document open beside the Note is chosen when it opens, so Enter takes it. */
  startsOnScreen?: boolean;
  onChoose(documentId: string): void;
  onClose(): void;
}) {
  const t = useT();
  const wall = useTurnWall({ mindId, conversationId: null });
  if (wall === undefined) return null;
  return (
    <DocumentOrFolderPicker
      anchor={anchor}
      wall={wall}
      documentsOnly
      startsOnScreen={startsOnScreen}
      labels={{
        title: t("claim.chooseCitation"),
        search: t("claim.chooseCitation.find"),
        noMatch: t("claim.chooseCitation.noMatch"),
      }}
      testId="citation-document"
      onChoose={(scope) => {
        const [documentId] = scope.documentIds;
        if (documentId) onChoose(documentId);
        else onClose();
      }}
      onClose={onClose}
    />
  );
}
