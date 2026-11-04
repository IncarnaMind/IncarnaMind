/*
 * The sidebar's rows (DESIGN.md, Sidebar): 28px, inset 8px by the sidebar's
 * padding and padded 8px, so every icon sits at x 16 and every text at x 40.
 * A row one level deeper (a Folder's child) moves both by `INDENT_PX`.
 */

/** One level deeper: a child's icon goes under its parent's text. */
export const INDENT_PX = 24;

/** The left padding of a row's button at a depth: 8px, plus one step per level. */
export const rowPadding = (depth: number) => ({ paddingLeft: 8 + depth * INDENT_PX });

/** The text of a row: the app's own rows, a Document's or Folder's name, or one still being processed. */
type RowTone = "app" | "item" | "muted";

const rowTones: Record<RowTone, string> = {
  app: "text-ink-secondary",
  item: "text-ink-strong",
  muted: "text-ink-meta",
};

/** A row a drag carries: quieter than the rest, so it reads as what moves rather than a target. */
export const draggedRowClass = "opacity-45";

/**
 * A row's container. Pointed at it's washed; selected it's on the sheet with
 * an inset rule and weight 600, or, one of several selected, on the accent's
 * wash; one a drag carries is quieter and not washed. Its actions
 * (`rowActionsClass`) sit on its right end and take its
 * background. Names of Documents and Folders are a shade darker than the
 * app's own rows. A row's words can't be selected, so a right-click never
 * selects them. `--row-bg` is the row's fill while selected, for a mark that
 * rings itself in it (a Document's Tag dots, which step aside while the row
 * is washed). The focus ring (DESIGN.md, Focus) is the row's, just inside its
 * edge, while its main button (`rowButtonClass`) has the focus.
 */
export const rowClass = (
  selected: boolean,
  tone: RowTone = "app",
  oneOfMany = false,
  dragged = false,
) =>
  `group relative flex h-7 shrink-0 items-center rounded-md text-ui select-none has-[.row-main:focus-visible]:outline-2 has-[.row-main:focus-visible]:-outline-offset-2 has-[.row-main:focus-visible]:outline-accent ${
    selected && oneOfMany
      ? "bg-accent-wash text-ink [--row-bg:var(--color-accent-wash)]"
      : selected
        ? "bg-sheet font-semibold text-ink shadow-[inset_0_0_0_1px_var(--color-rule)] [--row-bg:var(--color-sheet)]"
        : dragged
          ? rowTones[tone]
          : `${rowTones[tone]} hover:bg-hover has-[:focus-visible]:bg-hover`
  } ${dragged ? draggedRowClass : ""}`;

export const dropIntoClass = "bg-accent-wash shadow-[inset_0_0_0_2px_var(--color-accent)]";

/** A Folder dropped near a row's top edge goes beside it: a line across that edge. */
export const dropBeforeClass =
  "before:pointer-events-none before:absolute before:inset-x-2 before:top-0 before:z-10 before:h-0.5 before:rounded-full before:bg-accent before:content-['']";

/** A Folder dropped near a row's bottom edge goes beside it. */
export const dropAfterClass =
  "after:pointer-events-none after:absolute after:inset-x-2 after:bottom-0 after:z-10 after:h-0.5 after:rounded-full after:bg-accent after:content-['']";

/** A name being typed in a row. */
export const rowInputClass =
  "h-6 w-full min-w-0 rounded-sm border border-accent bg-sheet px-1.5 text-ui text-ink outline-1 outline-offset-0 outline-accent select-text";

/**
 * The button that fills a row: icon, 8px gap, text, and anything at its end.
 * `row-main` is how the row finds it (`rowClass`), which draws its focus ring.
 */
export const rowButtonClass =
  "row-main flex h-full w-full min-w-0 items-center gap-2 rounded-md pr-2 pl-2 text-left focus-visible:outline-0";

/**
 * Added to a row's button, so that while the row's actions show its content
 * ends before them: the name gives way with its "…" instead of running under
 * them. The room is the actions' own (`rowActionsClass`): 24px a button, 1px
 * between, 4px and 3px of padding, and the 2px they sit in from the edge.
 */
export const clearsActions = {
  menu: "actions-shown:pr-[33px]",
  tagsAndMenu: "actions-shown:pr-[58px]",
} as const;

/** A row's 16px icon: muted unless the row is selected. */
export const rowIconClass = (selected: boolean) =>
  `size-4 shrink-0 ${selected ? "text-ink" : "text-ink-meta"}`;

/**
 * A row's actions, over its right end: shown while it is pointed at, is
 * reached by keyboard, or has a menu open (a mouse click alone doesn't keep
 * them), which is what the `actions-shown:` variant (styles.css) says; the
 * `row-actions` class is how the variant finds an open menu. They
 * take the row's background and sit 2px inside its edge, clear of the focus
 * ring (2px) and a selected row's outline (1px). The row's button keeps its
 * content clear of them (`clearsActions`).
 */
export const rowActionsClass =
  "row-actions absolute inset-y-0.5 right-0.5 flex items-center gap-px rounded-r-[4px] bg-inherit pr-[3px] pl-1 opacity-0 actions-shown:opacity-100";

/** A 24px icon button among a row's actions. */
export const rowActionButtonClass =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-meta hover:bg-rule hover:text-ink focus-visible:outline-offset-0 aria-expanded:bg-rule aria-expanded:text-ink";
