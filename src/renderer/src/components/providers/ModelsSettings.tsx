import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ChatModelGroup,
  ChatProvider,
  DecisionHostStatus,
  JevSettings,
} from "../../../../core/api";
import { catalogProvider, endpointOf } from "../../../../core/providers/catalog/providers";
import { changedFromDefaults } from "../../../../shared/libraryModels";
import { useAnswers } from "../../answers";
import { core } from "../../core";
import { joinMeta } from "../../cost";
import { useDecisionHosts } from "../../decisionHosts";
import { useLanguage, useT } from "../../i18n";
import { useKeyRefusals } from "../../keyRefusals";
import { clearModelFailure } from "../../modelHealth";
import { useModelNames } from "../../modelNames";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { PlusLineIcon } from "../lineIcons";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowAction,
  SettingsSection,
} from "../settings/SettingsGroup";
import { TaggingSettings } from "../TaggingSettings";
import { UndoLineAt } from "../UndoLine";
import { buttonStyle, noticeClass } from "../ui";
import { AddProvider } from "./AddProvider";
import { ReadinessExplanation } from "./ChatReadinessNotice";
import { ModelDefaults } from "./ModelDefaults";
import { PlansSettings } from "./PlansSettings";
import { ProviderDirectory } from "./ProviderDirectory";
import { logoIdOf, ProviderLogo } from "./ProviderLogo";
import { ProviderPage, providerName, type RemovedProvider } from "./ProviderPage";
import { SortingKeyRows } from "./SortingKeyRows";
import { catalogIdOf, MODELS_UNDO_PLACE, regionFor, savedProviderFor } from "./shared";
import { keptForSorting } from "./sortingOptions";
import { useJevSettings } from "./useJevSettings";

type View =
  | { page: "list" }
  | { page: "directory" }
  | { page: "provider"; providerId: string; keyNotChecked?: boolean }
  | { page: "add"; catalogId: string; endpoint: string | null };

const ANSWERS_TARGET = ["chat-model"] as const;
const DIRECTORY_TARGET = ["add-provider"] as const;

