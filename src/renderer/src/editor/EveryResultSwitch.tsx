import type * as Y from "yjs";
import { setEveryCheckResult } from "../../../shared/everyCheckResult";
import { useT } from "../i18n";
import { useEveryCheckResult } from "./useEveryCheckResult";

/**
 * "Show every check result" (#3358): one switch for the Note, on its Checks card and in ⌘K. On, every checked sentence shows its mark, as before; off, only what needs a look and what
 * wasn't checked do.
 */
export function EveryResultSwitch({ doc, testId }: { doc: Y.Doc; testId: string }) {
  const t = useT();
  const shown = useEveryCheckResult(doc);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={shown}
      data-testid={testId}
      className="check-card-switch"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => setEveryCheckResult(doc, !shown)}
    >
      <span className="flex-1">{t("checks.everyResult")}</span>
      <span className="switch" data-on={shown || undefined} aria-hidden="true" />
    </button>
  );
}
