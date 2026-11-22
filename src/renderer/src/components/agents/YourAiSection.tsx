import { Fragment, useEffect, useRef, useState } from "react";
import type { AgentClient, AgentSettings, LibraryGroup } from "../../../../core/api";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { noModelSetUp } from "../../noModelSetUp";
import { useAppStore } from "../../store";
import { InlinePath } from "../PathText";
import { SLOT, Slotted } from "../Slotted";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowAction,
  SettingsSection,
  SettingsSwitchRow,
} from "../settings/SettingsGroup";
import { buttonStyle, noticeClass } from "../ui";
import { AgentFinder } from "./AgentFinder";
import { AgentPairingRow, type JustSetUp } from "./AgentPairingRow";
import { clientName, clientNote, setupWords } from "./agentWords";
import { ConnectAgentDialog } from "./ConnectAgentDialog";
import { type AgentChoice, useAgentConnection } from "./ConnectAgentFields";

/** One empty list for every read before the Library is: a new one each time would redraw forever. */
const NO_FOLDERS: readonly LibraryGroup[] = [];

export interface AgentsRead {
  settings: AgentSettings | null;
  /** The agents IncarnaMind can be set up in; none listed when they couldn't be read. */
  clients: readonly AgentClient[] | null;
  setSettings(settings: AgentSettings): void;
}

/** What Your AI shows, read with the rest of Settings › AI and kept as it changes. */
export function useAgentsRead(): AgentsRead {
  const reportError = useAppStore((state) => state.reportError);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [clients, setClients] = useState<readonly AgentClient[] | null>(null);
  useEffect(() => {
    core.getAgents().then(setSettings, reportError);
    core.listAgentClients().then(setClients, (failure: unknown) => {
      reportError(failure);
      setClients([]);
    });
    return core.on("agents.changed", setSettings);
  }, [reportError]);
  return { settings, clients, setSettings };
}

/**
 * Settings › AI › Your AI (#351, #3645): the AI the User already uses (Claude Code, Codex, Claude's
 * app…), searching what they share, with checked Citations. It leads the page. While nothing is
 * set up it lists the agents to connect, those on this computer first; otherwise each connected
 * agent's row (what it reads, its activity, Disconnect) and one row that unfolds the same list,
 * without the agents already connected. Connect turns connecting on first, as the setup's Your AI
 * step does, so there is no switch to find before it; a User who has turned connecting off keeps
 * the switch until they turn it on again. A row is one entry of the list in
 * src/core/agents/clients.ts. Connect asks once, in plain words, what the agent may read and where
 * that goes, then sets it up in one click where the agent allows it (see src/core/agents/setup.ts).
 */
