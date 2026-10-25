import { type ReactNode, useId } from "react";
import type { DropEffect, DropProps } from "../dragDrop";
import { useT } from "../i18n";
import { ChevronDownLineIcon, ChevronRightLineIcon } from "./lineIcons";
import { dropIntoClass } from "./sidebarRows";

/**
 * A section of the sidebar's tree. Its `actions` show only while the heading
 * is pointed at or one of them has the focus, as in Notion. A section with
 * nothing in it is left out by its caller rather than drawn empty.
 */
export function SidebarSection({
  testId,
  title,
  headingTestId,
  tooltip,
  fold,
  actions,
  drop,
  children,
}: {
  testId: string;
  title: string;
  headingTestId?: string;
  /** What hovering the heading says, where its name alone doesn't. */
  tooltip?: string;
  fold?: { open: boolean; toggle(): void };
  actions?: ReactNode;
  /** The heading takes a drop, with the "into" box while it would. */
  drop?: { over: DropEffect | null; props: DropProps };
  children: ReactNode;
}) {
  const t = useT();
  const id = useId();
  const open = fold?.open ?? true;
  const Chevron = open ? ChevronDownLineIcon : ChevronRightLineIcon;
  return (
    <section data-testid={testId} className="mt-3">
      <div
        {...drop?.props}
        data-testid={`${testId}-heading`}
        data-drop-target={drop?.over ? "true" : undefined}
        title={tooltip}
        className={`group/section flex h-7 items-end gap-2 rounded-md pr-0.5 pb-1 pl-2 text-label ${
          drop?.over ? dropIntoClass : ""
        }`}
      >
        {fold ? (
          <button
            type="button"
            data-testid={headingTestId}
            aria-expanded={open}
            title={t("sidebar.section.toggle", { name: title })}
            onClick={fold.toggle}
            className="flex min-w-0 items-center gap-0.5 rounded-sm font-semibold text-ink-meta hover:text-ink"
          >
            <span id={id} className="truncate">
              {title}
            </span>
            <Chevron className="size-3 shrink-0" />
          </button>
        ) : (
          <h3
            id={id}
            data-testid={headingTestId}
            className="min-w-0 flex-1 truncate font-semibold text-ink-meta"
          >
            {title}
          </h3>
        )}
        {actions && (
          <span className="ml-auto flex shrink-0 items-center gap-px opacity-0 group-hover/section:opacity-100 has-[:focus-visible]:opacity-100 has-[[aria-expanded=true]]:opacity-100">
            {actions}
          </span>
        )}
      </div>
      {open && (
        <div role="tree" aria-labelledby={id} aria-multiselectable="true">
          {children}
        </div>
      )}
    </section>
  );
}
