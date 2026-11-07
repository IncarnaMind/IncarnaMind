import { useState } from "react";
import type { Connector, ConnectorRegistryServer } from "../../../../core/api";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { ProblemMark } from "../ProblemLine";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowAction,
  SettingsSection,
} from "../settings/SettingsGroup";
import { errorTextClass, primaryButtonClass } from "../ui";
import { BackToConnectors } from "./ConnectorDetail";
import { ConnectorTile } from "./ConnectorTile";
import { commandLine } from "./commandLine";

/**
 * A community server from the MCP Registry, before the User adds it: who
 * published it, that IncarnaMind hasn't reviewed it, and how it runs. A
 * remote one is added by its URL; a local one opens Add custom connector's
 * command, filled in, for its variables; one IncarnaMind can't run says so.
 */
export function RegistryDetail({
  server,
  onBack,
  onAdded,
  onSetUp,
}: {
  server: ConnectorRegistryServer;
  onBack(): void;
  onAdded(connector: Connector): void;
  onSetUp(server: ConnectorRegistryServer): void;
}) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { url, command } = server;

  const add = async (address: string) => {
    setAdding(true);
    setError(null);
    try {
      onAdded(await core.addConnector({ name: server.name, url: address }));
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setAdding(false);
    }
  };

  return (
    <section
      data-testid="registry-detail"
      data-registry-id={server.id}
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-4">
        <BackToConnectors onBack={onBack} />
        <div className="flex flex-wrap items-center gap-3">
          <ConnectorTile name={server.name} large />
          <div className="flex min-w-[200px] flex-1 flex-col">
            <h4
              data-testid="connector-name"
              className="text-[17px] leading-6 font-semibold break-words text-ink"
            >
              {server.name}
            </h4>
            <p className="flex flex-wrap items-center gap-x-1.5 text-[12px] leading-[18px] text-ink-meta">
              <span className="break-all">
                {t("connectors.registry.by", { publisher: server.publisher })}
              </span>
              <span className="rounded-sm bg-frame px-1.5 text-[11px] leading-[18px] text-ink-secondary">
                {t("connectors.registry.badge")}
              </span>
            </p>
          </div>
          {url ? (
            <button
              type="button"
              data-testid="registry-add"
              disabled={adding}
              onClick={() => void add(url)}
              className={`${primaryButtonClass} shrink-0`}
            >
              {t("connectors.registry.add")}
            </button>
          ) : (
            command && (
              <button
                type="button"
                data-testid="registry-set-up"
                onClick={() => onSetUp(server)}
                className={`${primaryButtonClass} shrink-0`}
              >
                {t("connectors.registry.setUp")}
              </button>
            )
          )}
        </div>
        {error && (
          <p role="alert" className={errorTextClass}>
            <ProblemMark />
            {error}
          </p>
        )}
      </div>
      <SettingsSection help={t("connectors.registry.note")}>
        <SettingsGroup>
          {server.description && (
            <SettingsRow label={<span className="break-words">{server.description}</span>} />
          )}
          <SettingsRow
            label={
              <span className="break-words">
                {url
                  ? t("connectors.registry.remote", { url })
                  : command
                    ? t("connectors.registry.local", {
                        command: commandLine(command.command, command.args),
                      })
                    : t("connectors.registry.cannot")}
              </span>
            }
          />
          {server.link && (
            <SettingsRowAction href={server.link} label={t("connectors.registry.link")} />
          )}
        </SettingsGroup>
      </SettingsSection>
    </section>
  );
}
