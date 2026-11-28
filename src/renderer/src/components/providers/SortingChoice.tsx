import { useEffect, useState } from "react";
import {
  DECISION_HOST_ENTRIES,
  decisionModelOf,
} from "../../../../core/providers/catalog/decisions";
import { useAnswers } from "../../answers";
import { core } from "../../core";
import { useDecisionHosts } from "../../decisionHosts";
import { useLanguage, useT } from "../../i18n";
import { useModelNames } from "../../modelNames";
import { useAppStore } from "../../store";
import { useRead } from "../../useRead";
import { PopUpSelect } from "../settings/PopUpButton";
import { fieldClass } from "../ui";
import {
  automaticRow,
  jevStateOf,
  type SortingOption,
  sortingKey,
  sortingOptions,
} from "./sortingOptions";
import { useJevSettings } from "./useJevSettings";

/**
 * What the core says can sort and where the saved choice goes, as one read: nothing is said of a
 * saved choice until the core has answered, and a read that fails says so.
 */
export function useSortingModels(again: readonly unknown[] = []) {
  const chatModel = useAppStore((state) => state.settings?.user.chatModel ?? null);
  const readiness = useAppStore((state) => state.chatReadiness);
  // biome-ignore lint/correctness/useExhaustiveDependencies: listed again whenever these change.
  useEffect(() => {
    // The line that says what sorts names the User's model: its group is where the name is.
    useAnswers.getState().loadModels();
  }, [chatModel, readiness]);
  return useRead("The models that can sort", () => core.getTaggingModels(), [
    chatModel,
    readiness,
    ...again,
  ]);
}

/**
 * The choice of what sorts Documents, and the way to save it: one setting for automatic tagging
 * and Organize, and choosing it is the consent for its flow (ADR-0022).
 */
export function useSorting() {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  const [jevSettings] = useJevSettings();
  const jev = jevStateOf(jevSettings);
  const [decisionHosts] = useDecisionHosts();
  const library = useAppStore((state) => state.library);
  const saved = library?.settings.classifier ?? null;
  // Read again only when asked: a read more as the step opens would overtake the one it shows.
  const [rereads, setRereads] = useState(0);
  // A host's key kept or forgotten anywhere changes what can sort.
  useEffect(() => core.on("decisions.changed", () => setRereads((count) => count + 1)), []);
  const read = useSortingModels([rereads]);
  const models = read.state === "ready" ? read.data : null;
  const chatModel = useAppStore((state) => state.settings?.user.chatModel ?? null);
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  const chatName = chatModel ? nameOf(chatModel.modelId, chatModel.providerId).name : "";
  const options = models
    ? sortingOptions(models, {
        chatModel,
        language,
        localMode,
        jev,
        chatLabel: t("models.sorting.chat", { model: chatName }),
        chatName,
      })
    : [];
  if (saved && saved.kind !== "automatic") {
    // Where the saved choice goes is what the core says for it, whichever model it names and
    // whether or not the list offers it: the card works out nothing of its own. Until the core
    // has said, or when it can't (what the choice names is gone), it is unresolved.
    const answer =
      models?.saved && sortingKey(models.saved.classifier) === sortingKey(saved)
        ? models.saved.destination
        : undefined;
    const at = options.findIndex((each) => sortingKey(each.classifier) === sortingKey(saved));
    const named =
      saved.kind === "chat" ? nameOf(saved.choice.modelId, saved.choice.providerId).name : "";
    const base: SortingOption = options[at] ?? {
      classifier: saved,
      label:
        saved.kind === "chat"
          ? named
          : saved.kind === "jev"
            ? "TypeSafe Jev"
            : saved.kind === "decision"
              ? `${
                  decisionHosts
                    ?.find((each) => each.host === saved.host)
                    ?.models.find((model) => model.id === saved.modelId)?.name ??
                  decisionModelOf(saved.host, saved.modelId)?.name ??
                  saved.modelId
                } · ${DECISION_HOST_ENTRIES[saved.host].name[language === "zh-CN" ? "zh" : "en"]}`
              : saved.kind === "auto"
                ? t("tagging.decision.auto")
                : saved.modelId,
      provider: null,
      decisionModel: saved.kind !== "chat",
      ...(saved.kind === "chat" && { modelName: named }),
    };
    const told: SortingOption = {
      ...base,
      provider: answer?.kind === "service" ? answer.service.name : null,
      ...(answer?.kind === "here" || answer?.kind === "service" ? {} : { unresolved: true }),
    };
    if (at >= 0) options[at] = told;
    else options.unshift(told);
  }
  // Under Automatic, what it sorts with now, which Turn on… allows (#1907).
  const pick =
    (!saved || saved.kind === "automatic") && models
      ? automaticRow(models, options, language)
      : null;
  const unlisted = pick && !pick.listed ? pick.row : null;
  const current =
    saved && saved.kind !== "automatic"
      ? (options.find((each) => sortingKey(each.classifier) === sortingKey(saved)) ?? null)
      : (pick?.row ?? null);
  /** Saves the choice; the switch for tagging stays where it was (#2308). */
  const choose = async (option: Pick<SortingOption, "classifier">): Promise<boolean> => {
    let settings = useAppStore.getState().library?.settings;
    if (!settings) {
      await useAppStore.getState().refreshLibrary();
      settings = useAppStore.getState().library?.settings;
    }
    if (!settings) return false;
    try {
      await core.saveLibrarySettings({
        ...settings,
        classifier: option.classifier,
      });
      return true;
    } catch (error) {
      useAppStore.getState().reportError(error);
      return false;
    }
  };
  return {
    options,
    current,
    /** Settings' list: Automatic's own pick first where the list doesn't offer it. */
    settingsOptions: unlisted ? [unlisted, ...options] : options,
    choose,
    read,
    library,
    decisionHosts,
  };
}

