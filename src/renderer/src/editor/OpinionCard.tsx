import type { Editor } from "@tiptap/core";
import { useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type * as Y from "yjs";
import { readOpinionSentences } from "../../../shared/opinions";
import { closeOpenClaim, setClaimFocus, useChecks } from "../checks";
import { useT } from "../i18n";
import { ClaimPartRows } from "./ClaimPartRows";
import { focusFirstAction, keepFocusInside } from "./cardFocus";
import { useCardPlace } from "./checkPlace";
import { claimCardPlace } from "./claimCardPlace";
import { shownClaims } from "./claimChecks";
import { checkOpinion, useOpinionChecks } from "./opinionChecks";
import { Popover } from "./Popover";

export function OpinionCard({
  editor,
  mindId,
  doc,
}: {
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
}) {
  const t = useT();
  const place = useCardPlace(mindId);
  const id = useChecks((state) => state.openClaim[place]);
  const focus = useChecks((state) => state.focusClaim[place] === id);
  const opinions = useOpinionChecks(editor, doc);
  const checking = useChecks((state) => state.running[mindId] !== undefined);
  const { from, to } = editor.state.selection;
  const opinion =
    opinions.find((each) => each.id === id && each.range.from <= from && to <= each.range.to) ??
    opinions.find((each) => each.id === id);
  const card = useRef<HTMLDivElement>(null);
  const anchor = useMemo(
    () =>
      opinion
        ? {
            contextElement: editor.view.dom,
            getBoundingClientRect() {
              const start = editor.view.domAtPos(opinion.range.from);
              const end = editor.view.domAtPos(opinion.range.to);
              const range = document.createRange();
              range.setStart(start.node, start.offset);
              range.setEnd(end.node, end.offset);
              return range.getBoundingClientRect();
            },
          }
        : null,
    [editor, opinion],
  );
  if (!opinion || !anchor || shownClaims(editor.state).some((claim) => claim.check.id === id))
    return null;
  const entry = readOpinionSentences(doc).find((each) => each.id === id);
  if (!entry) return null;
  const dismiss = () => {
    closeOpenClaim(place, opinion.id);
    setClaimFocus(place, null);
  };
  return createPortal(
    <Popover
      anchor={anchor}
      placement="bottom-end"
      middleware={() => claimCardPlace(anchor)}
      initialFocus={{
        current: focus ? { focus: () => focusFirstAction(card.current, editor.view.dom) } : null,
      }}
      aria-label={t("claim.card.label", { state: t("claim.opinion"), sentence: opinion.text })}
      data-testid="claim-card"
      data-check="opinion"
      onKeyDown={(event) => keepFocusInside(event, event.currentTarget)}
      onDismiss={(how) => {
        if (how === "escape") editor.view.focus();
        dismiss();
      }}
    >
      <div ref={card} className="citation-card citation-card--cant-check" contentEditable={false}>
        <p className="claim-card-sentence" data-testid="claim-sentence">
          {t("claim.sentence", { sentence: opinion.text })}
        </p>
        <ClaimPartRows
          editor={editor}
          id={opinion.id}
          text={opinion.text}
          parts={entry.parts}
          checking={checking}
          onOpen={dismiss}
          onCheck={(span) => {
            const target = opinions.find(
              (each) =>
                each.id === opinion.id &&
                each.span.start === span.start &&
                each.span.end === span.end,
            );
            if (!target) return;
            checkOpinion(editor, mindId, doc, target, place);
          }}
        />
      </div>
    </Popover>,
    document.body,
  );
}
