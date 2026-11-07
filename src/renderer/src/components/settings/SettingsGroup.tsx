import { type CSSProperties, type HTMLAttributes, type ReactNode, type Ref, useId } from "react";
import { InfoTip } from "../InfoTip";
import { ChevronRightLineIcon } from "../lineIcons";

/** The room an icon takes before a row's words: its 32px and the 12px after it. */
const LEADING_PX = 44;
/** Where a row's words start, and so where the hairline above it does. */
const TEXT_EDGE_PX = 16;

/** Whether an optional piece of a row has anything to show: `cond && <p/>` may be false or "". */
const present = (node: ReactNode) =>
  node !== undefined && node !== null && node !== false && node !== "";

/**
 * A Settings section in the macOS System Settings way: its title above in 13/20 weight 600
 * `ink-secondary`, one or more groups of rows under it, and help for them in 12/18 `ink-meta` under
 * the last. Titles and help start at the rows' text edge.
 */
export function SettingsSection({
  title,
  titleId,
  tip,
  help,
  helpId,
  testId,
  ref,
  children,
}: {
  title?: ReactNode;
  /** The id of the title, for a group it names (`aria-labelledby`). */
  titleId?: string;
  /** A tooltip beside the title, for what a row's own lines don't say. */
  tip?: string;
  help?: ReactNode;
  helpId?: string;
  testId?: string;
  ref?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <section ref={ref} data-testid={testId}>
      {title !== undefined && (
        <h4
          id={titleId}
          className="mb-2 flex items-center px-4 text-[13px] leading-5 font-semibold text-ink-secondary"
        >
          {title}
          {tip !== undefined && <InfoTip text={tip} />}
        </h4>
      )}
      {children}
      {present(help) && <SettingsHelp id={helpId}>{help}</SettingsHelp>}
    </section>
  );
}

/** One rounded group: `sheet` on the page's `frame`, a hairline edge, rows split by inset hairlines. */
export function SettingsGroup({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`rounded-[10px] border border-rule bg-sheet [&>:first-child]:rounded-t-[9px] [&>:last-child]:rounded-b-[9px] ${className}`}
    />
  );
}

/** Help for the group above it: 12/18 `ink-meta`, from the rows' text edge. */
export function SettingsHelp({
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div {...rest} className={`mt-2 px-4 text-[12px] leading-[18px] text-ink-meta ${className}`} />
  );
}

interface RowWords {
  label?: ReactNode;
  /** The id of the control the label names: the label is then a `<label>`. */
  htmlFor?: string;
  /** The id of the label, for a control it names (`aria-labelledby`). */
  labelId?: string;
  /** A tooltip beside the label, for what needs more than a line. */
  tip?: string;
  tipId?: string;
  /** What the row is about, in 12/18 `ink-meta` under its label. */
  detail?: ReactNode;
  detailId?: string;
}

/** A row's label, its ⓘ and the lines under them. */
function RowWords({ label, htmlFor, labelId, tip, tipId, detail, detailId }: RowWords) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {(label !== undefined || tip !== undefined) && (
        <div className="flex min-h-5 items-center">
          {label !== undefined &&
            (htmlFor ? (
              <label htmlFor={htmlFor} id={labelId} className="min-w-0 text-ui text-ink">
                {label}
              </label>
            ) : (
              <span id={labelId} className="min-w-0 text-ui text-ink">
                {label}
              </span>
            ))}
          {tip !== undefined && <InfoTip id={tipId} text={tip} />}
        </div>
      )}
      {present(detail) && (
        <div id={detailId} className="text-[12px] leading-[18px] text-ink-meta">
          {detail}
        </div>
      )}
    </div>
  );
}

const insetOf = (leading: boolean): CSSProperties =>
  ({ "--row-inset": `${leading ? TEXT_EDGE_PX + LEADING_PX : TEXT_EDGE_PX}px` }) as CSSProperties;

/**
 * A row of a group: 44px at least, its label and lines on the left and its control (a switch, a
 * pop-up button, a button) at the right end. `children` go full width under them, for a field or
 * a note that belongs to the row. `leading` is an icon of 32px before the words; the hairline above
 * the row then starts at the words.
 */
