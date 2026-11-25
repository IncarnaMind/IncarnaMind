import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  type AgentClient,
  type AgentPairing,
  type AgentSetupPreview,
  type AgentSetupResult,
  ALL_SHARED_ID,
} from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import { useAgentClients, useAgentPairings } from "../../agentNote";
import {
  cancelClaudeCodeInstall,
  checkClaudeCodeAuth,
  openClaudeCodeSignIn,
  resetClaudeCodeInstall,
  startClaudeCodeInstall,
  useClaudeCodeInstallAvailability,
  useClaudeCodeInstallStarting,
  useClaudeCodeInstallState,
} from "../../claudeCodeInstall";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { clientName, setupProblem } from "../agents/agentWords";
import { installFailureKey } from "../agents/ClaudeCodeInstallRow";
import { ConnectAgentFields, useAgentConnection } from "../agents/ConnectAgentFields";
import {
  AgentSecretNotice,
  connectManyAgents,
  FileChangePreview,
  useSecretStorage,
} from "../agents/connectShared";
import { ProposeChoice } from "../agents/ProposeChoice";
import { ChevronDownLineIcon, ChevronRightLineIcon } from "../lineIcons";
import { ProblemMark } from "../ProblemLine";
import { ReadProblem } from "../ReadProblem";
import { buttonStyle, checkBoxClass, dialogTextClass } from "../ui";
import { SetupPanel, type StepPlace } from "./SetupPanel";
import { SortingModelLine } from "./SortingModelLine";
import {
  firstTicked,
  foundApps,
  monogram,
  notConnected,
  SHOWN_FIRST,
  stillNeedsUser,
} from "./yourAiList";

/** What came of connecting one app in the step: its connection, or why it failed. */
type Done =
  | { client: AgentClient; pairingId: string; result: AgentSetupResult }
  | { client: AgentClient; error: unknown };

interface Choice {
  propose: boolean;
}

type View =
  | { kind: "list" }
  | { kind: "another" }
  | { kind: "app"; client: AgentClient }
  | { kind: "after"; done: readonly Done[]; installs: boolean; choice: Choice };

const linkClass =
  "rounded-sm font-semibold text-accent-strong underline-offset-2 hover:underline focus-visible:outline-offset-0";

const listClass = "flex flex-col rounded-[10px] shadow-[inset_0_0_0_1px_var(--color-rule)]";

const rowClass =
  "flex min-h-11 min-w-0 items-center gap-3 border-t border-rule px-3 py-2 first:border-t-0";

/** The pairings that wait for their app's own Install, as Settings › AI is told of them; null until read. */
function useAwaitingInstall(): readonly string[] | null {
  const [awaiting, setAwaiting] = useState<readonly string[] | null>(null);
  const reportError = useAppStore((state) => state.reportError);
  useEffect(() => {
    core.getAgents().then((settings) => setAwaiting(settings.awaitingInstall), reportError);
    return core.on("agents.changed", (settings) => setAwaiting(settings.awaitingInstall));
  }, [reportError]);
  return awaiting;
}

/**
 * The first run's Your AI step (#3791): the AI apps on this computer as one list, one tick each, the
 * first of them ticked; one sentence of what connecting lets them read, with Details; one Connect.
 * Connecting moves on by itself once every app chosen works; while one still needs the User, its
 * row says what is left, with the one button that does it. With only the Claude app found, the same
 * Connect installs Claude Code too, as the row says first. With none found, Claude Code is offered
 * to install, and any other app is reached through Another app….
 */
