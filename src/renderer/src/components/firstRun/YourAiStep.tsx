import { type ReactNode, useEffect, useRef, useState } from "react";
import { type AgentClient, type AgentPairing, ALL_SHARED_ID } from "../../../../core/api";
import { useAgentClients, useAgentPairings } from "../../agentNote";
import {
  resetClaudeCodeInstall,
  startClaudeCodeInstall,
  useClaudeCodeInstallAvailability,
  useClaudeCodeInstallState,
} from "../../claudeCodeInstall";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { clientName, setupProblem } from "../agents/agentWords";
import { AgentSecretNotice, connectManyAgents, useSecretStorage } from "../agents/connectShared";
import { ChevronDownLineIcon } from "../lineIcons";
import { ProblemMark } from "../ProblemLine";
import { ReadProblem } from "../ReadProblem";
import { buttonStyle, checkBoxClass, dialogTextClass } from "../ui";
import { AnotherApp } from "./AnotherApp";
import { InstallOfferRow } from "./ClaudeCodeInstallLine";
import { SetupPanel, type StepPlace } from "./SetupPanel";
import { SortingModelLine } from "./SortingModelLine";
import { YourAiAfter } from "./YourAiAfter";
import { YourAiConsent } from "./YourAiConsent";
import { firstTicked, foundApps, notConnected, SHOWN_FIRST } from "./yourAiList";
import { AppMark, type Choice, type Done, listClass, rowClass, StepFoot } from "./yourAiParts";

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

  // While the apps or the connections are read, or if that fails (said where it failed), the User
  // can still go back or on.
  if (clients.state === "loading" || pairings === null) {
    return (
      <SetupPanel
        place={place}
        view="ai"
        title={t("setupPage.ai.title")}
        foot={<StepFoot place={place} />}
      >
        {null}
      </SetupPanel>
    );
  }
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
  const [ticks, setTicks] = useState<ReadonlySet<string> | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problemLine, setProblemLine] = useState<string | null>(null);
  const [propose, setPropose] = useState(true);
  // A press still connecting when the User goes back or on moves them nowhere once it lands.
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
  const { storage, canKeepKey, accept } = useSecretStorage(chosen.map((each) => each.id).join(","));
  const inUse = new Set(pairings.map((pairing) => pairing.client));
  const shown = open || found.length <= SHOWN_FIRST ? found : found.slice(0, SHOWN_FIRST);
  const folded = found.length - shown.length;
  const anyConnected = pairings.length > 0;

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
    try {
      const outcomes = await connectManyAgents(
        chosen,
        { folderIds: [ALL_SHARED_ID], propose },
        { enable: true },
      );
      if (!here.current) return;
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
        { propose },
        installs,
      );
    } catch (error) {
      setProblemLine(setupProblem(error, t));
    } finally {
      setBusy(false);
    }
  };

  const main =
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
    );

  return (
    <SetupPanel
      place={place}
      view="ai"
      title={t("setupPage.ai.title")}
      lead={t(found.length > 0 ? "setupPage.ai.lead.found" : "setupPage.ai.lead.none")}
      foot={<StepFoot place={place} later={!anyConnected || chosen.length > 0} main={main} />}
    >
      {problem}
      <ul data-testid="setup-apps" aria-label={t("setupPage.ai.title")} className={listClass}>
        {offersInstall && <InstallOfferRow />}
        {shown.map((client) => (
          <FoundRow
            key={client.id}
            client={client}
            connected={inUse.has(client.id)}
            ticked={ticked.has(client.id)}
            installs={installs && client.id === "claude-desktop"}
            onTick={(on) => toggle(client, on)}
          />
        ))}
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
      {chosen.length > 0 && (
        <YourAiConsent chosen={chosen} propose={propose} onPropose={setPropose} />
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

/** One app found: its tick, or Connected once it is; with only the Claude app, what Connect installs. */
function FoundRow({
  client,
  connected,
  ticked,
  installs,
  onTick,
}: {
  client: AgentClient;
  connected: boolean;
  ticked: boolean;
  installs: boolean;
  onTick(on: boolean): void;
}) {
  const t = useT();
  const name = clientName(client, t);
  const words = (
    <>
      <AppMark name={name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui text-ink" title={name}>
          {name}
        </span>
        {installs && (
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
            checked={ticked}
            onChange={(event) => onTick(event.target.checked)}
            className={`${checkBoxClass} accent-ink`}
          />
        </label>
      )}
    </li>
  );
}
