import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatModelGroup, ChatProvider } from "../../../../core/api";
import { catalogProvider, endpointOf } from "../../../../core/providers/catalog/providers";
import { changedFromDefaults } from "../../../../shared/libraryModels";
import { useAnswers } from "../../answers";
import { core } from "../../core";
import { joinMeta } from "../../cost";
import { useLanguage, useT } from "../../i18n";
import { useKeyRefusals } from "../../keyRefusals";
import { clearModelFailure } from "../../modelHealth";
import { useModelNames } from "../../modelNames";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { ChevronRightLineIcon, PlusLineIcon } from "../lineIcons";
import { TaggingSettings } from "../TaggingSettings";
import { UndoLineAt } from "../UndoLine";
import {
  buttonClass,
  noticeClass,
  pageIntroClass,
  rowTextClass,
  ruledListClass,
  sectionTitleClass,
} from "../ui";
import { AddProvider } from "./AddProvider";
import { ReadinessExplanation } from "./ChatReadinessNotice";
import { ModelDefaults } from "./ModelDefaults";
import { PlansSettings } from "./PlansSettings";
import { ProviderDirectory } from "./ProviderDirectory";
import { logoIdOf, ProviderLogo } from "./ProviderLogo";
import { ProviderPage, providerName, type RemovedProvider } from "./ProviderPage";
import { catalogIdOf, MODELS_UNDO_PLACE, regionFor, savedProviderFor } from "./shared";

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

  const answers = useSettingsTarget<HTMLDivElement>(ANSWERS_TARGET, providers !== null, () => {
    setView({ page: "list" });
    answers.current?.querySelector<HTMLSelectElement>("select")?.focus();
  });
  useSettingsTarget<HTMLDivElement>(DIRECTORY_TARGET, providers !== null, () =>
    setView({ page: "directory" }),
  );
  const changed = useAppStore(
    (state) =>
      !!state.library &&
      changedFromDefaults(state.library.settings, state.library.automaticDefault),
  );
  const toTagging = useAppStore((state) => state.settingsAt === "tagging");
  const [advanced, setAdvanced] = useState(false);
  // Once open, it never folds under the cursor; the next opening starts folded.
  useLayoutEffect(() => {
    if (changed || toTagging) setAdvanced(true);
  }, [changed, toTagging]);

  // Each page starts at its top; back on the list, the focus is where it was.
  useLayoutEffect(() => {
    section.current?.closest("[data-testid^='settings-page-']")?.scrollTo({ top: 0 });
    if (view.page === "list" && opener.current) {
      section.current
        ?.querySelector<HTMLElement>(`[data-opens="${CSS.escape(opener.current)}"]`)
        ?.focus();
    }
  }, [view.page]);

  if (!providers) return null;

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
    <div ref={section} data-testid="models-settings" className="flex flex-col gap-7">
      <UndoLineAt place={MODELS_UNDO_PLACE} />
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
              className="cursor-default text-[13px] leading-5 font-semibold text-ink-secondary select-none hover:text-ink"
            >
              {t("models.advanced")}
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
  onOpen,
  onAdd,
}: {
  providers: readonly ChatProvider[];
  groups: readonly ChatModelGroup[];
  onOpen(provider: ChatProvider): void;
  onAdd(): void;
}) {
  const t = useT();
  return (
    <section data-testid="your-providers" className="flex flex-col gap-2">
      <h4 className={sectionTitleClass}>{t("models.providers.title")}</h4>
      {providers.length === 0 ? (
        <p className={pageIntroClass}>{t("models.providers.none")}</p>
      ) : (
        <ul className={ruledListClass}>
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              group={groups.find((each) => each.provider.id === provider.id)}
              onOpen={() => onOpen(provider)}
            />
          ))}
        </ul>
      )}
      <button
        type="button"
        data-testid="models-add-provider"
        data-opens="add-provider"
        onClick={onAdd}
        className={`${buttonClass} gap-1.5 self-start`}
      >
        <PlusLineIcon className="size-3.5" />
        {t("models.providers.add")}
      </button>
    </section>
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
    <li>
      <button
        type="button"
        data-testid="provider-row"
        data-provider-id={provider.id}
        data-opens={`provider:${provider.id}`}
        onClick={onOpen}
        className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-hover"
      >
        <ProviderLogo id={logoIdOf(provider)} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui font-semibold text-ink" title={name}>
            {name}
            {region && <span className="font-normal text-ink-meta"> · {region}</span>}
          </span>
          <span
            data-testid="provider-row-status"
            className="truncate text-[13px] leading-5 text-ink-meta"
          >
            {joinMeta([state, models])}
          </span>
        </span>
        <ChevronRightLineIcon aria-hidden="true" className="size-4 shrink-0 text-ink-meta" />
      </button>
    </li>
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
    <p data-testid="models-removed" role="status" className={rowTextClass}>
      {text}
    </p>
  );
}