/** The choice of what sorts, editable in place wherever it is shown. */
export function SortingSelect({
  id,
  className = fieldClass,
  popUp = false,
  labelledBy,
  options,
  groups,
  current,
  none,
  onChange,
}: {
  id: string;
  className?: string;
  /** Drawn as a pop-up button, as Settings' rows draw a choice; `className` then only bounds it. */
  popUp?: boolean;
  labelledBy?: string;
  options: readonly SortingOption[];
  /** The options under their group names (Settings › AI groups them by who pays); else `options` as they are. */
  groups?: readonly { label: string; options: readonly SortingOption[] }[];
  current: SortingOption | null;
  /** What it shows with nothing chosen; "No model yet" by default. */
  none?: string;
  onChange(option: SortingOption): void;
}) {
  const t = useT();
  const noPlaceholder = none ?? t("setup.sorting.noChoice");
  const Field = popUp ? PopUpSelect : "select";
  const optionOf = (option: SortingOption) => (
    <option key={sortingKey(option.classifier)} value={sortingKey(option.classifier)}>
      {option.label}
    </option>
  );
  return (
    <Field
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
      {groups
        ? groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map(optionOf)}
            </optgroup>
          ))
        : options.map(optionOf)}
    </Field>
  );
}

/**
 * What the choice sends, in a line (ADR-0022): to its service for a decision model, or the
 * User's model's own line; and what meeting hints need, which the User's AI model can't do.
 */
export function SortingLine({
  option,
  reading = false,
}: {
  option: SortingOption | null;
  /** The core hasn't answered: nothing is said. */
  reading?: boolean;
}) {
  const t = useT();
  const rows = (each: SortingOption | null) => {
    if (!each) {
      return <p className="text-small leading-5 text-ink-meta">{t("setup.sorting.none")}</p>;
    }
    if (each.decisionModel) {
      return (
        <>
          <p className="text-small leading-5 text-ink-meta">
            {t(each.provider ? "setup.sorting.uses" : "setup.sorting.here")}
          </p>
          {each.provider && (
            <p className="text-small leading-5 text-ink-meta">
              {t("setup.sorting.sendsWhenOn", { service: each.provider })}
            </p>
          )}
        </>
      );
    }
    return (
      <>
        <p className="text-small leading-5 text-ink-meta">
          {t(each.provider ? "setup.sorting.chat" : "setup.sorting.chatHere", {
            model: each.modelName ?? "",
          })}
        </p>
        <p className="text-small leading-5 text-ink-meta">{t("setup.sorting.chat.hints")}</p>
        {each.provider && (
          <p className="text-small leading-5 text-ink-meta">
            {t("setup.sorting.sendsWhenOn", { service: each.provider })}
          </p>
        )}
      </>
    );
  };
  const unresolved = reading || option?.unresolved === true;
  return (
    <div data-testid="models-sorting-line" className="flex flex-col gap-1">
      {unresolved ? null : rows(option)}
    </div>
  );
}
