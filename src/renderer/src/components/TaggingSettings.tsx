import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import type {
  ChatProvider,
  LibraryClassifier,
  LibrarySettings,
  TaggingClassifier,
  TaggingCost,
  TaggingModelGroup,
  TaggingModelOption,
  TaggingModels,
} from "../../../core/api";
import type { Language } from "../../../core/language";
import { formatTime } from "../../../shared/dates";
import type { MessageKey } from "../../../shared/i18n";
import { supportsLibraryImages } from "../../../shared/libraryModels";
import { core } from "../core";
import { estimateText } from "../cost";
import { useDecisionHosts } from "../decisionHosts";
import { errorMessage } from "../errors";
import { translateNow, useLanguage, useT } from "../i18n";
import { useSettingsTarget } from "../settingsTarget";
import { useAppStore } from "../store";
import { placesText, stoppedPlaces, tagWithAi } from "../taggingStop";
import { useUndo } from "../undo";
import { ProblemMark } from "./ProblemLine";
import { JevSettingsSection } from "./providers/JevSettings";
import { PopUpSelect } from "./settings/PopUpButton";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from "./settings/SettingsGroup";
import { buttonStyle, compactChoiceRadioClass, errorTextClass, rowFieldClass } from "./ui";

/** The groups of models, as the composer's model chip groups them. */
const GROUPS: readonly TaggingModelGroup[] = ["keys", "plan", "local"];

const TARGET = ["tagging"] as const;

const GROUP_NAMES: Record<TaggingModelGroup, MessageKey> = {
  keys: "composer.model.group.keys",
  plan: "tagging.group.plan",
  local: "tagging.group.local",
};

/** A label beside a model's name, in the "Example" chip's look (DESIGN.md). */
const labelClass =
  "inline-flex h-[18px] shrink-0 items-center rounded-sm bg-chip px-1.5 text-[11px] leading-[18px] font-semibold text-ink-secondary";

const sameClassifier = (a: LibraryClassifier, b: LibraryClassifier) =>
  JSON.stringify(a) === JSON.stringify(b);

/** About what 100 Documents cost, in plain words: rough, as tokenizers differ. Null for nothing. */
function costText(
  cost: TaggingCost,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  language: Language,
): string | null {
  switch (cost.kind) {
    case "free":
      return t("tagging.cost.free");
    case "plan":
      return t("tagging.cost.plan");
    case "unknown":
      return t("tagging.cost.unknown");
    case "estimate": {
      const about = estimateText(cost, null, t, language);
      return about && t("tagging.cost.estimate", { cost: about });
    }
  }
}

/** A model's name to show: Ollama's decision models picked per Document say so. */
const nameOf = (
  option: TaggingModelOption,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
) => (option.classifier.kind === "auto" ? t("tagging.decision.auto") : option.name);

export const providerOf = (option: TaggingModelOption, language: Language) =>
  option.provider ? (language === "zh-CN" ? option.provider.zh : option.provider.en) : null;

/**
 * Settings → Models → Advanced → Tagging: the one model choice for automatic
 * tagging and Organize, Automatic by default, which says what it uses now and
 * why; the models to choose instead, grouped as the model chip groups them,
 * each with what 100 Documents cost; "Other model…" for one the list doesn't
 * have; and the switch for organizing new Documents by itself. Every choice
 * is saved as it is made.
 */
