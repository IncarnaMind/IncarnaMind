import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ChatProvider } from "../../../../core/api";
import type { KeyTarget } from "../../../../core/providers/catalog/keyForms";
import { useAgentClients, useAgentPairings } from "../../agentNote";
import { useAnswers } from "../../answers";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { turnOffLocalMode } from "../../localMode";
import { useModelNames } from "../../modelNames";
import { useAppStore } from "../../store";
import { ServiceDirectory, useEntryName, usePlansOffered } from "../ai/AddSheet";
import { RoleSelect } from "../ai/RoleSelect";
import { jobsOf, type ServiceEntry } from "../ai/serviceDirectory";
import { ChevronDownLineIcon, ChevronRightLineIcon, PlusLineIcon } from "../lineIcons";
import { ProblemLine } from "../ProblemLine";
import { useContinueWithChatGpt } from "../providers/ChatGptSignIn";
import { ClaudePlanSignIn, useClaudePlanOffered } from "../providers/ClaudePlan";
import { CopilotSetupWay } from "../providers/CopilotPlan";
import { KeyEntry } from "../providers/KeyEntry";
import { useOllama } from "../providers/OllamaCard";
import { ProviderForm } from "../providers/ProviderForm";
import { SendsLine } from "../providers/SendsLine";
import { ChatGptPlanWay, LocalWay } from "../providers/SetupWays";
import { providerName, savedProviderFor } from "../providers/shared";
import { buttonStyle } from "../ui";
import { AgentWays } from "./AgentWays";
import { KeysStay, SetupPanel, type StepPlace, WorksRow } from "./SetupPanel";

type View =
  | { kind: "main" }
  | { kind: "list" }
  | { kind: "entry"; entry: ServiceEntry }
  | { kind: "key"; key: string; target: KeyTarget | undefined };

type Way = "chatgpt" | "claude" | "local";

const answers = (entry: ServiceEntry) => jobsOf(entry).includes("answers");

function backToMore(setView: (view: View) => void) {
  setView({ kind: "main" });
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('[data-testid="setup-way-more-open"]')?.focus(),
  );
}

/**
 * The setup's second step (#3296): the User's AI, two ways (#3362). First the AI they already
 * have, connected as Settings › Agents connects it (`AgentWays`); then a model in IncarnaMind: a
 * key is recognised by its form and works at once, and the other ways follow, cloud first and a
 * model on this computer last. "More services…" opens the directory in the step, and a service
 * chosen there is set up in it, so the setup is never left. Continue waits for either way to
 * work; "Set up later" asks for a model where it is first needed instead.
 */
