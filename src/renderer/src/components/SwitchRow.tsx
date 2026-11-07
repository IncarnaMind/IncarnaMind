import { type ReactNode, useId } from "react";
import { hintClass } from "./ui";

/** A switch in a row of a sheet, with what it does under its label. */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 flex-col">
        <label htmlFor={id} className="text-ui text-ink">
          {label}
        </label>
        {hint && (
          <span id={`${id}-hint`} className={hintClass}>
            {hint}
          </span>
        )}
      </div>
      <input
        id={id}
        type="checkbox"
        role="switch"
        data-testid={testId}
        checked={checked}
        aria-checked={checked}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.checked)}
        className="switch shrink-0"
      />
    </div>
  );
}