export function YourAiStep({ place }: { place: StepPlace }) {
  const t = useT();
  const clients = useAgentClients();
  const pairings = useAgentPairings();
  const availability = useClaudeCodeInstallAvailability();
  const install = useClaudeCodeInstallState();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const [view, setView] = useState<View>({ kind: "list" });

  // Esc leaves Another app… for the list, once nothing inside has taken the key.
  const away = view.kind === "another" || view.kind === "app";
  useEffect(() => {
    if (!away) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setView((current) => (current.kind === "app" ? { kind: "another" } : { kind: "list" }));
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [away]);

  if (clients.state === "loading" || pairings === null) return null;
  const all = clients.state === "ready" ? clients.data : [];
  const claudeCodeHere = availability?.installed === true || install.kind === "signed-in";
  const found = foundApps(all, claudeCodeHere);
  // Claude Code is installed in the same press only where nothing installs one already.
  const installs =
    !localOnly &&
    availability?.supported === true &&
    !availability.cliAgentPresent &&
    !claudeCodeHere &&
    found.length === 1 &&
    found[0]?.id === "claude-desktop";
  const claudeCode = all.find((client) => client.id === "claude-code") ?? null;

  if (view.kind === "another" || view.kind === "app") {
    return (
      <AnotherApp
        place={place}
        clients={all.filter(
          (client) => client.id === "other" || !found.some((each) => each.id === client.id),
        )}
        chosen={view.kind === "app" ? view.client : null}
        onChoose={(client) => setView({ kind: "app", client })}
        onBack={() => setView(view.kind === "app" ? { kind: "another" } : { kind: "list" })}
        onDone={(done, choice) => setView({ kind: "after", done: [done], installs: false, choice })}
      />
    );
  }
  if (view.kind === "after") {
    return (
      <AfterConnect
        place={place}
        done={view.done}
        installs={view.installs}
        choice={view.choice}
        claudeCode={claudeCode}
        pairings={pairings}
        onDone={(done) => setView({ ...view, done })}
        onUndo={() => setView({ kind: "list" })}
      />
    );
  }
  return (
    <FoundList
      place={place}
      problem={
        clients.state === "failed" ? (
          <ReadProblem
            words={t("setupPage.agents.failed")}
            read={clients}
            testId="setup-agents-problem"
          />
        ) : null
      }
      found={found}
      pairings={pairings}
      installs={installs}
      offersInstall={
        found.length === 0 && !localOnly && availability?.supported === true && claudeCode !== null
      }
      onAnother={() => setView({ kind: "another" })}
      onConnected={(done, choice, installed) =>
        setView({ kind: "after", done, installs: installed, choice })
      }
    />
  );
}

function StepFoot({
  place,
  start,
  later,
  main,
}: {
  place: StepPlace;
  start?: ReactNode;
  later?: boolean;
  main?: ReactNode;
}) {
  const t = useT();
  return (
    <>
      {start ??
        (place.back && (
          <button
            type="button"
            data-testid="setup-back"
            onClick={place.back}
            className={`-ml-2.5 ${buttonStyle("ghost", "lg")}`}
          >
            {t("setupPage.back")}
          </button>
        ))}
      <span className="flex-1" />
      {later !== false && (
        <button
          type="button"
          data-testid="setup-skip"
          onClick={place.next}
          className={buttonStyle("ghost", "lg")}
        >
          {t("providers.setup.later")}
        </button>
      )}
      {main}
    </>
  );
}

function AppMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-chip text-[11px] leading-none font-semibold text-ink-secondary"
    >
      {monogram(name)}
    </span>
  );
}

