import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useEffect, useId, useRef } from "react";
import { TipBubble } from "../components/TipBubble";
import { useTip } from "../components/useTip";
import { translateNow, useT } from "../i18n";

export const missingNumberWordsNow = (): string => translateNow("missingNumber.words");

/**
 * "[number missing]" where a figure couldn't be calculated (#2577), in the can't-check look, with
 * the shared tip when the pointer rests on it and at once while it is selected.
 */
export function MissingNumberView({ selected }: ReactNodeViewProps) {
  const t = useT();
  const id = useId();
  const mark = useRef<HTMLSpanElement>(null);
  const tip = useTip(mark, () => selected);
  const { show, close } = tip;
  useEffect(() => {
    if (selected) show();
    else close();
  }, [selected, show, close]);

  return (
    <NodeViewWrapper as="span" className="missing-number-wrap">
      <span
        ref={mark}
        data-testid="missing-number"
        aria-describedby={id}
        className="missing-number"
        onPointerMove={tip.point}
        onPointerLeave={tip.leave}
      >
        {t("missingNumber.words")}
      </span>
      <TipBubble anchor={mark.current} id={id} text={t("missingNumber.tip")} tip={tip} />
    </NodeViewWrapper>
  );
}
