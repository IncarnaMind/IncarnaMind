import { useState } from "react";
import type { LinkedFolderLayout, LinkedFolderPreview } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { useLanguage, useT } from "../i18n";
import { folderName, formatBytes, formatCount, formatDuration } from "../linkedFolders";
import { type LinkingFolder, useAppStore } from "../store";
import { FolderLineIcon } from "./lineIcons";
import { ProblemMark } from "./ProblemLine";
import {
  buttonClass,
  choiceListClass,
  choiceRadioClass,
  choiceRowClass,
  choiceTextClass,
  choiceTitleClass,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTitleClass,
  errorTextClass,
  fieldLabelClass,
  primaryButtonClass,
} from "./ui";
import { useModal } from "./useModal";

const LAYOUTS: readonly { value: LinkedFolderLayout; label: MessageKey; hint: MessageKey }[] = [
  {
    value: "tree",
    label: "linkedFolders.preview.layout.tree",
    hint: "linkedFolders.preview.layout.tree.hint",
  },
  {
    value: "flat",
    label: "linkedFolders.preview.layout.flat",
    hint: "linkedFolders.preview.layout.flat.hint",
  },
];

/** A line of the preview: 13/20 in the dialog's secondary ink. */
const factClass = "text-[13px] leading-5 text-ink-secondary";

/**
 * Before a folder is linked (ADR-0010, "Big folders"): its name and path, how
 * many supported files it holds and their size, roughly how long indexing
 * takes on this computer (once files of their kinds have been read here), how
 * many online-only files it would skip, whether it shows as Folders or a flat
 * list (the User's choice, the suggestion picked), and what happens with
 * Linked folders it overlaps (or that it is linked already). Then "Link
 * folder" or "Cancel". Open while the store has a folder `linking`; several
 * dropped at once are asked about in turn.
 */
export function LinkFolderDialog() {
  const linking = useAppStore((state) => state.linking);
  // A dialog of its own for each folder: it starts from that folder's suggested layout.
  return linking && <LinkFolderModal key={linking.path} linking={linking} />;
}

function LinkFolderModal({ linking }: { linking: LinkingFolder }) {
  const t = useT();
  const cancel = useAppStore((state) => state.cancelLinkedFolder);
  const dialog = useModal(true);
  return (
    <dialog
      ref={dialog}
      onClose={cancel}
      data-testid="link-folder-dialog"
      aria-labelledby="link-folder-title"
      className={`${dialogClass} w-[30rem]`}
    >
      <div className={dialogBodyClass}>
        <h2 id="link-folder-title" className={dialogTitleClass}>
          {t(
            linking.preview?.insideLinkedFolderId != null
              ? "linkedFolders.preview.titleLinked"
              : "linkedFolders.preview.title",
          )}
        </h2>
        <LinkFolderForm linking={linking} onCancel={cancel} />
      </div>
    </dialog>
  );
}

