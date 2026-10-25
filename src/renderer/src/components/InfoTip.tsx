import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Popover } from "../editor/Popover";
import { useT } from "../i18n";
import { InfoLineIcon } from "./lineIcons";
import { useTopModal } from "./useModal";
import { useTip } from "./useTip";

/** What would be a helper line under a control, as a tooltip beside its label (DESIGN.md, Words on screen). */
export function InfoTip({ text, id, testId }: { text: string; id?: string; testId?: string }) {
  const t = useT();
  const generatedId = useId();
  const descriptionId = id ?? generatedId;
  const button = useRef<HTMLButtonElement>(null);
  const tip = useTip(button);
  const modal = useTopModal();

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={t("settings.help")}
        aria-describedby={descriptionId}
        data-testid={testId}
        onFocus={tip.show}
        onBlur={tip.blur}
        onClick={tip.show}
        onPointerMove={tip.point}
        onPointerLeave={tip.leave}
        className="ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm align-middle text-ink-meta hover:bg-hover hover:text-ink-secondary"
      >
        <InfoLineIcon className="size-3.5" />
      </button>
      {!tip.shown && (
        <span id={descriptionId} role="tooltip" hidden>
          {text}
        </span>
      )}
      {tip.shown &&
        button.current &&
        createPortal(
          <Popover
            anchor={button.current}
            role="tooltip"
            id={descriptionId}
            onDismiss={tip.close}
            onPointerMove={tip.point}
            onPointerLeave={tip.leave}
          >
            <div className="w-max max-w-[min(20rem,calc(100vw-32px))] rounded-md bg-sheet px-3 py-2 text-[12px] leading-5 font-normal text-ink shadow-popover">
              {text}
            </div>
          </Popover>,
          modal ?? document.body,
        )}
    </>
  );
}
