import { useState } from "react";
import type { DecisionHostStatus } from "../../../../core/api";
import { catalogProvider } from "../../../../core/providers/catalog/providers";
import { core } from "../../core";
import { useDecisionHosts } from "../../decisionHosts";
import { errorMessage } from "../../errors";
import { useGap, useLanguage, useT } from "../../i18n";
import { ProblemLine } from "../ProblemLine";
import {
  buttonStyle,
  rowButtonsClass,
  rowStatusClass,
  rowTextClass,
  rowTitleClass,
  ruledListClass,
  ruledRowClass,
  sectionNoteClass,
  sectionTitleClass,
} from "../ui";
import { DecisionKeyForm, hostName } from "./DecisionKeyForm";

const NAMED = 3;

/**
 * Settings › Models: every host of decision models (#1907), as Settings › Meetings lists the
 * transcription services: a key of its own added, changed or removed here, a chat provider's key
 * added where the providers are, and the account a host asks for. TypeSafe's Jev keeps its own
 * section under Advanced, with its server and review band.
 */
export function DecisionHostsSection({
  onAddProvider,
}: {
  /** Opens the page where a chat provider's key is added, by its catalog id. */
  onAddProvider(catalogId: string): void;
}) {
  const t = useT();
  const [hosts, setHosts] = useDecisionHosts();
  if (!hosts) return null;
  return (
    <section data-testid="decision-hosts" className="flex flex-col">
      <h4 className={sectionTitleClass}>{t("decisions.title")}</h4>
      <p className={sectionNoteClass}>{t("decisions.intro")}</p>
      <div className={ruledListClass}>
        {hosts.map((host) => (
          <DecisionHostRow
            key={host.host}
            host={host}
            onChanged={setHosts}
            onAddProvider={onAddProvider}
          />
        ))}
      </div>
    </section>
  );
}

function DecisionHostRow({
  host,
  onChanged,
  onAddProvider,
}: {
  host: DecisionHostStatus;
  onChanged(hosts: DecisionHostStatus[]): void;
  onAddProvider(catalogId: string): void;
}) {
  const t = useT();
  const language = useLanguage();
  const spaced = useGap();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = hostName(host, language);
  const provider = host.provider ? catalogProvider(host.provider) : undefined;
  const named = provider?.name[language === "zh-CN" ? "zh" : "en"] ?? "";
  // The Chinese line has no spaces of its own: a Latin name gets them, a Chinese one none.
  const providerName =
    language === "zh-CN" ? `${spaced("汉", named)}${named}${spaced(named, "汉")}` : named;
  const names = host.models.slice(0, NAMED).map((model) => model.name);
  const models =
    host.models.length > NAMED
      ? t("decisions.models.more", {
          models: names.join(", "),
          count: host.models.length - NAMED,
        })
      : names.join(", ");
  // What the host keeps here, which Remove forgets: its own key, or the account it asks for.
  const keeps = host.key === "own" ? host.hasKey : host.account?.value != null;
  const remove = async () => {
    setProblem(null);
    try {
      onChanged(await core.removeDecisionKey(host.host));
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };

  return (
    <div data-testid={`decision-host-${host.host}`} className={ruledRowClass}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={rowTitleClass}>{name}</p>
        <p className={rowTextClass}>{models}</p>
        {host.key === "provider" && (
          <p className={rowTextClass}>{t("decisions.usesKey", { provider: providerName })}</p>
        )}
        {host.account?.value && !open && (
          <p data-testid="decision-host-account" className={`${rowTextClass} break-words`}>
            {t(`decisions.account.${host.account.kind}`)}: {host.account.value}
          </p>
        )}
        {open && (
          <div className="mt-1.5">
            <DecisionKeyForm
              host={host}
              onSaved={(hosts) => {
                onChanged(hosts);
                setOpen(false);
              }}
              onCancel={() => setOpen(false)}
            />
          </div>
        )}
        {problem && <ProblemLine className="mt-1">{problem}</ProblemLine>}
      </div>
      {!open && (
        <div className={rowButtonsClass}>
          {host.ready && (
            <span data-testid="decision-host-ready" className={rowStatusClass}>
              {t("meetings.key.saved")}
            </span>
          )}
          {host.key === "provider" && !host.hasKey ? (
            <button
              type="button"
              data-testid="decision-host-add-provider"
              onClick={() => host.provider && onAddProvider(host.provider)}
              className={buttonStyle("secondary")}
            >
              {t("meetings.key.add")}
            </button>
          ) : (
            (host.key === "own" || host.account) && (
              <button
                type="button"
                data-testid="decision-host-add"
                onClick={() => {
                  setProblem(null);
                  setOpen(true);
                }}
                className={buttonStyle("secondary")}
              >
                {t(
                  host.key === "own"
                    ? host.hasKey
                      ? "meetings.key.replace"
                      : "meetings.key.add"
                    : keeps
                      ? "decisions.account.change"
                      : "decisions.account.set",
                )}
              </button>
            )
          )}
          {keeps && (
            <button
              type="button"
              data-testid="decision-host-remove"
              onClick={() => void remove()}
              className={buttonStyle("ghost")}
            >
              {t("meetings.key.remove")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