function LinkFolderForm({ linking, onCancel }: { linking: LinkingFolder; onCancel(): void }) {
  const t = useT();
  const confirm = useAppStore((state) => state.confirmLinkedFolder);
  const { path, preview, error } = linking;
  const [chosen, setChosen] = useState<LinkedFolderLayout | null>(null);
  const layout = chosen ?? preview?.layout ?? "tree";
  const inside = preview?.insideLinkedFolderId != null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <FolderLineIcon className="mt-0.5 size-4 shrink-0 text-ink-meta" />
        <div className="min-w-0">
          <p data-testid="link-folder-name" className="truncate text-ui font-semibold text-ink">
            {folderName(path)}
          </p>
          <p
            data-testid="link-folder-path"
            title={preview?.path ?? path}
            className="text-[12px] leading-[18px] break-all text-ink-meta"
          >
            {preview?.path ?? path}
          </p>
        </div>
      </div>

      {error ? (
        <p role="alert" className={errorTextClass}>
          <ProblemMark />
          {t("linkedFolders.preview.failed", { message: error })}
        </p>
      ) : preview ? (
        <PreviewFacts preview={preview} />
      ) : (
        <p role="status" className="text-[13px] leading-5 text-ink-meta">
          {t("linkedFolders.preview.counting")}
        </p>
      )}

      {preview && !inside && (
        <fieldset>
          <legend className={`mb-1.5 ${fieldLabelClass}`}>
            {t("linkedFolders.preview.layout")}
          </legend>
          <div className={choiceListClass}>
            {LAYOUTS.map((option) => (
              <label key={option.value} className={choiceRowClass}>
                <input
                  type="radio"
                  name="linked-folder-layout"
                  value={option.value}
                  data-testid={`link-folder-layout-${option.value}`}
                  checked={layout === option.value}
                  onChange={() => setChosen(option.value)}
                  className={choiceRadioClass}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-baseline gap-2">
                    <span className={choiceTitleClass}>{t(option.label)}</span>
                    {preview.layout === option.value && (
                      <span className="text-label font-semibold text-ink-meta">
                        {t("linkedFolders.preview.suggested")}
                      </span>
                    )}
                  </span>
                  <span className={choiceTextClass}>{t(option.hint)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className={dialogActionsClass}>
        {inside ? (
          <button type="button" onClick={onCancel} className={buttonClass}>
            {t("linkedFolders.preview.close")}
          </button>
        ) : (
          <>
            <button type="button" onClick={onCancel} className={buttonClass}>
              {t("linkedFolders.preview.cancel")}
            </button>
            <button
              type="button"
              data-testid="link-folder-confirm"
              disabled={preview === null}
              onClick={() => void confirm(layout)}
              className={primaryButtonClass}
            >
              {t("linkedFolders.preview.confirm")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What linking would take, one fact a line, split by rules: the files and
 * their size, the time, the online-only files skipped, and any overlap with
 * Linked folders. Then that the folder is only ever read.
 */
function PreviewFacts({ preview }: { preview: LinkedFolderPreview }) {
  const t = useT();
  const language = useLanguage();
  const linkedFolders = useAppStore((state) => state.linkedFolders);
  const nameOf = (id: string) => {
    const linked = linkedFolders.find((each) => each.id === id);
    return linked ? folderName(linked.path) : "";
  };
  const count = (n: number) => formatCount(n, language);

  if (preview.insideLinkedFolderId !== null) {
    const owner = linkedFolders.find((each) => each.id === preview.insideLinkedFolderId);
    // The folder itself, linked already, or one inside a Linked folder: either way, nothing to do.
    return owner?.path === preview.path ? (
      <p data-testid="link-folder-inside" className={factClass}>
        {t("linkedFolders.preview.already", { name: folderName(owner.path) })}
      </p>
    ) : (
      <p data-testid="link-folder-inside" className={factClass}>
        {t("linkedFolders.preview.inside", { name: nameOf(preview.insideLinkedFolderId) })}
      </p>
    );
  }

  const merged = preview.containsLinkedFolderIds.map(nameOf).filter((name) => name !== "");
  const { onlineOnly, estimatedSeconds } = preview;
  return (
    <div className="flex flex-col border-y border-rule [&>*+*]:border-t [&>*+*]:border-rule">
      <p data-testid="link-folder-files" className={`py-2 ${factClass}`}>
        {preview.files === 0
          ? t("linkedFolders.preview.noFiles")
          : t(
              preview.files === 1
                ? "linkedFolders.preview.files.one"
                : "linkedFolders.preview.files.other",
              { count: count(preview.files), size: formatBytes(preview.bytes, t) },
            )}
      </p>
      {preview.files > 0 && estimatedSeconds !== null && (
        <p data-testid="link-folder-time" className={`py-2 ${factClass}`}>
          {t("linkedFolders.preview.time", { time: formatDuration(estimatedSeconds, t) })}
        </p>
      )}
      {onlineOnly.files > 0 && (
        <p data-testid="link-folder-online-only" className={`py-2 ${factClass}`}>
          {onlineOnly.files === 1
            ? t("linkedFolders.preview.onlineOnly.one")
            : t("linkedFolders.preview.onlineOnly.other", {
                // No size: an iCloud stub's is its own, not the file's.
                count: count(onlineOnly.files),
              })}
        </p>
      )}
      {merged.length > 0 && (
        <p data-testid="link-folder-merge" className={`py-2 ${factClass}`}>
          {merged.length === 1
            ? t("linkedFolders.preview.merge.one", { names: merged[0] ?? "" })
            : t("linkedFolders.preview.merge.other", {
                names: new Intl.ListFormat(language, { type: "conjunction" }).format(
                  merged.map((name) => `“${name}”`),
                ),
              })}
        </p>
      )}
      <p className="py-2 text-[13px] leading-5 text-ink-meta">
        {t("linkedFolders.preview.readOnly")}
      </p>
    </div>
  );
}
