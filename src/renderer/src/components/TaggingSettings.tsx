import { useCallback, useEffect, useId, useState } from "react";
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
import { errorMessage } from "../errors";
import { translateNow, useLanguage, useT } from "../i18n";
import { useSettingsTarget } from "../settingsTarget";
import { useAppStore } from "../store";
import { placesText, stoppedPlaces, tagWithAi } from "../taggingStop";
import { useUndo } from "../undo";
import { ProblemMark } from "./ProblemLine";
import { JevSettingsSection } from "./providers/JevSettings";
import {
  buttonClass,
  choiceListClass,
  choiceRadioClass,
  choiceRowClass,
  choiceTextClass,
  choiceTitleClass,
  errorTextClass,
  fieldLabelClass,
  inputClass,
  menuTitleClass,
  sectionNoteClass,
  sectionTitleClass,
} from "./ui";

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

/** About what 100 Documents cost, in plain words: rough, as tokenizers differ. */
function costText(
  cost: TaggingCost,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): string {
  switch (cost.kind) {
    case "free":
      return t("tagging.cost.free");
    case "plan":
      return t("tagging.cost.plan");
    case "unknown":
      return t("tagging.cost.unknown");
    case "estimate":
      if (cost.currency === "CNY") {
        return cost.amount < 0.01
          ? t("tagging.cost.underYuan")
          : t("tagging.cost.yuan", { amount: cost.amount.toFixed(2) });
      }
      if (cost.amount < 0.01) return t("tagging.cost.underCent");
      if (cost.amount < 1)
        return t("tagging.cost.cents", { amount: Math.round(cost.amount * 100) });
      return t("tagging.cost.dollars", {
        amount: cost.amount.toFixed(2),
        dollars: `$${cost.amount.toFixed(2)}`,
      });
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
  const switchId = useId();
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

  const save = async (next: Partial<LibrarySettings>) => {
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
    void save(classifier.kind === "automatic" ? { classifier } : { classifier, automatic: true });
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
      : t("tagging.automatic.sends", {
          service: [
            ...new Set(clouds.map((each) => (each && providerOf(each, language)) || "")),
          ].join(", "),
        });
  const localDecision = models.options.find((option) => option.decisionModel);
  const stopped = stoppedPlaces(library);

  return (
    <section ref={section} data-testid="tagging-settings" className="flex scroll-mt-8 flex-col">
      <h4 className={sectionTitleClass}>{t("tagging.title")}</h4>
      <p className={sectionNoteClass}>{t("tagging.intro")}</p>
      <div role="radiogroup" aria-label={t("tagging.model")} className="flex flex-col gap-3">
        <div className={choiceListClass}>
          <label className={choiceRowClass} data-testid="tagging-automatic">
            <input
              type="radio"
              name="tagging-model"
              checked={current.kind === "automatic" && !otherOpen}
              onChange={() => choose({ kind: "automatic" })}
              className={choiceRadioClass}
            />
            <span className="flex min-w-0 flex-col">
              <span className={choiceTitleClass}>{t("tagging.automatic")}</span>
              <span className={choiceTextClass} data-testid="tagging-automatic-line">
                {automaticLine}
              </span>
            </span>
          </label>
        </div>
        {GROUPS.map((group) => {
          const inGroup = models.options.filter((option) => option.group === group);
          if (inGroup.length === 0) return null;
          return (
            <div key={group} className="flex flex-col">
              <p className={`${menuTitleClass} px-0`}>{t(GROUP_NAMES[group])}</p>
              <div className={choiceListClass}>
                {inGroup.map((option) => (
                  <ModelRow
                    key={JSON.stringify(option.classifier)}
                    option={option}
                    checked={!otherOpen && sameClassifier(option.classifier, current)}
                    onChoose={() => choose(option.classifier)}
                  />
                ))}
              </div>
            </div>
          );
        })}
        <div className={choiceListClass}>
          <label className={choiceRowClass} data-testid="tagging-other">
            <input
              type="radio"
              name="tagging-model"
              checked={other}
              onChange={() => setOtherOpen(true)}
              className={choiceRadioClass}
            />
            <span className="flex min-w-0 flex-col">
              <span className={choiceTitleClass}>{t("tagging.other")}</span>
              <span className={choiceTextClass}>
                {custom ? customName(current, t) : t("tagging.other.hint")}
              </span>
            </span>
          </label>
          {other && (
            <OtherModelForm
              current={custom ? current : null}
              onSave={(classifier) => choose(classifier)}
            />
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-1 text-[13px] leading-5 text-ink-secondary">
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
            {t("tagging.plan.paused", { time: formatTime(models.planPausedUntil, language) })}
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
      <div className="mt-3 flex items-start gap-2 text-[13px] leading-5 text-ink-secondary">
        <input
          id={`${switchId}-switch`}
          type="checkbox"
          data-testid="tagging-automatic-organize"
          checked={settings.automatic}
          aria-describedby={sendsLine ? `${switchId}-sends` : undefined}
          onChange={(event) => void save({ automatic: event.target.checked })}
          className="mt-0.5 size-4 accent-ink"
        />
        <span className="flex min-w-0 flex-col">
          <label htmlFor={`${switchId}-switch`}>{t("tagging.automatic.switch")}</label>
          {sendsLine && (
            <span
              id={`${switchId}-sends`}
              data-testid="tagging-automatic-sends"
              className="text-ink-meta"
            >
              {sendsLine}
            </span>
          )}
        </span>
      </div>
      {error && (
        <p role="alert" className={`mt-2 ${errorTextClass}`}>
          <ProblemMark />
          {error}
        </p>
      )}
      <JevSettingsSection embedded />
    </section>
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
  return (
    <label className={choiceRowClass} data-testid="tagging-option" data-model={option.name}>
      <input
        type="radio"
        name="tagging-model"
        checked={checked}
        onChange={onChoose}
        className={choiceRadioClass}
      />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="min-w-0 truncate text-ui text-ink" title={option.name}>
            {nameOf(option, t)}
          </span>
          {provider && <span className="text-[13px] leading-5 text-ink-meta">{provider}</span>}
          {option.decisionModel ? (
            <span className={labelClass}>{t("tagging.label.decision")}</span>
          ) : (
            option.goodForTagging && <span className={labelClass}>{t("tagging.label.good")}</span>
          )}
        </span>
        <span className={choiceTextClass}>{costText(option.cost, t)}</span>
        {provider && option.group !== "local" && (
          <span className={choiceTextClass} data-testid="tagging-option-sends">
            {t("setup.sorting.sends", { service: provider })}
          </span>
        )}
      </span>
    </label>
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
  const [providers, setProviders] = useState<ChatProvider[]>([]);
  // A saved provider's id, "ollama" for a decision model by name, or "auto" for them picked per Document.
  const [where, setWhere] = useState(
    current?.kind === "chat" ? current.choice.providerId : current ? current.kind : "",
  );
  const [modelId, setModelId] = useState(
    current?.kind === "chat"
      ? current.choice.modelId
      : current?.kind === "ollama"
        ? current.modelId
        : "",
  );
  const [baseUrl, setBaseUrl] = useState(
    current?.kind === "ollama" || current?.kind === "auto"
      ? current.baseUrl
      : "http://localhost:11434",
  );
  const [usePageImages, setUsePageImages] = useState(
    current?.kind === "ollama" && current.usePageImages === true,
  );
  const [error, setError] = useState<string | null>(null);
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
      className="flex flex-col gap-3 px-4 pt-1 pb-4 pl-11"
      onSubmit={(event) => {
        event.preventDefault();
        if (where === "auto") {
          onSave({ kind: "auto", baseUrl });
          return;
        }
        const model = modelId.trim();
        if (!model) return;
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
      <label className={fieldLabelClass}>
        {t("library.connection")}
        <select
          aria-label={t("library.connection")}
          className={inputClass}
          value={where}
          onChange={(event) => setWhere(event.target.value)}
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.service?.name ?? (provider.kind === "ollama" ? "Ollama" : provider.kind)}
              {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
            </option>
          ))}
          <option value="ollama">{t("library.ollama")}</option>
          <option value="auto">{t("tagging.other.auto")}</option>
        </select>
      </label>
      {where !== "auto" && (
        <label className={fieldLabelClass}>
          {t("library.model")}
          <input
            className={inputClass}
            required
            maxLength={200}
            value={modelId}
            spellCheck={false}
            onChange={(event) => setModelId(event.target.value)}
          />
        </label>
      )}
      {(where === "ollama" || where === "auto") && (
        <>
          <label className={fieldLabelClass}>
            {t("library.server")}
            <input
              required
              type="url"
              className={inputClass}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          {where === "ollama" && supportsLibraryImages(modelId) && (
            <label className="flex items-start gap-2 text-[13px] text-ink-secondary">
              <input
                type="checkbox"
                checked={usePageImages}
                onChange={(event) => setUsePageImages(event.target.checked)}
                className="mt-0.5 size-4 accent-ink"
              />
              {t("library.pageImages")}
            </label>
          )}
        </>
      )}
      <div>
        <button type="submit" className={buttonClass} data-testid="tagging-other-save">
          {t("tagging.other.save")}
        </button>
      </div>
      {error && (
        <p role="alert" className={errorTextClass}>
          <ProblemMark />
          {error}
        </p>
      )}
    </form>
  );
}