export function AiStep({ place }: { place: StepPlace }) {
  const t = useT();
  const language = useLanguage();
  const chinese = language === "zh-CN";
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const readiness = useAppStore((state) => state.chatReadiness);
  const pairings = useAgentPairings();
  const clients = useAgentClients();
  const ready = readiness?.ready === true || (pairings?.length ?? 0) > 0;
  const [view, setView] = useState<View>({ kind: "main" });
  const [open, setOpen] = useState<Way | null>(null);
  const [providers, setProviders] = useState<ChatProvider[]>([]);
  const keyField = useRef<HTMLInputElement>(null);
  const sign = useContinueWithChatGpt({ onSignedIn: () => setView({ kind: "main" }) });
  const claudeOffered = useClaudePlanOffered();
  const offered = usePlansOffered();
  const entryName = useEntryName();
  useEffect(() => {
    if (!readiness) return;
    // Only to tell a key form a key is already saved: the forms work with none listed.
    core
      .listChatProviders()
      .then(setProviders, (error: unknown) =>
        console.error("The saved chat providers couldn't be listed for the setup.", error),
      );
  }, [readiness]);
  // Esc leaves the service list, or a service's form, for the step, once the search field has
  // emptied itself and nothing inside has taken the key.
  const away = view.kind !== "main";
  useEffect(() => {
    if (!away) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      backToMore(setView);
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [away]);
  // A model that starts working while a service is set up brings the step back, with it set.
  const modelReady = readiness?.ready === true;
  const wasReady = useRef(modelReady);
  useEffect(() => {
    if (modelReady && !wasReady.current) setView({ kind: "main" });
    wasReady.current = modelReady;
  }, [modelReady]);

  const main = () => setView({ kind: "main" });
  const useKeyInstead = () => {
    main();
    requestAnimationFrame(() => keyField.current?.focus());
  };
  const toggle = (way: Way) => setOpen(open === way ? null : way);
  // The step opens whole, its first choice focused: in the setup they were read on its first step.
  if (clients.state === "loading") return null;

  if (view.kind !== "main") {
    const crumb = { label: t("setupPage.ai.title"), onClick: () => backToMore(setView) };
    let title = t("setupPage.ai.services");
    let content: ReactNode;
    if (view.kind === "list") {
      content = (
        <ServiceDirectory
          offered={offered}
          only={answers}
          added={(entry) =>
            entry.kind === "provider"
              ? savedProviderFor(providers, entry.provider.id, null, language) !== undefined
              : entry.kind === "plan" && providers.some((each) => each.kind === entry.plan)
          }
          onOpen={(entry) => setView({ kind: "entry", entry })}
        />
      );
    } else if (view.kind === "key") {
      content = (
        <ProviderForm
          providers={providers}
          initialKey={view.key}
          {...(view.target !== undefined && {
            initialKind: view.target.service,
            initialEndpoint: view.target.region,
          })}
          onSaved={main}
          standalone
        />
      );
    } else {
      const { entry } = view;
      title = entryName(entry);
      content = <EntrySetUp entry={entry} sign={sign} onDone={main} onUseKey={useKeyInstead} />;
    }
    return (
      <SetupPanel
        place={place}
        view={view.kind === "entry" ? `entry:${title}` : view.kind}
        title={title}
        crumb={crumb}
        foot={null}
      >
        <div data-testid="setup-services" className="flex flex-col gap-3">
          {content}
        </div>
      </SetupPanel>
    );
  }

  const plans = !localOnly && (
    <>
      <WayRow
        title={t("setup.chatgpt.use")}
        testId="setup-way-chatgpt"
        expanded={open === "chatgpt" || sign.waiting}
        onClick={() => toggle("chatgpt")}
      >
        <ChatGptPlanWay sign={sign} leads label="chatgpt.continue" quiet />
      </WayRow>
      {claudeOffered && (
        <WayRow
          title={t("claudePlan.way.title")}
          testId="setup-way-claude"
          expanded={open === "claude"}
          onClick={() => toggle("claude")}
        >
          <ClaudePlanSignIn onClose={() => setOpen(null)} onUseKey={useKeyInstead} />
        </WayRow>
      )}
    </>
  );
  const more = !localOnly && (
    <WayRow
      title={t("setupPage.ai.more")}
      testId="setup-way-more"
      icon={<PlusLineIcon aria-hidden="true" className="size-4 shrink-0 text-ink-meta" />}
      onClick={() => setView({ kind: "list" })}
    />
  );
  return (
    <SetupPanel
      place={place}
      view="ai"
      title={t("setupPage.ai.title")}
      lead={t("setupPage.ai.lead")}
      foot={
        <>
          {place.back && (
            <button
              type="button"
              data-testid="setup-back"
              onClick={place.back}
              className={`-ml-2.5 ${buttonStyle("ghost", "lg")}`}
            >
              {t("setupPage.back")}
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            data-testid="setup-skip"
            onClick={place.next}
            className={buttonStyle("ghost", "lg")}
          >
            {t("providers.setup.later")}
          </button>
          <button
            type="button"
            data-testid="setup-next"
            disabled={!ready}
            onClick={place.next}
            className={buttonStyle("primary", "lg")}
          >
            {t("setupPage.continue")}
          </button>
        </>
      }
    >
      <AgentWays clients={clients} pairings={pairings ?? []} />
      <h2 id="setup-in-app" className="-mb-2 text-ui font-semibold text-ink">
        {t("setupPage.ai.inApp")}
      </h2>
      <div className="flex flex-col gap-2">
        {localOnly ? (
          <ProblemLine
            testId="setup-local-mode"
            action={{
              label: t("localMode.turnOff"),
              testId: "setup-local-mode-off",
              onClick: () => void turnOffLocalMode(),
            }}
          >
            {t("setup.localMode")}
          </ProblemLine>
        ) : (
          <KeyEntry
            testId="setup-key"
            inputRef={keyField}
            label="setupPage.ai.key"
            placeholder="setupPage.ai.keyPlaceholder"
            below={<KeysStay />}
            onSaved={() => undefined}
            unrecognised={{
              label: "setup.key.chooseService",
              run: (key, target) => setView({ kind: "key", key, target }),
            }}
          />
        )}
        {readiness?.ready && <ModelWorks />}
      </div>
      <div className="flex flex-col gap-2">
        <h3 id="setup-other" className="text-[13px] leading-5 font-semibold text-ink-secondary">
          {t("setup.other")}
        </h3>
        {/* Neither plan is sold in mainland China, which the Chinese interface stands for, so
            there they come after the other services (#2865); this computer is last either way. */}
        <ul aria-labelledby="setup-other" className="flex flex-col gap-2">
          {chinese ? (
            <>
              {more}
              {plans}
            </>
          ) : (
            <>
              {plans}
              {more}
            </>
          )}
          <WayRow
            title={t("setupPage.ai.local")}
            testId="setup-way-local"
            expanded={open === "local"}
            onClick={() => toggle("local")}
          >
            <LocalPanel />
          </WayRow>
        </ul>
      </div>
    </SetupPanel>
  );
}

function ModelWorks() {
  const t = useT();
  const id = useId();
  const language = useLanguage();
  const readiness = useAppStore((state) => state.chatReadiness);
  const groups = useAnswers((state) => state.models);
  const loadModels = useAnswers((state) => state.loadModels);
  const nameOf = useModelNames();
  const [providers, setProviders] = useState<ChatProvider[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the model that works changes.
  useEffect(() => {
    loadModels();
    core
      .listChatProviders()
      .then(setProviders, (error: unknown) =>
        console.error("The saved chat providers couldn't be listed for the setup.", error),
      );
  }, [loadModels, readiness]);
  if (!readiness?.ready) return null;
  const name = `${nameOf(readiness.modelId, readiness.provider.id).name} · ${providerName(
    readiness.provider,
    t,
    language,
  )}`;
  const service = readiness.provider.service;
  return (
    <>
      <WorksRow text={t("setup.ready", { name })} testId="setup-ai-works">
        <label htmlFor={id} className="text-[12px] leading-[18px] text-ink-meta">
          {t("setupPage.ai.model")}
        </label>
        <RoleSelect
          id={id}
          job="chatModel"
          groups={groups ?? []}
          providers={providers.length > 0 ? providers : [readiness.provider]}
          roles={null}
        />
      </WorksRow>
      {service && <SendsLine provider={service.name} testId="setup-ai-sends" />}
    </>
  );
}

// Ollama is asked about only once the User opens its row.
function LocalPanel() {
  const ollama = useOllama(() => undefined, undefined, { localModeUnasked: true });
  return <LocalWay ollama={ollama} quiet />;
}

function EntrySetUp({
  entry,
  sign,
  onDone,
  onUseKey,
}: {
  entry: ServiceEntry;
  sign: ReturnType<typeof useContinueWithChatGpt>;
  onDone(): void;
  onUseKey(): void;
}) {
  const [providers, setProviders] = useState<ChatProvider[]>([]);
  useEffect(() => {
    core
      .listChatProviders()
      .then(setProviders, (error: unknown) =>
        console.error("The saved chat providers couldn't be listed for the setup.", error),
      );
  }, []);
  if (entry.kind === "plan") {
    if (entry.plan === "chatgpt")
      return <ChatGptPlanWay sign={sign} leads label="chatgpt.continue" quiet />;
    if (entry.plan === "claude-account") {
      return <ClaudePlanSignIn onClose={onDone} onUseKey={onUseKey} />;
    }
    return <CopilotSetupWay onKey={onUseKey} />;
  }
  if (entry.kind !== "provider") return null;
  if (entry.provider.id === "ollama") return <LocalPanel />;
  return (
    <ProviderForm
      key={entry.provider.id}
      providers={providers}
      only={entry.provider.id}
      onSaved={onDone}
    />
  );
}

function WayRow({
  title,
  testId,
  icon,
  expanded,
  onClick,
  children,
}: {
  title: string;
  testId: string;
  icon?: ReactNode;
  expanded?: boolean;
  onClick(): void;
  children?: ReactNode;
}) {
  const panel = useId();
  const Chevron = expanded ? ChevronDownLineIcon : ChevronRightLineIcon;
  return (
    <li
      data-testid={testId}
      className="flex flex-col rounded-lg shadow-[inset_0_0_0_1px_var(--color-rule-strong)]"
    >
      <button
        type="button"
        data-testid={`${testId}-open`}
        aria-expanded={children === undefined ? undefined : expanded === true}
        aria-controls={children === undefined ? undefined : panel}
        onClick={onClick}
        className="flex min-h-10 items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-hover"
      >
        <span className="min-w-0 flex-1 text-ui font-semibold text-ink">{title}</span>
        {icon ?? <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-ink-meta" />}
      </button>
      {children !== undefined && expanded && (
        <div id={panel} className="flex flex-col gap-2 px-3 pt-1 pb-3">
          {children}
        </div>
      )}
    </li>
  );
}
