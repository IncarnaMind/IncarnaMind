import { type ReactNode, useState } from "react";
import type { DecisionHostStatus, JevSettings, LibraryClassifier } from "../../../../core/api";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";
import { buttonStyle, rowButtonsClass } from "../ui";
import { DecisionKeyForm, hostName } from "./DecisionKeyForm";
import { JevForm } from "./JevSettings";
import { ProviderLogo } from "./ProviderLogo";

/**
 * Before a key goes, sorting and Organize stop naming the model it reached, so the sorting row
 * shows what sorts next: Automatic's pick, which starts no host by itself (#1907). Nothing is
 * turned on, and nothing is sent anywhere new.
 */
async function stopUsing(reached: (classifier: LibraryClassifier | null) => boolean) {
  const settings = useAppStore.getState().library?.settings;
  if (!settings || !(reached(settings.classifier) || reached(settings.organizeWith))) return;
  await core.saveLibrarySettings({
    ...settings,
    classifier: reached(settings.classifier) ? { kind: "automatic" } : settings.classifier,
    organizeWith: reached(settings.organizeWith) ? null : settings.organizeWith,
  });
}

const isHost = (host: DecisionHostStatus["host"]) => (classifier: LibraryClassifier | null) =>
  classifier?.kind === "decision" && classifier.host === host;
const isJev = (classifier: LibraryClassifier | null) => classifier?.kind === "jev";

/**
 * The keys saved only for sorting and meeting hints (#1907), each a row of Your providers: a
 * host's own key (Perplexity, Liquid AI, Cloudflare with its account) and TypeSafe Jev's. A host
 * that uses a chat provider's key has none: that provider's row is its key.
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
  return (
    <>
      {hosts
        .filter((host) => host.key === "own" && host.hasKey)
        .map((host) => (
          <SortingKeyRow
            key={host.host}
            id={host.host}
            name={hostName(host, language)}
            logo={host.host}
            remove={async () => {
              await stopUsing(isHost(host.host));
              onHosts(await core.removeDecisionKey(host.host));
            }}
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
        ))}
      {jev?.enabled && jev.hasApiKey && (
        <SortingKeyRow
          id="jev"
          name={t("jev.settings.title")}
          logo={null}
          remove={async () => {
            await stopUsing(isJev);
            onJev(await core.removeJevSettings());
          }}
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
  remove,
  form,
}: {
  id: string;
  name: string;
  logo: string | null;
  remove(): Promise<void>;
  /** The form that changes the key in place; `done` puts it away. */
  form(done: () => void): ReactNode;
}) {
  const t = useT();
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const removeKey = async () => {
    setProblem(null);
    try {
      await remove();
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };
  return (
    <li data-testid="sorting-key-row" data-host={id} className="flex flex-col py-2.5">
      <div className="flex items-center gap-3">
        <ProviderLogo id={logo} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui font-semibold text-ink" title={name}>
            {name}
          </span>
          <span className="truncate text-[13px] leading-5 text-ink-meta">
            {t("models.providers.forSorting")}
          </span>
        </span>
        {!changing && (
          <span className={rowButtonsClass}>
            <button
              type="button"
              data-testid="sorting-key-change"
              onClick={() => {
                setProblem(null);
                setChanging(true);
              }}
              className={buttonStyle("secondary")}
            >
              {t("models.providers.changeKey")}
            </button>
            <button
              type="button"
              data-testid="sorting-key-remove"
              onClick={() => void removeKey()}
              className={buttonStyle("ghost")}
            >
              {t("models.providers.removeKey")}
            </button>
          </span>
        )}
      </div>
      {changing && <div className="mt-3 pl-11">{form(() => setChanging(false))}</div>}
      {problem && <ProblemLine className="mt-1 pl-11">{problem}</ProblemLine>}
    </li>
  );
}
