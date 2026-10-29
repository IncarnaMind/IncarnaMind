import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { openClaimCard, setCheckCardOpen } from "../checks";
import { openFigureSchedule } from "../figures";
import { useAppStore } from "../store";
import { shownClaims } from "./claimChecks";

/**
 * Puts the cursor at `at` and opens the card of the claim there: a chart's figure schedule for a
 * chart's. A Citation's place (`cited`) is just after its marker, where its state shows, so a key
 * can't take the Citation away, and opens no card. The place is centred by its own position, not
 * its paragraph's, which can be taller than the page, and clear of the fade and the badge at the
 * page's foot. `focusCard`: the keyboard goes into the card.
 */
export function goToClaim(
  editor: Editor,
  {
    mindId,
    place,
    at,
    cited = false,
    focusCard = false,
  }: { mindId: string; place: string; at: number; cited?: boolean; focusCard?: boolean },
): void {
  if (editor.isDestroyed) return;
  const { doc } = editor.state;
  const pos = Math.min(at, doc.content.size);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(doc.resolve(pos))));
  editor.view.focus();
  const scroller = editor.view.dom.closest(".mind-scroller");
  if (scroller) {
    const caret = editor.view.coordsAtPos(cited ? pos - 1 : pos);
    const area = scroller.getBoundingClientRect();
    scroller.scrollTop += (caret.top + caret.bottom) / 2 - (area.top + area.bottom) / 2;
  }
  const claim = cited
    ? undefined
    : shownClaims(editor.state).find((each) => each.sentence.from <= pos && pos < each.sentence.to);
  if (!claim) return;
  if (claim.kind === "chart") {
    setCheckCardOpen(place, false);
    void openFigureSchedule(mindId).catch(useAppStore.getState().reportError);
    return;
  }
  openClaimCard(place, claim.check.id, { focus: focusCard });
}
