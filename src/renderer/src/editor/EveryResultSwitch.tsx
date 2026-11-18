import type * as Y from "yjs";
import { setEveryCheckResult } from "../../../shared/everyCheckResult";
import { useT } from "../i18n";
import { useEveryCheckResult } from "./useEveryCheckResult";

/**
 * "Show every check result" (#3358): one switch for the Note, in its ⋯ menu and on its Checks
 * card. On, every checked sentence shows its mark, as before; off, only what needs a look and what
 * wasn't checked do.
 */
export function EveryResultSwitch({
  doc,
  inMenu = false,
  testId,
}: {
  doc: Y.Doc;
  /** In a menu the item itself is the switch, a `menuitemcheckbox`. */
  inMenu?: boolean;
  testId: string;
}) {
  const t = useT();
  const shown = useEveryCheckResult(doc);
  const content = (
    <>
      <span className="flex-1">{t("checks.everyResult")}</span>
      <span className="switch" data-on={shown || undefined} aria-hidden="true" />
    </>
  );
  const toggle = () => setEveryCheckResult(doc, !shown);
  return inMenu ? (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={shown}
      data-testid={testId}
      className="page-menu-switch"
      onClick={toggle}
    >
      {content}
    </button>
  ) : (
    <button
      type="button"
      role="switch"
      aria-checked={shown}
      data-testid={testId}
      className="check-card-switch"
      onMouseDown={(event) => event.preventDefault()}
      onClick={toggle}
    >
      {content}
    </button>
  );
}
