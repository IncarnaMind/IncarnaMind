import { useId, useRef } from "react";
import { useT } from "../i18n";
import { InfoLineIcon } from "./lineIcons";
import { TipBubble } from "./TipBubble";
import { useTip } from "./useTip";

/** What would be a helper line under a control, as a tooltip beside its label (DESIGN.md, Words on screen). */
export function InfoTip({ text, id, testId }: { text: string; id?: string; testId?: string }) {
  const t = useT();
  const generatedId = useId();
  const descriptionId = id ?? generatedId;
  const button = useRef<HTMLButtonElement>(null);
  const tip = useTip(button);

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
      <TipBubble anchor={button.current} id={descriptionId} text={text} tip={tip} />
    </>
  );
}
