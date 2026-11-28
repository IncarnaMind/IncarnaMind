import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { CopyLineIcon } from "../icons";

/** Copies a request's words as the User sent them. */
export function CopyRequest({ words }: { words: string }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="note-column-copy-request"
      aria-label={t("noteColumn.copy")}
      title={t("noteColumn.copy")}
      onClick={() =>
        void navigator.clipboard.writeText(words).catch(useAppStore.getState().reportError)
      }
      className="note-column-icon"
    >
      <CopyLineIcon />
    </button>
  );
}
