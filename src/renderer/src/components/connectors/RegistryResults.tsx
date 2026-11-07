import type { ConnectorRegistrySearch, ConnectorRegistryServer } from "../../../../core/api";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ProblemMark } from "../ProblemLine";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowAction,
  SettingsSection,
} from "../settings/SettingsGroup";
import { buttonStyle } from "../ui";
import { ConnectorTile } from "./ConnectorTile";

/**
 * The MCP Registry's community servers for what the User typed, under the
 * reviewed ones: marked "Community · not reviewed", with why it was asked and
 * what that means. While it is asked, a line says so; a failure says why,
 * with what to do.
 */
export function RegistryResults({
  words,
  search,
  onOpen,
  onRetry,
}: {
  words: string;
  /** Null while the Registry is being asked. */
  search: ConnectorRegistrySearch | null;
  onOpen(server: ConnectorRegistryServer): void;
  onRetry(): void;
}) {
  const t = useT();
  return (
    <SettingsSection
      testId="connectors-registry"
      title={
        <>
          {t("connectors.registry.title")}
          <span
            data-testid="connectors-registry-badge"
            className="ml-1.5 rounded-sm bg-frame px-1.5 text-[11px] leading-[18px] font-normal text-ink-secondary"
          >
            {t("connectors.registry.badge")}
          </span>
        </>
      }
      help={t("connectors.registry.note")}
    >
      {search === null ? (
        <p role="status" className="px-4 text-[13px] leading-5 text-ink-meta">
          {t("connectors.registry.searching")}
        </p>
      ) : search.outcome === "failed" ? (
        <SettingsGroup>
          <SettingsRow
            role="alert"
            data-testid="connectors-registry-problem"
            data-reason={search.reason}
            label={
              <span className="break-words">
                <ProblemMark />
                {t(`connectors.registry.failed.${search.reason}`)}
              </span>
            }
            control={
              search.reason === "declined" ? (
                <button
                  type="button"
                  onClick={() => useAppStore.getState().showSettingsPage("privacy")}
                  className={buttonStyle("secondary", "sm")}
                >
                  {t("connectors.registry.privacy")}
                </button>
              ) : search.reason === "local-mode" ? undefined : (
                <button type="button" onClick={onRetry} className={buttonStyle("secondary", "sm")}>
                  {t("connectors.registry.retry")}
                </button>
              )
            }
          />
        </SettingsGroup>
      ) : search.servers.length === 0 ? (
        <p className="px-4 text-[13px] leading-5 text-ink-meta">
          {t("connectors.registry.none", { query: words })}
        </p>
      ) : (
        <SettingsGroup>
          {search.servers.map((server) => (
            <SettingsRowAction
              key={server.id}
              testId="registry-server"
              data-registry-id={server.id}
              data-opens={`registry:${server.id}`}
              onClick={() => onOpen(server)}
              leading={<ConnectorTile name={server.name} />}
              label={server.name}
              detail={<span className="line-clamp-2">{server.description}</span>}
            />
          ))}
        </SettingsGroup>
      )}
    </SettingsSection>
  );
}
