import { useEffect, useId, useState } from "react";
import type { AgentClient, AgentSetupPreview } from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import { core } from "../../core";
import { useGap, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { clientName } from "../agents/agentWords";
import { FileChangePreview } from "../agents/connectShared";
import { ProposeChoice } from "../agents/ProposeChoice";
import { InlinePath } from "../PathText";
import { SLOT, Slotted } from "../Slotted";
import { dialogTextClass } from "../ui";
import { linkClass } from "./yourAiParts";

/**
 * The one sentence of what connecting lets the chosen apps read, and where it goes, with Details
 * (#3791): what else they read and what is sent, that they may write notes, how the background run
 * behaves, and what IncarnaMind adds to each app's settings file. `installs`: Claude Code, which
 * the same press downloads from Anthropic and connects once signed in, so all of it covers Claude
 * Code too, before the press, as its own connect sheet would.
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
  const gap = useGap();
  const panel = useId();
  const [open, setOpen] = useState(false);
  const connects = installs ? [...chosen, installs] : chosen;
  const one = connects.length === 1 ? connects[0] : undefined;
  const agent = one ? clientInSentence(one, t) : "";
  const claudeCode = connects.find((client) => client.id === "claude-code");
  const codex = connects.some((client) => client.id === "codex");
  const said = t(one ? "setupPage.ai.consent.one" : "setupPage.ai.consent.many");
  return (
    <div className="-mt-1 flex flex-col gap-2">
      <p data-testid="setup-consent" className="text-[13px] leading-5 text-ink-secondary">
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
            {one ? t("agents.connect.body", { agent }) : t("agents.connectAll.body")}
          </p>
          <p className={dialogTextClass}>{t("agents.propose.hint")}</p>
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
          {connects
            .filter((client) => client.setup === "file")
            .map((client) => (
              <SettingsChange key={client.id} client={client} />
            ))}
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
      <p className="text-[12px] leading-[18px] font-semibold text-ink">{clientName(client, t)}</p>
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
