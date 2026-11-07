import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type CitationPick, chooseCitationIn, dropCitationPick, usePickIn } from "../citationPick";
import { ViewerTabContext } from "../commands/handles";
import { buttonStyle } from "../components/ui";
import { CitationDocumentPicker } from "../editor/ChooseCitationAction";
import { useDismissOnEscape } from "../escapeDismiss";
import { useT } from "../i18n";
import { groupOfTab } from "../layoutSlice";
import { enter } from "../motion";
import { useAppStore } from "../store";

/** The space under the line, as an export's result line keeps it, and between the line and the words. */
const LINE_GAP_PX = 24;

/**
 * While a sentence waits for its Citation in this Document (#1554): a line floating at the foot of
 * the viewer, as an export's result line floats, naming the sentence and saying what to select,
 * with Choose another Document… and Cancel. The page can scroll its last lines clear of it. Esc
 * ends the wait too.
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
  const tab = useContext(ViewerTabContext);
  const cells = useAppStore((state) => {
    const kind = state.documents.find((each) => each.id === pick.documentId)?.kind;
    return kind === "xlsx" || kind === "csv";
  });
  // Esc closes the newest thing on screen first: a problem line shown since, then this.
  useDismissOnEscape(true, dropCitationPick);
  useEffect(() => {
    if (line.current) enter(line.current, { y: 8 });
  }, []);
  // The viewer's pages end that far lower, so their last lines can scroll clear of the line.
  useLayoutEffect(() => {
    const element = line.current;
    const pane = element?.closest<HTMLElement>(".viewer-pane");
    if (!element || !pane) return;
    const room = () =>
      pane.style.setProperty("--viewer-foot-room", `${element.offsetHeight + 2 * LINE_GAP_PX}px`);
    room();
    pane.dataset.footLine = "";
    const observer = new ResizeObserver(room);
    observer.observe(element);
    return () => {
      observer.disconnect();
      delete pane.dataset.footLine;
      pane.style.removeProperty("--viewer-foot-room");
    };
  }, []);
  return (
    <div className="citation-pick-line-place">
      <div ref={line} data-testid="citation-pick-line" className="citation-pick-line">
        <p className="citation-pick-line-sentence" title={pick.sentence}>
          {t("claim.chooseCitation.for", { sentence: pick.sentence })}
        </p>
        <div className="citation-pick-line-row">
          <b role="status">
            {t(cells ? "claim.chooseCitation.hintCells" : "claim.chooseCitation.hint")}
          </b>
          <span className="citation-pick-line-actions">
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
          </span>
        </div>
        {picking && other && (
          <CitationDocumentPicker
            anchor={other}
            mindId={pick.mindId}
            onChoose={(documentId) => {
              setPicking(false);
              const group =
                tab === null ? undefined : groupOfTab(useAppStore.getState().layout, tab);
              chooseCitationIn({ ...pick, documentId }, null, group?.group.id);
            }}
            onClose={() => setPicking(false)}
          />
        )}
      </div>
    </div>
  );
}
