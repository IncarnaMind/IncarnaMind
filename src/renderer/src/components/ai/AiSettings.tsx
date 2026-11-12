import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ChatModelGroup,
  ChatProvider,
  DecisionHostStatus,
  OlderKeyJob,
  RerankSettings,
  TranscriptionServiceStatus,
} from "../../../../core/api";
import { useAnswers } from "../../answers";
import { useClaudeAccount } from "../../claudeSignIn";
import { core } from "../../core";
import { useDecisionHosts } from "../../decisionHosts";
import { useLanguage, useT } from "../../i18n";
import { useKeyRefusals } from "../../keyRefusals";
import { clearModelFailure } from "../../modelHealth";
import { useModelNames } from "../../modelNames";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { ROUTE_LABELS, useTranscriptionServicesRead } from "../../transcriptionServices";
import { MicLineIcon } from "../lineIcons";
import { TranscriptionSetUp } from "../meetings/TranscriptionSetUp";
import { AddProvider } from "../providers/AddProvider";
import { ChatGptPlanRow } from "../providers/ChatGptPlanSettings";
import { ReadinessExplanation } from "../providers/ChatReadinessNotice";
import { ClaudePlanRow } from "../providers/ClaudePlan";
import { CopilotPlanRow, useOfferedWay } from "../providers/CopilotPlan";
import { DecisionSortingSetUp, firstModelOf } from "../providers/DecisionKeyForm";
import { JevSortingSetUp } from "../providers/JevSortingSetUp";
import { LocalModeUnavailable } from "../providers/LocalModeUnavailable";
import { ProviderLogo } from "../providers/ProviderLogo";
import { ProviderPage, type RemovedProvider } from "../providers/ProviderPage";
import { RerankKeyForm, useRerank } from "../providers/RerankSettings";
import { useSorting } from "../providers/SortingChoice";
import {
  catalogIdOf,
  MODELS_UNDO_PLACE,
  providerName,
  regionFor,
  savedProviderFor,
} from "../providers/shared";
import { useJevSettings } from "../providers/useJevSettings";
import { SettingsBackLink } from "../SettingsBackLink";
import { SettingsGroup } from "../settings/SettingsGroup";
import { UndoLineAt } from "../UndoLine";
import { noticeClass } from "../ui";
import { AccountsSection } from "./AccountsSection";
import { AddSheet, useEntryName } from "./AddSheet";
import { JobsSection } from "./JobsSection";
import { LimitsSection } from "./LimitsSection";
import type { PlanId, ServiceEntry } from "./serviceDirectory";

type View =
  | { page: "list" }
  | { page: "provider"; providerId: string; keyNotChecked?: boolean }
  | { page: "add"; catalogId: string; endpoint: string | null }
  | { page: "entry"; entry: Exclude<ServiceEntry, { kind: "provider" }> };

const DIRECTORY_TARGET = ["add-provider"] as const;

/**
 * Settings › AI: where the User's AI comes from and which model does each job, on one page. Its
 * three sections are What each job uses, Accounts and keys, and Limits; a provider's page, and
 * the page that sets up an entry of "Add an account or key", open in its place.
 */
