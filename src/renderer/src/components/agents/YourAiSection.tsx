import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { AgentClient, AgentPairing, AgentSettings, LibraryGroup } from "../../../../core/api";
import { unitsOf } from "../../../../shared/i18n/join";
import {
  resetClaudeCodeInstall,
  useClaudeCodeInstallAvailability,
  useClaudeCodeInstallState,
} from "../../claudeCodeInstall";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { noModelSetUp } from "../../noModelSetUp";
import { useAppStore } from "../../store";
import { InlinePath } from "../PathText";
import { ProblemLine, ProblemMark } from "../ProblemLine";
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
import {
  DisconnectAll,
  type LeftBehind,
  RepairAll,
  useAgentsNeedingRepair,
} from "./AllAgentsActions";
import { clientName, clientNote, setupWords } from "./agentWords";
import { ClaudeCodeInstallRow } from "./ClaudeCodeInstallRow";
import { ConnectAgentDialog } from "./ConnectAgentDialog";
import { type AgentChoice, useAgentConnection } from "./ConnectAgentFields";
import { ConnectManyDialog } from "./ConnectManyDialog";
import { type ManyAgentsChoice, useManyAgentConnection } from "./ConnectManyFields";

/** One empty list for every read before the Library is: a new one each time would redraw forever. */
const NO_FOLDERS: readonly LibraryGroup[] = [];
const NO_PAIRINGS: readonly AgentPairing[] = [];

export interface AgentsRead {
  settings: AgentSettings | null;
  /** The agents' settings couldn't be read: Your AI says so, and the rest of the page shows. */
  failed: boolean;
  /** The agents IncarnaMind can be set up in; none listed when they couldn't be read. */
  clients: readonly AgentClient[] | null;
  /** The agents to connect couldn't be listed: where the list goes, one line says so. */
  clientsFailed: boolean;
  /**
   * Connecting is off with an agent connected, so the switch shows; once shown it stays while
   * Settings is open, a provider's page and back included, not going from under the pointer.
   */
  switchShown: boolean;
  setSettings(settings: AgentSettings): void;
  /** Reads again what couldn't be read. */
  retry(): void;
}

/** What Your AI shows, read with the rest of Settings › AI and kept as it changes. */
export function useAgentsRead(): AgentsRead {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [clients, setClients] = useState<readonly AgentClient[] | null>(null);
  const [clientsFailed, setClientsFailed] = useState(false);
  const [switchShown, setSwitchShown] = useState(false);
  if (!switchShown && settings && !settings.enabled && settings.pairings.length > 0) {
    setSwitchShown(true);
  }
  // A failed read stays said until one succeeds: the page doesn't go blank while Try again waits.
  const read = useCallback(() => {
    core.getAgents().then(
      (next) => {
        setSettings(next);
        setFailed(false);
      },
      (failure: unknown) => {
        console.error("Couldn't read the agents' settings for Settings › AI:", failure);
        setFailed(true);
      },
    );
  }, []);
  const list = useCallback(() => {
    core.listAgentClients().then(
      (next) => {
        setClients(next);
        setClientsFailed(false);
      },
      (failure: unknown) => {
        console.error("Couldn't list the agents to connect for Settings › AI:", failure);
        setClients((shown) => shown ?? []);
        setClientsFailed(true);
      },
    );
  }, []);
  useEffect(() => {
    read();
    list();
    const offAgents = core.on("agents.changed", (next) => {
      setFailed(false);
      setSettings(next);
      list();
    });
    const offInstall = core.on("claudeCodeInstall.changed", (next) => {
      if (next.kind === "awaiting-sign-in" || next.kind === "signed-in" || next.kind === "idle") {
        list();
      }
    });
    return () => {
      offAgents();
      offInstall();
    };
  }, [read, list]);
  const retry = () => {
    if (failed) read();
    if (clientsFailed) list();
  };
  return { settings, failed, clients, clientsFailed, switchShown, setSettings, retry };
}

