import { type Editor, isMacOS } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  Fragment,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { ShortcutKeys } from "../../../shared/commands";
import { keysHere } from "../commands/keymap";
import { keysOn, pressed } from "../commands/keys";
import {
  ChatLineIcon,
  CheckLineIcon,
  ChevronDownLineIcon,
  CloseLineIcon,
  MoreLineIcon,
} from "../components/lineIcons";
import {
  buttonStyle,
  iconButtonClass,
  menuClass,
  menuItemClass,
  menuRuleClass,
  segmentClass,
  segmentedClass,
} from "../components/ui";
import { usePopoverMenu } from "../components/usePopoverMenu";
import { useLanguage, useT } from "../i18n";
import {
  authorKey,
  authorShown,
  filterOf,
  isDecided,
  type ReviewFilter,
  type ReviewPaneState,
  shownIn,
  useReviewPanes,
} from "../reviewPane";
import { pendingIn } from "./proposalReview";
import {
  decideInPane,
  decideSelected,
  itemsOf,
  selectCard,
  selectedChange,
  washSelected,
} from "./reviewActions";
import {
  type ChangeItem,
  type CommentItem,
  type ExcerptPart,
  initialsOf,
  madeByLine,
  type ReviewItem,
  waitingChanges,
} from "./theirChanges";

type Shown = Omit<ChangeItem, "from" | "to"> | Omit<CommentItem, "from" | "to">;

// Places move with every key typed above them: without them, the cards redraw only when they change.
const withoutPlace = ({ from: _from, to: _to, ...rest }: ReviewItem): Shown => rest;

const cardIn = (list: HTMLElement | null, id: string) =>
  list?.querySelector<HTMLButtonElement>(`[data-review-id="${CSS.escape(id)}"]`) ?? null;

function focusCard(
  list: RefObject<HTMLElement | null>,
  fallback: RefObject<HTMLElement | null>,
  id: string | null,
): void {
  // Once the list has drawn the card selected next, which may be new.
  requestAnimationFrame(() => {
    const button = id ? cardIn(list.current, id) : null;
    const target = button ?? list.current?.querySelector("[data-review-id]") ?? fallback.current;
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest" });
  });
}

const ACCEPT_KEYS = "CmdOrCtrl+Enter";
const REJECT_KEYS = "CmdOrCtrl+Backspace";

const pressedKeys = (keys: ShortcutKeys, event: KeyboardEvent<Element>) =>
  pressed(keysOn(keys, isMacOS()), event.nativeEvent, isMacOS());

/**
 * Someone else's changes and comments from the Word file, beside the Mind
 * inside its tab (#697, the board Final-10-Redlines): a card each in the
 * Mind's order; All · Unresolved and a menu of who made them; the selected
 * card opens to the whole change, with Accept and Reject (⌘↵, ⌘⌫), and its
 * change is washed in the text and scrolled to. A change or comment clicked
 * in the text selects its card.
 */
