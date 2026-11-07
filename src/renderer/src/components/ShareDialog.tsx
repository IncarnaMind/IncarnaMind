import { type FormEvent, useEffect, useState } from "react";
import type { Mind, SharePagePreferences, SharePagePreview } from "../../../core/api";
import { core } from "../core";
import { errorMessage } from "../errors";
import { exportMind, exportPreferences } from "../exports";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { CloseLineIcon } from "./lineIcons";
import { ProblemLine } from "./ProblemLine";
import { SharePageContents } from "./SharePageContents";
import { SwitchRow } from "./SwitchRow";
import {
  buttonClass,
  dialogActionsClass,
  dialogTitleClass,
  primaryButtonClass,
  ruledListClass,
  tabSheetClass,
} from "./ui";
import { useModal } from "./useModal";

/**
 * The Share sheet (#1258): "Share as a web page…" opens it from Export › More formats and ⌘K,
 * with only what sharing needs. Save writes the file as an export does and leaves the Saved
 * line; what a reader gets from the page is unchanged (#72).
 */
export function ShareDialog({ mind, onClose }: { mind: Mind | null; onClose(): void }) {
  const dialog = useModal(mind !== null);
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      data-testid="share-dialog"
      aria-labelledby="share-title"
      className={tabSheetClass}
    >
      {mind && <SharePageForm mind={mind} onDone={onClose} />}
    </dialog>
  );
}

function SharePageForm({ mind, onDone }: { mind: Mind; onDone(): void }) {
  const t = useT();
  const [draft, setDraft] = useState<SharePagePreferences>(() => exportPreferences()["share-page"]);
  const [shared, setShared] = useState<SharePagePreview | null>(null);
  const [textOnly, setTextOnly] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const preferences = exportPreferences();
    core
      .previewSharePage(mind.id, {
        format: "share-page",
        ...preferences["share-page"],
        theirChanges: preferences.theirChanges ?? "shown",
      })
      .then(
        (preview) => {
          if (!current) return;
          setShared(preview);
          setTextOnly(
            (kept) =>
              kept ??
              new Set(
                preview.documents.filter((each) => each.textOnly).map((each) => each.documentId),
              ),
          );
        },
        (error: unknown) => useAppStore.getState().reportError(error),
      );
    return () => {
      current = false;
    };
  }, [mind.id]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setProblem(null);
    try {
      const settings = await core.updateSettings({
        user: { exportOptions: { ...exportPreferences(), "share-page": draft } },
      });
      useAppStore.setState({ settings });
      const before = shared?.documents
        .filter((each) => each.textOnly)
        .map((each) => each.documentId);
      if (
        textOnly &&
        before &&
        (before.length !== textOnly.size || before.some((id) => !textOnly.has(id)))
      ) {
        await core.setSharePageTextOnly(mind.id, [...textOnly]);
      }
      onDone();
      await exportMind(mind.id, "share-page");
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} className="flex min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 pt-4 pr-4 pb-2.5 pl-6">
        <h2 id="share-title" className={dialogTitleClass}>
          {t("export.share.title")}
        </h2>
        <button
          type="button"
          data-testid="share-close"
          aria-label={t("export.options.close")}
          title={t("export.options.close")}
          onClick={onDone}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-hover hover:text-ink"
        >
          <CloseLineIcon className="size-4" />
        </button>
      </header>

      <div
        data-testid="share-dialog-body"
        className={`mx-6 min-h-0 overflow-y-auto ${ruledListClass}`}
      >
        <SwitchRow
          label={t("export.share.cards")}
          hint={t("export.share.cards.hint")}
          checked={draft.citationCards}
          onChange={(citationCards) => setDraft({ ...draft, citationCards })}
          testId="export-citation-cards"
        />
        {draft.citationCards && shared && textOnly && (
          <SharePageContents preview={shared} textOnly={textOnly} onChange={setTextOnly} />
        )}
      </div>

      {problem && (
        <ProblemLine testId="share-problem" className="mx-6 mt-3 shrink-0">
          {t("export.failed.options", { reason: problem })}
        </ProblemLine>
      )}

      <div className={`${dialogActionsClass} shrink-0 px-6 pt-5 pb-6`}>
        <span className="mr-auto min-w-0 text-[12.5px] leading-[18px] text-ink-meta">
          {t("export.share.nothing")}
        </span>
        <button type="button" onClick={onDone} className={buttonClass}>
          {t("export.cancel")}
        </button>
        <button
          type="submit"
          data-testid="share-save"
          disabled={saving}
          className={primaryButtonClass}
        >
          {t("export.share.save")}
        </button>
      </div>
    </form>
  );
}
