import { formatShortDate, formatTime } from "../../../shared/dates";
import { useLanguage, useT } from "../i18n";
import { useMindSource } from "../mindSources";

/**
 * The Mind's snapshot at the foot of its ⋯ menu (#335): a line saying when it
 * was taken, never a button. Updating and removing are the menu's own items.
 */
export function MindSourceFoot({ mindId }: { mindId: string }) {
  const t = useT();
  const language = useLanguage();
  const source = useMindSource(mindId);
  const at = source?.yourNote?.snapshotAt;
  if (!at) return null;
  return (
    <p className="page-menu-counts" data-testid="mind-source-foot">
      {t("mind.sourceFoot", {
        date: formatShortDate(at, language),
        time: formatTime(at, language),
      })}
    </p>
  );
}
