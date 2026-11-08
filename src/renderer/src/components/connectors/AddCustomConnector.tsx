import { type KeyboardEvent, useId, useState } from "react";
import type { Connector } from "../../../../core/api";
import { useT } from "../../i18n";
import { SettingsHelp } from "../settings/SettingsGroup";
import { BackToConnectors } from "./ConnectorDetail";
import { ConnectorForm } from "./ConnectorForm";
import { ConnectorImport } from "./ConnectorImport";

const tabs = ["remote", "local", "import"] as const;
type Tab = (typeof tabs)[number];

const tabLabel = {
  remote: "connectors.custom.remote",
  local: "connectors.custom.local",
  import: "connectors.custom.import",
} as const;

/**
 * Add custom connector: a remote server by its URL, a local one by its
 * command, or the ones set up in Claude Desktop or Cursor, imported. Neither
 * is reviewed, as the page says.
 */
export function AddCustomConnector({
  onBack,
  onAdded,
  prefill,
}: {
  onBack(): void;
  /** One Connector added, whose page opens next. */
  onAdded(connector: Connector): void;
  /** A command to start from, e.g. a community server's from the MCP Registry: it opens on Command. */
  prefill?: { name: string; command: string; args: string[]; env: string[] };
}) {
  const t = useT();
  const id = useId();
  const [tab, setTab] = useState<Tab>(prefill ? "local" : "remote");
  const done = (connector?: Connector) => (connector ? onAdded(connector) : onBack());

  // The arrow keys move between the tabs, as in any tab strip.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length] ?? tab;
    setTab(next);
    document.getElementById(`${id}-${next}`)?.focus();
  };

  return (
    <section data-testid="connector-custom" className="flex flex-col gap-4">
      <BackToConnectors onBack={onBack} />
      <h4 className="text-[20px] leading-7 font-semibold text-ink">
        {t("connectors.custom.title")}
      </h4>
      <div
        role="tablist"
        aria-label={t("connectors.custom.title")}
        onKeyDown={onKeyDown}
        className="inline-flex flex-wrap gap-0.5 self-start rounded-lg bg-frame p-0.5 shadow-[inset_0_0_0_1px_var(--color-rule)]"
      >
        {tabs.map((each) => (
          <button
            key={each}
            id={`${id}-${each}`}
            type="button"
            role="tab"
            aria-selected={tab === each}
            aria-controls={`${id}-panel`}
            tabIndex={tab === each ? 0 : -1}
            onClick={() => setTab(each)}
            className={`h-7 rounded-md px-3 text-[13px] leading-7 ${
              tab === each
                ? "bg-sheet font-semibold text-ink shadow-[0_0_0_1px_var(--color-rule)]"
                : "text-ink-secondary hover:text-ink"
            }`}
          >
            {t(tabLabel[each])}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`}>
        {tab === "import" ? (
          <ConnectorImport onDone={onBack} />
        ) : (
          <ConnectorForm
            key={tab}
            kind={tab}
            onDone={done}
            prefill={tab === "local" ? prefill : undefined}
          />
        )}
      </div>
      <SettingsHelp>{t("connectors.custom.note")}</SettingsHelp>
    </section>
  );
}
