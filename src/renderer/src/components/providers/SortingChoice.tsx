import { useEffect, useRef, useState } from "react";
import type { ChatModelChoice, TaggingClassifier, TaggingModels } from "../../../../core/api";
import type { Language } from "../../../../core/language";
import { useAnswers } from "../../answers";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { useModelNames } from "../../modelNames";
import { useAppStore } from "../../store";
import { fieldClass } from "../ui";
import { SendsLine } from "./SendsLine";
import { useJevSettings } from "./useJevSettings";

export const sortingKey = (classifier: TaggingClassifier): string => JSON.stringify(classifier);

/** One way to sort: a decision model a key reaches, one on this computer, or the User's AI model. */
export interface SortingOption {
  classifier: TaggingClassifier;
  label: string;
  /** Where its requests go; null on this computer. */
  provider: string | null;
  decisionModel: boolean;
  /** The User's AI model, as the line that says what sorts names it. */
  modelName?: string;
}

const providerOf = (option: TaggingModels["options"][number], language: Language) =>
  option.provider ? (language === "zh-CN" ? option.provider.zh : option.provider.en) : null;

/**
 * What sorting can use, best first (#1922): a decision model a key reaches (Jev today), then
 * the User's AI model; in Local mode, only what runs here, its decision models first. The rest
 * follow as choices.
 */
export function sortingOptions(
  models: TaggingModels,
  {
    chatModel,
    language,
    localMode,
    jev,
    chatLabel,
    chatName,
  }: {
    chatModel: ChatModelChoice | null;
    language: Language;
    localMode: boolean;
    /** Jev, when it can run, and whether it runs on this computer. */
    jev: { ready: boolean; local: boolean } | null;
    chatLabel: string;
    chatName: string;
  },
): SortingOption[] {
  const jevOption =
    jev?.ready && (!localMode || jev.local)
      ? models.options.find((option) => option.classifier.kind === "jev")
      : undefined;
  const decisions = models.options
    .filter((option) => option.decisionModel && option.group === "local")
    .map(
      (option): SortingOption => ({
        classifier: option.classifier,
        label: option.name,
        provider: null,
        decisionModel: true,
      }),
    );
  const chat =
    chatModel &&
    models.options.find(
      (option) =>
        option.classifier.kind === "chat" &&
        option.classifier.choice.providerId === chatModel.providerId &&
        option.classifier.choice.modelId === chatModel.modelId,
    );
  const chatOption =
    chat && chat.classifier.kind === "chat" && (!localMode || chat.group === "local")
      ? {
          classifier: chat.classifier,
          label: chatLabel,
          provider: providerOf(chat, language),
          decisionModel: false,
          modelName: chatName,
        }
      : null;
  const byKey = jevOption
    ? {
        classifier: jevOption.classifier,
        label: jevOption.name,
        provider: providerOf(jevOption, language),
        decisionModel: true,
      }
    : null;
  return localMode
    ? [...(byKey ? [byKey] : []), ...decisions, ...(chatOption ? [chatOption] : [])]
    : [...(byKey ? [byKey] : []), ...(chatOption ? [chatOption] : []), ...decisions];
}

/** The models sorting may use now; null until Ollama and the providers have answered. */
export function useSortingModels(): TaggingModels | null {
  const chatModel = useAppStore((state) => state.settings?.user.chatModel ?? null);
  const readiness = useAppStore((state) => state.chatReadiness);
  const [models, setModels] = useState<TaggingModels | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: listed again whenever these change.
  useEffect(() => {
    // The line that says what sorts names the User's model: its group is where the name is.
    useAnswers.getState().loadModels();
    let current = true;
    core.getTaggingModels().then(
      (listed) => current && setModels(listed),
      (error: unknown) => console.error("The models that sort couldn't be listed.", error),
    );
    return () => {
      current = false;
    };
  }, [chatModel, readiness]);
  return models;
}

/**
 * The choice of what sorts Documents, and the way to save it: one setting for automatic tagging
 * and Organize, and choosing it is the consent for its flow (ADR-0022).
 */
