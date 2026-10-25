import { type ReactNode, useId, useState } from "react";
import { useT } from "../i18n";

export function DetailsLine({
  children,
  details,
  testId,
  id,
  className = "",
}: {
  children: string;
  details: ReactNode;
  testId: string;
  id?: string;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div id={id} data-testid={testId} className={className}>
      <p>
        {children}{" "}
        <span className="whitespace-nowrap">
          <span aria-hidden="true">· </span>
          <button
            type="button"
            data-testid={`${testId}-details`}
            aria-expanded={open}
            aria-controls={panel}
            onClick={() => setOpen(!open)}
            className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
          >
            {t("details.label")}
          </button>
        </span>
      </p>
      {open && (
        <div id={panel} data-testid={`${testId}-list`} className="mt-0.5">
          {details}
        </div>
      )}
    </div>
  );
}