function FoundList({
  place,
  problem,
  found,
  pairings,
  installs,
  offersInstall,
  onAnother,
  onConnected,
}: {
  place: StepPlace;
  problem: ReactNode;
  found: readonly AgentClient[];
  pairings: readonly AgentPairing[];
  installs: boolean;
  offersInstall: boolean;
  onAnother(): void;
  onConnected(done: readonly Done[], choice: Choice, installed: boolean): void;
}) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const [ticks, setTicks] = useState<ReadonlySet<string> | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problemLine, setProblemLine] = useState<string | null>(null);
  const [propose, setPropose] = useState(true);
  const connectable = notConnected(found, pairings);
  const first = firstTicked(found, pairings);
  const ticked = ticks ?? new Set(first ? [first] : []);
  const chosen = connectable.filter((client) => ticked.has(client.id));
  const { storage, canKeepKey, accept } = useSecretStorage(chosen.map((each) => each.id).join(","));
  const inUse = new Set(pairings.map((pairing) => pairing.client));
  const shown = open || found.length <= SHOWN_FIRST + 1 ? found : found.slice(0, SHOWN_FIRST);
  const folded = found.length - shown.length;

  const toggle = (client: AgentClient, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(client.id);
    else next.delete(client.id);
    setTicks(next);
  };

  const connect = async () => {
    if (busy || chosen.length === 0) return;
    setBusy(true);
    setProblemLine(null);
    const choice = { propose };
    try {
      const outcomes = await connectManyAgents(
        chosen,
        { folderIds: [ALL_SHARED_ID], propose },
        { enable: true },
      );
      if (installs) void startClaudeCodeInstall();
      if (outcomes.some((each) => each.kind === "connected" && each.client.id === "claude-code")) {
        void resetClaudeCodeInstall();
      }
      // Every app works already: first run moves on, with nothing left to show here.
      if (
        !installs &&
        outcomes.every((each) => each.kind === "connected" && each.result.kind === "wrote")
      ) {
        place.next();
        return;
      }
      onConnected(
        outcomes.map((each) =>
          each.kind === "connected"
            ? { client: each.client, pairingId: each.pairing.id, result: each.result }
            : { client: each.client, error: each.error },
        ),
        choice,
        installs,
      );
    } catch (error) {
      setProblemLine(setupProblem(error, t));
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const anyConnected = pairings.length > 0;
  return (
    <SetupPanel
      place={place}
      view="ai"
      title={t("setupPage.ai.title")}
      lead={t(found.length > 0 ? "setupPage.ai.lead.found" : "setupPage.ai.lead.none")}
      foot={
        <StepFoot
          place={place}
          later={!anyConnected || chosen.length > 0}
          main={
            found.length === 0 && !anyConnected ? undefined : chosen.length > 0 || !anyConnected ? (
              <button
                type="button"
                data-testid="setup-connect"
                disabled={busy || chosen.length === 0 || !canKeepKey}
                onClick={() => void connect()}
                className={buttonStyle("primary", "lg")}
              >
                {t("setupPage.ai.connect")}
              </button>
            ) : (
              <button
                type="button"
                data-testid="setup-next"
                onClick={place.next}
                className={buttonStyle("primary", "lg")}
              >
                {t("setupPage.continue")}
              </button>
            )
          }
        />
      }
    >
      {problem}
      <ul data-testid="setup-apps" aria-label={t("setupPage.ai.title")} className={listClass}>
        {offersInstall && <InstallRow />}
        {shown.map((client) => {
          const name = clientName(client, t);
          const connected = inUse.has(client.id);
          const words = (
            <>
              <AppMark name={name} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui text-ink" title={name}>
                  {name}
                </span>
                {installs && client.id === "claude-desktop" && (
                  <span
                    data-testid="setup-app-installs"
                    className="text-[12px] leading-[18px] text-ink-meta"
                  >
                    {t("setupPage.ai.alsoInstalls")}
                  </span>
                )}
              </span>
            </>
          );
          return (
            <li
              key={client.id}
              data-testid="setup-app"
              data-value={client.id}
              data-connected={connected || undefined}
              className={rowClass}
            >
              {connected ? (
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {words}
                  <span
                    data-testid="setup-app-connected"
                    className="shrink-0 text-[13px] leading-5 text-ink-meta"
                  >
                    {t("setupPage.ai.connected")}
                  </span>
                </div>
              ) : (
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  {words}
                  <input
                    type="checkbox"
                    data-testid="setup-app-tick"
                    aria-label={name}
                    checked={ticked.has(client.id)}
                    onChange={(event) => toggle(client, event.target.checked)}
                    className={`${checkBoxClass} accent-ink`}
                  />
                </label>
              )}
            </li>
          );
        })}
        {folded > 0 && (
          <li className={rowClass}>
            <button
              type="button"
              data-testid="setup-apps-more"
              aria-expanded={false}
              onClick={() => setOpen(true)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left text-ui text-ink-secondary hover:text-ink"
            >
              <span
                aria-hidden="true"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-chip text-[11px] leading-none font-semibold text-ink-secondary"
              >
                +{folded}
              </span>
              <span className="min-w-0 flex-1">
                {t("setupPage.ai.moreFound", { count: folded })}
              </span>
              <ChevronDownLineIcon aria-hidden="true" className="size-3.5 shrink-0" />
            </button>
          </li>
        )}
        <li className={rowClass}>
          <button
            type="button"
            data-testid="setup-another-app"
            onClick={onAnother}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left text-ui text-ink-secondary hover:text-ink"
          >
            <span
              aria-hidden="true"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-chip text-[13px] leading-none text-ink-secondary"
            >
              …
            </span>
            <span className="min-w-0 flex-1">{t("setupPage.ai.another")}</span>
          </button>
        </li>
      </ul>
      {chosen.length > 0 && <Consent chosen={chosen} propose={propose} onPropose={setPropose} />}
      <AgentSecretNotice storage={storage} onAccept={accept} />
      {problemLine && (
        <p data-testid="setup-connect-problem" role="alert" className={dialogTextClass}>
          <ProblemMark />
          {problemLine}
        </p>
      )}
      {/* The model steps again have a Sorting step of their own next, which this would offer twice. */}
      {!place.steps.includes("sorting") && <SortingModelLine />}
    </SetupPanel>
  );
}

/**
 * The one sentence of what connecting lets the chosen apps read, and where it goes, with Details:
 * what else they read and what is sent, that they may write notes, how the background run behaves,
 * and what IncarnaMind adds to each app's settings file.
 */
function Consent({
  chosen,
  propose,
  onPropose,
}: {
  chosen: readonly AgentClient[];
  propose: boolean;
  onPropose(propose: boolean): void;
}) {
  const t = useT();
  const panel = useId();
  const [open, setOpen] = useState(false);
  const one = chosen.length === 1 ? chosen[0] : undefined;
  const agent = one ? clientInSentence(one, t) : "";
  const claudeCode = chosen.find((client) => client.id === "claude-code");
  const codex = chosen.some((client) => client.id === "codex");
  return (
    <div className="-mt-1 flex flex-col gap-2">
      <p data-testid="setup-consent" className="text-[13px] leading-5 text-ink-secondary">
        {t(one ? "setupPage.ai.consent.one" : "setupPage.ai.consent.many")}{" "}
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
            <>
              <p className={dialogTextClass}>
                {t("agents.connect.background", { agent: clientInSentence(claudeCode, t) })}
              </p>
              <p className={dialogTextClass}>{t("agents.connect.background.details")}</p>
            </>
          )}
          {codex && (
            <p className={dialogTextClass}>
              {t("agents.connect.background.codex")} {t("agents.connect.background.codex.details")}
            </p>
          )}
          {chosen
            .filter((client) => client.setup === "file")
            .map((client) => (
              <SettingsChange key={client.id} client={client} />
            ))}
        </div>
      )}
    </div>
  );
}

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
    <div className="flex flex-col gap-1">
      <p className="text-[12px] leading-[18px] font-semibold text-ink">{clientName(client, t)}</p>
      <FileChangePreview preview={preview} testIdPrefix="setup-consent" />
    </div>
  );
}

