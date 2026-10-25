import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { Tag } from "../../../core/api";
import { nextTagColour, type TagColour } from "../../../shared/tagColours";
import { core } from "../core";
import { errorMessage } from "../errors";
import { useLanguage, useT } from "../i18n";
import { formatCount } from "../linkedFolders";
import { matchName, queryWords } from "../matcher";
import { useRequests } from "../requests";
import { useAppStore } from "../store";
import { deleteTag, editTag, mergeTags } from "../tagChanges";
import { MergeLineIcon, PencilLineIcon, TrashLineIcon } from "./lineIcons";
import { ProblemMark } from "./ProblemLine";
import { TagColourPicker, tagChipColour } from "./TagColour";
import { TypingTextarea } from "./TypingTextarea";
import {
  buttonClass,
  dialogActionsClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
  errorTextClass,
  fieldLabelClass,
  ghostButtonClass,
  hintClass,
  iconButtonClass,
  inputClass,
  primaryButtonClass,
  ruledListClass,
  sectionTitleClass,
} from "./ui";
import { useModal } from "./useModal";

/** Runs a change, showing its failure in the dialog. Resolves with whether it worked. */
type Run = (action: () => Promise<unknown>) => Promise<boolean>;

/** How many Documents carry each Tag, and how many of those await review. */
interface Usage {
  count: number;
  review: number;
}

/**
 * Managing Tags, in a native modal <dialog>: each Tag's name, description and
 * how many Documents carry it (a click shows them in the Library), in rows
 * split by rules, to edit, merge into another Tag, or delete; a field to find
 * one; a form for a new one; and "Re-tag all Documents". The list follows the
 * core's "tags.changed" event, and the counts the Documents' Tags.
 */
