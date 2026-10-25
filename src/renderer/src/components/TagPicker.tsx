import {
  type KeyboardEvent,
  type ReactNode,
  type ToggleEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import type { Document, DocumentTag, Tag } from "../../../core/api";
import { pressesShortcut } from "../commands/keymap";
import { errorMessage } from "../errors";
import { useT } from "../i18n";
import { type Box, enterFrom, exitToward } from "../motion";
import { useAppStore } from "../store";
import { actionFor, pickerOptions, type TagOnDocuments, tagsOnDocuments } from "../tagEditing";
import { useUndo } from "../undo";
import { CheckLineIcon, CloseLineIcon, PlusLineIcon, SparkLineIcon } from "./lineIcons";
import { ProblemMark } from "./ProblemLine";
import { ReviewRing, TagDot, tagChipColour } from "./TagColour";
import { TypingTextarea } from "./TypingTextarea";
import { buttonStyle, errorTextClass, hintClass, inputClass, menuRuleClass } from "./ui";

const GAP_PX = 4;
const EDGE_PX = 8;
const COVER_INSET_PX = 4;

/**
 * Below its button, or above it if the window is too short; kept inside the
 * window. A popover not showing yet has no size, so it is laid out for a
 * moment to measure it as it will show (as `usePopoverMenu` does). Returns
 * where it put it.
 */
function place(
  button: HTMLElement | null,
  popover: HTMLElement | null,
  cover: HTMLElement | null = null,
): Box | null {
  const anchor = (cover ?? button)?.getBoundingClientRect();
  if (!anchor || !popover) return null;
  const hidden = !popover.matches(":popover-open");
  if (hidden) popover.style.display = "block";
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  if (hidden) popover.style.removeProperty("display");
  const bottomEdge = window.innerHeight - EDGE_PX;
  // Over what it covers, its field where the cell's Tags were, as a Notion database's cell opens.
  const start = cover ? anchor.left - COVER_INSET_PX : anchor.left;
  const left = Math.max(EDGE_PX, Math.min(start, window.innerWidth - width - EDGE_PX));
  const below = cover ? anchor.top - COVER_INSET_PX : anchor.bottom + GAP_PX;
  const top =
    below + height <= bottomEdge
      ? below
      : cover
        ? Math.max(EDGE_PX, bottomEdge - height)
        : Math.max(EDGE_PX, anchor.top - GAP_PX - height);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  return { left, top, width, height };
}

/** Focuses the picker's field (or the description field while describing a new Tag). */
const focusFieldIn = (popover: HTMLElement | null) =>
  popover?.querySelector<HTMLElement>("[data-picker-field]")?.focus();

/**
 * A popover that opens from a button, like `usePopoverMenu`, for the Tag
 * picker: it takes the focus into its field, Esc closes only it, and a
 * click outside closes it. Given `cover`, it opens over that element (a
 * row's Tags cell) instead of under the button.
 */
export function useTagPopover({ cover }: { cover?: () => HTMLElement | null } = {}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const covered = useRef(cover);
  covered.current = cover;
  // Where the focus was when it opened (its button, or the row T was pressed on), to go back to.
  const returnTo = useRef<HTMLElement | null>(null);
  const giveBackFocus = () =>
    (returnTo.current?.isConnected ? returnTo.current : button.current)?.focus();

  // Once rendered with the picker, and before it is drawn: placed, so it shows where it
  // belongs from the first frame, growing from its button. It takes the focus once it shows
  // (here or on `toggle`).
  useLayoutEffect(() => {
    if (!open) return;
    const over = covered.current?.() ?? null;
    const box = place(button.current, popover.current, over);
    if (popover.current && box) enterFrom(popover.current, over ?? button.current, box);
    if (popover.current?.matches(":popover-open")) focusFieldIn(popover.current);
  }, [open]);

  return {
    open,
    close() {
      popover.current?.hidePopover();
      giveBackFocus();
    },
    /** Places it again, e.g. after its height changed. */
    reposition: () => {
      place(button.current, popover.current, covered.current?.() ?? null);
    },
    buttonProps: {
      ref: button,
      popoverTarget: id,
      "aria-haspopup": "dialog" as const,
      "aria-expanded": open,
    },
    popoverProps: {
      ref: popover,
      id,
      popover: "auto" as const,
      onBeforeToggle: (event: ToggleEvent<HTMLDivElement>) => {
        if (event.newState === "closed" && popover.current) {
          exitToward(popover.current, button.current);
        }
        if (event.newState === "open") {
          const focus = document.activeElement;
          returnTo.current = focus instanceof HTMLElement && focus !== document.body ? focus : null;
        }
        setOpen(event.newState === "open");
      },
      // Now it shows, where it was placed: it can take the focus.
      onToggle: (event: ToggleEvent<HTMLDivElement>) => {
        if (event.newState === "open") focusFieldIn(popover.current);
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        // Here, so the Document viewer's Esc doesn't close it too.
        event.preventDefault();
        popover.current?.hidePopover();
        giveBackFocus();
      },
    },
  };
}

/** The popover's look: a menu's, a little wider, with room for the field. */
export const tagPopoverClass =
  "inset-auto m-0 w-[360px] max-w-[calc(100vw-16px)] overflow-visible rounded-lg border-0 bg-sheet p-0 text-ui font-normal text-ink shadow-popover";

/** A chip's shape in the picker's field and on a row: 20px, radius 4. Its colours are its Tag's. */
export const chipClass =
  "inline-flex h-5 max-w-[10rem] shrink-0 items-center gap-1 rounded-sm px-1.5 text-[12px] leading-5";

/**
 * A Tag's tooltip on one Document: who added it and, when automatic tagging
 * said, how likely it is, or that it awaits review.
 */
export function chipTitle(
  link: Pick<DocumentTag, "source" | "confidence" | "needsReview">,
  tag: Pick<Tag, "name">,
  t: ReturnType<typeof useT>,
): string {
  const percent = link.confidence === null ? null : Math.round(link.confidence * 100);
  if (link.needsReview)
    return percent === null
      ? t("tags.chip.reviewTitle", { tag: tag.name })
      : t("jev.chip.review", { tag: tag.name, percent });
  if (link.source === "user") return t("tags.chip.user", { tag: tag.name });
  return percent === null
    ? t("tags.chip.automatic", { tag: tag.name })
    : t("jev.chip.likely", { tag: tag.name, percent });
}

/** The tooltip of a Tag in the picker's field, on one Document. */
const stateTitle = (state: TagOnDocuments, t: ReturnType<typeof useT>) =>
  chipTitle(
    {
      source: state.automatic ? "automatic" : "user",
      confidence: state.confidence,
      needsReview: state.needsReview,
    },
    state.tag,
    t,
  );

/** The amber dot of a Tag awaiting the User's review, inside its chip (DESIGN.md: `attention`). */
export function ReviewDot() {
  return <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-attention" />;
}

const undoStepOf = (event: KeyboardEvent) =>
  pressesShortcut("edit.undo", event.nativeEvent)
    ? "undo"
    : pressesShortcut("edit.redo", event.nativeEvent)
      ? "redo"
      : null;

/**
 * Edits the Tags of one Document or several, keyboard first: type to filter,
 * ↑↓ to move, Enter to add (or, on one Document, to confirm a Tag awaiting
 * review, or to take off one it has), Backspace in the empty field to pick
 * the last Tag and again to take it off, × on a Tag to take it off, ⌘Z in
 * the empty field to take back the last change. A name no Tag has is
 * created, optionally with a description (Shift+Enter), and added. With
 * several Documents, a Tag some of them have is added to all.
 */
export function TagPicker({
  documentIds,
  label,
  footer,
  onReposition,
}: {
  documentIds: readonly string[];
  /** Says what is edited, for screen readers. */
  label: string;
  /** More actions under the list (re-tag, manage). */
  footer?: ReactNode;
  /** The popover's height changed. */
  onReposition?(): void;
}) {
  const t = useT();
  const listId = useId();
  const tags = useAppStore((state) => state.tags);
  const documents = useAppStore(
    useShallow((state) =>
      documentIds.flatMap((id) => state.documents.find((each) => each.id === id) ?? []),
    ),
  );
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [describing, setDescribing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const states = useMemo(() => tagsOnDocuments(tags, documents), [tags, documents]);
  const { matches, create } = pickerOptions(states, query);
  const options: ({ kind: "tag"; state: TagOnDocuments } | { kind: "create"; name: string })[] = [
    ...matches.map((state) => ({ kind: "tag" as const, state })),
    ...(create ? [{ kind: "create" as const, name: create }] : []),
  ];
  const applied = states.filter((state) => state.coverage === "all");
  const ids = documents.map((document) => document.id);
  const single = ids.length === 1;
  const names = documents.map((document) => document.name).join(", ");
  const current = Math.min(active, options.length - 1);

  // The list's length changes the popover's height: place it again, before it is drawn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placing follows the visible rows.
  useLayoutEffect(() => onReposition?.(), [options.length, describing, applied.length, error]);

  // Back from describing a new Tag (created or not): the field has the keys again.
  useEffect(() => {
    if (describing === null) field.current?.focus();
  }, [describing]);

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(errorMessage(failure, t));
    }
  };
  const store = useAppStore.getState;
  const add = (tagId: string) =>
    single
      ? store().addDocumentTag(ids[0] as string, tagId)
      : store().addTagToDocuments(ids, tagId);
  const remove = (tagId: string) =>
    single
      ? store().removeDocumentTag(ids[0] as string, tagId)
      : store().removeTagFromDocuments(ids, tagId);

  // The field empties at once, so keys typed while the change is saved go to the next Tag.
  const choose = (state: TagOnDocuments) => {
    setQuery("");
    setPicked(null);
    return run(async () => {
      if (actionFor(state) === "remove") await remove(state.tag.id);
      else await add(state.tag.id);
      field.current?.focus();
    });
  };
  const createTag = (name: string, description = "") => {
    setQuery("");
    setActive(0);
    return run(async () => {
      try {
        const tag = await store().createTag(name, description);
        await add(tag.id);
      } catch (failure) {
        // Not created (e.g. the name is taken): the name comes back to correct.
        setQuery(name);
        throw failure;
      }
      setDescribing(null);
      field.current?.focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + options.length) % options.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = options[current];
      if (!option) return;
      if (option.kind === "create") {
        if (event.shiftKey) setDescribing(option.name);
        else void createTag(option.name);
      } else void choose(option.state);
      return;
    }
    // An empty field has nothing of its own to take back: ⌘Z takes back the last change to the Tags.
    const step = query === "" ? undoStepOf(event) : null;
    if (step) {
      event.preventDefault();
      setPicked(null);
      void run(() => useUndo.getState()[step]());
      return;
    }
    if (event.key === "Backspace" && query === "") {
      const last = applied.at(-1);
      if (!last) return;
      event.preventDefault();
      if (picked === last.tag.id) {
        void run(async () => {
          await remove(last.tag.id);
          setPicked(null);
        });
      } else setPicked(last.tag.id);
      return;
    }
    if (event.key !== "Shift") setPicked(null);
  };

  if (describing !== null)
    return (
      <DescribeTag
        name={describing}
        error={error}
        onCreate={(description) => void createTag(describing, description)}
        onBack={() => {
          setDescribing(null);
          setError(null);
        }}
      />
    );

  const activeId = options[current] ? `${listId}-${current}` : undefined;
  return (
    <div data-testid="tag-picker" className="flex flex-col">
      {/* The Tags on every Document edited, then the field. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a click on the field's empty space focuses the field, which has the keys. */}
      <div
        className="flex max-h-28 min-h-10 flex-wrap items-center gap-1 overflow-y-auto border-b border-rule px-2 py-1.5"
        onClick={() => field.current?.focus()}
      >
        {applied.map((state) => (
          <span
            key={state.tag.id}
            data-testid="tag-token"
            data-tag-id={state.tag.id}
            data-colour={state.tag.colour}
            data-source={state.automatic ? "automatic" : "user"}
            data-needs-review={state.needsReview && single ? "true" : undefined}
            title={single ? stateTitle(state, t) : state.tag.description || undefined}
            className={`${chipClass} ${tagChipColour(state.tag.colour)} pr-0.5 ${
              picked === state.tag.id ? "shadow-[inset_0_0_0_1px_currentColor]" : ""
            }`}
          >
            {state.needsReview && single && <ReviewDot />}
            {state.automatic && !(state.needsReview && single) && (
              <SparkLineIcon aria-hidden="true" className="size-2.5 shrink-0 opacity-70" />
            )}
            <span className="truncate">{state.tag.name}</span>
            {state.needsReview && single && (
              <span className="sr-only">{t("jev.chip.needsReview")}</span>
            )}
            {state.needsReview && single && (
              <button
                type="button"
                tabIndex={-1}
                data-testid="confirm-document-tag"
                aria-label={t("jev.chip.confirm", { tag: state.tag.name, name: names })}
                title={t("tags.review.confirm", { tag: state.tag.name })}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void run(() => add(state.tag.id))}
                className="inline-flex size-4 items-center justify-center rounded-sm hover:bg-sheet/70"
              >
                <CheckLineIcon className="size-3" />
              </button>
            )}
            <button
              type="button"
              tabIndex={-1}
              data-testid="tag-token-remove"
              aria-label={t("tags.picker.remove", { tag: state.tag.name })}
              title={t("tags.picker.remove", { tag: state.tag.name })}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void run(() => remove(state.tag.id))}
              className="inline-flex size-4 items-center justify-center rounded-sm opacity-70 hover:bg-sheet/70 hover:opacity-100"
            >
              <CloseLineIcon className="size-2.5" />
            </button>
          </span>
        ))}
        <input
          ref={field}
          data-picker-field
          data-testid="tag-picker-input"
          role="combobox"
          aria-label={label}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          placeholder={applied.length ? "" : t("tags.picker.placeholder")}
          title={t("tags.picker.hint")}
          value={query}
          maxLength={100}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setPicked(null);
          }}
          onKeyDown={onKeyDown}
          className="h-7 min-w-24 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-ink-placeholder"
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-multiselectable="true"
        aria-label={label}
        data-testid="tag-picker-list"
        className="max-h-64 overflow-y-auto p-1"
      >
        {options.length === 0 && (
          <p className="px-2 py-1 text-[13px] text-ink-meta">{t("tags.picker.none")}</p>
        )}
        {options.map((option, index) =>
          option.kind === "create" ? (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the field owns the keys (aria-activedescendant).
            <div
              key="create"
              id={`${listId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected="false"
              data-testid="tag-option-create"
              data-active={index === current ? "true" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActive(index)}
              onClick={() => void createTag(option.name)}
              className={`flex h-7 cursor-default items-center gap-2 rounded-md pr-1 pl-2 ${
                index === current ? "bg-hover" : ""
              }`}
            >
              <PlusLineIcon className="size-3.5 shrink-0 text-ink-meta" />
              <span className="min-w-0 flex-1 truncate">
                {t("tags.picker.create", { name: option.name })}
              </span>
              <button
                type="button"
                tabIndex={-1}
                data-testid="tag-option-describe"
                onClick={(event) => {
                  event.stopPropagation();
                  setDescribing(option.name);
                }}
                className="shrink-0 rounded-sm px-1 text-[12px] text-ink-meta hover:bg-chip hover:text-ink"
              >
                {t("tags.picker.describe")}
              </button>
            </div>
          ) : (
            <TagOption
              key={option.state.tag.id}
              id={`${listId}-${index}`}
              state={option.state}
              single={single}
              active={index === current}
              onHover={() => setActive(index)}
              onChoose={() => void choose(option.state)}
            />
          ),
        )}
      </div>
      {error && (
        <p role="alert" className={`${errorTextClass} px-3 pb-2`}>
          <ProblemMark />
          {error}
        </p>
      )}
      {footer && (
        <>
          <div className={menuRuleClass} />
          <div className="flex min-h-8 min-w-0 items-center px-1 pb-1">{footer}</div>
        </>
      )}
    </div>
  );
}

/** One Tag in the list: a mark for on all, some or none; its name; review or automatic; its description. */
function TagOption({
  id,
  state,
  single,
  active,
  onHover,
  onChoose,
}: {
  id: string;
  state: TagOnDocuments;
  single: boolean;
  active: boolean;
  onHover(): void;
  onChoose(): void;
}) {
  const t = useT();
  const { tag, coverage } = state;
  const review = single && state.needsReview;
  const automatic = state.automatic && coverage !== "none" && !review;
  const markTitle = review
    ? t("jev.chip.needsReview")
    : coverage === "all"
      ? t(single ? "tags.picker.on" : "tags.picker.all", { total: state.total })
      : coverage === "some"
        ? t("tags.picker.some", { count: state.count, total: state.total })
        : undefined;
  const notes = [
    review ? t("jev.chip.needsReview") : null,
    automatic ? t("tags.picker.automatic") : null,
    coverage === "some" ? t("tags.picker.some", { count: state.count, total: state.total }) : null,
    tag.description || null,
  ].filter((note): note is string => note !== null);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the field owns the keys (aria-activedescendant).
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={coverage === "all"}
      aria-label={tag.name}
      aria-description={notes.join(" · ") || undefined}
      data-testid="tag-option"
      data-tag-id={tag.id}
      data-coverage={coverage}
      data-needs-review={review ? "true" : undefined}
      data-active={active ? "true" : undefined}
      title={tag.description ? `${tag.name}: ${tag.description}` : tag.name}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHover}
      onClick={onChoose}
      className={`flex h-7 cursor-default items-center gap-2 rounded-md pr-2 pl-2 ${active ? "bg-hover" : ""}`}
    >
      <span
        aria-hidden="true"
        title={markTitle}
        className="flex size-3.5 shrink-0 items-center justify-center"
      >
        {coverage === "all" && !review && <CheckLineIcon className="size-3.5 text-ink" />}
        {coverage === "some" && <span className="h-0.5 w-2.5 rounded-full bg-ink-secondary" />}
        {review && <ReviewRing />}
      </span>
      <TagDot colour={tag.colour} />
      <span className="min-w-0 truncate">{tag.name}</span>
      {automatic && (
        <span
          aria-hidden="true"
          title={t("tags.picker.automatic")}
          className="flex shrink-0 text-ink-meta"
        >
          <SparkLineIcon className="size-2.5" />
        </span>
      )}
    </div>
  );
}

/** Creating a Tag with a description, which automatic tagging reads. */
function DescribeTag({
  name,
  error,
  onCreate,
  onBack,
}: {
  name: string;
  error: string | null;
  onCreate(description: string): void;
  onBack(): void;
}) {
  const t = useT();
  const [description, setDescription] = useState("");
  return (
    <form
      data-testid="tag-describe"
      className="flex flex-col gap-2 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate(description);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Back to the list, not closed.
          event.preventDefault();
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <p className="text-ui font-semibold break-words text-ink">
        {t("tags.picker.create", { name })}
      </p>
      <label className="block text-[13px] leading-5 text-ink-secondary">
        {t("tags.picker.descriptionLabel")}
        <TypingTextarea
          data-picker-field
          data-testid="tag-describe-input"
          // biome-ignore lint/a11y/noAutofocus: the form replaces the list the focus was in.
          autoFocus
          rows={2}
          maxLength={500}
          value={description}
          placeholder={t("tags.dialog.descriptionPlaceholder")}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onCreate(description);
            }
          }}
          className={`${inputClass} resize-none`}
        />
      </label>
      <p className={`${hintClass} mt-0`}>{t("tags.picker.descriptionHint")}</p>
      {error && (
        <p role="alert" className={errorTextClass}>
          <ProblemMark />
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onBack} className={buttonStyle("ghost", "sm")}>
          {t("tags.picker.back")}
        </button>
        <button
          type="submit"
          data-testid="tag-describe-create"
          className={buttonStyle("primary", "sm")}
        >
          {t("tags.picker.createConfirm")}
        </button>
      </div>
    </form>
  );
}

/** The Documents a picker edits, for its label: "Tags of X" or "Tags of 3 Documents". */
export function pickerLabel(
  t: ReturnType<typeof useT>,
  documents: readonly Pick<Document, "name">[],
): string {
  return documents.length === 1
    ? t("tags.menu.open", { name: documents[0]?.name ?? "" })
    : t("tags.picker.labelMany", { count: documents.length });
}
