import { useRef } from "react";
import { ClaimMarkIcon } from "../editor/icons";
import { useDismissOnEscape } from "../escapeDismiss";
import { useT } from "../i18n";
import { useFade } from "../motion";
import { type Confirmation, useNotices } from "../notices";
import { CheckLineIcon } from "./lineIcons";

/**
 * "Copied", for a few seconds, at the foot of the sidebar beside the undo
 * line: what the User asked to copy (a path) is on the clipboard. Not an
 * error, so it goes by itself, or with Esc. Read out politely.
 */
export function CopiedLine() {
  const confirmation = useNotices((state) => state.confirmation);
  return (
    <div role="status" aria-live="polite" data-testid="copied-line" className="flex flex-col">
      {confirmation && <Line key={confirmation.id} confirmation={confirmation} />}
    </div>
  );
}

function Line({ confirmation }: { confirmation: Confirmation }) {
  const t = useT();
  const line = useRef<HTMLDivElement>(null);
  useFade(line);
  useDismissOnEscape(true, () => useNotices.getState().dismissConfirmation());
  return (
    <div
      ref={line}
      className="mx-2 flex items-center gap-1 pt-0.5 pb-1 pl-2 text-[12px] leading-4 text-ink-secondary"
    >
      {confirmation.look ? (
        <ClaimMarkIcon state="unsupported" className="size-3.5 shrink-0" />
      ) : (
        <CheckLineIcon className="size-3.5 shrink-0" />
      )}
      {t(confirmation.message, confirmation.params)}
    </div>
  );
}
