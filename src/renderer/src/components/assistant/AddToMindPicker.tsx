import { type KeyboardEvent, useId, useRef, useState } from "react";
import type { Mind } from "../../../../core/api";
import { mindName } from "../../../../shared/naming";
import type { AddTarget } from "../../addToNote";
import { Popover } from "../../editor/Popover";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { SearchIcon } from "../icons";
import { MindLineIcon, PlusLineIcon } from "../lineIcons";

/** Under "Recent", this many Minds; a search shows up to this many. */
const RECENT = 4;
const FOUND = 8;

interface Option {
  id: string;
  target: AddTarget;
  title: string;
  detail: string;
  icon: "mind" | "new";
}

/**
 * The ▾ beside "Add to note" (#201), as Notion's "Add to page":
 * a field to find a Mind, then This Mind (the one in focus, at its cursor or
 * end), the Minds edited most recently, each with its Folder, and New Mind,
 * made from the Answer in the conversation's Folder. Typing finds any Mind by
 * its name. ↑ ↓ move, Enter adds, Esc closes.
 */
export function AddToMindPicker({
  anchor,
  focusedMindId,
  atCursor,
  newFolderId,
  onChoose,
  onClose,
}: {
  anchor: HTMLElement;
  /** The Mind the assistant reads, if any: first, as one click on Add to note would add there. */
  focusedMindId: string | null;
  atCursor: boolean;
  /** The Folder a new Mind is made in: the conversation's. */
  newFolderId: string | null;
  onChoose(target: AddTarget): void;
  onClose(): void;
}) {
  const t = useT();
  const minds = useAppStore((state) => state.minds);
  // The groups as stored, not a list made from them: a new list each time would never settle.
  const tabGroups = useAppStore((state) => state.layout?.groups);
  const groups = useAppStore((state) => state.library?.groups);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const listId = useId();

  const nameOf = (mind: Mind) => mindName(mind) || t("mind.untitled");
  const folderOf = (folderId: string | null) => {
    const folder = folderId ? groups?.find((group) => group.id === folderId) : undefined;
    return folder ? folder.name : t("library.unsorted");
  };
  const isOpen = (mind: Mind) =>
    tabGroups?.some((group) =>
      group.tabs.some((tab) => tab.item.kind === "mind" && tab.item.mindId === mind.id),
    ) ?? false;
  const typed = query.trim().toLocaleLowerCase();
  const matches = (mind: Mind) => nameOf(mind).toLocaleLowerCase().includes(typed);
  const focused = minds.find((mind) => mind.id === focusedMindId && mind.kind === "mind");
  const others = minds.filter((mind) => mind.id !== focusedMindId && mind.kind === "mind");
  const shown = typed ? others.filter(matches).slice(0, FOUND) : others.slice(0, RECENT);

  const options: Option[] = [];
  if (focused && (!typed || matches(focused))) {
    options.push({
      id: `${listId}-focused`,
      target: { kind: "mind", mindId: focused.id },
      title: t("answer.addTo.here"),
      detail: t(atCursor ? "answer.addTo.atCursor" : "answer.addTo.atEnd", {
        mind: nameOf(focused),
      }),
      icon: "mind",
    });
  }
  const first = options.length;
  for (const mind of shown) {
    options.push({
      id: `${listId}-${mind.id}`,
      target: { kind: "mind", mindId: mind.id },
      title: nameOf(mind),
      detail: isOpen(mind) ? t("answer.addTo.open") : folderOf(mind.folderId),
      icon: "mind",
    });
  }
  options.push({
    id: `${listId}-new`,
    target: { kind: "new" },
    title: t("answer.addTo.new"),
    detail: newFolderId
      ? t("answer.addTo.newIn", { folder: folderOf(newFolderId) })
      : t("library.unsorted"),
    icon: "new",
  });
  const current = Math.min(active, options.length - 1);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[current];
      if (option) onChoose(option.target);
    }
  };

  const row = (option: Option, index: number) => (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the search field owns the keys (aria-activedescendant).
    <div
      key={option.id}
      id={option.id}
      role="option"
      tabIndex={-1}
      aria-selected={index === current}
      data-testid="add-to-option"
      data-target={option.target.kind === "new" ? "new" : option.target.mindId}
      onMouseMove={() => setActive(index)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onChoose(option.target)}
      className="add-to-option"
    >
      <span className="add-to-option-icon">
        {option.icon === "new" ? (
          <PlusLineIcon className="size-4" />
        ) : (
          <MindLineIcon className="size-4" />
        )}
      </span>
      <span className="add-to-option-text">
        <span className="add-to-option-title" title={option.title}>
          {option.title}
        </span>
        <span className="add-to-option-detail" title={option.detail}>
          {option.detail}
        </span>
      </span>
      {index === current && (
        <span aria-hidden="true" className="add-to-option-key">
          {t("answer.addTo.enter")}
        </span>
      )}
    </div>
  );

  return (
    <Popover
      anchor={anchor}
      placement="top-start"
      onDismiss={onClose}
      initialFocus={field}
      returnFocus
      aria-label={t("answer.addTo.label")}
      data-testid="add-to-picker"
      className="add-to-picker"
    >
      <div className="add-to-search">
        <label className="add-to-field">
          <SearchIcon className="size-3.5 shrink-0" />
          <span className="sr-only">{t("answer.addTo.find")}</span>
          <input
            ref={field}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={options[current]?.id}
            aria-autocomplete="list"
            data-testid="add-to-search"
            placeholder={t("answer.addTo.find")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </label>
      </div>
      <div id={listId} role="listbox" aria-label={t("answer.addTo.label")} className="add-to-list">
        {options.slice(0, first).map(row)}
        {shown.length > 0 && (
          // biome-ignore lint/a11y/useSemanticElements: a group of a listbox's options, which a fieldset can't hold.
          <div role="group" aria-label={typed ? t("answer.addTo.found") : t("answer.addTo.recent")}>
            <p aria-hidden="true" className="add-to-heading">
              {typed ? t("answer.addTo.found") : t("answer.addTo.recent")}
            </p>
            {options
              .slice(first, first + shown.length)
              .map((option, index) => row(option, first + index))}
          </div>
        )}
        {typed && shown.length === 0 && first === 0 && (
          <p className="add-to-empty">{t("answer.addTo.none")}</p>
        )}
        {/* biome-ignore lint/a11y/useSemanticElements: a rule between a listbox's options, where an hr can't go. */}
        <div role="separator" className="add-to-separator" />
        {row(options[options.length - 1] as Option, options.length - 1)}
      </div>
    </Popover>
  );
}
