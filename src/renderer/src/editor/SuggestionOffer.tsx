import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { useGap, useT } from "../i18n";
import { useAppStore } from "../store";
import { declineOffer, useSuggestionOffer } from "../suggestions";

const lineClass = "composer-problem font-sans text-[13px] leading-5 break-words text-ink-meta";
const actionClass =
  "rounded-sm font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent";

/**
 * The offer to suggest as the User writes, where they write, the once it
 * helps: a question with Turn on · Not now. Turn on asks for consent first
 * (the core does, naming the provider), then says how suggestions work; Not
 * now never offers again in this Mind. Either way the cursor goes back to the
 * note.
 */
export function SuggestionOffer({
  mindId,
  doc,
  editor,
}: {
  mindId: string;
  doc: Y.Doc;
  editor: Editor;
}) {
  const t = useT();
  const gap = useGap();
  const line = useSuggestionOffer((state) =>
    state.shown?.mindId === mindId ? state.shown.line : null,
  );
  if (!line) return null;

  const backToNote = () => {
    if (!editor.isDestroyed) editor.view.focus();
  };

  if (line === "on") {
    return (
      <p role="status" data-testid="suggestion-offer-on" className={lineClass}>
        {t("suggestion.offer.on")}
      </p>
    );
  }

  const turnOn = async () => {
    await useAppStore.getState().updateSettings({ user: { suggestWhileWriting: true } });
    const on = useAppStore.getState().settings?.user.suggestWhileWriting ?? false;
    // Declined (the consent, or a problem saving): the line goes, and suggestions stay off.
    useSuggestionOffer.setState({ shown: on ? { mindId, line: "on" } : null });
    backToNote();
  };

  return (
    <p role="status" data-testid="suggestion-offer" className={lineClass}>
      <span>{t("suggestion.offer")}</span>
      {gap(t("suggestion.offer"), t("suggestion.offer.turnOn"))}
      <button
        type="button"
        data-testid="suggestion-offer-turn-on"
        onClick={() => void turnOn()}
        className={actionClass}
      >
        {t("suggestion.offer.turnOn")}
      </button>
      <span aria-hidden="true"> · </span>
      <button
        type="button"
        data-testid="suggestion-offer-not-now"
        onClick={() => {
          declineOffer(doc);
          useSuggestionOffer.setState({ shown: null });
          backToNote();
        }}
        className={actionClass}
      >
        {t("suggestion.offer.notNow")}
      </button>
    </p>
  );
}
