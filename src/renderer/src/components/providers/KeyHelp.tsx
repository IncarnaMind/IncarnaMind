import type { CatalogProvider } from "../../../../core/providers/catalog";
import { useLanguage, useT } from "../../i18n";
import { hintClass } from "../ui";

const linkClass = `${hintClass} mt-0 underline`;

/**
 * What the catalog knows of getting a key, under the key field. First run keeps it all in
 * "Where do I find it?", closed; Settings shows the notes and the key line under the
 * field, and keeps the steps and the key page in the disclosure.
 */
export function KeyHelp({
  catalog,
  keyUrl,
  provider,
  firstRun,
}: {
  catalog: CatalogProvider;
  keyUrl: string | undefined;
  /** Its name, as the interface says it. */
  provider: string;
  firstRun: boolean;
}) {
  const t = useT();
  const words = useLanguage() === "zh-CN" ? "zh" : "en";
  const notes = (catalog.notes ?? []).map((note) => (
    <span key={note.en} data-testid="provider-note" className={hintClass}>
      {note[words]}
    </span>
  ));
  const linkLabel = t(
    catalog.keyLine?.link === "pricing" ? "providers.form.pricing" : "providers.form.details",
  );
  const line = catalog.keyLine && (
    <span data-testid="provider-key-line" className={hintClass}>
      {catalog.keyLine[words]} <span aria-hidden="true">· </span>
      <a href={catalog.keyLine.url} target="_blank" rel="noreferrer" className="underline">
        {linkLabel} ↗
      </a>
    </span>
  );
  const aboveHelp =
    !firstRun && (notes.length > 0 || line) ? (
      <div className="flex flex-col">
        {notes}
        {line}
      </div>
    ) : null;
  const steps = catalog.keyGuide ?? [];
  if (!keyUrl && steps.length === 0 && (!firstRun || (notes.length === 0 && !line))) {
    return aboveHelp;
  }
  return (
    <>
      {aboveHelp}
      <details data-testid="provider-key-help" className="group">
        <summary
          data-testid="provider-key-help-toggle"
          className={`${hintClass} mt-0 flex cursor-default list-none items-baseline gap-1 [&::-webkit-details-marker]:hidden`}
        >
          <span aria-hidden="true" className="group-open:hidden">
            ▸
          </span>
          <span aria-hidden="true" className="hidden group-open:inline">
            ▾
          </span>
          {t("providers.form.whereKey")}
        </summary>
        <div className="mt-1 flex flex-col gap-1 pl-3">
          {firstRun && notes}
          {steps.length > 0 && (
            <ol className="list-decimal pl-4 text-[12px] leading-[18px] text-ink-meta">
              {steps.map((step) => (
                <li key={step.en}>{step[words]}</li>
              ))}
            </ol>
          )}
          {firstRun && line}
          {keyUrl && (
            <a
              href={keyUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="provider-key-link"
              className={linkClass}
            >
              {t("providers.form.keyPage", { provider })} ↗
            </a>
          )}
        </div>
      </details>
    </>
  );
}