export function TaggingSettings() {
  const t = useT();
  const language = useLanguage();
  const library = useAppStore((state) => state.library);
  const settings = library?.settings ?? null;
  const [models, setModels] = useState<TaggingModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);

  const reload = useCallback(() => {
    core
      .getTaggingModels()
      .then(setModels, (failure: unknown) => setError(errorMessage(failure, translateNow)));
  }, []);
  useEffect(() => {
    reload();
    const stops = [
      core.on("library.changed", reload),
      core.on("chatReadiness.changed", reload),
      core.on("jev.changed", reload),
      core.on("decisions.changed", reload),
      core.on("embedding.changed", reload),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [reload]);
  const section = useSettingsTarget<HTMLElement>(TARGET, !!settings && !!models, () =>
    section.current
      ?.querySelector<HTMLInputElement>("input[name='tagging-model']:checked")
      ?.focus({ preventScroll: true }),
  );

  const save = async (next: Partial<LibrarySettings> & { turnOn?: boolean }) => {
    if (!settings) return;
    setError(null);
    try {
      await core.saveLibrarySettings({ ...settings, ...next });
      await useAppStore.getState().refreshLibrary();
    } catch (failure) {
      setError(errorMessage(failure, t));
    }
  };

  if (!settings || !models) return null;
  const current = settings.classifier;
  const listed = models.options.find((option) => sameClassifier(option.classifier, current));
  const custom = current.kind !== "automatic" && !listed;
  const other = otherOpen || custom;
  // What tags now: Automatic's pick, or the model chosen.
  const inUse = current.kind === "automatic" ? models.automatic : (listed ?? null);
  const automaticLine = models.automatic
    ? t(`tagging.using.${models.automatic.reason}`, {
        model: models.automatic.name,
        provider: providerOf(models.automatic, language) ?? "",
      })
    : t("tagging.using.none");
  // Choosing a model, its sends line under the switch, is choosing to tag and sort with it (#2308).
  const choose = (classifier: LibraryClassifier) => {
    setOtherOpen(false);
    void save(
      classifier.kind === "automatic"
        ? { classifier }
        : { classifier, automatic: true, turnOn: true },
    );
  };
  const onPlan = inUse?.group === "plan";
  const { organizeWith } = settings;
  const organizesWith =
    current.kind !== "automatic"
      ? t("tagging.organize.same")
      : organizeWith
        ? t("tagging.organize.with", {
            model:
              models.options.find((option) => sameClassifier(option.classifier, organizeWith))
                ?.name ?? customName(organizeWith, t),
          })
        : t("tagging.organize.ask");
  const organizer =
    current.kind !== "automatic"
      ? inUse
      : organizeWith &&
        models.options.find((option) => sameClassifier(option.classifier, organizeWith));
  const clouds = [inUse, organizer].filter((each) => !!each && each.group !== "local");
  const sendsLine = !inUse
    ? null
    : clouds.length === 0
      ? t("tagging.automatic.local")
      : t("setup.sorting.sendsWhenOn", {
          service: [
            ...new Set(clouds.map((each) => (each && providerOf(each, language)) || "")),
          ].join(", "),
        });
  const localDecision = models.options.find((option) => option.decisionModel);
  const stopped = stoppedPlaces(library);

  return (
    <section
      ref={section}
      data-testid="tagging-settings"
      className="flex scroll-mt-8 flex-col gap-6"
    >
      <div role="radiogroup" aria-label={t("tagging.model")} className="flex flex-col gap-6">
        <SettingsSection title={t("tagging.title")} help={t("tagging.intro")}>
          <SettingsGroup>
            <ChoiceRow
              testId="tagging-automatic"
              checked={current.kind === "automatic" && !otherOpen}
              onChoose={() => choose({ kind: "automatic" })}
              label={t("tagging.automatic")}
              detail={<span data-testid="tagging-automatic-line">{automaticLine}</span>}
            />
          </SettingsGroup>
        </SettingsSection>
        {GROUPS.map((group) => {
          const inGroup = models.options.filter((option) => option.group === group);
          if (inGroup.length === 0) return null;
          return (
            <SettingsSection key={group} title={t(GROUP_NAMES[group])}>
              <SettingsGroup>
                {inGroup.map((option) => (
                  <ModelRow
                    key={JSON.stringify(option.classifier)}
                    option={option}
                    checked={!otherOpen && sameClassifier(option.classifier, current)}
                    onChoose={() => choose(option.classifier)}
                  />
                ))}
              </SettingsGroup>
            </SettingsSection>
          );
        })}
        <SettingsSection
          help={
            <div className="flex flex-col gap-1">
              <p data-testid="tagging-organize">{organizesWith}</p>
              {models.localMode && <p data-testid="tagging-local-mode">{t("tagging.localMode")}</p>}
              {onPlan && <p data-testid="tagging-plan">{t("tagging.plan")}</p>}
              {onPlan && localDecision && (
                <p>
                  {t("tagging.plan.local", { model: nameOf(localDecision, t) })}{" "}
                  <button
                    type="button"
                    data-testid="tagging-use-local"
                    onClick={() => choose(localDecision.classifier)}
                    className="text-accent underline-offset-2 hover:text-accent-strong hover:underline"
                  >
                    {t("tagging.plan.useLocal", { model: nameOf(localDecision, t) })}
                  </button>
                </p>
              )}
              {models.planPausedUntil && (
                <p data-testid="tagging-plan-paused">
                  {t("tagging.plan.paused", {
                    time: formatTime(models.planPausedUntil, language),
                  })}
                </p>
              )}
              {inUse && (
                <p data-testid="tagging-review">
                  {t(inUse.likelihoods ? "tagging.review.marked" : "tagging.review.kept")}
                </p>
              )}
              {stopped.length > 0 && (
                <p data-testid="tagging-stopped">
                  {t("tagging.stoppedIn", { places: placesText(stopped, library, t, language) })}{" "}
                  <button
                    type="button"
                    data-testid="tagging-restart"
                    onClick={() =>
                      void tagWithAi(stopped).then(
                        (change) => useUndo.getState().push(change),
                        (failure: unknown) => setError(errorMessage(failure, t)),
                      )
                    }
                    className="text-accent underline-offset-2 hover:text-accent-strong hover:underline"
                  >
                    {t("folder.tagWithAi")}
                  </button>
                </p>
              )}
            </div>
          }
        >
          <SettingsGroup>
            <ChoiceRow
              testId="tagging-other"
              checked={other}
              onChoose={() => setOtherOpen(true)}
              label={t("tagging.other")}
              detail={custom ? customName(current, t) : t("tagging.other.hint")}
            />
            {other && (
              <OtherModelForm
                current={custom ? current : null}
                onSave={(classifier) => choose(classifier)}
              />
            )}
          </SettingsGroup>
        </SettingsSection>
      </div>
      <SettingsSection
        help={
          error && (
            <p role="alert" className={errorTextClass}>
              <ProblemMark />
              {error}
            </p>
          )
        }
      >
        <SettingsGroup>
          <SettingsSwitchRow
            label={t("tagging.automatic.switch")}
            detail={sendsLine && <span data-testid="tagging-automatic-sends">{sendsLine}</span>}
            checked={settings.automatic}
            onChange={(on) =>
              void save(on ? { automatic: true, turnOn: true } : { automatic: false })
            }
            switchTestId="tagging-automatic-organize"
          />
        </SettingsGroup>
      </SettingsSection>
      <JevSettingsSection />
    </section>
  );
}

/**
 * One choice of the list: its radio before the words, and the whole row the radio's label (the
 * label's own box stretched over it), so a click anywhere on the row chooses it.
 */
function ChoiceRow({
  testId,
  model,
  checked,
  onChoose,
  label,
  detail,
}: {
  testId: string;
  model?: string;
  checked: boolean;
  onChoose(): void;
  label: ReactNode;
  detail: ReactNode;
}) {
  const id = useId();
  const detailId = `${id}-detail`;
  return (
    <SettingsRow
      data-testid={testId}
      data-model={model}
      className="cursor-pointer hover:bg-frame active:bg-hover"
      htmlFor={id}
      label={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 after:absolute after:inset-0 after:cursor-pointer after:content-['']">
          {label}
        </span>
      }
      detail={detail}
      detailId={detailId}
      leading={
        <input
          id={id}
          type="radio"
          name="tagging-model"
          checked={checked}
          onChange={onChoose}
          aria-describedby={detail ? detailId : undefined}
          className={compactChoiceRadioClass}
        />
      }
    />
  );
}

/** One model to choose: its name, provider and labels, and what 100 Documents cost with it. */
function ModelRow({
  option,
  checked,
  onChoose,
}: {
  option: TaggingModelOption;
  checked: boolean;
  onChoose(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const provider = providerOf(option, language);
  const cost = costText(option.cost, t, language);
  const sends =
    provider && option.group !== "local" ? t("setup.sorting.sends", { service: provider }) : null;
  return (
    <ChoiceRow
      testId="tagging-option"
      model={option.name}
      checked={checked}
      onChoose={onChoose}
      label={
        <>
          <span className="min-w-0 truncate" title={option.name}>
            {nameOf(option, t)}
          </span>
          {provider && <span className="text-[13px] leading-5 text-ink-meta">{provider}</span>}
          {option.decisionModel ? (
            <span className={labelClass}>{t("tagging.label.decision")}</span>
          ) : (
            option.goodForTagging && <span className={labelClass}>{t("tagging.label.good")}</span>
          )}
        </>
      }
      detail={
        (cost || sends) && (
          <>
            {cost && <span className="block">{cost}</span>}
            {sends && (
              <span className="block" data-testid="tagging-option-sends">
                {sends}
              </span>
            )}
          </>
        )
      }
    />
  );
}

/** A model chosen by hand that the list doesn't have, in words. */
function customName(
  classifier: TaggingClassifier,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): string {
  switch (classifier.kind) {
    case "chat":
      return classifier.choice.modelId;
    case "ollama":
      return t("tagging.other.decision", { model: classifier.modelId });
    case "auto":
      return t("tagging.other.decision", { model: "Tev1, Clef-Flash" });
    case "jev":
      return "TypeSafe Jev";
    case "decision":
      return classifier.modelId;
  }
}

/** "Other model…": a model on a saved provider, or a local decision model in Ollama, by name. */
function OtherModelForm({
  current,
  onSave,
}: {
  current: TaggingClassifier | null;
  onSave(classifier: TaggingClassifier): void;
}) {
  const t = useT();
  const language = useLanguage();
  const id = useId();
  const listId = `${id}-models`;
  const [providers, setProviders] = useState<ChatProvider[]>([]);
  const [decisionHosts] = useDecisionHosts();
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  // Any model a host serves, by name: one it added since this copy was made included (#1907).
  const hosts = localMode ? [] : (decisionHosts ?? []).filter((host) => host.ready);
  // A saved provider's id, "ollama" for a decision model by name, "auto" for them picked per
  // Document, or "decision:<host>" for a decision model host.
  const [where, setWhere] = useState(
    current?.kind === "chat"
      ? current.choice.providerId
      : current?.kind === "decision"
        ? `decision:${current.host}`
        : current
          ? current.kind
          : "",
  );
  const [modelId, setModelId] = useState(
    current?.kind === "chat"
      ? current.choice.modelId
      : current?.kind === "ollama" || current?.kind === "decision"
        ? current.modelId
        : "",
  );
  const host = hosts.find((each) => `decision:${each.host}` === where);
  const [baseUrl, setBaseUrl] = useState(
    current?.kind === "ollama" || current?.kind === "auto"
      ? current.baseUrl
      : "http://localhost:11434",
  );
  const [usePageImages, setUsePageImages] = useState(
    current?.kind === "ollama" && current.usePageImages === true,
  );
  const [error, setError] = useState<string | null>(null);
  const service = host
    ? (host.service?.name ?? null)
    : (providers.find((provider) => provider.id === where)?.service?.name ?? null);
  useEffect(() => {
    core.listChatProviders().then(
      (list) => {
        setProviders(list);
        setWhere((chosen) => chosen || list[0]?.id || "ollama");
      },
      (failure: unknown) => setError(errorMessage(failure, translateNow)),
    );
  }, []);
  return (
    <form
      data-testid="tagging-other-form"
      className="settings-row"
      onSubmit={(event) => {
        event.preventDefault();
        if (where === "auto") {
          onSave({ kind: "auto", baseUrl });
          return;
        }
        const model = modelId.trim();
        if (!model) return;
        if (host) {
          onSave({ kind: "decision", host: host.host, modelId: model });
          return;
        }
        onSave(
          where === "ollama"
            ? {
                kind: "ollama",
                baseUrl,
                modelId: model,
                usePageImages: supportsLibraryImages(model) && usePageImages,
              }
            : { kind: "chat", choice: { providerId: where, modelId: model } },
        );
      }}
    >
      <SettingsRow
        label={t("library.connection")}
        htmlFor={`${id}-connection`}
        detail={
          service && (
            <span data-testid="tagging-other-sends">{t("setup.sorting.sends", { service })}</span>
          )
        }
        control={
          <PopUpSelect
            id={`${id}-connection`}
            className="max-w-64"
            value={where}
            onChange={(event) => setWhere(event.target.value)}
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.service?.name ?? (provider.kind === "ollama" ? "Ollama" : provider.kind)}
                {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
              </option>
            ))}
            {hosts.map((each) => (
              <option key={each.host} value={`decision:${each.host}`}>
                {each.name[language === "zh-CN" ? "zh" : "en"]}
              </option>
            ))}
            <option value="ollama">{t("library.ollama")}</option>
            <option value="auto">{t("tagging.other.auto")}</option>
          </PopUpSelect>
        }
      />
      {where !== "auto" && (
        <SettingsRow
          label={t("library.model")}
          htmlFor={`${id}-model`}
          control={
            <>
              <input
                id={`${id}-model`}
                className={`${rowFieldClass} w-64`}
                required
                maxLength={200}
                value={modelId}
                spellCheck={false}
                list={host ? listId : undefined}
                data-testid="tagging-other-model"
                onChange={(event) => setModelId(event.target.value)}
              />
              {host && (
                <datalist id={listId}>
                  {host.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.maker ? `${model.name} · ${model.maker}` : model.name}
                    </option>
                  ))}
                </datalist>
              )}
            </>
          }
        />
      )}
      {(where === "ollama" || where === "auto") && (
        <SettingsRow
          label={t("library.server")}
          htmlFor={`${id}-server`}
          control={
            <input
              id={`${id}-server`}
              required
              type="url"
              className={`${rowFieldClass} w-64`}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          }
        />
      )}
      {where === "ollama" && supportsLibraryImages(modelId) && (
        <SettingsSwitchRow
          label={t("library.pageImages")}
          checked={usePageImages}
          onChange={setUsePageImages}
          switchTestId="tagging-other-page-images"
        />
      )}
      <SettingsRow
        control={
          <button
            type="submit"
            className={buttonStyle("secondary", "sm")}
            data-testid="tagging-other-save"
          >
            {t("tagging.other.save")}
          </button>
        }
      >
        {error && (
          <p role="alert" className={errorTextClass}>
            <ProblemMark />
            {error}
          </p>
        )}
      </SettingsRow>
    </form>
  );
}