export function YourAiSection({ settings, clients, setSettings }: AgentsRead) {
  const t = useT();
  const language = useLanguage();
  const reportError = useAppStore((state) => state.reportError);
  const openSettings = useAppStore((state) => state.openSettings);
  const folders = useAppStore((state) => state.library?.groups ?? NO_FOLDERS);
  const noModel = useAppStore((state) => noModelSetUp(state.chatReadiness));
  const [connecting, setConnecting] = useState<AgentClient | null>(null);
  const connection = useAgentConnection();
  const [justSetUp, setJustSetUp] = useState<JustSetUp | null>(null);
  // The Skill a Disconnect left because the User changed it, said until the page goes.
  const [skillLeft, setSkillLeft] = useState<{ agent: string; paths: string[] } | null>(null);
  const [addingAnother, setAddingAnother] = useState(false);
  // Shown once connecting is seen off, it stays while Settings is open: it doesn't go from under
  // the pointer that just turned it on.
  const [switchShown, setSwitchShown] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  const connected = settings?.pairings ?? [];
  if (!switchShown && settings && !settings.enabled && connected.length > 0) setSwitchShown(true);
  // Open while nothing at all is set up; otherwise one row unfolds it.
  const listed = (connected.length === 0 && noModel) || addingAnother;

  useEffect(() => {
    if (addingAnother) list.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [addingAnother]);

  if (!settings) return null;

  const turn = (enabled: boolean) => core.setAgentsEnabled(enabled).then(setSettings, reportError);

  const allow = async (client: AgentClient, choice: AgentChoice) => {
    const done = await connection.connect(client, choice, { enable: true });
    if (!done) return;
    setJustSetUp(done);
    setSkillLeft(null);
    setConnecting(null);
    setAddingAnother(false);
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

  const inUse = new Set(connected.map((pairing) => pairing.client));
  const toConnect = (clients ?? []).filter(
    (client) => client.id === "other" || !inUse.has(client.id),
  );

  return (
    <section data-testid="agents-settings" className="flex flex-col gap-6">
      {connected.length === 0 && (
        <p data-testid="ai-lede" className="px-4 text-[13px] leading-5 text-ink-meta">
          {t("agents.settings.intro")}
        </p>
      )}

      {settings.enabled && settings.paused === "local-mode" && (
        <p data-testid="agents-paused" role="status" className={noticeClass}>
          {t("agents.settings.paused")}
          <span aria-hidden="true"> · </span>
          <button
            type="button"
            data-testid="agents-paused-open"
            onClick={() => openSettings("ai", "local-mode")}
            className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
          >
            {t("agents.settings.paused.open")}
          </button>
        </p>
      )}

      {skillLeft && (
        <p data-testid="agent-skill-left" role="status" className={noticeClass}>
          <Slotted
            message={t("agents.settings.skillLeft", { agent: skillLeft.agent, path: SLOT })}
            slot={skillLeft.paths.map((path, at) => (
              <Fragment key={path}>
                {at > 0 && (language === "zh-CN" ? "、" : ", ")}
                <InlinePath path={path} />
              </Fragment>
            ))}
          />
        </p>
      )}

      <SettingsSection
        testId="agents-connected"
        title={t("setupPage.ai.title")}
        help={
          listed &&
          clients && (
            <>
              <p>{t("agents.settings.connect.note")}</p>
              <p className="mt-1">{t("agents.settings.web")}</p>
            </>
          )
        }
      >
        <div className="flex flex-col gap-3">
          {(connected.length > 0 || !listed) && (
            <SettingsGroup>
              {switchShown && connected.length > 0 && (
                <SettingsSwitchRow
                  label={t("agents.settings.switch")}
                  detail={t(
                    settings.enabled ? "agents.settings.switch.on" : "agents.settings.switch.off",
                  )}
                  checked={settings.enabled}
                  onChange={(on) => void turn(on)}
                  switchTestId="agents-enabled"
                />
              )}
              {connected.map((pairing) => (
                <AgentPairingRow
                  key={pairing.id}
                  pairing={pairing}
                  skillInstalled={settings.skills.includes(pairing.id)}
                  skillOutOfDate={settings.skillsOutOfDate.includes(pairing.id)}
                  awaitingInstall={settings.awaitingInstall.includes(pairing.id)}
                  folders={folders}
                  justSetUp={justSetUp}
                  onUndone={() => setJustSetUp(null)}
                  onInstallReopened={() =>
                    setJustSetUp({
                      pairingId: pairing.id,
                      result: { kind: "opened", how: "bundle" },
                    })
                  }
                  onDisconnected={(agent, left) =>
                    setSkillLeft(
                      left.skillsLeft.length > 0
                        ? { agent, paths: left.skillsLeft.map((each) => each.shown) }
                        : null,
                    )
                  }
                />
              ))}
              {!listed && (
                <SettingsRowAction
                  testId="agents-connect-another"
                  label={t(
                    connected.length > 0
                      ? "agents.settings.connectAnother"
                      : "agents.settings.connectFirst",
                  )}
                  onClick={() => setAddingAnother(true)}
                />
              )}
            </SettingsGroup>
          )}
          {listed && clients && (
            <div ref={list} data-testid="agents-clients">
              <AgentFinder clients={toConnect} testId="agents-list">
                {(shown) => (
                  <SettingsGroup data-testid="agents-list">{shown.map(clientRow)}</SettingsGroup>
                )}
              </AgentFinder>
            </div>
          )}
        </div>
      </SettingsSection>

      <ConnectAgentDialog
        client={connecting}
        busy={connection.busy}
        problem={connection.problem}
        onAllow={(choice) => connecting && void allow(connecting, choice)}
        onClose={() => {
          setConnecting(null);
          connection.clearProblem();
        }}
      />
    </section>
  );
}
