import { type KeyboardEvent, type Ref, type SelectHTMLAttributes, useId } from "react";
import { CheckLineIcon, ChevronUpDownLineIcon } from "../lineIcons";
import { menuFrameClass, menuItemClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";
import { SettingsRow } from "./SettingsGroup";

export interface PopUpOption<Value extends string> {
  value: Value;
  label: string;
}

const popUpLook =
  "h-7 rounded-md border border-rule-strong bg-sheet text-[13px] leading-5 text-ink hover:bg-frame active:bg-hover disabled:opacity-50 disabled:hover:bg-sheet";

/**
 * A choice among a few options, as macOS draws one at a row's right end: a button that shows the
 * chosen option and two chevrons, and opens a menu of the options with the chosen one ticked.
 *
 * It is a button with `aria-haspopup="menu"`, which the system's screen readers announce as a
 * pop-up button, named by the row's label and its value (`labelledBy` is the label's id). Space and
 * Enter open it, as does ↓ or ↑; in the menu the arrows, Home, End and typing a name move, Space or
 * Enter chooses, and Esc closes it with the focus back on the button. Its menu is the app's one
 * popover menu, so it is placed, focused and animated as every menu is.
 */
export function PopUpButton<Value extends string>({
  value,
  options,
  onChange,
  labelledBy,
  testId,
  disabled,
}: {
  value: Value;
  options: readonly PopUpOption<Value>[];
  /** Called with the option picked, also when it is the one already shown. */
  onChange(value: Value): void;
  labelledBy?: string;
  testId?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const menu = usePopoverMenu({ align: "end" });
  const chosen = options.find((option) => option.value === value);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    menu.show();
  };

  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        id={id}
        aria-labelledby={labelledBy ? `${labelledBy} ${id}` : undefined}
        data-testid={testId}
        data-value={value}
        disabled={disabled}
        onKeyDown={onKeyDown}
        className={`inline-flex max-w-64 items-center gap-1 pr-1.5 pl-2.5 ${popUpLook}`}
      >
        <span className="truncate">{chosen?.label ?? value}</span>
        <ChevronUpDownLineIcon className="size-3.5 shrink-0 text-ink-meta" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-labelledby={id}
        data-testid={testId === undefined ? undefined : `${testId}-menu`}
        // An option names its model, as "Same as Answers (Claude Sonnet 5.5)", on one line.
        className={`${menuFrameClass} w-max max-w-80 min-w-48`}
      >
        {options.map((option) => (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a menuitemradio takes aria-checked.
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={option.value === value}
            data-value={option.value}
            onClick={() => {
              onChange(option.value);
              menu.close();
            }}
            className={`${menuItemClass} pl-2`}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {option.value === value && <CheckLineIcon className="size-4" />}
            </span>
            <span className="flex-1">{option.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * A row with a pop-up button at its end, the label naming the button: a choice among a few
 * options, such as the interface language, Motion or Appearance.
 */
export function SettingsPopUpRow<Value extends string>({
  label,
  tip,
  detail,
  value,
  options,
  onChange,
  testId,
  buttonTestId,
}: {
  label: string;
  tip?: string;
  detail?: string;
  value: Value;
  options: readonly PopUpOption<Value>[];
  onChange(value: Value): void;
  testId?: string;
  buttonTestId?: string;
}) {
  const labelId = useId();
  return (
    <SettingsRow
      data-testid={testId}
      label={label}
      labelId={labelId}
      tip={tip}
      detail={detail}
      control={
        <PopUpButton
          value={value}
          options={options}
          onChange={onChange}
          labelledBy={labelId}
          testId={buttonTestId}
        />
      }
    />
  );
}

/**
 * A native `<select>` drawn as a pop-up button, for a long or grouped list of options (the models
 * of a provider), where the system's own menu scrolls and finds a name by typing better than a
 * drawn one. Pass the `<select>`'s props and its `<option>`s; name it with `aria-label` or a
 * `<label>`.
 */
export function PopUpSelect({
  className = "",
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return (
    <span className="relative inline-flex max-w-full min-w-0">
      <select {...rest} className={`min-w-0 appearance-none pr-7 pl-2.5 ${popUpLook} ${className}`}>
        {children}
      </select>
      <ChevronUpDownLineIcon className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-ink-meta" />
    </span>
  );
}
