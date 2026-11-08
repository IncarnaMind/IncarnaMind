import type { JevSettings } from "../../../../core/api";
import { JEV_PRICING_URL, JEV_SERVICE } from "../../../../core/providers/jev";
import { useT } from "../../i18n";
import { hintClass } from "../ui";
import { JevForm } from "./JevSettings";
import { SortingLine } from "./SortingChoice";

/**
 * "Use TypeSafe Jev…" chosen in the sorting picker (#2615): what Jev is, then the one Jev key
 * entry, with what choosing it sends above its Use this, which saves the key and makes Jev what
 * sorts.
 */
export function JevSortingSetUp({
  jev,
  choose,
  onChosen,
  onCancel,
}: {
  jev: JevSettings;
  choose(): Promise<boolean>;
  onChosen(): void;
  onCancel(): void;
}) {
  const t = useT();
  return (
    <div data-testid="jev-sorting-set-up" className="flex flex-col gap-2">
      <p data-testid="jev-sorting-line" className={`${hintClass} mt-0`}>
        {t("jev.setUp.line")} <span aria-hidden="true">· </span>
        <a
          href={JEV_PRICING_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="jev-pricing"
          className="underline underline-offset-2 hover:text-ink"
        >
          {t("providers.form.pricing")} ↗
        </a>
      </p>
      <JevForm
        current={jev}
        sorting={{
          consent: (service) => (
            <SortingLine
              option={{
                classifier: { kind: "jev" },
                label: JEV_SERVICE.name,
                provider: service,
                decisionModel: true,
              }}
              choosing={false}
            />
          ),
          choose,
        }}
        onSaved={(_saved, chosen) => {
          if (chosen) onChosen();
        }}
        onCancel={onCancel}
      />
    </div>
  );
}