/** With no AI app found: Claude Code, installed with one press, and each step of it in this row. */
function InstallRow() {
  const t = useT();
  const state = useClaudeCodeInstallState();
  const starting = useClaudeCodeInstallStarting();
  const name = "Claude Code";
  let line: string = t("setupPage.ai.install.line");
  let action: ReactNode = (
    <button
      type="button"
      data-testid="setup-install-claude-code"
      disabled={starting}
      onClick={() => void startClaudeCodeInstall()}
      className={buttonStyle("primary", "sm")}
    >
      {t("setupPage.ai.install")}
    </button>
  );
  const status = installStatus(state, t);
  if (status) {
    line = status.line;
    action = status.action;
  }
  return (
    <li data-testid="setup-install-row" data-state={state.kind} className={rowClass}>
      <AppMark name={name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-ui text-ink">{name}</span>
        <span role="status" className="text-[12px] leading-[18px] text-ink-meta">
          {line}
        </span>
      </span>
      {action}
    </li>
  );
}

/** What a row says, and its one button, while Claude Code installs and signs in; null when idle. */
function installStatus(
  state: ReturnType<typeof useClaudeCodeInstallState>,
  t: ReturnType<typeof useT>,
): { line: string; action: ReactNode } | null {
  switch (state.kind) {
    case "idle":
    case "signed-in":
      return null;
    case "installing":
      return {
        line: t("setupPage.ai.install.installing"),
        action: (
          <button
            type="button"
            data-testid="setup-install-cancel"
            onClick={() => void cancelClaudeCodeInstall()}
            className={buttonStyle("secondary", "sm")}
          >
            {t("agents.install.progress.cancel")}
          </button>
        ),
      };
    case "awaiting-sign-in":
      return state.notYet
        ? {
            line: t("setupPage.ai.install.notYet"),
            action: (
              <button
                type="button"
                data-testid="setup-install-reopen"
                onClick={() => void openClaudeCodeSignIn()}
                className={buttonStyle("secondary", "sm")}
              >
                {t("agents.install.signIn.reopen")}
              </button>
            ),
          }
        : {
            line: t("setupPage.ai.install.signIn"),
            action: (
              <button
                type="button"
                data-testid="setup-install-signed-in"
                onClick={() => void checkClaudeCodeAuth()}
                className={buttonStyle("secondary", "sm")}
              >
                {t("agents.install.signIn.done")}
              </button>
            ),
          };
    case "no-plan":
      return {
        line: t("agents.install.noPlan.title"),
        action: (
          <button
            type="button"
            data-testid="setup-install-other-account"
            onClick={() => void openClaudeCodeSignIn()}
            className={buttonStyle("secondary", "sm")}
          >
            {t("agents.install.noPlan.tryOther")}
          </button>
        ),
      };
    case "failed":
      return {
        line: t(installFailureKey(state.reason)),
        action:
          state.reason === "local-mode" || state.reason === "root" ? null : (
            <button
              type="button"
              data-testid="setup-install-retry"
              onClick={() =>
                void (state.reason === "sign-in-failed"
                  ? openClaudeCodeSignIn()
                  : startClaudeCodeInstall())
              }
              className={buttonStyle("secondary", "sm")}
            >
              {t("agents.install.failed.retry")}
            </button>
          ),
      };
  }
}

/**
 * After Connect, while an app chosen still needs the User: each row says what is left, with the one
 * button that does it, and a line to paste shows only under Details. Once every app works, first
 * run moves on by itself; Set up later moves on with something left.
 */
function AfterConnect({
  place,
  done,
  installs,
  choice,
  claudeCode,
  pairings,
  onDone,
  onUndo,
}: {
  place: StepPlace;
  done: readonly Done[];
  installs: boolean;
  choice: Choice;
  claudeCode: AgentClient | null;
  pairings: readonly AgentPairing[];
  onDone(done: readonly Done[]): void;
  onUndo(): void;
}) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const awaiting = useAwaitingInstall();
  const install = useClaudeCodeInstallState();
  const [undoing, setUndoing] = useState(false);
  const handedOff = useRef(false);
  const moved = useRef(false);

  // Signed in to the Claude Code it installed: the same press connects it, as the row said it would.
  useEffect(() => {
    if (!installs || install.kind !== "signed-in" || !claudeCode || handedOff.current) return;
    if (done.some((each) => each.client.id === "claude-code")) return;
    handedOff.current = true;
    void connectManyAgents(
      [claudeCode],
      { folderIds: [ALL_SHARED_ID], propose: choice.propose },
      { enable: true },
    )
      .then(([outcome]) => {
        if (!outcome) return;
        void resetClaudeCodeInstall();
        onDone([
          ...done,
          outcome.kind === "connected"
            ? { client: outcome.client, pairingId: outcome.pairing.id, result: outcome.result }
            : { client: outcome.client, error: outcome.error },
        ]);
      })
      .catch(reportError);
  }, [installs, install.kind, claudeCode, done, choice.propose, onDone, reportError]);

  const pairingOf = (id: string) => pairings.find((pairing) => pairing.id === id);
  // Until the waiting Installs are read, an app that isn't written to is taken as still waiting.
  const left = (each: Done) =>
    "error" in each
      ? true
      : awaiting === null
        ? each.result.kind !== "wrote"
        : stillNeedsUser(each.result, pairingOf(each.pairingId), awaiting);
  // Installing goes on until it ends: a plan without Claude Code ends it, and asks nothing more.
  const installLeft =
    installs &&
    !done.some((each) => each.client.id === "claude-code") &&
    install.kind !== "no-plan";
  const leftNames = [
    ...done.filter(left).map((each) => clientName(each.client, t)),
    ...(installLeft ? ["Claude Code"] : []),
  ];
  const nothingLeft = leftNames.length === 0;

  useEffect(() => {
    if (!nothingLeft || moved.current) return;
    moved.current = true;
    place.next();
  }, [nothingLeft, place]);

  const retry = async (client: AgentClient) => {
    const [outcome] = await connectManyAgents(
      [client],
      { folderIds: [ALL_SHARED_ID], propose: choice.propose },
      { enable: true },
    );
    if (!outcome) return;
    onDone(
      done.map((each) =>
        each.client.id !== client.id
          ? each
          : outcome.kind === "connected"
            ? { client, pairingId: outcome.pairing.id, result: outcome.result }
            : { client, error: outcome.error },
      ),
    );
  };

  const undo = async () => {
    if (undoing) return;
    setUndoing(true);
    try {
      if (installs) await cancelClaudeCodeInstall();
      for (const each of done) if ("pairingId" in each) await core.undoAgentSetup(each.pairingId);
      onUndo();
    } catch (error) {
      reportError(error);
    } finally {
      setUndoing(false);
    }
  };

  return (
    <SetupPanel
      place={place}
      view="ai-after"
      title={t("setupPage.ai.title")}
      lead={
        leftNames.length === 1
          ? t("setupPage.ai.left.one", { agent: leftNames[0] ?? "" })
          : leftNames.length > 1
            ? t("setupPage.ai.left.many")
            : undefined
      }
      foot={
        <StepFoot
          place={place}
          start={
            <button
              type="button"
              data-testid="setup-undo"
              disabled={undoing}
              onClick={() => void undo()}
              className={`-ml-2.5 ${buttonStyle("ghost", "lg")}`}
            >
              {t("agents.done.undo")}
            </button>
          }
          later={!nothingLeft}
          main={
            <button
              type="button"
              data-testid="setup-next"
              disabled={!nothingLeft}
              onClick={place.next}
              className={buttonStyle("primary", "lg")}
            >
              {t("setupPage.continue")}
            </button>
          }
        />
      }
    >
      <ul data-testid="setup-done" aria-label={t("setupPage.ai.title")} className={listClass}>
        {done.map((each) => (
          <DoneRow
            key={each.client.id}
            done={each}
            pairing={"pairingId" in each ? pairingOf(each.pairingId) : undefined}
            left={left(each)}
            onRetry={() => retry(each.client)}
          />
        ))}
        {installs && !done.some((each) => each.client.id === "claude-code") && (
          <InstallingRow state={install} />
        )}
      </ul>
    </SetupPanel>
  );
}

