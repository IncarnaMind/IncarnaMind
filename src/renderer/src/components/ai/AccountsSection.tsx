import { useEffect, useMemo, useState } from "react";
import type {
  ChatModelGroup,
  ChatProvider,
  DecisionHostStatus,
  JevSettings,
  RerankSettings,
  TranscriptionServiceStatus,
} from "../../../../core/api";
import { catalogModel, modelsProviderOfKind } from "../../../../core/providers/catalog";
import {
  catalogProvider,
  endpointOf,
  kindOfCatalogId,
} from "../../../../core/providers/catalog/providers";
import type { MessageKey } from "../../../../shared/i18n";
import { listOf } from "../../../../shared/i18n/join";
import { useClaudeAccount } from "../../claudeSignIn";
import { useCopilotStatus } from "../../copilotSignIn";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useGap, useLanguage, useT } from "../../i18n";
import { useModelHealth } from "../../modelHealth";
import { useModelNames } from "../../modelNames";
import type { SettingsTarget } from "../../settingsPages";
import { useAppStore } from "../../store";
import { ROUTE_LABELS, useTranscriptionServices } from "../../transcriptionServices";
import { ChevronRightLineIcon, MicLineIcon, PlusLineIcon } from "../lineIcons";
import { TranscriptionKeyForm } from "../meetings/TranscriptionKeyForm";
import { ProblemLine } from "../ProblemLine";
import { useChatGptPlan } from "../providers/ChatGptSignIn";
import { DecisionKeyForm, hostName } from "../providers/DecisionKeyForm";
import { JevForm } from "../providers/JevSettings";
import { KeyRow } from "../providers/KeyRow";
import { KeyNotCheckedLine } from "../providers/ProviderForm";
import { logoIdOf, ProviderLogo } from "../providers/ProviderLogo";
import { providerName } from "../providers/ProviderPage";
import { RerankKeyForm } from "../providers/RerankSettings";
import { keptForSorting } from "../providers/sortingOptions";
import {
  SettingsGroup,
  SettingsHelp,
  SettingsRow,
  SettingsRowAction,
  SettingsSection,
} from "../settings/SettingsGroup";
import { buttonStyle, rowFieldClass } from "../ui";
import { AccountState, type RowState } from "./AccountState";
import { type AccountJob, type AccountRowKey, accountUses } from "./accountUses";
import { isPlan } from "./payers";
import { useModelRoles } from "./RoleSelect";
import { jobsOf, type ServiceJob } from "./serviceDirectory";

const JOB_WORDS: Record<AccountJob, MessageKey> = {
  answers: "ai.uses.answers",
  quick: "ai.uses.quick",
  images: "ai.uses.images",
  organize: "ai.uses.organize",
  hints: "ai.uses.hints",
  transcription: "ai.uses.transcription",
  search: "ai.uses.search",
  rerank: "ai.uses.rerank",
};

const ABILITY_WORDS: Record<ServiceJob, MessageKey | null> = {
  answers: "ai.can.answer",
  transcription: "ai.can.transcribe",
  search: "ai.can.search",
  organize: "ai.can.organize",
  hints: null,
};

/** How a row says what it is used for today, or that nothing uses it yet. */
function useUsesLine() {
  const t = useT();
  const language = useLanguage();
  const list = (items: readonly string[]) => listOf(items, language);
  return (
    where: "plan" | "key" | "local",
    jobs: readonly AccountJob[],
    can: readonly ServiceJob[] = [],
  ): string => {
    if (jobs.length > 0) {
      const used = t("ai.uses.usedFor", { jobs: list(jobs.map((job) => t(JOB_WORDS[job]))) });
      return where === "plan"
        ? used
        : `${t(where === "key" ? "ai.uses.key" : "ai.uses.local")} · ${used}`;
    }
    const abilities = can.flatMap((job) => {
      const words = ABILITY_WORDS[job];
      return words ? [t(words)] : [];
    });
    const notUsed = t("ai.uses.notYet");
    const prefix = where === "plan" ? null : t(where === "key" ? "ai.uses.key" : "ai.uses.local");
    return [
      prefix,
      notUsed,
      where === "key" && abilities.length > 0
        ? t("ai.uses.can", { abilities: list(abilities) })
        : null,
    ]
      .filter((part) => part !== null)
      .join(" · ");
  };
}

/** A cloud account's state while "Keep everything on this computer" is on: nothing goes to it. */
function usePaused(): RowState | null {
  const t = useT();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  return localOnly ? { label: t("ai.state.paused"), tone: "quiet" } : null;
}

