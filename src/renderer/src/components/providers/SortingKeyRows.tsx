import { type ReactNode, useState } from "react";
import type { DecisionHostStatus, JevSettings } from "../../../../core/api";
import { catalogProvider } from "../../../../core/providers/catalog/providers";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import { ProblemLine } from "../ProblemLine";
import { SettingsRow } from "../settings/SettingsGroup";
import { buttonStyle } from "../ui";
import { DecisionKeyForm, hostName } from "./DecisionKeyForm";
import { JevForm } from "./JevSettings";
import { ProviderLogo } from "./ProviderLogo";
import { keptForSorting } from "./sortingOptions";

/**
 * What Your providers keeps only for sorting and meeting hints (#1907), each its own row: a host's
 * own key (Perplexity, Liquid AI, Cloudflare with its account ID), Alibaba's workspace beside the
 * Qwen key, and TypeSafe Jev's key. Another host that uses a chat key has nothing of its own to
 * keep: that provider's row is its key. Removing one that sorting uses gives sorting back to
 * Automatic, in the core.
 */
export function SortingKeyRows({
  hosts,
  jev,
  onHosts,
  onJev,
}: {
  hosts: readonly DecisionHostStatus[];
  jev: JevSettings | null;
  onHosts(hosts: DecisionHostStatus[]): void;
  onJev(jev: JevSettings): void;
}) {
  const t = useT();
  const language = useLanguage();
  const lang = language === "zh-CN" ? "zh" : "en";
  return (
    <>
      {hosts.filter(keptForSorting).map((host) => {
        const account = host.account?.value;
        const workspace = host.key === "provider";
        return (
          <SortingKeyRow
            key={host.host}
            id={host.host}
            name={
              workspace && host.provider
                ? (catalogProvider(host.provider)?.name[lang] ?? hostName(host, language))
                : hostName(host, language)
            }
            logo={workspace ? host.provider : host.host}
            status={
              !account
                ? t("models.providers.forSorting")
                : t(
                    workspace
                      ? "models.providers.forSorting.workspace"
                      : "models.providers.forSorting.account",
                    { id: account },
                  )
            }
            change={t(workspace ? "decisions.account.change" : "models.providers.changeKey")}
            remove={t(workspace ? "providers.settings.remove" : "models.providers.removeKey")}
            onRemove={async () => onHosts(await core.removeDecisionKey(host.host))}
            form={(done) => (
              <DecisionKeyForm
                host={host}
                onSaved={(saved) => {
                  onHosts(saved);
                  done();
                }}
                onCancel={done}
              />
            )}
          />
        );
      })}
      {jev?.enabled && jev.hasApiKey && (
        <SortingKeyRow
          id="jev"
          name={t("jev.settings.title")}
          logo={null}
          status={t("models.providers.forSorting")}
          change={t("models.providers.changeKey")}
          remove={t("models.providers.removeKey")}
          onRemove={async () => onJev(await core.removeJevSettings())}
          form={(done) => (
            <JevForm
              current={jev}
              onSaved={(saved) => {
                onJev(saved);
                done();
              }}
              onCancel={done}
            />
          )}
        />
      )}
    </>
  );
}

function SortingKeyRow({
  id,
  name,
  logo,
  status,
  change,
  remove,
  onRemove,
  form,
}: {
  id: string;
  name: string;
  logo: string | null;
  status: string;
  change: string;
  remove: string;
  onRemove(): Promise<void>;
  /** The form that changes the key in place; `done` puts it away. */
  form(done: () => void): ReactNode;
}) {
  const t = useT();
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const removeKey = async () => {
    setProblem(null);
    try {
      await onRemove();
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };
  const below = changing || problem !== null;
  return (
    <SettingsRow
      role="listitem"
      data-testid="sorting-key-row"
      data-host={id}
      leading={<ProviderLogo id={logo} />}
      label={
        <span className="block truncate" title={name}>
          {name}
        </span>
      }
      detail={
        <span data-testid="sorting-key-status" className="block truncate" title={status}>
          {status}
        </span>
      }
      control={
        changing ? undefined : (
          <>
            <button
              type="button"
              data-testid="sorting-key-change"
              onClick={() => {
                setProblem(null);
                setChanging(true);
              }}
              className={buttonStyle("secondary", "sm")}
            >
              {change}
            </button>
            <button
              type="button"
              data-testid="sorting-key-remove"
              onClick={() => void removeKey()}
              className={buttonStyle("ghost", "sm")}
            >
              {remove}
            </button>
          </>
        )
      }
    >
      {below && (
        <div className="flex flex-col gap-1 pl-11">
          {changing && form(() => setChanging(false))}
          {problem && <ProblemLine>{problem}</ProblemLine>}
        </div>
      )}
    </SettingsRow>
  );
}