/** The Skills each Disconnect left because the User changed them, by the app that had them. */
const skillsLeftBy = (left: readonly LeftBehind[]) =>
  left
    .filter((each) => each.left.skillsLeft.length > 0)
    .map((each) => ({
      agent: each.agent,
      paths: each.left.skillsLeft.map((skill) => skill.shown),
    }));

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
export function YourAiSection({
  settings,
  failed,
  clients,
  clientsFailed,
  switchShown,
  setSettings,
  retry,
}: AgentsRead) {
  const t = useT();
  const language = useLanguage();
  const reportError = useAppStore((state) => state.reportError);
  const openSettings = useAppStore((state) => state.openSettings);
  const openSetup = useAppStore((state) => state.openSetup);
  const folders = useAppStore((state) => state.library?.groups ?? NO_FOLDERS);
  const noModel = useAppStore((state) => noModelSetUp(state.chatReadiness));
  const installAvailability = useClaudeCodeInstallAvailability();
  const installState = useClaudeCodeInstallState();
  const [connecting, setConnecting] = useState<AgentClient | null>(null);
  const [manyClients, setManyClients] = useState<readonly AgentClient[] | null>(null);
  const connection = useAgentConnection();
  const many = useManyAgentConnection();
  const [justSetUp, setJustSetUp] = useState<JustSetUp | null>(null);
  // The Skills a Disconnect left because the User changed them, said until the page goes.
  const [skillLeft, setSkillLeft] = useState<{ agent: string; paths: string[] }[]>([]);
  const [addingAnother, setAddingAnother] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  const connected = settings?.pairings ?? NO_PAIRINGS;
  const repair = useAgentsNeedingRepair(connected);
  const hasClaudeCodePairing = connected.some((each) => each.client === "claude-code");
  // Open while nothing at all is set up; otherwise one row unfolds it.
  const listed = (connected.length === 0 && noModel) || addingAnother;

  const openClaudeCodeConnect = useCallback(() => {
    const claudeCode = clients?.find((each) => each.id === "claude-code");
    if (claudeCode) {
      connection.clearProblem();
      setConnecting(claudeCode);
    }
  }, [clients, connection]);

  const handedOffSignIn = useRef(false);
  useEffect(() => {
    if (installState.kind === "signed-in" && !handedOffSignIn.current && !hasClaudeCodePairing) {
      const claudeCode = clients?.find((each) => each.id === "claude-code");
      if (claudeCode) {
        handedOffSignIn.current = true;
        connection.clearProblem();
        setConnecting(claudeCode);
      }
    } else if (installState.kind !== "signed-in") {
      handedOffSignIn.current = false;
    }
  }, [installState.kind, hasClaudeCodePairing, clients, connection]);

  const keepDesktop = useCallback(() => {
    if (connected.some((each) => each.client === "claude-desktop")) return;
    const desktop = clients?.find((each) => each.id === "claude-desktop");
    if (desktop) {
      connection.clearProblem();
      setConnecting(desktop);
    }
  }, [clients, connected, connection]);

  useEffect(() => {
    if (addingAnother) list.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [addingAnother]);

  if (failed) {
    return (
      <SettingsSection testId="agents-connected" title={t("setupPage.ai.title")}>
        <ProblemLine
          testId="agents-read-failed"
          action={{ label: t("answer.error.retry"), onClick: retry }}
        >
          <ProblemMark />
          {t("agents.settings.readFailed")}
        </ProblemLine>
      </SettingsSection>
    );
  }
  if (!settings) return null;

  const turn = (enabled: boolean) => core.setAgentsEnabled(enabled).then(setSettings, reportError);

  const allow = async (client: AgentClient, choice: AgentChoice) => {
    const done = await connection.connect(client, choice, { enable: true });
    if (!done) return;
    setJustSetUp(done);
    setSkillLeft([]);
    setConnecting(null);
    setAddingAnother(false);
    if (client.id === "claude-code") void resetClaudeCodeInstall();
  };

  const showInstallRow =
    !hasClaudeCodePairing &&
    installAvailability?.supported === true &&
    (!installAvailability.cliAgentPresent ||
      (installState.kind !== "idle" && installState.kind !== "signed-in"));

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
  const foundToConnect = toConnect.filter((client) => client.installed && client.id !== "other");

  const openConnectMany = () => {
    many.clear();
    setManyClients(foundToConnect);
  };

  const allowMany = async (choice: ManyAgentsChoice) => {
    const outcomes = await many.connectAll(choice, { enable: true });
    if (outcomes?.some((each) => each.kind === "connected")) {
      setSkillLeft([]);
      setAddingAnother(false);
    }
  };

  const connectAllRow =
    foundToConnect.length >= 2 ? (
      <SettingsRow
        data-testid="agents-connect-all-row"
        label={t("agents.connectAll.row", { count: foundToConnect.length })}
        detail={t("agents.connectAll.rowDetail", {
          apps: unitsOf(
            foundToConnect.map((client) => clientName(client, t)),
            language,
          ),
        })}
        control={
          <button
            type="button"
            data-testid="agents-connect-all"
            onClick={openConnectMany}
            className={buttonStyle("primary", "sm")}
          >
            {t("agents.connectAll.button", { count: foundToConnect.length })}
          </button>
        }
      />
    ) : null;

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

      {skillLeft.map((each) => (
        <p
          key={each.paths.join("\n")}
          data-testid="agent-skill-left"
          role="status"
          className={noticeClass}
        >
          <Slotted
            message={t("agents.settings.skillLeft", { agent: each.agent, path: SLOT })}
            slot={each.paths.map((path, at) => (
              <Fragment key={path}>
                {at > 0 && (language === "zh-CN" ? "、" : ", ")}
                <InlinePath path={path} />
              </Fragment>
            ))}
          />
        </p>
      ))}

      <SettingsSection
        testId="agents-connected"
        title={t("setupPage.ai.title")}
        action={
          <RepairAll
            ids={connected
              .filter((pairing) => repair.needs?.has(pairing.id))
              .map((pairing) => pairing.id)}
            ready={repair.needs !== null}
            onRepaired={() => void repair.read()}
          />
        }
        help={
          listed &&
          clients &&
          !clientsFailed && (
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
                  shimOutOfDate={settings.shimsOutOfDate.includes(pairing.id)}
                  broken={repair.needs?.has(pairing.id) ?? false}
                  onRepaired={() => void repair.read()}
                  isBundleClient={
                    clients?.some(
                      (each) => each.id === pairing.client && each.setup === "bundle",
                    ) ?? false
                  }
                  folders={folders}
                  justSetUp={justSetUp}
                  onUndone={() => setJustSetUp(null)}
                  onInstallReopened={(rotated) =>
                    setJustSetUp({
                      pairingId: pairing.id,
                      result: { kind: "opened", how: "bundle" },
                      rotated,
                    })
                  }
                  onDisconnected={(agent, left) => setSkillLeft(skillsLeftBy([{ agent, left }]))}
                />
              ))}
              {showInstallRow && (
                <ClaudeCodeInstallRow
                  variant="settings"
                  pairings={connected}
                  onSignedIn={openClaudeCodeConnect}
                  onSetUpModel={openSetup}
                  onKeepDesktop={keepDesktop}
                />
              )}
              {!listed && connectAllRow}
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
          <DisconnectAll
            pairings={connected}
            onDisconnected={(left) => setSkillLeft(skillsLeftBy(left))}
          />
          {!(connected.length > 0 || !listed) && showInstallRow && (
            <SettingsGroup>
              <ClaudeCodeInstallRow
                variant="settings"
                pairings={connected}
                onSignedIn={openClaudeCodeConnect}
                onSetUpModel={openSetup}
                onKeepDesktop={keepDesktop}
              />
            </SettingsGroup>
          )}
          {listed && clientsFailed && (
            <ProblemLine
              testId="agents-list-failed"
              action={{ label: t("answer.error.retry"), onClick: retry }}
            >
              <ProblemMark />
              {t("agents.settings.listFailed")}
            </ProblemLine>
          )}
          {listed && clients && !clientsFailed && (
            <div ref={list} data-testid="agents-clients">
              <AgentFinder clients={toConnect} testId="agents-list">
                {(shown) => (
                  <SettingsGroup data-testid="agents-list">
                    {connectAllRow}
                    {shown.map(clientRow)}
                  </SettingsGroup>
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
          if (connecting?.id === "claude-code" && installState.kind === "signed-in") {
            void resetClaudeCodeInstall();
          }
          setConnecting(null);
          connection.clearProblem();
        }}
      />

      <ConnectManyDialog
        open={manyClients !== null}
        clients={manyClients ?? []}
        busy={many.busy}
        problem={many.problem}
        outcomes={many.outcomes}
        undone={many.undone}
        onAllow={(choice) => void allowMany(choice)}
        onUndo={many.undoOne}
        onRetry={many.retryOne}
        onClose={() => {
          if (many.busy) return;
          setManyClients(null);
          many.clear();
        }}
      />
    </section>
  );
}