export function TagsDialog() {
  const t = useT();
  const open = useAppStore((state) => state.tagsDialogOpen);
  const closeDialog = useAppStore((state) => state.closeTagsDialog);
  const close = () => {
    useRequests.getState().clear("manageTag");
    closeDialog();
  };
  const tags = useAppStore((state) => state.tags);
  const documents = useAppStore((state) => state.documents);
  const dialog = useModal(open);
  const [error, setError] = useState<string | null>(null);
  const [retagStarted, setRetagStarted] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    setError(null);
    setRetagStarted(false);
    setSearch("");
  }, [open]);

  const usage = useMemo(() => {
    const counts = new Map<string, Usage>();
    for (const document of documents)
      for (const link of document.tags) {
        const each = counts.get(link.tagId) ?? { count: 0, review: 0 };
        each.count++;
        if (link.needsReview) each.review++;
        counts.set(link.tagId, each);
      }
    return counts;
  }, [documents]);

  const run: Run = async (action) => {
    setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(errorMessage(failure, t));
      return false;
    }
  };

  const words = queryWords(search);
  const shown =
    words.length === 0
      ? tags
      : tags.filter((tag) => {
          const match = matchName(words, `${tag.name} ${tag.description}`);
          return match !== null && !match.typo;
        });

  return (
    <dialog
      ref={dialog}
      onClose={close}
      data-testid="tags-dialog"
      aria-labelledby="tags-title"
      className={`${dialogClass} w-[38rem]`}
    >
      <div className="flex flex-col gap-5 px-6 pt-6 pb-5">
        <div className="flex flex-col gap-2">
          <h2 id="tags-title" className={dialogTitleClass}>
            {t("tags.title")}
          </h2>
          {open && <p className={dialogTextClass}>{t("tags.dialog.body")}</p>}
        </div>
        {/* Rendered only while open, so forms start empty each time. */}
        {open && (
          <>
            {tags.length > 6 && (
              <input
                type="search"
                data-testid="tag-search"
                aria-label={t("tags.dialog.search")}
                placeholder={t("tags.dialog.search")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className={`${inputClass} mt-0`}
              />
            )}
            {tags.length === 0 ? (
              <p className="text-[13px] leading-5 text-ink-meta">{t("tags.dialog.empty")}</p>
            ) : shown.length === 0 ? (
              <p className="text-[13px] leading-5 text-ink-meta">{t("tags.dialog.noMatch")}</p>
            ) : (
              <ul className={ruledListClass}>
                {shown.map((tag) => (
                  <TagRow
                    key={tag.id}
                    tag={tag}
                    tags={tags}
                    usage={usage.get(tag.id) ?? { count: 0, review: 0 }}
                    run={run}
                  />
                ))}
              </ul>
            )}
            <NewTag run={run} />
            {error && (
              <p role="alert" className={errorTextClass}>
                <ProblemMark />
                {error}
              </p>
            )}
            <section className="flex flex-col items-start gap-1 border-t border-rule pt-4">
              <button
                type="button"
                data-testid="retag-all"
                onClick={async () => {
                  if (await run(() => core.retagDocuments())) setRetagStarted(true);
                }}
                className={buttonClass}
              >
                {t("tags.dialog.retag")}
              </button>
              <p className={hintClass} role={retagStarted ? "status" : undefined}>
                {t(retagStarted ? "tags.dialog.retag.started" : "tags.dialog.retag.hint")}
              </p>
            </section>
          </>
        )}
        <div className={dialogActionsClass}>
          <button type="button" onClick={close} className={primaryButtonClass}>
            {t("tags.dialog.done")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function TagRow({
  tag,
  tags,
  usage,
  run,
}: {
  tag: Tag;
  tags: readonly Tag[];
  usage: Usage;
  run: Run;
}) {
  const t = useT();
  const language = useLanguage();
  const asked = useRequests((state) => state.manageTag);
  const [mode, setMode] = useState<"view" | "edit" | "merge">(
    asked?.id === tag.id ? "edit" : "view",
  );
  const [into, setInto] = useState("");

  if (mode === "edit") {
    return (
      <li data-testid="tag-row" data-tag-id={tag.id} className="py-3">
        <TagForm
          initial={tag}
          submitLabel={t("tags.dialog.save")}
          note={t("tags.dialog.descriptionNote")}
          onSubmit={async (name, description, colour) => {
            if (await run(() => editTag(tag.id, { name, description, colour }))) setMode("view");
          }}
          onCancel={() => setMode("view")}
        />
      </li>
    );
  }

  if (mode === "merge") {
    const target = tags.find((each) => each.id === into);
    return (
      <li data-testid="tag-row" data-tag-id={tag.id} className="flex flex-col gap-2 py-3">
        <label className={fieldLabelClass}>
          {t("tags.dialog.merge.label", { name: tag.name })}
          <select
            data-testid="merge-target"
            value={into}
            onChange={(event) => setInto(event.target.value)}
            className={inputClass}
          >
            <option value="">{t("tags.dialog.merge.choose")}</option>
            {tags
              .filter((each) => each.id !== tag.id)
              .map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
          </select>
        </label>
        {target && (
          <p className={hintClass}>
            {t("tags.dialog.merge.body", { name: tag.name, into: target.name })}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setMode("view")} className={ghostButtonClass}>
            {t("tags.dialog.cancel")}
          </button>
          <button
            type="button"
            data-testid="confirm-merge-tag"
            disabled={!target}
            onClick={() => void run(() => mergeTags(tag.id, into))}
            className={buttonClass}
          >
            {t("tags.dialog.merge.confirm")}
          </button>
        </div>
      </li>
    );
  }

  return (
    <li data-testid="tag-row" data-tag-id={tag.id} className="flex items-start gap-2 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 text-ui font-semibold break-words text-ink">
          <span
            data-testid="tag-row-name"
            data-colour={tag.colour}
            className={`inline-flex min-h-6 max-w-full items-center rounded-sm px-2 ${tagChipColour(tag.colour)}`}
          >
            {tag.name}
          </span>
          {tag.preset && (
            <span className="text-label font-semibold text-ink-meta">
              {t("tags.dialog.preset")}
            </span>
          )}
        </p>
        {tag.description && (
          <p className="text-[13px] leading-5 break-words text-ink-secondary">{tag.description}</p>
        )}
      </div>
      <button
        type="button"
        data-testid="tag-count"
        data-count={usage.count}
        disabled={usage.count === 0}
        aria-label={t("tags.dialog.show", { name: tag.name })}
        title={t("tags.dialog.show", { name: tag.name })}
        onClick={() => {
          const store = useAppStore.getState();
          store.setTagFilter([tag.id]);
          store.closeTagsDialog();
          store.openLibrary();
        }}
        className="mt-1 shrink-0 rounded-sm px-1 text-right text-[12px] leading-5 text-ink-meta tabular-nums hover:text-ink hover:underline disabled:hover:no-underline"
      >
        {usage.count === 1
          ? t("tags.dialog.count.one")
          : t("tags.dialog.count", { count: formatCount(usage.count, language) })}
        {usage.review > 0 && (
          <span className="block">{t("tags.dialog.toReview", { count: usage.review })}</span>
        )}
      </button>
      <button
        type="button"
        data-testid="edit-tag"
        aria-label={t("tags.dialog.edit", { name: tag.name })}
        title={t("tags.dialog.edit", { name: tag.name })}
        onClick={() => setMode("edit")}
        className={iconButtonClass}
      >
        <PencilLineIcon className="size-4" />
      </button>
      {tags.length > 1 && (
        <button
          type="button"
          data-testid="merge-tag"
          aria-label={t("tags.dialog.merge", { name: tag.name })}
          title={t("tags.dialog.merge", { name: tag.name })}
          onClick={() => setMode("merge")}
          className={iconButtonClass}
        >
          <MergeLineIcon className="size-4" />
        </button>
      )}
      <button
        type="button"
        data-testid="delete-tag"
        aria-label={t("tags.dialog.delete", { name: tag.name })}
        title={t("tags.dialog.delete", { name: tag.name })}
        onClick={() => void run(() => deleteTag(tag.id))}
        className={iconButtonClass}
      >
        <TrashLineIcon className="size-4" />
      </button>
    </li>
  );
}

/** The form for a new Tag; it empties after each Tag added. */
function NewTag({ run }: { run: Run }) {
  const t = useT();
  const [added, setAdded] = useState(0);
  const tags = useAppStore((state) => state.tags);
  return (
    <section className="flex flex-col gap-2">
      <h3 className={sectionTitleClass}>{t("tags.dialog.new")}</h3>
      <TagForm
        key={added}
        initial={{
          name: "",
          description: "",
          colour: nextTagColour(tags.map((tag) => tag.colour)),
        }}
        submitLabel={t("tags.dialog.create")}
        note={t("tags.dialog.descriptionNote")}
        onSubmit={async (name, description, colour) => {
          if (await run(() => core.createTag({ name, description, colour })))
            setAdded((n) => n + 1);
        }}
      />
    </section>
  );
}

function TagForm(props: {
  initial: { name: string; description: string; colour: TagColour };
  submitLabel: string;
  /** Under the description: what it is for. */
  note: string;
  onSubmit(name: string, description: string, colour: TagColour): Promise<void>;
  onCancel?(): void;
}) {
  const { initial, submitLabel, note, onSubmit, onCancel } = props;
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [colour, setColour] = useState<TagColour>(initial.colour);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(name, description, colour);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <label className={fieldLabelClass}>
        {t("tags.dialog.name")}
        <input
          value={name}
          data-testid="tag-name-input"
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          className={inputClass}
        />
      </label>
      <label className={fieldLabelClass}>
        {t("tags.dialog.description")}
        <TypingTextarea
          value={description}
          data-testid="tag-description-input"
          maxLength={500}
          rows={2}
          placeholder={t("tags.dialog.descriptionPlaceholder")}
          onChange={(event) => setDescription(event.target.value)}
          className={`${inputClass} resize-y`}
        />
        <span className={hintClass}>{note}</span>
      </label>
      <TagColourPicker value={colour} onChange={setColour} />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className={ghostButtonClass}>
            {t("tags.dialog.cancel")}
          </button>
        )}
        <button
          type="submit"
          data-testid="save-tag"
          disabled={!name.trim() || busy}
          className={buttonClass}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
