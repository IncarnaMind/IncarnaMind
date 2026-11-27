import { useEffect, useId, useState } from "react";
import type { AgentClient, AgentSetupPreview } from "../../../../core/api";
import type { Language } from "../../../../core/language";
import { clientInSentence } from "../../../../shared/agentNames";
import { core } from "../../core";
import { useGap, useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { clientName } from "../agents/agentWords";
import { FileChangePreview } from "../agents/connectShared";
import { ProposeChoice } from "../agents/ProposeChoice";
import { InlinePath } from "../PathText";
import { SLOT, Slotted } from "../Slotted";
import { dialogTextClass } from "../ui";
import { linkClass } from "./yourAiParts";

/** Joins one or more app names cleanly in English ("A and B", "A, B and C") or Chinese ("A 和 B", "A、B 和 C"). */
export function joinAppNames(names: readonly string[], language: Language): string {
  if (names.length <= 1) return names[0] ?? "";
  if (language === "zh-CN") {
    if (names.length === 2) return `${names[0]} 和 ${names[1]}`;
    return `${names.slice(0, -1).join("、")} 和 ${names.at(-1)}`;
  }
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The one sentence of what connecting lets the chosen apps read (and write, when on), naming them,
 * with Details (#3791, #3819): plain words top-down, and technical metadata, file paths and raw
 * settings folded at the bottom. `installs`: Claude Code, which the same press downloads from
 * Anthropic and connects once signed in, so the sentence and Details cover it too.
 */
export function YourAiConsent({
  chosen,
  installs = null,
  propose,
  onPropose,
}: {
  chosen: readonly AgentClient[];
  installs?: AgentClient | null;
  propose: boolean;
  onPropose(propose: boolean): void;
}) {
  const t = useT();
  const language = useLanguage();
  const gap = useGap();
  const panel = useId();
  const [open, setOpen] = useState(false);
  const connects = installs ? [...chosen, installs] : chosen;
  const one = connects.length === 1 ? connects[0] : undefined;
  const names = connects.map((client) => clientName(client, t));
  const agent = one ? clientName(one, t) : "";
  const agents = joinAppNames(names, language);
  const claudeCode = connects.find((client) => client.id === "claude-code");
  const codex = connects.some((client) => client.id === "codex");
  const said = one
    ? t(propose ? "setupPage.ai.consent.one.write" : "setupPage.ai.consent.one", { agent })
    : t(propose ? "setupPage.ai.consent.many.write" : "setupPage.ai.consent.many", { agents });
  const fileClients = connects.filter((client) => client.setup === "file");
  return (
    <div className="-mt-1 flex flex-col gap-2">
      <p data-testid="setup-consent" className="text-ui leading-5 text-ink-secondary">
        {said}
        {gap(said, t("agents.connect.details"))}
        <button
          type="button"
          data-testid="setup-consent-details"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
          className={linkClass}
        >
          {t("agents.connect.details")}
        </button>
      </p>
      {open && (
        <div
          id={panel}
          data-testid="setup-consent-more"
          className="flex flex-col gap-2.5 rounded-lg px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--color-rule)]"
        >
          <ProposeChoice
            checked={propose}
            onChange={onPropose}
            hint={false}
            noFolders
            testId="setup-consent-propose"
          />
          <p className={dialogTextClass}>
            {one
              ? t("setupPage.ai.details.reads.one", { agent })
              : t("setupPage.ai.details.reads.many", { agents })}
          </p>
          <p className={dialogTextClass}>{t("agents.propose.hint")}</p>
          <p className={dialogTextClass}>
            {one
              ? t("setupPage.ai.details.where.one", { agent })
              : t("setupPage.ai.details.where.many")}
          </p>
          {claudeCode && (
            <div data-testid="setup-consent-background" className="flex flex-col gap-2.5">
              <p className={dialogTextClass}>
                {t("agents.connect.background", { agent: clientInSentence(claudeCode, t) })}
              </p>
              <p className={dialogTextClass}>{t("agents.connect.background.details")}</p>
            </div>
          )}
          {codex && (
            <p className={dialogTextClass}>
              {t("agents.connect.background.codex")}
              {gap(
                t("agents.connect.background.codex"),
                t("agents.connect.background.codex.details"),
              )}
              {t("agents.connect.background.codex.details")}
              {gap(
                t("agents.connect.background.codex.details"),
                t("agents.connect.codexInstructions"),
              )}
              {t("agents.connect.codexInstructions")}
            </p>
          )}
          {installs && <InstallDisclosure testId="setup-consent-install" />}
          <details data-testid="setup-consent-technical" className="flex flex-col">
            <summary className="cursor-pointer text-ui leading-5 text-ink-secondary">
              {t("setupPage.ai.details.technical")}
            </summary>
            <div className="mt-2 flex flex-col gap-2.5">
              <p className={dialogTextClass}>{t("setupPage.ai.details.metadata")}</p>
              {fileClients.map((client) => (
                <SettingsChange key={client.id} client={client} />
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

/** What a press that installs Claude Code downloads, from where, and what it sends for that. */
export function InstallDisclosure({ testId }: { testId: string }) {
  const t = useT();
  const gap = useGap();
  const download = t("agents.install.disclosure");
  return (
    <p data-testid={testId} className={dialogTextClass}>
      {download}
      {gap(download, t("setupPage.ai.install.sends"))}
      {t("setupPage.ai.install.sends")}
    </p>
  );
}

/** What connecting writes into the app's settings file, and where its Skill goes, as its own sheet shows. */
function SettingsChange({ client }: { client: AgentClient }) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const [preview, setPreview] = useState<AgentSetupPreview | null>(null);
  useEffect(() => {
    let current = true;
    core.previewAgentSetup(client.id).then((value) => {
      if (current) setPreview(value);
    }, reportError);
    return () => {
      current = false;
    };
  }, [client.id, reportError]);
  if (!preview) return null;
  return (
    <div data-testid="setup-consent-app" data-client={client.id} className="flex flex-col gap-1">
      <p className="text-small leading-[18px] text-ink">{clientName(client, t)}</p>
      <FileChangePreview preview={preview} testIdPrefix="setup-consent" />
      {client.skillPath && (
        <p data-testid="setup-consent-skill" className={dialogTextClass}>
          <Slotted
            message={t("agents.connect.skill", {
              path: SLOT,
              agent: clientInSentence(client, t),
            })}
            slot={<InlinePath path={client.skillPath} />}
          />
        </p>
      )}
    </div>
  );
}
