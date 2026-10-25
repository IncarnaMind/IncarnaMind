import type { ReactNode } from "react";
import { useT } from "../i18n";
import type { TipId } from "../tips";
import { CloseLineIcon, InfoLineIcon } from "./lineIcons";

export function Tip({
  id,
  onClose,
  children,
}: {
  id: TipId;
  onClose(): void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <p
      role="note"
      data-testid="tip"
      data-tip={id}
      className="flex min-h-6 items-center gap-1.5 text-[12px] leading-4 text-ink-meta"
    >
      <InfoLineIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      <button
        type="button"
        data-testid="tip-close"
        aria-label={t("tip.close")}
        title={t("tip.close")}
        onClick={onClose}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-hover hover:text-ink"
      >
        <CloseLineIcon aria-hidden="true" className="size-3" />
      </button>
    </p>
  );
}
