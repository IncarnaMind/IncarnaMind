import { useT } from "../i18n";
import { InfoLineIcon } from "./icons";

/**
 * Said at the top of a Mind this version can't edit: "update" for one of a
 * kind a newer version made (it isn't shown), "read-only" for one a newer
 * version wrote the content of (it is shown, and never written to).
 */
export function MindNotice({ kind }: { kind: "update" | "read-only" }) {
  const t = useT();
  const key = kind === "update" ? "mind.update" : "mind.readOnly";
  return (
    <aside
      role="status"
      data-testid={`mind-notice-${kind}`}
      // Reaching 12px into the margins, so its text keeps the Mind's text edge.
      className="-mx-3 mb-6 flex items-start gap-2.5 rounded-lg bg-accent-wash p-3 font-sans text-ui text-ink-strong"
    >
      <InfoLineIcon className="mt-0.5 shrink-0 text-accent-strong" />
      <p className="min-w-0 flex-1">
        <strong className="text-ink">{t(`${key}.title`)}</strong> {t(`${key}.body`)}
      </p>
    </aside>
  );
}
