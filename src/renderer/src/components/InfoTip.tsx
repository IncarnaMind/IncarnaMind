import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Popover } from "../editor/Popover";
import { useT } from "../i18n";
import { InfoLineIcon } from "./lineIcons";
import { useTopModal } from "./useModal";

/** What would be a helper line under a control, as a tooltip beside its label (DESIGN.md, Words on screen). */
export function InfoTip({ text, id, testId }: { text: string; id?: string; testId?: string }) {
  const t = useT();
  const generatedId = useId();
  const descriptionId = id ?? generatedId;
  const button = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState(false);
  const pointing = useRef(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modal = useTopModal();

  const cancelClose = () => {
    if (closing.current !== null) clearTimeout(closing.current);
    closing.current = null;
  };
  const show = () => {
    cancelClose();
    setShown(true);
  };
  const close = () => {
    cancelClose();
    pointing.current = button.current?.matches(":hover") ?? false;
    setShown(false);
  };
  const closeAfterPointer = () => {
    cancelClose();
    closing.current = setTimeout(() => {
      closing.current = null;
      if (!pointing.current && document.activeElement !== button.current) setShown(false);
    }, 100);
  };
  // Pointing is a move, not an enter: a tip that opens for the keyboard under a resting pointer
  // hears it enter, and would stay once the focus moves on (#1519).
  const point = () => {
    if (pointing.current) return;
    pointing.current = true;
    show();
  };
  const leave = () => {
    pointing.current = false;
    closeAfterPointer();
  };
  const blur = () => {
    if (!pointing.current) close();
  };
  useEffect(
    () => () => {
      if (closing.current !== null) clearTimeout(closing.current);
    },
    [],
  );

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={t("settings.help")}
        aria-describedby={descriptionId}
        data-testid={testId}
        onFocus={show}
        onBlur={blur}
        onClick={show}
        onPointerMove={point}
        onPointerLeave={leave}
        className="ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm align-middle text-ink-meta hover:bg-hover hover:text-ink-secondary"
      >
        <InfoLineIcon className="size-3.5" />
      </button>
      {!shown && (
        <span id={descriptionId} role="tooltip" hidden>
          {text}
        </span>
      )}
      {shown &&
        button.current &&
        createPortal(
          <Popover
            anchor={button.current}
            role="tooltip"
            id={descriptionId}
            onDismiss={close}
            onPointerMove={point}
            onPointerLeave={leave}
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
