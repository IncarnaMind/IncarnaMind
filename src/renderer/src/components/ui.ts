/**
 * The app chrome's shared looks, from DESIGN.md and the approved mockups:
 * buttons, fields, dialogs, Settings rows and sidebar rows. Components put
 * these class strings together instead of repeating raw values.
 *
 * The keyboard's focus ring (a 2px accent outline, 2px out) is the base style
 * in styles.css, for every control: these classes only move it (inside a
 * row, or onto the edge of a small button). `outline-none` would hide it.
 */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
/** 28px in a row, 32px in a dialog, 36px at the foot of first run. */
type ButtonSize = "sm" | "md" | "lg";

const buttonBase =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-semibold whitespace-nowrap transition-colors duration-80 disabled:cursor-default disabled:opacity-50";

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[13px] leading-5",
  md: "h-8 px-3 text-[13px] leading-5",
  lg: "h-9 px-4 text-ui",
};

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-ink text-white hover:bg-ink-strong disabled:hover:bg-ink",
  secondary:
    "border border-rule-strong bg-sheet text-ink-strong hover:bg-frame disabled:hover:bg-sheet",
  ghost: "text-ink-secondary hover:bg-chip hover:text-ink disabled:hover:bg-transparent",
  danger: "bg-danger text-white hover:bg-[#912018] disabled:hover:bg-danger",
};

/** A button's classes: primary (ink), secondary (outlined), ghost or danger. */
export const buttonStyle = (variant: ButtonVariant = "secondary", size: ButtonSize = "md") =>
  `${buttonBase} ${buttonSizes[size]} ${buttonVariants[variant]}`;

export const primaryButtonClass = buttonStyle("primary");
export const buttonClass = buttonStyle("secondary");
export const ghostButtonClass = buttonStyle("ghost");
export const dangerButtonClass = buttonStyle("danger");

/** A square ghost button around a 16px icon. */
export const iconButtonClass =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-meta hover:bg-chip hover:text-ink focus-visible:outline-offset-0 disabled:opacity-50";

/**
 * A field's box: radius 4, a 1px edge, blue when focused, `warning` while its
 * value is wrong (`aria-invalid`, with its message under it). Sized by where it sits.
 */
export const fieldClass =
  "rounded-sm border border-rule-strong bg-sheet px-2.5 py-1.5 text-ui text-ink placeholder:text-ink-placeholder aria-invalid:border-warning focus:border-accent focus:outline-1 focus:outline-offset-0 focus:outline-accent disabled:opacity-60";

/** A text field, under its label, as wide as its column. */
export const inputClass = `mt-1 block w-full ${fieldClass}`;

/** A field's label, above it. */
export const fieldLabelClass = "block text-[13px] leading-5 text-ink-secondary";

/** The line of help under a field. */
export const hintClass = "mt-1 block text-[12px] leading-[18px] text-ink-meta";

/**
 * A checkbox with its label, and the line of help under it: the box is 16px
 * and the gap 8px, so the line's indent (24px) is where the label's text starts.
 */
export const checkRowClass = "flex items-center gap-2 text-ui text-ink";
export const checkBoxClass = "m-0 size-4 shrink-0";
export const checkHintClass = `${hintClass} mt-0 pl-6`;

/** A note that needs reading, on the frame: no tinted boxes outside Citations. */
export const noticeClass =
  "rounded-lg border border-rule bg-frame px-3 py-2 text-[13px] leading-5 text-ink-secondary";

/** What went wrong, in words, in ink after a `ProblemMark`. Red is only for what can't be undone. */
export const errorTextClass = "text-[13px] leading-5 break-words text-ink";

/** Something that worked, e.g. a connection test: in ink, as green is for Citation checks. */
export const successTextClass = "text-[13px] leading-5 text-ink-secondary";

// Dialogs ------------------------------------------------------------------

/** A native modal <dialog>'s look: a 12px sheet with dialog depth over the scrim. */
export const dialogFrameClass =
  "m-auto rounded-xl bg-sheet p-0 text-ink shadow-dialog backdrop:bg-scrim";

/** A native modal <dialog>, 24px clear of the window's edges, scrolling if it must. Add a width. */
export const dialogClass = `${dialogFrameClass} max-h-[calc(100vh-48px)] max-w-[calc(100vw-48px)] overflow-y-auto`;

/** The padding inside a dialog. */
export const dialogBodyClass = "flex flex-col gap-4 px-6 pt-6 pb-5";

/** A dialog's title: serif, like the writing. */
export const dialogTitleClass =
  "font-serif text-[22px] leading-[30px] font-semibold text-ink [font-variation-settings:'opsz'_32]";

/** The line under a dialog's title. */
export const dialogTextClass = "text-ui break-words text-ink-secondary";

/** A dialog's buttons, at its foot: secondary first, the main one on the right. */
export const dialogActionsClass = "flex flex-wrap items-center justify-end gap-2 pt-1";

// Lists of choices -----------------------------------------------------------

/** Choices as rows split by rules, in one bordered box (not cards). */
export const choiceListClass =
  "flex flex-col overflow-hidden rounded-[10px] border border-rule [&>*+*]:border-t [&>*+*]:border-rule";

/** One choice: its radio in a 16px column, then its words. Chosen, it's washed. */
export const choiceRowClass =
  "grid cursor-pointer grid-cols-[16px_minmax(0,1fr)] gap-x-3 px-4 py-3 hover:bg-wash has-[input:checked]:bg-wash has-[input:disabled]:cursor-default has-[input:disabled]:hover:bg-transparent";

