import type { DecisionHostStatus, JevSettings } from "../../../../core/api";
import { catalogProvider } from "../../../../core/providers/catalog/providers";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { DecisionKeyForm, hostName } from "./DecisionKeyForm";
import { JevForm } from "./JevSettings";
import { KeyRow } from "./KeyRow";
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
          <KeyRow
            key={host.host}
            testId="sorting-key"
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
        <KeyRow
          testId="sorting-key"
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