/** Whether each Ollama server on the list answers now: asked once per page, for its row's state. */
function useOllamaRunning(providers: readonly ChatProvider[]): Record<string, boolean> {
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const servers = providers
    .filter((each) => each.kind === "ollama")
    .map((each) => `${each.id}\n${each.baseUrl ?? ""}`)
    .join("\t");
  useEffect(() => {
    let stopped = false;
    for (const entry of servers.split("\t").filter(Boolean)) {
      const [id = "", baseUrl = ""] = entry.split("\n");
      core.detectOllama(baseUrl ? { baseUrl } : undefined).then(
        (status) => {
          if (!stopped) setRunning((all) => ({ ...all, [id]: status.running }));
        },
        () => {
          if (!stopped) setRunning((all) => ({ ...all, [id]: false }));
        },
      );
    }
    return () => {
      stopped = true;
    };
  }, [servers]);
  return running;
}

/**
 * Settings › AI › Accounts and keys: one row per company or plan, whatever it is for, each saying
 * what it does today and whether it works, then the models built into IncarnaMind, and "Add an
 * account or key…".
 */
export function AccountsSection({
  providers,
  groups,
  hosts,
  services,
  jev,
  rerank,
  sorting,
  onHosts,
  onJev,
  onRerank,
  onOpen,
  onAdd,
}: {
  providers: readonly ChatProvider[];
  groups: readonly ChatModelGroup[];
  hosts: readonly DecisionHostStatus[];
  services: readonly TranscriptionServiceStatus[];
  jev: JevSettings | null;
  rerank: RerankSettings | null;
  sorting: Parameters<typeof accountUses>[0]["sorting"];
  onHosts(hosts: DecisionHostStatus[]): void;
  onJev(jev: JevSettings): void;
  onRerank(rerank: RerankSettings): void;
  onOpen(provider: ChatProvider): void;
  onAdd(): void;
}) {
  const t = useT();
  const chatModel = useAppStore((state) => state.settings?.user.chatModel ?? null);
  const transcriptionRoute = useAppStore(
    (state) => state.settings?.device.transcriptionRoute ?? null,
  );
  const embedding = useAppStore((state) => state.embedding);
  const roles = useModelRoles(groups);
  const uses = useMemo(
    () =>
      accountUses({
        providers,
        chatModel,
        roles,
        sorting,
        transcriptionRoute,
        services,
        embedding: embedding?.provider ?? null,
        rerank,
      }),
    [providers, chatModel, roles, sorting, transcriptionRoute, services, embedding, rerank],
  );
  const usesOf = (row: AccountRowKey) => uses.get(row) ?? [];
  const line = useUsesLine();
  const paused = usePaused();
  const ollamaRunning = useOllamaRunning(providers);
  const plans = providers.filter(isPlan);
  const keys = providers.filter((each) => !isPlan(each) && each.service !== null);
  const local = providers.filter((each) => !isPlan(each) && each.service === null);
  const ownTranscription = services.filter((each) => each.key === "own" && each.hasKey);
  const ownSorting = hosts.filter(keptForSorting);
  const searchKey =
    embedding &&
    (embedding.provider.kind === "openai" || embedding.provider.kind === "google") &&
    usesOf(`search:${embedding.provider.kind}`).length > 0
      ? embedding.provider.kind
      : null;
  const rerankKey =
    rerank?.kind && rerank.kind !== "built-in" && usesOf(`rerank:${rerank.kind}`).length > 0
      ? rerank.kind
      : null;
  const providerRow = (provider: ChatProvider) => (
    <ProviderRow
      key={provider.id}
      provider={provider}
      providers={providers}
      groups={groups}
      jobs={usesOf(`provider:${provider.id}`)}
      line={line}
      running={ollamaRunning[provider.id]}
      onOpen={() => onOpen(provider)}
    />
  );
  return (
    <SettingsSection title={t("ai.accounts.title")} testId="your-providers">
      <SettingsGroup role="list">
        {plans.map(providerRow)}
        {keys.map(providerRow)}
        {ownTranscription.map((service) => (
          <TranscriptionKeyRow
            key={service.route}
            service={service}
            status={withServer(
              line("key", usesOf(`transcription:${service.route}`), ["transcription"]),
              service.server ? t("ai.uses.sentTo", { server: service.server }) : null,
            )}
          />
        ))}
        {ownSorting.map((host) => (
          <SortingKeyRow
            key={host.host}
            host={host}
            status={line(
              "key",
              // A workspace beside a company's key: what it does is the host's, chosen or not.
              host.key === "provider"
                ? sorting?.kind === "decision" && sorting.host === host.host
                  ? ["organize", "hints"]
                  : []
                : usesOf(`sorting:${host.host}`),
              ["organize"],
            )}
            onHosts={onHosts}
          />
        ))}
        {jev?.enabled && jev.hasApiKey && (
          <KeyRow
            testId="sorting-key"
            id="jev"
            name={t("jev.settings.title")}
            logo={null}
            status={line(jev.service === null ? "local" : "key", usesOf("jev"), ["organize"])}
            state={
              (jev.service !== null && paused) || { label: t("ai.state.keyWorks"), tone: "good" }
            }
            change={t("models.providers.changeKey")}
            remove={t("models.providers.removeKey")}
            onRemove={async () => onJev(await core.removeJevSettings())}
            form={(done) => (
              <JevForm
                current={jev}
                onSaved={(saved) => {
                  onJev(saved);
                  done();
                }}
                onCancel={done}
              />
            )}
          />
        )}
        {rerank && rerankKey && (
          <KeyRow
            testId="rerank-key"
            id={rerankKey}
            name={t(`rerank.kind.${rerankKey}`)}
            logo={rerankKey}
            status={line("key", usesOf(`rerank:${rerankKey}`), ["search"])}
            state={paused ?? { label: t("ai.state.keyWorks"), tone: "good" }}
            change={t("models.providers.changeKey")}
            remove={t("models.providers.removeKey")}
            onRemove={async () => onRerank(await core.removeRerankSettings())}
            form={(done) => (
              <RerankKeyForm
                kind={rerankKey}
                current={rerank}
                onSaved={(saved) => {
                  onRerank(saved);
                  done();
                }}
                onCancel={done}
              />
            )}
          />
        )}
        {searchKey && embedding && (
          <SearchKeyRow
            kind={searchKey}
            status={line("key", usesOf(`search:${searchKey}`), ["search"])}
            modelId={embedding.provider.modelId}
            refused={embedding.error?.kind === "auth"}
          />
        )}
        {local.map(providerRow)}
        <BuiltInRow line={line("local", usesOf("built-in"))} />
      </SettingsGroup>
      <div className="mt-3">
        <button
          type="button"
          data-testid="models-add-provider"
          data-opens="add-provider"
          onClick={onAdd}
          className={buttonStyle("secondary", "sm")}
        >
          <PlusLineIcon className="size-3.5" />
          {t("ai.accounts.add")}
        </button>
      </div>
      <SettingsHelp>{t("ai.accounts.foot")}</SettingsHelp>
    </SettingsSection>
  );

  function withServer(text: string, server: string | null) {
    return server ? `${text} · ${server}` : text;
  }
}