export function ModelsSettings() {
  const t = useT();
  const language = useLanguage();
  const readiness = useAppStore((state) => state.chatReadiness);
  const groups = useAnswers((state) => state.models);
  const loadModels = useAnswers((state) => state.loadModels);
  const [providers, setProviders] = useState<ChatProvider[] | null>(null);
  const [view, setView] = useState<View>({ page: "list" });
  const [removed, setRemoved] = useState<RemovedProvider | null>(null);
  const section = useRef<HTMLDivElement>(null);
  const opener = useRef<string | null>(null);
  const refused = useKeyRefusals((state) => state.showing);
  // Read with the providers, so the page lays out once: a section landing later would move the
  // one a link scrolled to (Plans, Advanced) out of view.
  const [hosts, setHosts] = useDecisionHosts();
  const laidOut = providers !== null && hosts !== null;

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

  const answers = useSettingsTarget<HTMLDivElement>(ANSWERS_TARGET, laidOut, () => {
    setView({ page: "list" });
    answers.current?.querySelector<HTMLSelectElement>("select")?.focus();
  });
  useSettingsTarget<HTMLDivElement>(DIRECTORY_TARGET, laidOut, () =>
    setView({ page: "directory" }),
  );
  const changed = useAppStore(
    (state) =>
      !!state.library &&
      changedFromDefaults(state.library.settings, state.library.automaticDefault),
  );
  const [jev, setJev] = useJevSettings();
  const jevEnabled = jev?.enabled === true;
  const toTagging = useAppStore((state) => state.settingsAt === "tagging");
  const [advanced, setAdvanced] = useState(false);
  // Once open, it never folds under the cursor; the next opening starts folded.
  useLayoutEffect(() => {
    if (changed || jevEnabled || toTagging) setAdvanced(true);
  }, [changed, jevEnabled, toTagging]);

  // Each page starts at its top; back on the list, the focus is where it was.
  useLayoutEffect(() => {
    section.current?.closest("[data-testid^='settings-page-']")?.scrollTo({ top: 0 });
    if (view.page === "list" && opener.current) {
      section.current
        ?.querySelector<HTMLElement>(`[data-opens="${CSS.escape(opener.current)}"]`)
        ?.focus();
    }
  }, [view.page]);

  if (!providers || !hosts) return null;

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

  let body: React.ReactNode;
  if (view.page === "directory") {
    body = (
      <ProviderDirectory
        providers={providers}
        onBack={back}
        onOpen={(catalogId, endpoint) => setView(pageFor(catalogId, endpoint))}
      />
    );
  } else if (view.page === "add") {
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
  }

  return (
    <div ref={section} data-testid="models-settings" className="flex flex-col gap-6">
      {/* An empty line takes no room: the gap after it would push the first section down. */}
      <UndoLineAt place={MODELS_UNDO_PLACE} className="-mb-6 has-[*]:mb-0" />
      {body ?? (
        <>
          {readiness && !readiness.ready && readiness.reason !== "no-provider" && (
            <p role="note" className={noticeClass}>
              <ReadinessExplanation readiness={readiness} />
            </p>
          )}
          {removed && <RemovedLine removed={removed} providers={providers} />}
          <div ref={answers}>
            <ModelDefaults groups={groups ?? []} providers={providers} />
          </div>
          <YourProviders
            providers={providers}
            groups={groups ?? []}
            hosts={hosts}
            jev={jev}
            onHosts={setHosts}
            onJev={setJev}
            onOpen={(provider) =>
              open({ page: "provider", providerId: provider.id }, `provider:${provider.id}`)
            }
            onAdd={() => open({ page: "directory" }, "add-provider")}
          />
          <PlansSettings />
          <details
            data-testid="models-advanced"
            open={advanced}
            onToggle={(event) => setAdvanced(event.currentTarget.open)}
          >
            <summary
              data-testid="models-advanced-toggle"
              className="cursor-default px-4 text-[13px] leading-5 font-semibold text-ink-secondary select-none hover:text-ink"
            >
              {t("settings.advanced")}
            </summary>
            <div className="mt-3">
              <TaggingSettings />
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function YourProviders({
  providers,
  groups,
  hosts,
  jev,
  onHosts,
  onJev,
  onOpen,
  onAdd,
}: {
  providers: readonly ChatProvider[];
  groups: readonly ChatModelGroup[];
  hosts: readonly DecisionHostStatus[];
  jev: JevSettings | null;
  onHosts(hosts: DecisionHostStatus[]): void;
  onJev(jev: JevSettings): void;
  onOpen(provider: ChatProvider): void;
  onAdd(): void;
}) {
  const t = useT();
  const sortingKeys = hosts.some(keptForSorting) || (jev?.enabled && jev.hasApiKey);
  const none = providers.length === 0 && !sortingKeys;
  return (
    <SettingsSection title={t("models.providers.title")} testId="your-providers">
      <SettingsGroup role={none ? undefined : "list"}>
        {none ? (
          <SettingsRow
            label={<span className="text-ink-secondary">{t("models.providers.none")}</span>}
          />
        ) : (
          <>
            {providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                group={groups.find((each) => each.provider.id === provider.id)}
                onOpen={() => onOpen(provider)}
              />
            ))}
            <SortingKeyRows hosts={hosts} jev={jev} onHosts={onHosts} onJev={onJev} />
          </>
        )}
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
          {t("models.providers.add")}
        </button>
      </div>
    </SettingsSection>
  );
}

function ProviderRow({
  provider,
  group,
  onOpen,
}: {
  provider: ChatProvider;
  group: ChatModelGroup | undefined;
  onOpen(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const name = providerName(provider, t, language);
  const catalog = catalogProvider(provider.catalogId);
  const region =
    catalog && catalog.endpoints.length > 1
      ? endpointOf(catalog, provider.endpoint)?.label[language === "zh-CN" ? "zh" : "en"]
      : undefined;
  const state = provider.hasApiKey
    ? t("models.providers.keySaved")
    : provider.apiKeyUnreadable
      ? t("models.providers.keyUnreadable")
      : catalog?.apiKey === "required"
        ? t("models.providers.noKey")
        : provider.service === null
          ? t("models.providers.onThisComputer")
          : "";
  const count = group?.models.length;
  const models =
    count === undefined
      ? ""
      : count === 1
        ? t("models.providers.inMenu.one")
        : t("models.providers.inMenu.other", { count });
  return (
    <SettingsRowAction
      listItem
      testId="provider-row"
      data-provider-id={provider.id}
      data-opens={`provider:${provider.id}`}
      leading={<ProviderLogo id={logoIdOf(provider)} />}
      label={
        <span className="block truncate" title={name}>
          {name}
          {region && <span className="text-ink-meta"> · {region}</span>}
        </span>
      }
      detail={
        <span data-testid="provider-row-status" className="block truncate">
          {joinMeta([state, models])}
        </span>
      }
      onClick={onOpen}
    />
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