function InstallingRow({ state }: { state: ReturnType<typeof useClaudeCodeInstallState> }) {
  const t = useT();
  const status = installStatus(state, t);
  return (
    <li
      data-testid="setup-done-row"
      data-client="claude-code"
      data-state={state.kind}
      className={rowClass}
    >
      <AppMark name="Claude Code" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-ui text-ink">Claude Code</span>
        <span role="status" className="text-[12px] leading-[18px] text-ink-meta">
          {status?.line ?? t("setupPage.ai.install.installing")}
        </span>
      </span>
      {status?.action}
    </li>
  );
}

function DoneRow({
  done,
  pairing,
  left,
  onRetry,
}: {
  done: Done;
  pairing: AgentPairing | undefined;
  left: boolean;
  onRetry(): Promise<void>;
}) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = clientName(done.client, t);
  const agent = clientInSentence(done.client, t);
  let line: string;
  let action: ReactNode = null;
  let details: string | null = null;
  if ("error" in done) {
    line = setupProblem(done.error, t);
    action = (
      <button
        type="button"
        data-testid="setup-done-retry"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onRetry()
            .catch(reportError)
            .finally(() => setBusy(false));
        }}
        className={buttonStyle("secondary", "sm")}
      >
        {t("agents.connectAll.retry")}
      </button>
    );
  } else if (!left) {
    line = t("setupPage.ai.connected");
  } else if (done.result.kind === "opened") {
    line = t("setupPage.ai.row.install", { agent });
    const { pairingId } = done;
    action = (
      <button
        type="button"
        data-testid="setup-done-open"
        onClick={() => void core.openAgentInstallAgain(pairingId).catch(reportError)}
        className={buttonStyle("secondary", "sm")}
      >
        {t("setupPage.ai.row.open", { agent })}
      </button>
    );
  } else if (done.result.kind === "copy") {
    const { text, shown, how } = done.result;
    line = t(how === "command" ? "setupPage.ai.row.command" : "setupPage.ai.row.settings", {
      agent,
    });
    details = shown;
    action = (
      <button
        type="button"
        data-testid="setup-done-copy"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => setCopied(true), reportError)
        }
        className={buttonStyle("secondary", "sm")}
      >
        {t(copied ? "agents.pairing.copied" : "agents.pairing.copy")}
      </button>
    );
  } else {
    line = t("setupPage.ai.connected");
  }
  return (
    <li
      data-testid="setup-done-row"
      data-client={done.client.id}
      data-left={left || undefined}
      data-paired={pairing ? "" : undefined}
      className="flex flex-col border-t border-rule first:border-t-0"
    >
      <div className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-2">
        <AppMark name={name} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui text-ink" title={name}>
            {name}
          </span>
          <span
            role="status"
            className={`text-[12px] leading-[18px] ${left ? "text-ink-secondary" : "text-ink-meta"}`}
          >
            {"error" in done && <ProblemMark />}
            {line}
          </span>
        </span>
        {action}
      </div>
      {details !== null && <PasteDetails text={details} />}
    </li>
  );
}

