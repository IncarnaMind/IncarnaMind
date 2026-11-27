import { type ReactNode, useEffect, useRef, useState } from "react";
import { type AgentClient, type AgentPairing, ALL_SHARED_ID } from "../../../../core/api";
import { clientInSentence } from "../../../../shared/agentNames";
import { useAgentClients, useAgentPairingsRead } from "../../agentNote";
import {
  cancelClaudeCodeInstall,
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
import { AgentSecretNotice, connectManyAgents, useSecretStorage } from "../agents/connectShared";
import { ChevronDownLineIcon } from "../icons";
import { ProblemMark } from "../ProblemLine";
import { ReadProblem } from "../ReadProblem";
import { buttonStyle, checkBoxClass, dialogTextClass } from "../ui";
import { AnotherApp } from "./AnotherApp";
import { InstallOfferRow } from "./ClaudeCodeInstallLine";
import { SetupPanel, type StepPlace } from "./SetupPanel";
import { SortingModelLine } from "./SortingModelLine";
import { YourAiAfter } from "./YourAiAfter";
import { YourAiConsent } from "./YourAiConsent";
import { firstTicked, foundApps, notConnected, shownApps } from "./yourAiList";
import {
  AppMark,
  type Choice,
  type Done,
  listClass,
  rowClass,
  StepFoot,
  useAwaitingInstall,
} from "./yourAiParts";

type View =
  | { kind: "list" }
  | { kind: "another" }
  | { kind: "app"; client: AgentClient }
  | { kind: "after"; done: readonly Done[]; installs: boolean; choice: Choice };

/**
 * The first run's Your AI step (#3791): the AI apps on this computer as one list, one tick each, the
 * first of them ticked; one sentence of what connecting lets them read, with Details; one Connect.
 * Connecting moves on by itself once every app chosen works; while one still needs the User, its
 * row says what is left, with the one button that does it. With only the Claude app found, the same
 * Connect downloads and connects Claude Code too, as the row and the consent say first. With none
 * found, Claude Code is offered to install, and any other app is reached through Another app….
 */
export function YourAiStep({ place }: { place: StepPlace }) {
  const t = useT();
  const clients = useAgentClients();
  const pairingsRead = useAgentPairingsRead();
  const availability = useClaudeCodeInstallAvailability();
  const install = useClaudeCodeInstallState();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const starting = useClaudeCodeInstallStarting();
  const [view, setView] = useState<View>({ kind: "list" });
  // Claude Code installed by a press the User then took back: it stays, and the step says so.
  const [kept, setKept] = useState(false);

  // An install this step started and the User left by Back, Set up later or any other way: what
  // hasn't happened yet doesn't. Its download stops, and so does a sign-in still waiting.
  const ours = useRef(false);
  const pending = useRef(false);
  pending.current =
    starting || install.kind === "installing" || install.kind === "awaiting-sign-in";
  useEffect(
    () => () => {
      if (ours.current && pending.current) void cancelClaudeCodeInstall();
    },
    [],
  );
  const startInstall = () => {
    ours.current = true;
    void startClaudeCodeInstall();
  };

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

  // While the apps or the connections are read, or when the connections can't be, the User can
  // still go back or on.
  if (clients.state === "loading" || pairingsRead.state !== "ready") {
    return (
      <SetupPanel
        place={place}
        view="ai"
        title={t("setupPage.ai.title")}
        foot={<StepFoot place={place} />}
      >
        {pairingsRead.state === "failed" ? (
          <ReadProblem
            words={t("setupPage.ai.connections.failed")}
            read={pairingsRead}
            testId="setup-connections-problem"
          />
        ) : null}
      </SetupPanel>
    );
  }
  const pairings = pairingsRead.data;
  const all = clients.state === "ready" ? clients.data : [];
  // While its install goes on, or stopped with something left to do, Claude Code is its install
  // row, with that state's words and button, though its download already put it here.
  const installShown =
    install.kind === "installing" ||
    install.kind === "awaiting-sign-in" ||
    install.kind === "no-plan" ||
    install.kind === "failed";
  const claudeCodeHere =
    install.kind === "signed-in" || (availability?.installed === true && !installShown);
  const found = foundApps(all, claudeCodeHere).filter(
    (client) => !(installShown && client.id === "claude-code"),
  );
  const claudeCode = all.find((client) => client.id === "claude-code") ?? null;
  // Claude Code is installed in the same press only where nothing installs one already.
  const installs =
    !localOnly &&
    availability?.supported === true &&
    !availability.cliAgentPresent &&
    !claudeCodeHere &&
    claudeCode !== null &&
    found.length === 1 &&
    found[0]?.id === "claude-desktop";

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
        onDone={(done, choice) =>
          // Only while the User is still on that app's sheet: one they left stays left.
          setView((current) =>
            current.kind === "app" && current.client.id === done.client.id
              ? { kind: "after", done: [done], installs: false, choice }
              : current,
          )
        }
      />
    );
  }
  if (view.kind === "after") {
    return (
      <YourAiAfter
        place={place}
        done={view.done}
        installs={view.installs}
        choice={view.choice}
        claudeCode={claudeCode}
        pairings={pairings}
        onDone={(update) =>
          setView((current) =>
            current.kind === "after" ? { ...current, done: update(current.done) } : current,
          )
        }
        onUndo={(installKept) => {
          setKept(installKept);
          setView({ kind: "list" });
        }}
        onInstallStart={startInstall}
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
      installs={installs ? claudeCode : null}
      kept={kept}
      offersInstall={
        (found.length === 0 || installShown) &&
        !localOnly &&
        availability?.supported === true &&
        claudeCode !== null
      }
      onAnother={() => setView({ kind: "another" })}
      onInstallStart={startInstall}
      onConnected={(done, choice, installed) =>
        setView({ kind: "after", done, installs: installed, choice })
      }
    />
  );
}

