import type { Ref } from "react";
import { SearchLineIcon } from "./lineIcons";

/** A search field: Esc empties it first, and only once it is empty closes what it is in. */
export function SearchField({
  value,
  onChange,
  label,
  testId,
  inputRef,
  className = "",
}: {
  value: string;
  onChange(value: string): void;
  /** Its placeholder, and its name for a screen reader. */
  label: string;
  testId: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Its height and background, where they differ. */
  className?: string;
}) {
  return (
    <label
      className={`flex items-center gap-2 rounded-lg px-2.5 text-ink-meta shadow-[inset_0_0_0_1px_var(--color-rule-strong)] focus-within:shadow-[inset_0_0_0_1px_var(--color-accent)] ${className}`}
    >
      <SearchLineIcon className="size-3.5 shrink-0" />
      <input
        ref={inputRef}
        type="search"
        data-testid={testId}
        value={value}
        placeholder={label}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value !== "") {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-placeholder"
      />
    </label>
  );
}
