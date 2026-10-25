import type { HTMLAttributes, ReactNode } from "react";
import type { DropEffect, DropProps } from "../../dragDrop";
import { useLanguage, useT } from "../../i18n";
import { formatCount } from "../../linkedFolders";
import { ChevronDownLineIcon } from "../lineIcons";
import { dropIntoClass } from "../sidebarRows";

/**
 * The head of a section of the Library page, as a toggle in a Notion page:
 * the chevron that folds it, its icon, its name, how many it holds and, at its
 * end, what it offers. What it is for is its tooltip. It rules the section off
 * from the next in the strong rule.
 */
export function SectionHead({
  label,
  open,
  onToggle,
  icon,
  name,
  count,
  tip,
  after,
  end,
  testId,
  rowProps,
  drop,
}: {
  /** Its name in words, for the chevron's label. */
  label: string;
  open: boolean;
  onToggle(): void;
  icon: ReactNode;
  /** The name as shown: a button that folds it too, or a field while it is renamed. */
  name: ReactNode;
  count: number;
  tip?: string | undefined;
  after?: ReactNode;
  end?: ReactNode;
  testId: string;
  rowProps?: HTMLAttributes<HTMLDivElement>;
  drop?: { over: DropEffect | null; props: DropProps };
}) {
  const t = useT();
  const language = useLanguage();
  return (
    // biome-ignore lint/a11y/useSemanticElements: the head of a group of rows in a grid of sections, not a table.
    // biome-ignore lint/a11y/useFocusableInteractive: its name's button takes the focus.
    <div
      role="row"
      data-testid={testId}
      data-open={open ? "true" : "false"}
      title={tip || undefined}
      data-drop-target={drop?.over ? "true" : undefined}
      {...rowProps}
      {...drop?.props}
      className={`group/head flex h-9 items-center gap-2 rounded-t-md border-b border-rule-strong pr-1.5 pl-1 select-none ${
        drop?.over ? `rounded-md ${dropIntoClass}` : "hover:bg-frame"
      }`}
    >
      <button
        type="button"
        tabIndex={-1}
        data-testid="library-section-toggle"
        aria-expanded={open}
        aria-label={t(open ? "library.collapse" : "library.expand", { name: label })}
        title={t(open ? "library.collapse" : "library.expand", { name: label })}
        onClick={onToggle}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-meta hover:bg-hover hover:text-ink"
      >
        <ChevronDownLineIcon className={`size-3.5 ${open ? "" : "-rotate-90"}`} />
      </button>
      <span className="flex shrink-0 text-ink-meta">{icon}</span>
      {name}
      <span
        data-testid="library-section-count"
        className="shrink-0 text-[12px] tabular-nums text-ink-meta"
      >
        {formatCount(count, language)}
      </span>
      {after}
      <span className="min-w-0 flex-1" />
      {end}
    </div>
  );
}

/** A section's name, the button that folds it: bold, cut with "…" when long. */
export const sectionNameClass =
  "min-w-0 shrink truncate rounded-sm text-left text-[15px] leading-5 font-semibold text-ink";
