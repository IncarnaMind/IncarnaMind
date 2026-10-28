import { useEffect, useRef, useState } from "react";
import type {
  ChatModelChoice,
  ChatProvider,
  TaggingClassifier,
  TaggingModels,
} from "../../../../core/api";
import type { Language } from "../../../../core/language";
import { useAnswers } from "../../answers";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { useModelNames } from "../../modelNames";
import { useAppStore } from "../../store";
import { fieldClass } from "../ui";
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
  /** A saved choice whose destination isn't known yet: nothing is said about it, and it can't be used. */
  unresolved?: boolean;
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

/**
 * The models sorting may use now: read until Ollama and the providers answer, and `failed` when
 * they couldn't, so a line says the model it opened with only while the list is still coming.
 */
export function useSortingModels(): {
  models: TaggingModels | null;
  /** The saved providers, read with the list: where a saved choice goes is told by its provider. */
  providers: ChatProvider[] | null;
  failed: boolean;
} {
  const chatModel = useAppStore((state) => state.settings?.user.chatModel ?? null);
  const readiness = useAppStore((state) => state.chatReadiness);
  const [models, setModels] = useState<TaggingModels | null>(null);
  const [providers, setProviders] = useState<ChatProvider[] | null>(null);
  const [failed, setFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: listed again whenever these change.
  useEffect(() => {
    // The line that says what sorts names the User's model: its group is where the name is.
    useAnswers.getState().loadModels();
    let current = true;
    setFailed(false);
    core.listChatProviders().then(
      (saved) => current && setProviders(saved),
      (error: unknown) => console.error("The saved chat providers couldn't be listed.", error),
    );
    core.getTaggingModels().then(
      (listed) => current && setModels(listed),
      (error: unknown) => {
        console.error("The models that sort couldn't be listed.", error);
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [chatModel, readiness]);
  return { models, providers, failed };
}

/**
 * The choice of what sorts Documents, and the way to save it: one setting for automatic tagging
 * and Organize, and choosing it is the consent for its flow (ADR-0022).
 */
export function useSorting() {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  const { models, providers, failed } = useSortingModels();
  const [jev] = useJevSettings();
  const chatModel = useAppStore((state) => state.settings?.user.chatModel ?? null);
  const readiness = useAppStore((state) => state.chatReadiness);
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  const library = useAppStore((state) => state.library);
  const saved = library?.settings.classifier ?? null;
  // The model that works, which sorting will use unless the list says otherwise: its line holds
  // the rows from the step's first paint, so the list landing changes only the words (#2130).
  const known =
    chatModel &&
    readiness?.ready &&
    readiness.provider.id === chatModel.providerId &&
    readiness.modelId === chatModel.modelId
      ? {
          classifier: { kind: "chat" as const, choice: chatModel },
          label: t("models.sorting.chat"),
          provider:
            readiness.provider.service?.name ?? t(`providers.kind.${readiness.provider.kind}`),
          decisionModel: false,
          modelName: nameOf(chatModel.modelId, chatModel.providerId).name,
        }
      : null;
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
    // Where a saved choice goes comes from what is stored: its entry in the list once that is
    // read, else the provider it names among the saved ones (the list holds each provider's tagging
    // and default models, not every model the User set up), else the Jev settings. A list still
    // being read never makes a cloud choice look local. undefined: not known, because the
    // provider isn't saved or the saved ones aren't read yet, or Jev's settings aren't read yet.
    const listed = models?.options.find(
      (each) => sortingKey(each.classifier) === sortingKey(saved),
    );
    const provider =
      saved.kind === "chat"
        ? (providers?.find((each) => each.id === saved.choice.providerId) ??
          (readiness?.ready && readiness.provider.id === saved.choice.providerId
            ? readiness.provider
            : undefined))
        : undefined;
    const goes = listed
      ? providerOf(listed, language)
      : saved.kind === "chat"
        ? provider
          ? (provider.service?.name ?? null)
          : undefined
        : saved.kind === "jev"
          ? jev === null
            ? undefined
            : (jev.service?.name ?? null)
          : null;
    const named =
      saved.kind === "chat" ? nameOf(saved.choice.modelId, saved.choice.providerId).name : "";
    options.unshift({
      classifier: saved,
      label:
        saved.kind === "chat"
          ? named
          : saved.kind === "jev"
            ? "TypeSafe Jev"
            : saved.kind === "auto"
              ? t("tagging.decision.auto")
              : saved.modelId,
      provider: goes ?? null,
      decisionModel: listed?.decisionModel ?? saved.kind !== "chat",
      ...(goes === undefined && { unresolved: true }),
      ...(saved.kind === "chat" && { modelName: named }),
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
  return {
    options,
    current,
    choose,
    known,
    loading: models === null && !failed,
    library,
  };
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
 * `holds`: the option the line had before its list came. Its rows keep the block's height, so a
 * shorter choice swaps its words in place and the buttons under it stay where they were (#2130).
 */
export function SortingLine({
  option,
  holds = null,
}: {
  option: SortingOption | null;
  holds?: SortingOption | null;
}) {
  const t = useT();
  const rows = (each: SortingOption | null) => {
    if (!each) {
      return <p className="text-[12px] leading-5 text-ink-meta">{t("setup.sorting.none")}</p>;
    }
    if (each.decisionModel) {
      return (
        <>
          <p className="text-[12px] leading-5 text-ink-meta">
            {t(each.provider ? "setup.sorting.uses" : "setup.sorting.here")}
          </p>
          {each.provider && (
            <p className="text-[12px] leading-5 text-ink-meta">
              {t("setup.sorting.sends", { service: each.provider })}
            </p>
          )}
        </>
      );
    }
    return (
      <>
        <p className="text-[12px] leading-5 text-ink-meta">
          {t(each.provider ? "setup.sorting.chat" : "setup.sorting.chatHere", {
            model: each.modelName ?? "",
          })}
        </p>
        <p className="text-[12px] leading-5 text-ink-meta">{t("setup.sorting.chat.hints")}</p>
        {each.provider && (
          <p className="text-[12px] leading-5 text-ink-meta">
            {t("setup.sorting.sends", { service: each.provider })}
          </p>
        )}
      </>
    );
  };
  const unresolved = option?.unresolved === true;
  const holding =
    holds !== null &&
    (option === null ||
      unresolved ||
      sortingKey(holds.classifier) !== sortingKey(option.classifier));
  return (
    <div data-testid="models-sorting-line" className="grid">
      {holding && (
        <div aria-hidden="true" className="invisible col-start-1 row-start-1 flex flex-col gap-1">
          {rows(holds)}
        </div>
      )}
      <div className="col-start-1 row-start-1 flex flex-col gap-1">
        {unresolved ? null : rows(option)}
      </div>
    </div>
  );
}