export function useSorting() {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  const models = useSortingModels();
  const [jev] = useJevSettings();
  const chatModel = useAppStore((state) => state.settings?.user.chatModel ?? null);
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  const library = useAppStore((state) => state.library);
  const saved = library?.settings.classifier ?? null;
  const options = models
    ? sortingOptions(models, {
        chatModel,
        language,
        localMode,
        jev:
          jev && (jev.hasApiKey || jev.service === null)
            ? { ready: jev.enabled, local: jev.service === null }
            : null,
        chatLabel: t("models.sorting.chat"),
        chatName: chatModel ? nameOf(chatModel.modelId, chatModel.providerId).name : "",
      })
    : [];
  if (
    saved &&
    saved.kind !== "automatic" &&
    !options.some((each) => sortingKey(each.classifier) === sortingKey(saved))
  ) {
    options.unshift({
      classifier: saved,
      label:
        saved.kind === "chat"
          ? nameOf(saved.choice.modelId, saved.choice.providerId).name
          : saved.kind === "jev"
            ? "TypeSafe Jev"
            : saved.kind === "auto"
              ? t("tagging.decision.auto")
              : saved.modelId,
      provider: saved.kind === "jev" ? "TypeSafe" : null,
      decisionModel: saved.kind !== "chat",
      ...(saved.kind === "chat" && {
        modelName: nameOf(saved.choice.modelId, saved.choice.providerId).name,
      }),
    });
  }
  const current =
    saved && saved.kind !== "automatic"
      ? (options.find((each) => sortingKey(each.classifier) === sortingKey(saved)) ?? null)
      : (options[0] ?? null);
  const choose = async (option: SortingOption): Promise<boolean> => {
    let settings = useAppStore.getState().library?.settings;
    if (!settings) {
      await useAppStore.getState().refreshLibrary();
      settings = useAppStore.getState().library?.settings;
    }
    if (!settings) return false;
    try {
      await core.saveLibrarySettings({ ...settings, classifier: option.classifier });
      return true;
    } catch (error) {
      useAppStore.getState().reportError(error);
      return false;
    }
  };
  return { options, current, choose, loading: models === null, library };
}

/** The choice of what sorts, editable in place wherever it is shown. */
export function SortingSelect({
  id,
  className = fieldClass,
  labelledBy,
  options,
  current,
  autoFocus = false,
  onChange,
}: {
  id: string;
  className?: string;
  labelledBy?: string;
  options: readonly SortingOption[];
  current: SortingOption | null;
  /** It takes the focus as its step opens. */
  autoFocus?: boolean;
  onChange(option: SortingOption): void;
}) {
  const t = useT();
  const noPlaceholder = t("setup.sorting.noChoice");
  const field = useRef<HTMLSelectElement>(null);
  // It can't take the focus while it waits for the list, so it does once the list comes.
  useEffect(() => {
    if (autoFocus && options.length > 0) field.current?.focus();
  }, [autoFocus, options.length]);
  return (
    <select
      ref={field}
      id={id}
      aria-labelledby={labelledBy}
      data-testid="models-sorting"
      value={current ? sortingKey(current.classifier) : ""}
      disabled={options.length === 0}
      onChange={(event) => {
        const chosen = options.find(
          (option) => sortingKey(option.classifier) === event.target.value,
        );
        if (chosen) onChange(chosen);
      }}
      className={className}
    >
      {!current && <option value="">{noPlaceholder}</option>}
      {options.map((option) => (
        <option key={sortingKey(option.classifier)} value={sortingKey(option.classifier)}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * What the choice sends, in a line (ADR-0022): to its service for a decision model, or the
 * User's model's own line; and what meeting hints need, which the User's AI model can't do.
 */
export function SortingLine({ option }: { option: SortingOption | null }) {
  const t = useT();
  if (!option) {
    return (
      <p data-testid="models-sorting-line" className="text-[12px] leading-5 text-ink-meta">
        {t("setup.sorting.none")}
      </p>
    );
  }
  if (option.decisionModel) {
    return (
      <div data-testid="models-sorting-line" className="flex flex-col gap-1">
        <p className="text-[12px] leading-5 text-ink-meta">
          {t(option.provider ? "setup.sorting.uses" : "setup.sorting.here")}
        </p>
        {option.provider && (
          <p className="text-[12px] leading-5 text-ink-meta">
            {t("setup.sorting.jev.sends", { service: option.provider })}
          </p>
        )}
      </div>
    );
  }
  return (
    <div data-testid="models-sorting-line" className="flex flex-col gap-1">
      <p className="text-[12px] leading-5 text-ink-meta">
        {t(option.provider ? "setup.sorting.chat" : "setup.sorting.chatHere", {
          model: option.modelName ?? "",
        })}
      </p>
      <p className="text-[12px] leading-5 text-ink-meta">{t("setup.sorting.chat.hints")}</p>
      {option.provider && <SendsLine provider={option.provider} testId="setup-sorting-sends" />}
    </div>
  );
}
