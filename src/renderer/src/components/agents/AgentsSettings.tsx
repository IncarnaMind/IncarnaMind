import { useEffect, useState } from "react";
import type { AgentClient, AgentSettings } from "../../../../core/api";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from "../settings/SettingsGroup";
import { buttonStyle, noticeClass, pageIntroClass } from "../ui";
import { AgentPairingRow, type JustSetUp } from "./AgentPairingRow";
import { clientName, clientNote, setupWords } from "./agentWords";
import { ConnectAgentDialog } from "./ConnectAgentDialog";

/**
 * Settings → Agents (#351, experimental): the User's own AI agent (Claude,
 * Codex, Cursor…) searching the Folders they choose, with checked Citations.
 * Off by default. On, it lists the agents connected, each with its Folders,
 * activity and Disconnect, then the agents IncarnaMind is set up in (a few
 * first-class ones, and "Other agent" for the rest; ADR-0019), those on this
 * computer first. A row is one entry of the list in src/core/agents/clients.ts,
 * so a connected app can be listed beside them. Connect asks once, in plain words, what the
 * agent may read and where that goes, then sets it up in one click where the
 * agent allows it (see src/core/agents/setup.ts). What's technical (settings
 * to copy) stays behind "Details".
 */
export function AgentsSettings() {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const openSettings = useAppStore((state) => state.openSettings);
  const folders = useAppStore((state) => state.library?.groups ?? []);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [clients, setClients] = useState<AgentClient[] | null>(null);
  const [connecting, setConnecting] = useState<AgentClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [justSetUp, setJustSetUp] = useState<JustSetUp | null>(null);

  useEffect(() => {
    core.getAgents().then(setSettings, reportError);
    core.listAgentClients().then(setClients, reportError);
    return core.on("agents.changed", setSettings);
  }, [reportError]);

  if (!settings) return null;

  const turn = (enabled: boolean) => core.setAgentsEnabled(enabled).then(setSettings, reportError);

  const allow = async (
    client: AgentClient,
    folderIds: string[],
    name: string,
    propose: boolean,
  ) => {
    setBusy(true);
    setProblem(null);
    try {
      const { pairing, result } = await core.setUpAgent({
        client: client.id,
        folderIds,
        ...(name && { name }),
        propose,
      });
      setJustSetUp({ pairingId: pairing.id, result });
      setConnecting(null);
      // The agent is connected either way: "Copy settings" in its details copies it again.
      if (result.kind === "copy")
        await navigator.clipboard.writeText(result.text).catch(reportError);
    } catch (error) {
      setProblem(errorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const clientRow = (client: AgentClient) => (
    <SettingsRow
      key={client.id}
      data-testid="agent-client"
      data-client={client.id}
      label={clientName(client, t)}
      detail={
        <>
          {setupWords(client, t)}
          {clientNote(client, t) && <span className="block">{clientNote(client, t)}</span>}
        </>
      }
      control={
        <button
          type="button"
          data-testid="agent-connect"
          onClick={() => setConnecting(client)}
          className={buttonStyle("secondary", "sm")}
        >
          {t("agents.settings.connectButton")}
        </button>
      }
    />
  );

  return (
    <section data-testid="agents-settings" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="self-start rounded-full bg-chip px-2 text-label leading-5 font-semibold text-ink-secondary">
          {t("agents.settings.experimental")}
        </span>
        <p className={pageIntroClass}>
          <span className="block font-semibold text-ink">{t("agents.settings.lead")}</span>
          {t("agents.settings.intro")}
        </p>
      </div>

      <SettingsGroup>
        <SettingsSwitchRow
          label={t("agents.settings.switch")}
          detail={t(settings.enabled ? "agents.settings.switch.on" : "agents.settings.switch.off")}
          checked={settings.enabled}
          onChange={(on) => void turn(on)}
          switchTestId="agents-enabled"
        />
      </SettingsGroup>

      {settings.enabled && settings.paused === "local-mode" && (
        <p data-testid="agents-paused" role="status" className={noticeClass}>
          {t("agents.settings.paused")}
          <span aria-hidden="true"> · </span>
          <button
            type="button"
            onClick={() => openSettings("ai", "local-mode")}
            className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
          >
            {t("agents.settings.paused.open")}
          </button>
        </p>
      )}

      {settings.enabled && settings.pairings.length > 0 && (
        <SettingsSection testId="agents-connected" title={t("agents.settings.connected")}>
          <SettingsGroup>
            {settings.pairings.map((pairing) => (
              <AgentPairingRow
                key={pairing.id}
                pairing={pairing}
                skillInstalled={settings.skills.includes(pairing.id)}
                folders={folders}
                justSetUp={justSetUp}
                onUndone={() => setJustSetUp(null)}
              />
            ))}
          </SettingsGroup>
        </SettingsSection>
      )}

      {settings.enabled && clients && (
        <SettingsSection
          testId="agents-clients"
          title={t("agents.settings.connect")}
          help={
            <>
              <p>{t("agents.settings.connect.note")}</p>
              <p className="mt-1">{t("agents.settings.web")}</p>
            </>
          }
        >
          <SettingsGroup data-testid="agents-list">{clients.map(clientRow)}</SettingsGroup>
        </SettingsSection>
      )}

      <ConnectAgentDialog
        client={connecting}
        busy={busy}
        problem={problem}
        onAllow={(folderIds, name, propose) =>
          connecting && void allow(connecting, folderIds, name, propose)
        }
        onClose={() => {
          setConnecting(null);
          setProblem(null);
        }}
      />
    </section>
  );
}
