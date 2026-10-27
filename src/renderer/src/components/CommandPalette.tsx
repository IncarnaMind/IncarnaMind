import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { MessageKey } from "../../../shared/i18n";
import { assistantHandle } from "../commands/handles";
import { keysHere, pressesShortcut } from "../commands/keymap";
import { commands, labelOf } from "../commands/registry";
import { mindInFront } from "../commands/targets";
import { conversationById, conversationLabel, useConversations } from "../conversations";
import { core } from "../core";
import { errorMessage } from "../errors";
import { findable } from "../finding";
import "../findingKinds";
import { useLanguage, useT } from "../i18n";
import { prepareName } from "../matcher";
import { exit } from "../motion";
import {
  actionGroup,
  activeOf,
  askGroup,
  conversationTextGroup,
  documentTextGroup,
  findings,
  nameGroups,
  noteGroup,
  type PaletteGroup,
  type PaletteItem,
  readQuery,
  recentGroup,
  runItem,
  searchesWords,
  usePalette,
} from "../palette";
import { useAppStore } from "../store";
import {
  ConversationLineIcon,
  DocumentLineIcon,
  MindLineIcon,
  SearchLineIcon,
  SparkLineIcon,
} from "./lineIcons";
import { Marked } from "./Marked";
import { ProblemMark } from "./ProblemLine";
import { errorTextClass } from "./ui";
import { useFocusReturn } from "./useFocusReturn";
import { useBackdropClose } from "./useModal";

/** How long typing pauses before the words inside are searched for. */
const WORDS_DELAY_MS = 120;

const OWN_TITLES: Record<string, MessageKey> = {
  recent: "palette.group.recent",
  actions: "palette.group.actions",
  notes: "palette.group.notes",
  documentText: "palette.group.documentText",
  conversationText: "palette.group.conversationText",
  ask: "palette.group.ask",
};

/** What the core found for one query; `failed` holds why it couldn't search. */
interface Found<T> {
  query: string;
  items: readonly T[];
  failed?: { error: unknown };
}