export function AiSettings() {
  const t = useT();
  const language = useLanguage();
  const readiness = useAppStore((state) => state.chatReadiness);
  const groups = useAnswers((state) => state.models);
  const loadModels = useAnswers((state) => state.loadModels);
  const [providers, setProviders] = useState<ChatProvider[] | null>(null);
  const [view, setView] = useState<View>({ page: "list" });
  const [adding, setAdding] = useState(false);
  const [removed, setRemoved] = useState<RemovedProvider | null>(null);
  const section = useRef<HTMLDivElement>(null);
  const opener = useRef<string | null>(null);
  const chosen = useRef<ServiceEntry | null>(null);
  const refused = useKeyRefusals((state) => state.showing);
  // Read with the providers, so the page lays out once: a section landing later would move the
  // one a link scrolled to out of view.
  const [hosts, setHosts] = useDecisionHosts();
  const [jev, setJev] = useJevSettings();
  const { rerank, setRerank, answered: rerankAnswered } = useRerank();
  const sorting = useSorting();
  // One read for the page: the Meeting transcription row and the transcription keys. The page
  // waits for its first answer only: a Try again after a failure keeps the page on screen.
  const services = useTranscriptionServicesRead();
  const [servicesAnswered, setServicesAnswered] = useState(false);
  if (!servicesAnswered && services.state !== "loading") setServicesAnswered(true);
  const [sortingAnswered, setSortingAnswered] = useState(false);
  if (!sortingAnswered && sorting.read.state !== "loading") setSortingAnswered(true);
  const laidOut =
    providers !== null &&
    hosts !== null &&
    rerankAnswered &&
    sortingAnswered &&
    (servicesAnswered || services.state !== "loading");

  const refresh = useCallback(() => {
    core.listChatProviders().then(setProviders, (failure: unknown) => {
      useAppStore.getState().reportError(failure);
    });
  }, []);
  // Saving or removing a provider changes readiness, and with it the providers and their menus.
  useEffect(() => {
    if (readiness) {
      refresh();
      loadModels();
    }
  }, [readiness, refresh, loadModels]);
  useEffect(() => () => useKeyRefusals.getState().done(), []);
  const embedding = useAppStore((state) => state.embedding);
  const [olderKeys, setOlderKeys] = useState<OlderKeyJob[]>([]);
  const readOlderKeys = useCallback(() => {
    core.getOlderKeys().then(setOlderKeys, (failure: unknown) => {
      console.error("Couldn't read which jobs use an older key:", failure);
    });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever a key may have changed.
  useEffect(readOlderKeys, [readOlderKeys, providers, embedding?.provider, rerank]);

  // "Check the key" on a refused Answer: that provider's page, its key field focused.
  useEffect(() => {
    if (!refused || !providers) return;
    const saved = providers.find(
      (each) =>
        catalogIdOf(each) === refused.catalogId &&
        (each.endpoint ?? null) === (refused.endpoint ?? each.endpoint ?? null),
    );
    setView(
      saved
        ? { page: "provider", providerId: saved.id }
        : { page: "add", catalogId: refused.catalogId, endpoint: refused.endpoint },
    );
  }, [refused, providers]);

  useSettingsTarget<HTMLDivElement>(DIRECTORY_TARGET, laidOut, () => {
    setView({ page: "list" });
    setAdding(true);
  });
  // A plan's sign-in asked for elsewhere: its page, whose card then takes the target as its own.
  const at = useAppStore((state) => state.settingsAt);
  useEffect(() => {
    if (laidOut && (at === "claude-account" || at === "copilot")) {
      setView({ page: "entry", entry: { kind: "plan", plan: at } });
    }
  }, [at, laidOut]);

  // Each page starts at its top; back on the list, the focus is where it was.
  useLayoutEffect(() => {
    section.current?.closest("[data-testid^='settings-page-']")?.scrollTo({ top: 0 });
    if (view.page === "list" && opener.current) {
      section.current
        ?.querySelector<HTMLElement>(`[data-opens="${CSS.escape(opener.current)}"]`)
        ?.focus();
    }
  }, [view.page]);

  const offered = usePlansOffered();
  const entryName = useEntryName();

  if (!providers || !hosts || !laidOut) return null;

  const open = (next: View, from: string) => {
    opener.current = from;
    setRemoved(null);
    setView(next);
  };
  const back = () => {
    useKeyRefusals.getState().done();
    setView({ page: "list" });
  };
  const groupOf = (providerId: string): ChatModelGroup | undefined =>
    groups?.find((each) => each.provider.id === providerId);

  const pageFor = (catalogId: string, endpoint: string | null): View => {
    const saved = savedProviderFor(providers, catalogId, endpoint, language);
    return saved
      ? { page: "provider", providerId: saved.id }
      : { page: "add", catalogId, endpoint: regionFor(catalogId, endpoint, language) };
  };

  const added = (provider: ChatProvider, keyNotChecked = false) => {
    useKeyRefusals.getState().saved(provider);
    clearModelFailure(provider.id);
    refresh();
    setView({ page: "provider", providerId: provider.id, keyNotChecked });
  };

  const isAdded = (entry: ServiceEntry): boolean => {
    switch (entry.kind) {
      case "provider":
        return savedProviderFor(providers, entry.provider.id, null, language) !== undefined;
      case "plan":
        return providers.some((each) => each.kind === entry.plan);
      case "transcription":
        return services.state === "ready"
          ? services.data.some((each) => each.route === entry.route && each.hasKey)
          : false;
      case "decision":
        return hosts.some((each) => each.host === entry.host && each.ready);
      case "jev":
        return jev?.enabled === true && jev.hasApiKey;
      case "rerank":
        return rerank?.kind === entry.service && rerank.hasApiKey;
    }
  };

  // The entry's page opens once the sheet has closed: until then the sheet keeps everything else
  // out of reach, the page's first control too, which the page focuses.
  const openEntry = (entry: ServiceEntry) => {
    chosen.current = entry;
    setAdding(false);
  };
  const sheetClosed = () => {
    setAdding(false);
    const entry = chosen.current;
    chosen.current = null;
    if (!entry) return;
    opener.current = "add-provider";
    setRemoved(null);
    setView(
      entry.kind === "provider" ? pageFor(entry.provider.id, null) : { page: "entry", entry },
    );
  };

  let body: ReactNode = null;
  if (view.page === "add") {
    body = (
      <AddProvider
        key={`${view.catalogId}:${view.endpoint ?? ""}`}
        catalogId={view.catalogId}
        endpoint={view.endpoint}
        providers={providers}
        refused={refused?.catalogId === view.catalogId ? refused : null}
        onBack={back}
        onAdded={added}
      />
    );
  } else if (view.page === "provider") {
    const provider = providers.find((each) => each.id === view.providerId);
    body = provider ? (
      <ProviderPage
        key={provider.id}
        provider={provider}
        keyNotChecked={view.keyNotChecked === true}
        group={groupOf(provider.id)}
        refused={refused && refused.catalogId === catalogIdOf(provider) ? refused : null}
        onBack={back}
        onRegion={(endpoint) => setView(pageFor(catalogIdOf(provider), endpoint))}
        onRemoved={(what) => {
          refresh();
          setRemoved(what);
          back();
        }}
      />
    ) : null;
  } else if (view.page === "entry") {
    body = (
      <EntryPage
        entry={view.entry}
        name={entryName(view.entry)}
        sorting={sorting}
        services={services.state === "ready" ? services.data : []}
        hosts={hosts}
        rerank={rerank}
        onRerank={setRerank}
        onBack={back}
      />
    );
  }

  return (
    <div ref={section} data-testid="models-settings" className="flex flex-col gap-6">
      {/* An empty line takes no room: the gap after it would push the first section down. */}
      <UndoLineAt place={MODELS_UNDO_PLACE} className="-mb-6 has-[*]:mb-0" />
      {body ?? (
        <>
          <p data-testid="ai-lede" className="px-4 text-[13px] leading-5 text-ink-meta">
            {t("ai.lede")}
          </p>
          <ReadinessNote />
          {removed && <RemovedLine removed={removed} providers={providers} />}
          <JobsSection
            groups={groups ?? []}
            providers={providers}
            services={services}
            sorting={sorting}
            rerank={rerank}
            onRerank={setRerank}
          />
          <AccountsSection
            providers={providers}
            groups={groups ?? []}
            hosts={hosts}
            services={services.state === "ready" ? services.data : []}
            jev={jev}
            rerank={rerank}
            sorting={
              sorting.current && !sorting.current.unresolved ? sorting.current.classifier : null
            }
            onHosts={setHosts}
            onJev={setJev}
            onRerank={setRerank}
            olderKeys={olderKeys}
            onUseAccountKey={(job) => {
              core.switchToAccountKey(job).then(readOlderKeys, (failure: unknown) => {
                useAppStore.getState().reportError(failure);
              });
            }}
            onOpen={(provider) =>
              open({ page: "provider", providerId: provider.id }, `provider:${provider.id}`)
            }
            onAdd={() => {
              opener.current = "add-provider";
              setAdding(true);
            }}
          />
          <LimitsSection />
        </>
      )}
      <AddSheet
        open={adding}
        offered={offered}
        added={isAdded}
        onOpen={openEntry}
        onClose={sheetClosed}
      />
    </div>
  );
}

/** The plans this copy can sign in to. */
function usePlansOffered(): (plan: PlanId) => boolean {
  const claude = useClaudeAccount();
  const copilot = useOfferedWay();
  return (plan) =>
    plan === "chatgpt" ||
    (plan === "claude-account" && claude?.available === true) ||
    (plan === "copilot" && copilot !== null);
}

/**
 * The page an entry of "Add an account or key" opens when it isn't a chat provider's: a plan's
 * sign-in, or a key kept for one job with what it sends above its Use this, which keeps the key and
 * chooses it for that job (the consent, ADR-0022).
 */
function EntryPage({
  entry,
  name,
  sorting,
  services,
  hosts,
  rerank,
  onRerank,
  onBack,
}: {
  entry: Exclude<ServiceEntry, { kind: "provider" }>;
  name: string;
  sorting: ReturnType<typeof useSorting>;
  services: readonly TranscriptionServiceStatus[];
  hosts: readonly DecisionHostStatus[];
  rerank: RerankSettings | null;
  onRerank(rerank: RerankSettings): void;
  onBack(): void;
}) {
  const t = useT();
  const logo =
    entry.kind === "plan"
      ? entry.plan === "chatgpt"
        ? "openai"
        : entry.plan === "claude-account"
          ? "anthropic"
          : "copilot"
      : entry.kind === "decision"
        ? entry.host
        : entry.kind === "rerank"
          ? entry.service
          : null;
  let content: ReactNode = null;
  if (entry.kind === "plan") {
    content = (
      <SettingsGroup role="list">
        {entry.plan === "chatgpt" ? (
          <ChatGptPlanRow />
        ) : entry.plan === "claude-account" ? (
          <ClaudePlanRow />
        ) : (
          <CopilotPlanRow />
        )}
      </SettingsGroup>
    );
  } else if (entry.kind === "transcription") {
    const service = services.find((each) => each.route === entry.route);
    content = service ? <TranscriptionSetUp service={service} onDone={onBack} /> : null;
  } else if (entry.kind === "decision") {
    const host = hosts.find((each) => each.host === entry.host);
    content = host ? (
      <DecisionSortingSetUp
        host={host}
        choose={async () => {
          const chosen = await sorting.choose({ classifier: firstModelOf(host) });
          sorting.reread();
          return chosen;
        }}
        onChosen={onBack}
        onCancel={onBack}
      />
    ) : null;
  } else if (entry.kind === "jev") {
    content = sorting.jevSettings ? (
      <JevSortingSetUp
        jev={sorting.jevSettings}
        choose={async () => {
          const chosen = await sorting.choose({ classifier: { kind: "jev" } });
          sorting.reread();
          return chosen;
        }}
        onChosen={onBack}
        onCancel={onBack}
      />
    ) : null;
  } else if (entry.kind === "rerank") {
    content = rerank ? (
      <RerankKeyForm
        kind={entry.service}
        current={rerank}
        onSaved={(saved) => {
          onRerank(saved);
          onBack();
        }}
        onCancel={onBack}
      />
    ) : null;
  }
  return (
    <section data-testid="ai-entry-page" data-entry={entry.kind} className="flex flex-col gap-6">
      <SettingsBackLink label={t("settings.pages.ai")} testId="models-back" onBack={onBack} />
      <header className="flex items-center gap-3">
        <ProviderLogo
          id={logo}
          large
          fallback={entry.kind === "transcription" ? <MicLineIcon className="size-6" /> : undefined}
        />
        <h4
          data-testid="provider-page-title"
          className="min-w-0 truncate text-[17px] leading-6 font-semibold text-ink"
          title={name}
        >
          {entry.kind === "transcription" ? t(ROUTE_LABELS[entry.route]) : name}
        </h4>
      </header>
      <LocalModeUnavailable />
      {entry.kind === "plan" && <ReadinessNote />}
      {content}
    </section>
  );
}

/** Why Questions can't be asked yet, where that isn't only that nothing is set up. */
function ReadinessNote() {
  const readiness = useAppStore((state) => state.chatReadiness);
  if (!readiness || readiness.ready || readiness.reason === "no-provider") return null;
  return (
    <p role="note" className={noticeClass}>
      <ReadinessExplanation readiness={readiness} />
    </p>
  );
}

function RemovedLine({
  removed,
  providers,
}: {
  removed: RemovedProvider;
  providers: readonly ChatProvider[];
}) {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  const { provider, answers, automatic } = removed;
  const movedTo = answers && providers.find((each) => each.id === answers.providerId);
  const text =
    answers && movedTo
      ? t("models.removed.answers", {
          provider,
          model: `${nameOf(answers.modelId, answers.providerId).name} · ${providerName(movedTo, t, language)}`,
        })
      : answers === null && providers.length > 0
        ? t("models.removed.noAnswers", { provider })
        : automatic
          ? t("models.removed.automatic", { provider })
          : t("models.removed", { provider });
  return (
    <p data-testid="models-removed" role="status" className={noticeClass}>
      {text}
    </p>
  );
}
