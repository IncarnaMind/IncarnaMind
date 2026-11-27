import type { CitationCheck } from "../../../core/api";
import { CheckMarkIcon } from "../components/icons";

export function ChartCheck({
  check,
  label,
  size = "lg",
}: {
  /** Null: the value has no Citation. */
  check: CitationCheck | null;
  label: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="chart-check"
      data-check={check ?? "none"}
      className={`chart-check chart-check--${size} chart-check--${check ?? "none"}`}
    >
      {check && <CheckMarkIcon check={check} className="chart-check-icon" />}
    </span>
  );
}