/** A one-line choice (a provider's name): a 36px row in a `choiceListClass` box. */
export const compactChoiceRowClass =
  "flex min-h-9 cursor-pointer items-center gap-3 px-3 py-1.5 text-ui text-ink hover:bg-wash has-[input:checked]:bg-wash has-[input:disabled]:cursor-default has-[input:disabled]:text-ink-placeholder has-[input:disabled]:hover:bg-transparent";

/** The radio of a one-line choice. */
export const compactChoiceRadioClass = "size-4 shrink-0 accent-ink";

/** The radio of a choice, lined up with its first line. */
export const choiceRadioClass = "mt-[3px] size-4 accent-ink";

/** A choice's name. */
export const choiceTitleClass = "text-ui font-semibold text-ink";

/** What a choice means. */
export const choiceTextClass = "text-[13px] leading-5 text-ink-secondary";

// Settings -------------------------------------------------------------------

/** A page in Settings' list on the left: a 28px row, selected like a sidebar row. */
export const navRowClass = (selected: boolean) =>
  `flex h-7 w-full shrink-0 items-center rounded-md px-2 text-left text-ui focus-visible:-outline-offset-2 ${
    selected
      ? "bg-sheet font-semibold text-ink shadow-[inset_0_0_0_1px_var(--color-rule)]"
      : "text-ink-secondary hover:bg-hover"
  }`;

/** The paragraph that opens a Settings page. */
export const pageIntroClass = "max-w-[560px] text-ui leading-[22px] text-ink-secondary";

/** A section's title on a Settings page. */
export const sectionTitleClass = "text-[15px] leading-[22px] font-semibold text-ink";

/** The line under a section's title. */
export const sectionNoteClass = "mt-0.5 mb-2 text-[13px] leading-5 text-ink-meta";

/**
 * Rows split by rules: a rule above each, and one under the last. Each row
 * puts its words on the left and its status or switch on the right.
 */
export const ruledListClass = "flex flex-col border-b border-rule [&>*]:border-t [&>*]:border-rule";

/**
 * One ruled row: words left, status right, lined up at the top, the middle or
 * the bottom. A one-line row is a little shorter.
 */
export const ruledRow = (align: "start" | "center" | "end" = "start", oneLine = false) =>
  `grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 ${oneLine ? "py-2.5" : "py-3.5"} ${
    align === "start" ? "items-start" : align === "center" ? "items-center" : "items-end"
  }`;

export const ruledRowClass = ruledRow();

/**
 * A ruled row's buttons, on the right: their 32px are centred on the row's
 * first 20px line, so they line up with its name.
 */
export const rowButtonsClass = "-my-1.5 flex flex-wrap items-center justify-end gap-2";

/** The name in a ruled row. */
export const rowTitleClass = "text-ui font-semibold text-ink";

/** What a ruled row is about. */
export const rowTextClass = "text-[13px] leading-5 text-ink-secondary";

/** A row's status, on the right. */
export const rowStatusClass = "text-[13px] leading-5 text-ink-meta";

/**
 * A few choices side by side, one chosen (radio buttons that look like a
 * segmented control): `segmentedClass` on the group, `segmentClass` on each
 * `<label>`, whose radio input is visually hidden (`sr-only`).
 */
export const segmentedClass =
  "inline-flex shrink-0 overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--color-rule-strong)]";

export const segmentClass =
  "h-[26px] cursor-default px-2 text-[12px] leading-[26px] whitespace-nowrap text-ink-secondary hover:text-ink has-[:checked]:bg-frame has-[:checked]:font-semibold has-[:checked]:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent";

// Menus ----------------------------------------------------------------------

/**
 * A popover menu's element, but its width: a picker that needs more room sets its own. It is as
 * tall as its rows need, up to the window less its edges; past that it scrolls, a shadow at the cut
 * edge saying so (`.menu-scrolls`).
 */
export const menuFrameClass =
  "menu-scrolls inset-auto m-0 max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border-0 bg-sheet p-1 text-ui font-normal text-ink shadow-popover";

/** A popover menu's element. */
export const menuClass = `${menuFrameClass} w-max max-w-72 min-w-48`;

/** A menu's small heading. */
export const menuTitleClass = "px-2 pt-1.5 pb-1 text-label font-semibold text-ink-meta";

const menuItemBase =
  "flex w-full items-center gap-2 rounded-md pr-2 text-left -outline-offset-2 hover:bg-hover focus-visible:bg-hover disabled:text-ink-placeholder disabled:hover:bg-transparent";

/** A menu item: a 28px row, in the menu's ink unless it says otherwise. */
export const menuItemClass = `${menuItemBase} h-7`;

/** A menu item whose text may wrap: 28px at least, taller for a second line. */
export const tallMenuItemClass = `${menuItemBase} min-h-7 py-1`;

/**
 * A menu item that can't be used right now (`aria-disabled`): it stays in
 * the arrow keys' reach, greyed, with the reason as its tooltip.
 */
export const menuItemUnavailableClass =
  "aria-disabled:cursor-default aria-disabled:text-ink-placeholder aria-disabled:hover:bg-transparent";

/** A rule between groups of menu items. */
export const menuRuleClass = "mx-1 my-1 border-t border-rule";