/** Asks the core once typing pauses; each answer stays until the next arrives. */
function useFound<T>(
  searching: boolean,
  text: string,
  search: (text: string) => Promise<readonly T[]>,
): Found<T> | null {
  const [found, setFound] = useState<Found<T> | null>(null);
  const latest = useRef(search);
  latest.current = search;
  useEffect(() => {
    if (!searching) return;
    let current = true;
    const timer = setTimeout(() => {
      latest.current(text).then(
        (items) => current && setFound({ query: text, items }),
        (error: unknown) => current && setFound({ query: text, items: [], failed: { error } }),
      );
    }, WORDS_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [searching, text]);
  return searching ? found : null;
}

/** Folds every name in idle time once ⌘K opens, so the first key typed waits for none. */
function usePreparedNames(names: () => readonly string[]): void {
  const latest = useRef(names);
  latest.current = names;
  useEffect(() => {
    const all = latest.current();
    let at = 0;
    let handle = 0;
    const step = (deadline: IdleDeadline) => {
      while (at < all.length && deadline.timeRemaining() > 1) prepareName(all[at++] ?? "");
      if (at < all.length) handle = requestIdleCallback(step);
    };
    handle = requestIdleCallback(step);
    return () => cancelIdleCallback(handle);
  }, []);
}

/**
 * ⌘K, a native modal <dialog> opened by ⌘K (Ctrl+K) or the sidebar's Search.
 * The field keeps the focus and owns the keys; Esc closes and gives the focus
 * back where it was.
 */
export function CommandPalette() {
  const open = usePalette((state) => state.open);
  return open ? <Palette /> : null;
}

function Palette() {
  const t = useT();
  const language = useLanguage();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const focus = useFocusReturn();
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const context = usePalette((state) => state.context);
  const minds = useAppStore((state) => state.minds);
  const documents = useAppStore((state) => state.documents);
  const openConversation = useConversations((state) =>
    state.openId ? conversationById(state.openId) : undefined,
  );
  const version = useSyncExternalStore(findable.subscribe, findable.version);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is when the objects changed.
  const found = useMemo(() => findings(t), [version, t]);

  usePreparedNames(() => [
    ...found.kinds.flatMap(({ objects }) => objects.map((object) => object.name)),
    ...commands.list(context).map((command) => labelOf(command, context, t)),
  ]);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    focus.remember();
    element.showModal();
    field.current?.focus();
  }, [focus]);

  const { text, words, actionsOnly } = useMemo(() => readQuery(query), [query]);
  const searching = !actionsOnly && searchesWords(text);
  const notes = useFound(searching, text, core.searchMinds);
  const passages = useFound(searching, text, core.searchDocumentText);
  const said = useFound(searching, text, core.searchConversations);

  const groups: PaletteGroup[] = useMemo(() => {
    if (actionsOnly) return actionGroup(words, context, language, found.names, true);
    if (words.length === 0) {
      return [
        ...recentGroup(minds, found, mindInFront()),
        ...actionGroup([], context, language, found.names),
      ];
    }
    return [
      ...nameGroups(words, found),
      ...actionGroup(words, context, language, found.names),
      ...(notes ? noteGroup(notes.items, minds, t) : []),
      ...(passages ? documentTextGroup(passages.items, documents, t) : []),
      ...(said ? conversationTextGroup(said.items) : []),
    ];
  }, [actionsOnly, words, found, context, language, t, notes, passages, said, minds, documents]);

  const waiting =
    searching && [notes, passages, said].some((each) => each === null || each.query !== text);
  const asking =
    text !== "" && !actionsOnly && assistantHandle.current !== null
      ? askGroup(text, conversationLabel(openConversation), t)
      : [];
  const failed = searching ? (notes?.failed ?? passages?.failed ?? said?.failed) : undefined;
  const problem = failed ? errorMessage(failed.error, t) : undefined;

  const items = [...groups, ...asking].flatMap((group) => group.items);
  const active = activeOf(items, activeKey, waiting);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the option chosen now is when to scroll, not what is read.
  useLayoutEffect(() => {
    list.current
      ?.querySelector('[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active?.key]);

  const close = () => {
    const element = dialog.current;
    if (!element?.open) return;
    exit(element, {});
    element.close();
    focus.giveBack(element);
    // Now, not on the dialog's close event a task later: ⌘K pressed meanwhile opens it again.
    usePalette.getState().hide();
  };
  useBackdropClose(dialog, close);

  const choose = (item: PaletteItem, inTab = false) => {
    // Closed first, so the focus is back where it was before what was chosen moves it.
    close();
    runItem(item, { inTab, context }).catch((error: unknown) =>
      useAppStore.getState().reportError(error),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" || pressesShortcut("palette.open", event.nativeEvent)) {
      // Here rather than the dialog's cancel, which Chromium may refuse to stop a second time.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      const down = event.key === "ArrowDown";
      const at = active ? items.indexOf(active) : down ? -1 : 0;
      const step = down ? 1 : -1;
      setActiveKey(items[(at + step + items.length) % items.length]?.key ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active) choose(active, event.metaKey || event.ctrlKey);
    }
  };

  const optionId = (item: PaletteItem) => `${id}-${items.indexOf(item)}`;
  const option = (item: PaletteItem) => (
    <Option
      key={item.key}
      id={optionId(item)}
      item={item}
      active={item.key === active?.key}
      onPoint={() => item.key !== active?.key && setActiveKey(item.key)}
      onChoose={(inTab) => choose(item, inTab)}
    />
  );

  return (
    <dialog
      ref={dialog}
      data-testid="palette"
      aria-label={t("palette.label")}
      onKeyDown={onKeyDown}
      onClose={() => usePalette.getState().hide()}
      className="mx-auto mt-16 mb-auto open:flex max-h-[calc(100vh-96px)] w-[640px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl bg-sheet p-0 text-ink shadow-popover backdrop:bg-transparent"
    >
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-rule px-4">
        <SearchLineIcon className="size-4 shrink-0 text-ink-meta" />
        <input
          ref={field}
          value={query}
          data-testid="palette-search"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={active ? optionId(active) : undefined}
          aria-label={t("palette.label")}
          placeholder={t("palette.placeholder")}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveKey(null);
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-placeholder"
        />
        <Key>esc</Key>
      </div>
      <div
        ref={list}
        id={`${id}-list`}
        role="listbox"
        aria-label={t("palette.results")}
        data-testid="palette-results"
        className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {[...groups, ...asking].map((group) => (
          <Group
            key={group.id}
            id={`${id}-${group.id}`}
            group={group}
            title={t(group.title ?? OWN_TITLES[group.id] ?? "palette.results")}
          >
            {group.items.map(option)}
          </Group>
        ))}
        {problem !== undefined ? (
          <p id={`${id}-status`} role="alert" className={`px-2 pt-3 ${errorTextClass}`}>
            <ProblemMark />
            {problem}
          </p>
        ) : (
          groups.length === 0 &&
          query.trim() !== "" && (
            <p
              id={`${id}-status`}
              role="status"
              data-testid={waiting ? "palette-searching" : "palette-empty"}
              className="px-2 pt-4 pb-2 text-[13px] leading-5 text-ink-meta"
            >
              {t(
                waiting
                  ? "palette.searching"
                  : actionsOnly
                    ? "palette.empty.actions"
                    : "palette.empty",
              )}
            </p>
          )
        )}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-4 border-t border-rule px-4 text-[12px] whitespace-nowrap text-ink-meta">
        <Hint keys="↑↓" label={t("palette.hint.move")} />
        <Hint keys={keysHere("Enter")} label={t("palette.hint.open")} />
        <Hint keys={keysHere("CmdOrCtrl+Enter")} label={t("palette.hint.openTab")} />
        <span className="ml-auto min-w-0 truncate">{t("palette.hint.actionsOnly")}</span>
      </div>
    </dialog>
  );
}

function Group({
  id,
  group,
  title,
  children,
}: {
  id: string;
  group: PaletteGroup;
  title: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: options in a listbox are grouped by role, which a fieldset can't be.
    <div role="group" aria-labelledby={id} data-testid="palette-group" data-group={group.id}>
      <div
        id={id}
        className="px-2 pt-3 pb-1 text-[12px] leading-[18px] font-semibold text-ink-meta"
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span>
      <span aria-hidden="true">{keys} </span>
      {label}
    </span>
  );
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="shrink-0 rounded-sm border border-rule px-1 font-sans text-[11px] leading-4 text-ink-meta">
      {children}
    </kbd>
  );
}

function ItemIcon({ item }: { item: PaletteItem }) {
  const className = "size-4 shrink-0 text-ink-meta";
  switch (item.kind) {
    case "object":
      return <>{item.icon(className)}</>;
    case "note":
      return <MindLineIcon className={className} />;
    case "passage":
      return <DocumentLineIcon kind={item.documentKind} className={className} />;
    case "said":
      return <ConversationLineIcon className={className} />;
    case "ask":
      return <SparkLineIcon className={className} />;
    case "command": {
      const Icon = commands.get(item.id)?.icon;
      return Icon ? (
        <Icon className={className} />
      ) : (
        <span aria-hidden="true" className="size-4 shrink-0" />
      );
    }
  }
}

function Option({
  id,
  item,
  active,
  onPoint,
  onChoose,
}: {
  id: string;
  item: PaletteItem;
  active: boolean;
  onPoint(): void;
  onChoose(inTab: boolean): void;
}) {
  const words = item.kind === "note" || item.kind === "passage" || item.kind === "said";
  const ranges = item.kind === "object" || item.kind === "command" ? item.ranges : [];
  const purpose = item.kind === "command" ? item.purpose : "";
  const twoLines = words || purpose !== "";
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the field owns the keys (aria-activedescendant).
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      data-testid="palette-item"
      data-kind={item.kind === "object" ? item.ref.kind : item.kind}
      data-key={item.key}
      // Choosing with the pointer keeps the focus in the field until it closes.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onPoint}
      onClick={(event) => onChoose(event.metaKey || event.ctrlKey)}
      className={`flex cursor-default gap-2.5 rounded-md px-2 ${
        twoLines ? "items-start py-1.5" : "h-9 items-center"
      } ${active ? "bg-hover" : ""}`}
    >
      <span className={`flex shrink-0 ${twoLines ? "pt-0.5" : ""}`}>
        <ItemIcon item={item} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-ui text-ink" title={item.name}>
            <Marked text={item.name} ranges={ranges} />
          </span>
          {item.meta && (
            <span className="min-w-0 shrink truncate text-[12px] text-ink-meta" title={item.meta}>
              {item.meta}
            </span>
          )}
        </span>
        {words && (
          <span className="block truncate text-[13px] leading-5 text-ink-secondary">
            <Marked text={item.excerpt} ranges={item.highlights} />
          </span>
        )}
        {purpose !== "" && (
          <span
            data-testid="palette-purpose"
            className="block truncate text-[12px] leading-4 text-ink-meta"
            title={purpose}
          >
            {purpose}
          </span>
        )}
      </span>
      {item.kind === "command" && item.shortcut && (
        <span className="shrink-0 text-[12px] text-ink-meta">{item.shortcut}</span>
      )}
      {active && item.kind !== "command" && (
        <span className={`flex shrink-0 ${words ? "pt-0.5" : ""}`}>
          <Key>↵</Key>
        </span>
      )}
    </div>
  );
}