export function ReviewPane({
  editor,
  mindId,
  over,
}: {
  editor: Editor;
  mindId: string;
  over: boolean;
}) {
  const t = useT();
  const pane = useReviewPanes((state) => state.panes[mindId]);
  const items = useEditorState({
    editor,
    selector: ({ editor: current }) => itemsOf(current).map(withoutPlace),
  });
  const filter = filterOf(pane, items);
  const who = authorShown(items, pane);
  const update = (patch: Partial<ReviewPaneState>) =>
    useReviewPanes.getState().update(mindId, patch);

  // The default is kept once the pane opens, so deciding a change doesn't switch the list under the User.
  useEffect(() => {
    if (pane && pane.filter === null) {
      useReviewPanes.getState().update(mindId, { filter: filterOf(pane, items) });
    }
  }, [pane, items, mindId]);

  const shown = shownIn(items, pane);
  const selected = shown.some((item) => item.id === pane?.selected)
    ? (pane?.selected ?? null)
    : null;

  const list = useRef<HTMLUListElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  const opened = pane?.opened ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `opened` is what asks for it.
  useLayoutEffect(() => {
    const { from } = editor.state.selection;
    const atCursor = pane?.selected
      ? undefined
      : itemsOf(editor).find(
          (each) =>
            each.kind === "change" &&
            each.state === "waiting" &&
            each.from <= from &&
            from <= each.to,
        );
    if (atCursor) update({ selected: atCursor.id });
    const target =
      (atCursor ? cardIn(list.current, atCursor.id) : null) ??
      (selected ? cardIn(list.current, selected) : null) ??
      list.current?.querySelector<HTMLButtonElement>("[data-review-id]") ??
      null;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
  }, [opened]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: new `items` mean the change may have moved: washed again where it is.
  useEffect(() => washSelected(editor, selected), [editor, selected, items]);
  useEffect(() => () => washSelected(editor, null), [editor]);

  // Undo brings back a change decided from the pane: the one that starts waiting again is selected, so ⌘↵ after ⌘Z acts on it.
  const waitingBefore = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const waiting = new Set(
      items
        .filter((item) => item.kind === "change" && item.state === "waiting")
        .map((item) => item.id),
    );
    const before = waitingBefore.current;
    waitingBefore.current = waiting;
    if (before === null) return;
    const decided = useReviewPanes.getState().panes[mindId]?.decided ?? [];
    const undone = decided.findLast((id) => waiting.has(id) && !before.has(id));
    if (undone === undefined) return;
    const inPane = list.current?.contains(document.activeElement) ?? false;
    selectCard(editor, mindId, undone, { scroll: true });
    if (inPane) focusCard(list, closeButton, undone);
  }, [items, editor, mindId]);

  useEffect(() => {
    const showCard = (id: string) => {
      useReviewPanes.getState().update(mindId, { selected: id });
      requestAnimationFrame(() => cardIn(list.current, id)?.scrollIntoView({ block: "nearest" }));
    };
    const onSelection = () => {
      if (!editor.isFocused) return;
      const { from } = editor.state.selection;
      const change = pendingIn(editor.state).find(
        (each) =>
          each.theirs && each.ranges.some((range) => range.from <= from && from <= range.to),
      );
      if (change) showCard(change.id);
    };
    const onClick = (event: MouseEvent) => {
      const mark = event.target instanceof Element ? event.target.closest(".word-atom") : null;
      if (!mark || editor.isDestroyed) return;
      const pos = editor.view.posAtDOM(mark, 0);
      const item = itemsOf(editor).find(
        (each) =>
          (each.kind === "comment" || each.state === "kept") && each.from <= pos && pos < each.to,
      );
      if (item) showCard(item.id);
    };
    const dom = editor.view.dom;
    editor.on("selectionUpdate", onSelection);
    dom.addEventListener("click", onClick);
    return () => {
      editor.off("selectionUpdate", onSelection);
      dom.removeEventListener("click", onClick);
    };
  }, [editor, mindId]);

  const close = () => {
    useReviewPanes.getState().close(mindId);
    if (!editor.isDestroyed) editor.commands.focus(null, { scrollIntoView: false });
  };

  const decide = (outcome: "accept" | "reject") => {
    // On a comment or a card already decided there is nothing to do, and the focus stays.
    if (!selectedChange(editor, mindId)) return;
    focusCard(list, closeButton, decideSelected(editor, mindId, outcome));
  };

  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (pressedKeys(ACCEPT_KEYS, event) || pressedKeys(REJECT_KEYS, event)) {
      event.preventDefault();
      decide(pressedKeys(ACCEPT_KEYS, event) ? "accept" : "reject");
      return;
    }
    const at = shown.findIndex((item) => item.id === selected);
    const next =
      event.key === "ArrowDown"
        ? shown[Math.min(at + 1, shown.length - 1)]
        : event.key === "ArrowUp"
          ? shown[Math.max(at - 1, 0)]
          : event.key === "Home"
            ? shown[0]
            : event.key === "End"
              ? shown.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    selectCard(editor, mindId, next.id, { scroll: true });
    const button = cardIn(list.current, next.id);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest" });
  };

  return (
    <aside
      aria-label={t("review.title")}
      data-testid="review-pane"
      data-review-of={mindId}
      data-placement={over ? "over" : "beside"}
      className={`review-pane ${over ? "review-pane--over" : ""}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing)
          return;
        event.preventDefault();
        close();
      }}
    >
      <div className="review-pane-head">
        <FilterSwitch
          mindId={mindId}
          filter={filter}
          onChange={(next) => update({ filter: next })}
        />
        <AuthorMenu
          items={items.filter((item) => filter === "all" || !isDecided(item))}
          who={who}
          onChange={(next) => update({ who: next })}
        />
        <PaneMenu editor={editor} mindId={mindId} />
        <button
          ref={closeButton}
          type="button"
          data-testid="review-close"
          aria-label={t("review.close")}
          title={t("review.close")}
          onClick={close}
          className={iconButtonClass}
        >
          <CloseLineIcon className="size-4" />
        </button>
      </div>
      {shown.length === 0 ? (
        <p data-testid="review-empty" className="review-pane-empty">
          {t("review.empty")}
        </p>
      ) : (
        <ul
          ref={list}
          aria-label={t("review.list")}
          data-testid="review-list"
          className="review-pane-list"
          onKeyDown={onListKey}
        >
          {shown.map((item, index) => (
            <Card
              key={item.id}
              item={item}
              selected={item.id === selected}
              tabbable={selected ? item.id === selected : index === 0}
              onSelect={() => selectCard(editor, mindId, item.id, { scroll: true })}
              onDecide={decide}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

function FilterSwitch({
  mindId,
  filter,
  onChange,
}: {
  mindId: string;
  filter: ReviewFilter;
  onChange(next: ReviewFilter): void;
}) {
  const t = useT();
  const name = `review-filter-${mindId}`;
  const option = (value: ReviewFilter, label: string) => (
    <label className={segmentClass}>
      <input
        type="radio"
        name={name}
        value={value}
        data-testid={`review-filter-${value}`}
        checked={filter === value}
        onChange={() => onChange(value)}
        className="sr-only"
      />
      {label}
    </label>
  );
  return (
    <div role="radiogroup" aria-label={t("review.filter")} className={segmentedClass}>
      {option("all", t("review.all"))}
      {option("unresolved", t("review.unresolved"))}
    </div>
  );
}

function AuthorMenu({
  items,
  who,
  onChange,
}: {
  items: readonly Shown[];
  who: string | null;
  onChange(next: string | null): void;
}) {
  const t = useT();
  const menu = usePopoverMenu({ focus: "checked", align: "end" });
  const authors = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const item of items) {
      const key = authorKey(item.author);
      const entry = counts.get(key) ?? {
        name: item.author ?? t("proposal.unknownAuthor"),
        count: 0,
      };
      entry.count++;
      counts.set(key, entry);
    }
    return [...counts.entries()];
  }, [items, t]);
  const current = who === null ? null : authors.find(([key]) => key === who)?.[1].name;
  const choose = (next: string | null) => {
    onChange(next);
    menu.close();
  };
  const option = (key: string | null, label: string) => (
    <button
      key={key ?? "\u0000everyone"}
      type="button"
      role="menuitemradio"
      aria-checked={who === key}
      data-testid={key === null ? "review-author-everyone" : "review-author"}
      onClick={() => choose(key)}
      className={`${menuItemClass} pl-2`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {who === key && <CheckLineIcon className="size-4" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="review-author-menu"
        aria-label={t("review.authors", { name: current ?? t("review.everyone") })}
        title={current ?? undefined}
        className="review-pane-who"
      >
        <span className="min-w-0 truncate">{current ?? t("review.everyone")}</span>
        <ChevronDownLineIcon className="size-3 shrink-0" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("review.authors.menu")}
        data-testid="review-author-list"
        className={menuClass}
      >
        {menu.open && (
          <>
            {option(null, t("review.everyone"))}
            <div className={menuRuleClass} />
            {authors.map(([key, { name, count }]) =>
              option(key, t("review.author", { person: name, count })),
            )}
          </>
        )}
      </div>
    </>
  );
}

function PaneMenu({ editor, mindId }: { editor: Editor; mindId: string }) {
  const t = useT();
  const menu = usePopoverMenu({ focus: "first", align: "end" });
  const waiting = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      waitingChanges(itemsOf(current)).map(({ id, author }) => ({ id, author })),
  });
  if (waiting.length === 0) return null;
  const authors = [...new Set(waiting.map((each) => authorKey(each.author)))];
  const decide = (ids: string[], outcome: "accept" | "reject") => {
    menu.close();
    decideInPane(editor, mindId, ids, outcome);
  };
  const item = (testId: string, label: string, ids: string[], outcome: "accept" | "reject") => (
    <button
      key={testId}
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={() => decide(ids, outcome)}
      className={`${menuItemClass} pl-2`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
  const all = waiting.map((each) => each.id);
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="review-more"
        aria-label={t("review.more")}
        title={t("review.more")}
        className={iconButtonClass}
      >
        <MoreLineIcon className="size-4" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("review.more")}
        data-testid="review-more-menu"
        className={menuClass}
      >
        {menu.open && (
          <>
            {item("review-accept-all", t("proposal.acceptAll"), all, "accept")}
            {item("review-reject-all", t("proposal.rejectAll"), all, "reject")}
            {authors.length > 1 &&
              authors.map((key) => {
                const name = key === "" ? t("proposal.unknownAuthor") : key;
                const ids = waiting
                  .filter((each) => authorKey(each.author) === key)
                  .map((each) => each.id);
                return (
                  <Fragment key={key}>
                    <div className={menuRuleClass} />
                    {item(
                      "review-accept-author",
                      t("review.acceptAuthor", { person: name }),
                      ids,
                      "accept",
                    )}
                    {item(
                      "review-reject-author",
                      t("review.rejectAuthor", { person: name }),
                      ids,
                      "reject",
                    )}
                  </Fragment>
                );
              })}
          </>
        )}
      </div>
    </>
  );
}

function Excerpt({ parts, testId }: { parts: readonly ExcerptPart[]; testId: string }) {
  return (
    <span data-testid={testId} className="review-card-excerpt">
      {parts.map((part, index) =>
        part.kind === "insert" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one excerpt, in order.
          <ins key={index}>{part.text}</ins>
        ) : part.kind === "delete" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one excerpt, in order.
          <del key={index}>{part.text}</del>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one excerpt, in order.
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

const spoken = (parts: readonly ExcerptPart[], kind: ExcerptPart["kind"]) =>
  parts
    .filter((part) => part.kind === kind)
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

function Card({
  item,
  selected,
  tabbable,
  onSelect,
  onDecide,
}: {
  item: Shown;
  selected: boolean;
  tabbable: boolean;
  onSelect(): void;
  onDecide(outcome: "accept" | "reject"): void;
}) {
  const t = useT();
  const language = useLanguage();
  const made = madeByLine(item, t, language);
  if (item.kind === "comment") {
    return (
      <li
        data-testid="review-comment"
        className="review-card"
        data-selected={selected || undefined}
      >
        <button
          type="button"
          data-review-id={item.id}
          tabIndex={tabbable ? 0 : -1}
          aria-current={selected || undefined}
          aria-label={t("review.comment.label", { made, text: item.text })}
          title={made}
          onClick={onSelect}
          className="review-card-main"
        >
          <span className="review-card-mark" aria-hidden="true">
            <ChatLineIcon className="size-3.5" />
          </span>
          <span className="review-card-body">
            <span className="review-card-head">
              <b className="review-card-name">{item.author ?? t("proposal.unknownAuthor")}</b>
            </span>
            <span
              data-testid="review-comment-text"
              className="review-card-excerpt review-card-comment"
            >
              {item.text}
            </span>
          </span>
        </button>
      </li>
    );
  }
  const removed = spoken(item.excerpt, "delete");
  const added = spoken(item.excerpt, "insert");
  // A field or a picture someone added or removed has no words to show: what it is instead.
  const wordless =
    removed === "" && added === ""
      ? t(
          item.excerpt.some((part) => part.kind === "delete")
            ? "wordAtom.kind.deletion"
            : "wordAtom.kind.insertion",
        )
      : null;
  const what = wordless
    ? wordless
    : removed && added
      ? t("proposal.announce.replace", { removed, added })
      : added
        ? t("proposal.announce.add", { added })
        : t("proposal.announce.remove", { removed });
  const status =
    item.state === "accepted"
      ? t("review.accepted")
      : item.state === "rejected"
        ? t("review.rejected")
        : item.state === "kept"
          ? t("review.kept")
          : item.outOfDate
            ? t("proposal.outOfDate")
            : null;
  return (
    <li
      data-testid="review-change"
      data-state={item.state}
      className="review-card"
      data-selected={selected || undefined}
    >
      <button
        type="button"
        data-review-id={item.id}
        tabIndex={tabbable ? 0 : -1}
        aria-current={selected || undefined}
        aria-label={[made, item.clause, what, status].filter(Boolean).join(t("review.separator"))}
        title={made}
        onClick={onSelect}
        className="review-card-main"
      >
        <span className="review-card-initials" aria-hidden="true">
          {initialsOf(item.author)}
        </span>
        <span className="review-card-body">
          <span className="review-card-head">
            {item.clause && (
              <b data-testid="review-clause" className="review-card-clause">
                {item.clause}
              </b>
            )}
            {status && (
              <span
                data-testid="review-status"
                title={item.state === "kept" ? t("review.kept.why") : undefined}
                className="review-card-status"
              >
                {item.state === "accepted" && <CheckLineIcon className="size-3" />}
                {item.state === "rejected" && <CloseLineIcon className="size-3" />}
                {status}
              </span>
            )}
          </span>
          {wordless ? (
            <span data-testid="review-excerpt" className="review-card-excerpt review-card-what">
              {wordless}
            </span>
          ) : (
            <Excerpt parts={item.excerpt} testId="review-excerpt" />
          )}
        </span>
      </button>
      {selected && item.state === "waiting" && (
        <div className="review-card-actions">
          <button
            type="button"
            data-testid="review-accept"
            aria-disabled={item.outOfDate || undefined}
            aria-keyshortcuts={isMacOS() ? "Meta+Enter" : "Control+Enter"}
            title={
              item.outOfDate
                ? t("proposal.cantAccept.theirs")
                : `${t("proposal.accept")} (${keysHere(ACCEPT_KEYS)})`
            }
            onClick={(event) => {
              if (event.detail <= 1 && !item.outOfDate) onDecide("accept");
            }}
            className={`${buttonStyle("secondary", "sm")} aria-disabled:cursor-default aria-disabled:opacity-50`}
          >
            <CheckLineIcon className="size-3" />
            {t("proposal.accept")}
          </button>
          <button
            type="button"
            data-testid="review-reject"
            aria-keyshortcuts={isMacOS() ? "Meta+Backspace" : "Control+Backspace"}
            title={`${t("proposal.reject")} (${keysHere(REJECT_KEYS)})`}
            onClick={(event) => {
              if (event.detail <= 1) onDecide("reject");
            }}
            className={buttonStyle("secondary", "sm")}
          >
            <CloseLineIcon className="size-3" />
            {t("proposal.reject")}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * "Changes ({n})" at the page's top right, left of its ⋯ button, while the
 * Mind is too narrow for the pane beside it: it opens the pane over the
 * Mind's right edge, and folds it again.
 */
export function ReviewFold({ editor, mindId }: { editor: Editor; mindId: string }) {
  const t = useT();
  const over = useReviewPanes((state) => state.panes[mindId]?.over ?? false);
  const count = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      pendingIn(current.state).filter((each) => each.theirs).length,
  });
  return (
    <button
      type="button"
      data-testid="review-fold"
      aria-expanded={over}
      onClick={() => {
        if (over) useReviewPanes.getState().update(mindId, { over: false });
        else useReviewPanes.getState().open(mindId);
      }}
      className="review-fold"
    >
      {count > 0 ? t("review.fold", { count }) : t("review.fold.none")}
    </button>
  );
}
