import { useEffect, useId, useState } from "react";
import type { AgentClient, AgentSettings } from "../../../../core/api";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import {
  buttonStyle,
  hintClass,
  noticeClass,
  pageIntroClass,
  rowButtonsClass,
  rowTextClass,
  rowTitleClass,
  ruledListClass,
  ruledRowClass,
  sectionNoteClass,
  sectionTitleClass,
} from "../ui";
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
  const switchId = useId();

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
    <li
      key={client.id}
      data-testid="agent-client"
      data-client={client.id}
      className={ruledRowClass}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={rowTitleClass}>{clientName(client, t)}</span>
        <span className={rowTextClass}>{setupWords(client, t)}</span>
        {clientNote(client, t) && <span className={hintClass}>{clientNote(client, t)}</span>}
      </div>
      <div className={rowButtonsClass}>
        <button
          type="button"
          data-testid="agent-connect"
          onClick={() => setConnecting(client)}
          className={buttonStyle("secondary", "sm")}
        >
          {t("agents.settings.connectButton")}
        </button>
      </div>
    </li>
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

      <div className={ruledListClass}>
        <div className={ruledRowClass}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={switchId} className={rowTitleClass}>
              {t("agents.settings.switch")}
            </label>
            <p id={`${switchId}-description`} className={rowTextClass}>
              {t(settings.enabled ? "agents.settings.switch.on" : "agents.settings.switch.off")}
            </p>
          </div>
          <input
            id={switchId}
            type="checkbox"
            role="switch"
            aria-checked={settings.enabled}
            aria-describedby={`${switchId}-description`}
            data-testid="agents-enabled"
            checked={settings.enabled}
            onChange={(event) => void turn(event.target.checked)}
            className="switch"
          />
        </div>
      </div>

      {settings.enabled && settings.paused === "local-mode" && (
        <p data-testid="agents-paused" role="status" className={noticeClass}>
          {t("agents.settings.paused")}
          <span aria-hidden="true"> · </span>
          <button
            type="button"
            onClick={() => openSettings("privacy", "local-mode")}
            className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
          >
            {t("agents.settings.paused.open")}
          </button>
        </p>
      )}

      {settings.enabled && settings.pairings.length > 0 && (
        <section data-testid="agents-connected">
          <h4 className={`mb-2 ${sectionTitleClass}`}>{t("agents.settings.connected")}</h4>
          <ul className={ruledListClass}>
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
          </ul>
        </section>
      )}

      {settings.enabled && clients && (
        <section data-testid="agents-clients">
          <h4 className={sectionTitleClass}>{t("agents.settings.connect")}</h4>
          <p className={sectionNoteClass}>{t("agents.settings.connect.note")}</p>
          <ul data-testid="agents-list" className={ruledListClass}>
            {clients.map(clientRow)}
          </ul>
          <p className={`${hintClass} mt-2`}>{t("agents.settings.web")}</p>
        </section>
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