function PasteDetails({ text }: { text: string }) {
  const t = useT();
  return (
    <details data-testid="setup-done-details" className="px-3 pb-2 pl-[52px]">
      <summary className="cursor-pointer text-[12px] leading-[18px] text-ink-secondary">
        {t("agents.connect.details")}
      </summary>
      <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-frame p-2 font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap text-ink">
        {text}
      </pre>
    </details>
  );
}

/**
 * Another app…: the AI apps that aren't on this computer and Other agent, each connected through
 * the sheet Settings › AI connects it with.
 */
function AnotherApp({
  place,
  clients,
  chosen,
  onChoose,
  onBack,
  onDone,
}: {
  place: StepPlace;
  clients: readonly AgentClient[];
  chosen: AgentClient | null;
  onChoose(client: AgentClient): void;
  onBack(): void;
  onDone(done: Done, choice: Choice): void;
}) {
  const t = useT();
  const connection = useAgentConnection();
  const crumb = {
    label: chosen ? t("setupPage.ai.another.title") : t("setupPage.ai.title"),
    onClick: onBack,
  };
  if (chosen) {
    return (
      <SetupPanel
        place={place}
        view={`app:${chosen.id}`}
        title={clientName(chosen, t)}
        crumb={crumb}
        foot={null}
      >
        <div data-testid="setup-another-connect" className="flex flex-col gap-3">
          <ConnectAgentFields
            client={chosen}
            problem={connection.problem}
            actions={({ choice, disabled }) => (
              <div className="flex justify-end">
                <button
                  type="button"
                  data-testid="setup-another-allow"
                  disabled={disabled || connection.busy}
                  onClick={() =>
                    void connection.connect(chosen, choice, { enable: true }).then((done) => {
                      if (done) {
                        onDone(
                          { client: chosen, pairingId: done.pairingId, result: done.result },
                          { propose: choice.propose },
                        );
                      }
                    })
                  }
                  className={buttonStyle("primary", "md")}
                >
                  {t("setupPage.ai.connect")}
                </button>
              </div>
            )}
          />
        </div>
      </SetupPanel>
    );
  }
  return (
    <SetupPanel
      place={place}
      view="another"
      title={t("setupPage.ai.another.title")}
      crumb={crumb}
      foot={null}
    >
      <ul data-testid="setup-another" className="grid grid-cols-2 gap-2 max-[520px]:grid-cols-1">
        {clients.map((client) => {
          const name = clientName(client, t);
          return (
            <li key={client.id} className="flex min-w-0">
              <button
                type="button"
                data-testid="setup-another-app"
                data-value={client.id}
                onClick={() => onChoose(client)}
                className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left text-ui text-ink shadow-[inset_0_0_0_1px_var(--color-rule-strong)] hover:bg-hover"
              >
                <AppMark name={name} />
                <span className="min-w-0 flex-1 truncate" title={name}>
                  {name}
                </span>
                <ChevronRightLineIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-ink-meta"
                />
              </button>
            </li>
          );
        })}
      </ul>
    </SetupPanel>
  );
}
