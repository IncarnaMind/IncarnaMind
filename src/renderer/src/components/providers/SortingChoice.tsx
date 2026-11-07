import { useEffect, useRef, useState } from "react";
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
import { fieldClass } from "../ui";
import {
  hostSetUpOffers,
  jevStateOf,
  offersJevSetUp,
  type SetUpOffer,
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
  const readiness = useAppStore((state) => state.chatReadiness);
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
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
        jev,
        chatLabel: t("models.sorting.chat"),
        chatName: chatModel ? nameOf(chatModel.modelId, chatModel.providerId).name : "",
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
              ? `${decisionModelOf(saved.host, saved.modelId)?.name ?? saved.modelId} · ${
                  DECISION_HOST_ENTRIES[saved.host].name[language === "zh-CN" ? "zh" : "en"]
                }`
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
  // Under Automatic, what it sorts with now: it never starts a host's flow by itself (#1907), so
  // the best choice listed first may not be the one in use.
  const automatic = models?.automatic?.classifier;
  const current =
    saved && saved.kind !== "automatic"
      ? (options.find((each) => sortingKey(each.classifier) === sortingKey(saved)) ?? null)
      : ((automatic &&
          options.find((each) => sortingKey(each.classifier) === sortingKey(automatic))) ??
        options[0] ??
        null);
  /**
   * Saves the choice. `turnOn`: the choice was made with its sends line on screen, so it is the
   * choice to tag and sort with it (#2308); otherwise the switch stays where it was.
   */
  const choose = async (
    option: Pick<SortingOption, "classifier">,
    { turnOn = false } = {},
  ): Promise<boolean> => {
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
        ...(turnOn && { automatic: true, turnOn: true }),
      });
      return true;
    } catch (error) {
      useAppStore.getState().reportError(error);
      return false;
    }
  };
  // With the rest of the list, once it is read: the picker waits for both.
  const setUpOffers: SetUpOffer[] =
    read.state === "ready"
      ? [
          ...(offersJevSetUp(jev, localMode)
            ? [{ id: "jev" as const, label: t("jev.settings.setUp") }]
            : []),
          ...hostSetUpOffers(decisionHosts, localMode, (host) =>
            t("decisions.setUp.row", {
              model: host.models[0]?.name ?? "",
              provider: host.name[language === "zh-CN" ? "zh" : "en"],
            }),
          ),
        ]
      : [];
  return {
    options,
    current,
    /** The best the keys reach, preselected where the User is choosing (the setup card). */
    best: options[0] ?? null,
    choose,
    known,
    loading: read.state === "loading",
    read,
    library,
    setUpOffers,
    jevSettings,
    decisionHosts,
    /** Reads the list again, once Jev is set up in place and chosen (#2615). */
    reread: () => setRereads((count) => count + 1),
  };
}

const SET_UP = "set-up:";

/**
 * The rows at the foot of the list that set a decision model up in place: "Use TypeSafe Jev…"
 * while Jev isn't set up (#2615), and each host's (#1907). `open`: the one whose setup shows.
 */
export interface SetUpRows {
  offers: readonly SetUpOffer[];
  open: SetUpOffer["id"] | null;
  onChoose(id: SetUpOffer["id"]): void;
}

/** The choice of what sorts, editable in place wherever it is shown. */
export function SortingSelect({
  id,
  className = fieldClass,
  labelledBy,
  options,
  current,
  autoFocus = false,
  setUp = null,
  onChange,
}: {
  id: string;
  className?: string;
  labelledBy?: string;
  options: readonly SortingOption[];
  current: SortingOption | null;
  /** It takes the focus as its step opens. */
  autoFocus?: boolean;
  setUp?: SetUpRows | null;
  onChange(option: SortingOption): void;
}) {
  const t = useT();
  const noPlaceholder = t("setup.sorting.noChoice");
  const field = useRef<HTMLSelectElement>(null);
  // It can't take the focus while it waits for the list, so it does once the list comes.
  const settingUp = setUp?.open != null;
  useEffect(() => {
    if (autoFocus && options.length > 0 && !settingUp) field.current?.focus();
  }, [autoFocus, options.length, settingUp]);
  return (
    <select
      ref={field}
      id={id}
      aria-labelledby={labelledBy}
      data-testid="models-sorting"
      value={setUp?.open ? `${SET_UP}${setUp.open}` : current ? sortingKey(current.classifier) : ""}
      disabled={options.length === 0 && !setUp?.offers.length}
      onChange={(event) => {
        const offer = setUp?.offers.find((each) => `${SET_UP}${each.id}` === event.target.value);
        if (offer) {
          setUp?.onChoose(offer.id);
          return;
        }
        const chosen = options.find(
          (option) => sortingKey(option.classifier) === event.target.value,
        );
        if (chosen) onChange(chosen);
      }}
      className={className}
    >
      {!current && !setUp?.open && <option value="">{noPlaceholder}</option>}
      {options.map((option) => (
        <option key={sortingKey(option.classifier)} value={sortingKey(option.classifier)}>
          {option.label}
        </option>
      ))}
      {setUp && setUp.offers.length > 0 && (
        <optgroup label={t("decisions.setUp.group")}>
          {setUp.offers.map((offer) => (
            <option key={offer.id} value={`${SET_UP}${offer.id}`}>
              {offer.label}
            </option>
          ))}
        </optgroup>
      )}
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
  reading = false,
  choosing = true,
}: {
  option: SortingOption | null;
  holds?: SortingOption | null;
  /** The core hasn't answered: nothing is said, and the rows held hold the room. */
  reading?: boolean;
  /** Choosing here turns tagging on, so the line says so; elsewhere it says what goes once it is on. */
  choosing?: boolean;
}) {
  const t = useT();
  const sends = choosing ? "setup.sorting.sends" : "setup.sorting.sendsWhenOn";
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
              {t(sends, { service: each.provider })}
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
            {t(sends, { service: each.provider })}
          </p>
        )}
      </>
    );
  };
  const unresolved = reading || option?.unresolved === true;
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