/** A saved provider or plan: what it does today, whether it works, and its page. */
function ProviderRow({
  provider,
  providers,
  groups,
  jobs,
  line,
  running,
  onOpen,
}: {
  provider: ChatProvider;
  providers: readonly ChatProvider[];
  groups: readonly ChatModelGroup[];
  jobs: readonly AccountJob[];
  line: ReturnType<typeof useUsesLine>;
  running: boolean | undefined;
  onOpen(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const spaced = useGap();
  const nameOf = useModelNames();
  const name = providerName(provider, t, language);
  const catalog = catalogProvider(provider.catalogId);
  const region =
    catalog && catalog.endpoints.length > 1
      ? endpointOf(catalog, provider.endpoint)?.label[language === "zh-CN" ? "zh" : "en"]
      : undefined;
  const state = useProviderState(provider, running);
  const plan = isPlan(provider);
  const where = plan ? "plan" : provider.service === null ? "local" : "key";
  const can = catalog ? jobsOf({ kind: "provider", provider: catalog }) : ["answers" as const];
  const chatModel = useAppStore((state) => state.settings?.user.chatModel ?? null);
  // A plan and a key that both serve the Answers model: the row not used says which one is.
  const via =
    !jobs.includes("answers") && chatModel && chatModel.providerId !== provider.id
      ? providers.find((each) => each.id === chatModel.providerId)
      : undefined;
  // Its menu, or the catalog for a company whose list isn't read yet.
  const sameModel =
    via &&
    chatModel &&
    (groups.find((each) => each.provider.id === provider.id)?.models.includes(chatModel.modelId) ||
      (catalog &&
        catalogModel(
          modelsProviderOfKind(kindOfCatalogId(catalog.id), provider.endpoint, catalog.id),
          chatModel.modelId,
        ) !== undefined));
  const around = (text: string) =>
    language === "zh-CN" ? `${spaced("汉", text)}${text}${spaced(text, "汉")}` : text;
  const which =
    sameModel && via && chatModel
      ? t(isPlan(via) ? "ai.accounts.sameModel.plan" : "ai.accounts.sameModel.key", {
          model: around(nameOf(chatModel.modelId, chatModel.providerId).name),
          via: around(providerName(via, t, language)),
        })
      : null;
  const detail = [line(where, jobs, can), which].filter((part) => part !== null).join(" · ");
  return (
    <SettingsRowAction
      listItem
      testId="provider-row"
      data-provider-id={provider.id}
      data-opens={`provider:${provider.id}`}
      leading={<ProviderLogo id={logoIdOf(provider)} />}
      label={
        <span className="block truncate font-semibold" title={name}>
          {name}
          {region && <span className="font-normal text-ink-meta"> · {region}</span>}
        </span>
      }
      detail={
        <span data-testid="provider-row-status" className="block truncate" title={detail}>
          {detail}
        </span>
      }
      trailing={
        <span className="flex shrink-0 items-center gap-2">
          {state && <AccountState state={state} />}
          <ChevronRightLineIcon className="size-4 shrink-0 text-ink-placeholder" />
        </span>
      }
      onClick={onOpen}
    />
  );
}

/**
 * Whether a saved provider works, as far as IncarnaMind knows without asking it: a plan signed in
 * or out, a key refused or out of credit by the last Answer it wrote, an Ollama server that answers.
 */
function useProviderState(provider: ChatProvider, running: boolean | undefined): RowState | null {
  const t = useT();
  const paused = usePaused();
  const failure = useModelHealth((state) => state.failures[provider.id]);
  const [chatGpt] = useChatGptPlan();
  const claude = useClaudeAccount();
  const copilot = useCopilotStatus();
  const embeddingRefused = useAppStore(
    (state) =>
      state.embedding?.error?.kind === "auth" &&
      (state.embedding.provider.kind === provider.catalogId ||
        state.embedding.provider.kind === provider.kind),
  );
  if (paused && provider.service !== null) return paused;
  if (isPlan(provider)) {
    const account =
      provider.kind === "chatgpt"
        ? chatGpt?.account.state
        : provider.kind === "claude-account"
          ? claude?.account.state
          : copilot?.account.state;
    if (account === undefined) return null;
    return account === "signed-in" && failure?.error.kind !== "not-signed-in"
      ? { label: t("ai.state.signedIn"), tone: "good" }
      : { label: t("ai.state.signedOut"), tone: "problem" };
  }
  if (provider.kind === "ollama") {
    if (running === undefined) return null;
    return running
      ? { label: t("ai.state.running"), tone: "good" }
      : { label: t("ai.state.notRunning"), tone: "problem" };
  }
  if (provider.service === null) {
    return failure?.error.kind === "network"
      ? { label: t("ai.state.notRunning"), tone: "problem" }
      : null;
  }
  if (provider.apiKeyUnreadable) return { label: t("ai.state.unreadable"), tone: "problem" };
  if (!provider.hasApiKey) {
    return catalogProvider(provider.catalogId)?.apiKey === "required"
      ? { label: t("ai.state.noKey"), tone: "problem" }
      : null;
  }
  if (failure?.error.kind === "auth" || embeddingRefused) {
    return { label: t("ai.state.refused"), tone: "problem" };
  }
  if (failure?.error.kind === "out-of-credit") {
    return { label: t("ai.state.noCredit"), tone: "problem" };
  }
  return { label: t("ai.state.keyWorks"), tone: "good" };
}

/** A transcription service's own key: what it is used for, whether the service took it, and its key form. */
function TranscriptionKeyRow({
  service,
  status,
}: {
  service: TranscriptionServiceStatus;
  status: string;
}) {
  const t = useT();
  const [notChecked, setNotChecked] = useState(false);
  const paused = usePaused();
  const name = t(ROUTE_LABELS[service.route]);
  const reachedBy = useMemo<SettingsTarget[]>(
    () => [`transcription-key:${service.route}`],
    [service.route],
  );
  return (
    <KeyRow
      testId="transcription-key"
      id={service.route}
      name={name}
      logo={null}
      fallback={<MicLineIcon className="size-[18px]" />}
      status={status}
      state={
        paused ??
        (service.refused
          ? { label: t("ai.state.refused"), tone: "problem" }
          : { label: t("ai.state.keyWorks"), tone: "good" })
      }
      change={t("models.providers.changeKey")}
      remove={t("models.providers.removeKey")}
      onRemove={() => useTranscriptionServices.getState().removeKey(service.route)}
      note={notChecked ? <KeyNotCheckedLine provider={name} /> : null}
      reachedBy={reachedBy}
      form={(done) => (
        <TranscriptionKeyForm
          service={service}
          onSaved={({ unchecked }) => {
            setNotChecked(unchecked);
            done();
          }}
          onCancel={done}
        />
      )}
    />
  );
}

/**
 * A decision model host's own key, or Alibaba's workspace beside the Qwen key (#1907). Removing
 * one that sorting uses gives sorting back to Automatic, in the core.
 */
function SortingKeyRow({
  host,
  status,
  onHosts,
}: {
  host: DecisionHostStatus;
  status: string;
  onHosts(hosts: DecisionHostStatus[]): void;
}) {
  const t = useT();
  const language = useLanguage();
  const lang = language === "zh-CN" ? "zh" : "en";
  const account = host.account?.value;
  const workspace = host.key === "provider";
  const paused = usePaused();
  return (
    <KeyRow
      testId="sorting-key"
      id={host.host}
      name={
        workspace && host.provider
          ? (catalogProvider(host.provider)?.name[lang] ?? hostName(host, language))
          : hostName(host, language)
      }
      logo={workspace ? host.provider : host.host}
      status={
        account
          ? `${status} · ${t(workspace ? "ai.uses.workspace" : "ai.uses.account", { id: account })}`
          : status
      }
      state={paused ?? { label: t("ai.state.keyWorks"), tone: "good" }}
      change={t(workspace ? "decisions.account.change" : "models.providers.changeKey")}
      remove={t(workspace ? "providers.settings.remove" : "models.providers.removeKey")}
      onRemove={async () => onHosts(await core.removeDecisionKey(host.host))}
      form={(done) => (
        <DecisionKeyForm
          host={host}
          onSaved={(saved) => {
            onHosts(saved);
            done();
          }}
          onCancel={done}
        />
      )}
    />
  );
}

/**
 * A key kept for Document search alone, from before keys were one per company: OpenAI's or
 * Google's with no chat provider of theirs saved. It keeps working; Change key gives it another.
 */
function SearchKeyRow({
  kind,
  status,
  modelId,
  refused,
}: {
  kind: "openai" | "google";
  status: string;
  modelId: string;
  refused: boolean;
}) {
  const t = useT();
  const paused = usePaused();
  return (
    <KeyRow
      testId="search-key"
      id={kind}
      name={t(`embeddingProviders.kind.${kind}`)}
      logo={kind}
      status={status}
      state={
        paused ??
        (refused
          ? { label: t("ai.state.refused"), tone: "problem" }
          : { label: t("ai.state.keyWorks"), tone: "good" })
      }
      change={t("models.providers.changeKey")}
      form={(done) => <SearchKeyForm kind={kind} modelId={modelId} onDone={done} />}
    />
  );
}

function SearchKeyForm({
  kind,
  modelId,
  onDone,
}: {
  kind: "openai" | "google";
  modelId: string;
  onDone(): void;
}) {
  const t = useT();
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    setProblem(null);
    try {
      useAppStore.setState({
        embedding: await core.saveEmbeddingProvider({ kind, modelId, apiKey: key.trim() }),
      });
      onDone();
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };
  return (
    <form
      data-testid="search-key-form"
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (key.trim()) void save();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onDone();
      }}
    >
      <input
        type="password"
        aria-label={t("providers.form.apiKey")}
        value={key}
        onChange={(event) => setKey(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        // biome-ignore lint/a11y/noAutofocus: Change key was pressed to type it.
        autoFocus
        className={`${rowFieldClass} w-64`}
      />
      <button type="submit" disabled={!key.trim()} className={buttonStyle("primary", "sm")}>
        {t("models.providers.changeKey")}
      </button>
      <button type="button" onClick={onDone} className={buttonStyle("ghost", "sm")}>
        {t("providers.settings.cancel")}
      </button>
      {problem && <ProblemLine>{problem}</ProblemLine>}
    </form>
  );
}

/** The models built into IncarnaMind, on this computer: speech, search and ordering results. */
function BuiltInRow({ line }: { line: string }) {
  const t = useT();
  return (
    <SettingsRow
      role="listitem"
      data-testid="built-in-row"
      leading={<ProviderLogo id={null} />}
      label={<span className="block truncate font-semibold">{t("ai.accounts.builtIn")}</span>}
      detail={
        <span data-testid="built-in-row-status" className="block truncate" title={line}>
          {line}
        </span>
      }
    />
  );
}