export function SettingsRow({
  label,
  htmlFor,
  labelId,
  tip,
  tipId,
  detail,
  detailId,
  control,
  leading,
  align = "center",
  children,
  className = "",
  style,
  ...rest
}: RowWords & {
  control?: ReactNode;
  leading?: ReactNode;
  align?: "center" | "start";
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div
      {...rest}
      style={{ ...insetOf(leading !== undefined), ...style }}
      className={`settings-row ${className}`}
    >
      <div
        className={`flex min-h-11 gap-3 px-4 py-2 ${align === "center" ? "items-center" : "items-start"}`}
      >
        {leading !== undefined && (
          <span className="flex size-8 shrink-0 items-center">{leading}</span>
        )}
        <RowWords
          label={label}
          htmlFor={htmlFor}
          labelId={labelId}
          tip={tip}
          tipId={tipId}
          detail={detail}
          detailId={detailId}
        />
        {control !== undefined && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{control}</div>
        )}
      </div>
      {present(children) && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

const rowActionClass =
  "settings-row flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left hover:bg-frame active:bg-hover focus-visible:-outline-offset-2";

/**
 * A row that is itself the button (or the link, with `href`): it opens a provider, a Connector, a
 * folder. `trailing` is what sits at its end, a chevron unless it says otherwise.
 */
export function SettingsRowAction({
  label,
  detail,
  leading,
  trailing,
  href,
  onClick,
  testId,
  ...rest
}: {
  label: ReactNode;
  detail?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  href?: string;
  onClick?(): void;
  testId?: string;
} & Omit<HTMLAttributes<HTMLElement>, "children" | "onClick">) {
  const inner = (
    <>
      {leading !== undefined && (
        <span className="flex size-8 shrink-0 items-center">{leading}</span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 text-ui text-ink">{label}</span>
        {present(detail) && (
          <span className="text-[12px] leading-[18px] text-ink-meta">{detail}</span>
        )}
      </span>
      {trailing ?? <ChevronRightLineIcon className="size-4 shrink-0 text-ink-placeholder" />}
    </>
  );
  const common = {
    ...rest,
    "data-testid": testId,
    style: insetOf(leading !== undefined),
    className: rowActionClass,
  };
  return href !== undefined ? (
    <a {...common} href={href} target="_blank" rel="noreferrer">
      {inner}
    </a>
  ) : (
    <button {...common} type="button" onClick={onClick}>
      {inner}
    </button>
  );
}

/** A switch: the app's one native checkbox with `role="switch"`, for a row's right end. */
export function SettingsSwitch({
  checked,
  onChange,
  testId,
  id,
  ariaLabel,
  describedBy,
  disabled,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  testId?: string;
  id?: string;
  /** The switch's name, when no `<label>` has it (a row of a list, named by its item). */
  ariaLabel?: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      data-testid={testId}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      className="switch"
    />
  );
}

/** A row with a switch at its end: its label names the switch, and its tip and lines describe it. */
export function SettingsSwitchRow({
  label,
  tip,
  detail,
  checked,
  onChange,
  testId,
  switchTestId,
  disabled,
  children,
}: {
  label: ReactNode;
  tip?: string;
  detail?: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  testId?: string;
  switchTestId: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  const described = [
    tip !== undefined ? `${id}-tip` : null,
    present(detail) ? `${id}-detail` : null,
  ]
    .filter((each) => each !== null)
    .join(" ");
  return (
    <SettingsRow
      data-testid={testId}
      label={label}
      htmlFor={id}
      tip={tip}
      tipId={`${id}-tip`}
      detail={detail}
      detailId={`${id}-detail`}
      control={
        <SettingsSwitch
          id={id}
          checked={checked}
          onChange={onChange}
          testId={switchTestId}
          describedBy={described === "" ? undefined : described}
          disabled={disabled}
        />
      }
    >
      {children}
    </SettingsRow>
  );
}