function FoundList({
  place,
  problem,
  found,
  pairings,
  installs,
  kept,
  offersInstall,
  onAnother,
  onInstallStart,
  onConnected,
}: {
  place: StepPlace;
  problem: ReactNode;
  found: readonly AgentClient[];
  pairings: readonly AgentPairing[];
  /** Claude Code, when the same Connect also downloads and connects it. */
  installs: AgentClient | null;
  kept: boolean;
  offersInstall: boolean;
  onAnother(): void;
  onInstallStart(): void;
  onConnected(done: readonly Done[], choice: Choice, installed: boolean): void;
}) {
  const t = useT();
  const awaiting = useAwaitingInstall();
  const [ticks, setTicks] = useState<ReadonlySet<string> | null>(null);
  const [open, setOpen] = useState(false);
  // A press still connecting: its consent and its button stay as they were when it was pressed.
  const [pressed, setPressed] = useState<{
    apps: readonly AgentClient[];
    installs: AgentClient | null;
  } | null>(null);
  const [problemLine, setProblemLine] = useState<string | null>(null);
  const [propose, setPropose] = useState(true);
  // A press still connecting when the User goes back or on starts nothing more, and moves them
  // nowhere once it lands; what it connected shows as Connected, with Undo, when they come back.
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  const first = firstTicked(found, pairings);
  const ticked = ticks ?? new Set(first ? [first] : []);
  const chosen = notConnected(found, pairings).filter((client) => ticked.has(client.id));
  const pairingOf = (client: AgentClient) => pairings.find((each) => each.client === client.id);
  const waitingForUser = (client: AgentClient, pairing: AgentPairing | null): boolean => {
    if (!pairing) return false;
    if (client.setup === "bundle" || client.setup === "link") {
      return awaiting === null ? true : awaiting.includes(pairing.id);
    }
    return (client.setup === "command" || client.setup === "manual") && pairing.lastUsedAt === null;
  };
  // Claude Code comes with the Claude app's Connect only while that app is ticked and not connected.
  const installsNow = chosen.some((client) => client.id === "claude-desktop") ? installs : null;
  const asked = pressed?.apps ?? chosen;
  const askedInstalls = pressed ? pressed.installs : installsNow;
  const { storage, canKeepKey, accept } = useSecretStorage(asked.map((each) => each.id).join(","));
  const shown = shownApps(found, ticked, open);
  const folded = found.length - shown.length;
  const anyConnected = pairings.some((pairing) => {
    const client = found.find((each) => each.id === pairing.client);
    return !client || !waitingForUser(client, pairing);
  });
  const anyWaiting = found.some((client) => waitingForUser(client, pairingOf(client) ?? null));

  const toggle = (client: AgentClient, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(client.id);
    else next.delete(client.id);
    setTicks(next);
  };

  const connect = async () => {
    if (pressed || chosen.length === 0) return;
    setPressed({ apps: chosen, installs: installsNow });
    setProblemLine(null);
    try {
      const outcomes = await connectManyAgents(
        chosen,
        { folderIds: [ALL_SHARED_ID], propose },
        { enable: true, stillWanted: () => here.current },
      );
      if (!here.current) return;
      if (installsNow) onInstallStart();
      if (outcomes.some((each) => each.kind === "connected" && each.client.id === "claude-code")) {
        void resetClaudeCodeInstall();
      }
      // Every app works already: first run moves on, with nothing left to show here.
      if (
        !installsNow &&
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
        { propose },
        installsNow !== null,
      );
    } catch (error) {
      if (here.current) setProblemLine(setupProblem(error, t));
      else useAppStore.getState().reportError(error);
    } finally {
      if (here.current) setPressed(null);
    }
  };

  const undo = async (pairing: AgentPairing) => {
    setProblemLine(null);
    try {
      await core.undoAgentSetup(pairing.id);
    } catch (error) {
      setProblemLine(setupProblem(error, t));
    }
  };

  const main =
    found.length === 0 && !anyConnected && !pressed ? undefined : pressed ||
      chosen.length > 0 ||
      (!anyConnected && !anyWaiting) ? (
      <button
        type="button"
        data-testid="setup-connect"
        disabled={pressed !== null || chosen.length === 0 || !canKeepKey}
        onClick={() => void connect()}
        className={buttonStyle("primary", "lg")}
      >
        {t("setupPage.ai.connect")}
      </button>
    ) : (
      <button
        type="button"
        data-testid="setup-next"
        disabled={!anyConnected}
        onClick={place.next}
        className={buttonStyle("primary", "lg")}
      >
        {t("setupPage.continue")}
      </button>
    );

  return (
    <SetupPanel
      place={place}
      view="ai"
      title={t("setupPage.ai.title")}
      lead={t(found.length > 0 ? "setupPage.ai.lead.found" : "setupPage.ai.lead.none")}
      foot={
        <StepFoot
          place={place}
          later={!anyConnected || chosen.length > 0 || pressed !== null}
          main={main}
        />
      }
    >
      {problem}
      <ul data-testid="setup-apps" aria-label={t("setupPage.ai.title")} className={listClass}>
        {offersInstall && <InstallOfferRow onStart={onInstallStart} />}
        {shown.map((client) => {
          const pairing = pairingOf(client) ?? null;
          return (
            <FoundRow
              key={client.id}
              client={client}
              pairing={pairing}
              waiting={waitingForUser(client, pairing)}
              ticked={ticked.has(client.id)}
              installs={askedInstalls !== null && client.id === "claude-desktop"}
              busy={pressed !== null}
              onTick={(on) => toggle(client, on)}
              onUndo={(each) => void undo(each)}
            />
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
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-chip text-small leading-none text-ink-secondary"
              >
                +{folded}
              </span>
              <span className="min-w-0 flex-1">
                {t("setupPage.ai.moreFound", { count: folded })}
              </span>
              <ChevronDownLineIcon aria-hidden="true" className="shrink-0" />
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
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-chip text-ui leading-none text-ink-secondary"
            >
              …
            </span>
            <span className="min-w-0 flex-1">{t("setupPage.ai.another")}</span>
          </button>
        </li>
      </ul>
      {kept && (
        <p data-testid="setup-install-kept" role="status" className={dialogTextClass}>
          {t("setupPage.ai.install.kept")}
        </p>
      )}
      {asked.length > 0 && (
        <YourAiConsent
          chosen={asked}
          installs={askedInstalls}
          propose={propose}
          onPropose={setPropose}
        />
      )}
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
 * One app found: its tick, or Connected with Undo once it works, or what is still left with Open
 * and Undo while it waits for the User (Install not yet clicked in its own app, #3819); with only
 * the Claude app, what Connect downloads too.
 */
function FoundRow({
  client,
  pairing,
  waiting,
  ticked,
  installs,
  busy,
  onTick,
  onUndo,
}: {
  client: AgentClient;
  pairing: AgentPairing | null;
  waiting: boolean;
  ticked: boolean;
  installs: boolean;
  /** A press is still connecting: Undo waits for it. */
  busy: boolean;
  onTick(on: boolean): void;
  onUndo(pairing: AgentPairing): void;
}) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const name = clientName(client, t);
  const agent = clientInSentence(client, t);
  const canOpenAgain = client.setup === "bundle" || client.setup === "link";
  const words = (
    <>
      <AppMark name={name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui text-ink" title={name}>
          {name}
        </span>
        {installs && !pairing && (
          <span
            data-testid="setup-app-installs"
            className="text-small leading-[18px] text-ink-meta"
          >
            {t("setupPage.ai.alsoInstalls")}
          </span>
        )}
        {pairing && waiting && (
          <span
            data-testid="setup-app-waiting"
            className="text-small leading-[18px] text-ink-secondary"
          >
            {t(
              canOpenAgain
                ? "setupPage.ai.row.install"
                : client.setup === "command"
                  ? "setupPage.ai.row.command"
                  : "setupPage.ai.row.settings",
              { agent },
            )}
          </span>
        )}
      </span>
    </>
  );
  return (
    <li
      data-testid="setup-app"
      data-value={client.id}
      data-connected={pairing && !waiting ? true : undefined}
      data-waiting={pairing && waiting ? true : undefined}
      className={rowClass}
    >
      {pairing ? (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {words}
          {waiting ? (
            canOpenAgain && (
              <button
                type="button"
                data-testid="setup-app-open"
                disabled={busy}
                onClick={() => void core.openAgentInstallAgain(pairing.id).catch(reportError)}
                className={buttonStyle("secondary", "sm")}
              >
                {t("setupPage.ai.row.open", { agent })}
              </button>
            )
          ) : (
            <span
              data-testid="setup-app-connected"
              className="shrink-0 text-ui leading-5 text-ink-meta"
            >
              {t("setupPage.ai.connected")}
            </span>
          )}
          <button
            type="button"
            data-testid="setup-app-undo"
            disabled={busy}
            onClick={() => onUndo(pairing)}
            className={buttonStyle("ghost", "sm")}
          >
            {t("agents.done.undo")}
          </button>
        </div>
      ) : (
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
          {words}
          <input
            type="checkbox"
            data-testid="setup-app-tick"
            aria-label={name}
            checked={ticked}
            onChange={(event) => onTick(event.target.checked)}
            className={`${checkBoxClass} accent-ink`}
          />
        </label>
      )}
    </li>
  );
}
