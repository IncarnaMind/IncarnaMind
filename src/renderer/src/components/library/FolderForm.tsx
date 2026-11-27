import { useEffect, useRef, useState } from "react";
import type { LibraryGroup } from "../../../../core/api";
import { libraryPresetKeys } from "../../../../shared/libraryPresets";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { translateNow, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ProblemMark } from "../ProblemLine";
import { TypingTextarea } from "../TypingTextarea";
import { buttonStyle, errorTextClass, fieldLabelClass, inputClass } from "../ui";

/** Runs a change to the Library, then reads it again; says what went wrong, in place. */
function useLibraryAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await work();
      await useAppStore.getState().refreshLibrary();
      return true;
    } catch (failure) {
      setError(errorMessage(failure, translateNow));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, act };
}

/**
 * A Folder's name, description and evidence choice (#80), edited from its ⋯
 * (Edit description…).
 */
export function FolderForm({
  group,
  close,
  className = "",
}: {
  group: LibraryGroup;
  close(): void;
  className?: string;
}) {
  const t = useT();
  const { busy, error, act } = useLibraryAction();
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInput.current?.focus();
  }, []);
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description);
  const [countsOwnFiles, setCountsOwnFiles] = useState(group.countsOwnFiles);
  // Settings counts IncarnaMind's files everywhere: there's nothing for a folder to switch.
  const leftOut = useAppStore((state) => state.settings?.user.leaveOutOwnFiles ?? true);
  return (
    <form
      data-testid="folder-form"
      className={`max-w-xl border-y border-rule py-4 ${className}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        close();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void act(async () => {
          await useAppStore.getState().editFolder(group.id, { name, description, countsOwnFiles });
          close();
        });
      }}
    >
      <label className={fieldLabelClass}>
        {t("library.name")}
        <input
          ref={nameInput}
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={inputClass}
        />
      </label>
      <label className={`${fieldLabelClass} mt-3`}>
        {t("library.description")}
        <TypingTextarea
          rows={2}
          maxLength={500}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t("library.descriptionHint")}
          className={inputClass}
        />
      </label>
      {/* Checks leave the files IncarnaMind wrote out of their evidence; a folder can count them (#80). */}
      <label className="mt-3 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          data-testid="folder-counts-own-files"
          checked={leftOut ? countsOwnFiles : true}
          disabled={!leftOut}
          onChange={(event) => setCountsOwnFiles(event.target.checked)}
          className="mt-1 size-4 shrink-0 accent-ink"
        />
        <span>
          <span className="text-ink">{t("library.countsOwnFiles")}</span>
          <span className="block text-ui text-ink-meta">
            {t(leftOut ? "library.countsOwnFiles.hint" : "library.countsOwnFiles.everywhere")}
          </span>
        </span>
      </label>
      {error && (
        <p role="alert" className={`${errorTextClass} mt-3`}>
          <ProblemMark />
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={busy || !name.trim()} className={buttonStyle("primary")}>
          {t("library.save")}
        </button>
        <button type="button" className={buttonStyle("ghost")} onClick={close}>
          {t("library.cancel")}
        </button>
      </div>
    </form>
  );
}

export function StarterFolders({ close }: { close(): void }) {
  const t = useT();
  const { busy, error, act } = useLibraryAction();
  const [chosen, setChosen] = useState<string[]>([...libraryPresetKeys]);
  return (
    <section
      aria-label={t("library.chooseStarters")}
      className="mt-4 max-w-xl border-y border-rule py-4"
    >
      <h2 className="mb-1">{t("library.chooseStarters")}</h2>
      <p className="mb-3 text-ui text-ink-meta">{t("library.startersHint")}</p>
      {libraryPresetKeys.map((key) => (
        <label key={key} className="flex cursor-pointer items-start gap-3 py-2">
          <input
            type="checkbox"
            checked={chosen.includes(key)}
            onChange={(event) =>
              setChosen(
                event.target.checked ? [...chosen, key] : chosen.filter((item) => item !== key),
              )
            }
            className="mt-1 size-4 accent-ink"
          />
          <span>
            <span>{t(`library.preset.${key}`)}</span>
            <span className="block text-ui text-ink-meta">
              {t(`library.preset.${key}.description`)}
            </span>
          </span>
        </label>
      ))}
      {error && (
        <p role="alert" className={`${errorTextClass} mt-2`}>
          <ProblemMark />
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy || chosen.length === 0}
          className={buttonStyle("primary")}
          onClick={() =>
            void act(async () => {
              await core.addLibraryStarterGroups(chosen);
              close();
            })
          }
        >
          {t("library.addSelected")}
        </button>
        <button type="button" className={buttonStyle("ghost")} onClick={close}>
          {t("library.cancel")}
        </button>
      </div>
    </section>
  );
}
