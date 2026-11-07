import type {
  ChatModelChoice,
  DecisionHost,
  DecisionHostStatus,
  JevSettings,
  TaggingClassifier,
  TaggingModels,
} from "../../../../core/api";
import type { Language } from "../../../../core/language";

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

/** The hosts whose decision models come before Jev, as measured (#1907): Decider's. */
const BEFORE_JEV: readonly DecisionHost[] = ["openrouter", "perplexity"];
/**
 * After the User's AI model: OpenAI's, which measured below Decider and Jev and misses the
 * calibration bar in English, so an OpenAI key alone keeps its own model sorting, as Automatic does.
 */
const AFTER_CHAT: readonly DecisionHost[] = ["openai"];

/**
 * What sorting can use, best first (#1922, #1907): the decision models a key reaches (Decider,
 * then Jev, then the other hosts'), then the User's AI model, then OpenAI's; in Local mode, only
 * what runs here, its decision models first. Each host offers its best model here; the others are
 * under Advanced › Tagging.
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
    /** Jev's state here, once read. */
    jev: JevState | null;
    chatLabel: string;
    chatName: string;
  },
): SortingOption[] {
  const jevOption =
    jev?.ready && (!localMode || jev.local)
      ? models.options.find((option) => option.classifier.kind === "jev")
      : undefined;
  const seen = new Set<DecisionHost>();
  const hosted = (localMode ? [] : models.options)
    .filter((option) => {
      if (option.classifier.kind !== "decision" || seen.has(option.classifier.host)) return false;
      seen.add(option.classifier.host);
      return true;
    })
    .map((option): SortingOption => {
      const provider = providerOf(option, language);
      return {
        classifier: option.classifier,
        label: provider ? `${option.name} · ${provider}` : option.name,
        provider,
        decisionModel: true,
      };
    });
  const among = (hosts: readonly DecisionHost[]) =>
    hosted.filter(
      (option) => option.classifier.kind === "decision" && hosts.includes(option.classifier.host),
    );
  const first = among(BEFORE_JEV);
  const last = among(AFTER_CHAT);
  const rest = hosted.filter((option) => !first.includes(option) && !last.includes(option));
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
    : [
        ...first,
        ...(byKey ? [byKey] : []),
        ...rest,
        ...(chatOption ? [chatOption] : []),
        ...last,
        ...decisions,
      ];
}

/**
 * Under Automatic, the row for what it sorts with now: never the best listed in its place, as
 * Automatic starts no host by itself (#1907) and often tags with a model the list doesn't offer
 * (the provider's quick model), which `listed` false says Settings must add. Null while it has none.
 */
export function automaticRow(
  models: TaggingModels,
  options: readonly SortingOption[],
  language: Language,
): { row: SortingOption | null; listed: boolean } {
  const pick = models.automatic;
  if (!pick) return { row: null, listed: false };
  const listed = options.find(
    (each) => sortingKey(each.classifier) === sortingKey(pick.classifier),
  );
  if (listed) return { row: listed, listed: true };
  const provider = providerOf(pick, language);
  return {
    row: {
      classifier: pick.classifier,
      label: provider ? `${pick.name} · ${provider}` : pick.name,
      provider: pick.group === "local" ? null : provider,
      decisionModel: pick.classifier.kind !== "chat",
      ...(pick.classifier.kind === "chat" && { modelName: pick.name }),
    },
    listed: false,
  };
}

/** A row at the foot of the picker that sets a decision model up in place: Jev, or a host's. */
export interface SetUpOffer {
  id: "jev" | DecisionHost;
  label: string;
}

/**
 * The hosts the picker can set up in place, after Jev (#1907): one with a key of its own until it
 * has one (its row in Your providers changes it then), and one whose chat provider's key is there
 * and that asks for an account (Alibaba Cloud's workspace), which stays here to be changed. A host
 * that uses a chat provider's key is set up where that key is added. None in Local mode: each is
 * a cloud service.
 */
export function hostSetUpOffers(
  hosts: readonly DecisionHostStatus[] | null,
  localMode: boolean,
  label: (host: DecisionHostStatus) => string,
): SetUpOffer[] {
  if (!hosts || localMode) return [];
  return hosts
    .filter((host) => (host.key === "own" ? !host.ready : host.hasKey && host.account !== null))
    .map((host) => ({ id: host.host, label: label(host) }));
}

/**
 * The chat provider (a catalog id) whose key the chosen decision model uses: OpenRouter's,
 * OpenAI's or the Qwen key (#1907). Your providers has no row of its own for it, so the sorting
 * row names it. Null for any other choice.
 */
export function keyProviderOf(
  option: SortingOption | null,
  hosts: readonly DecisionHostStatus[] | null,
): string | null {
  const classifier = option?.classifier;
  if (classifier?.kind !== "decision") return null;
  const host = hosts?.find((each) => each.host === classifier.host);
  return host?.key === "provider" ? host.provider : null;
}

/** Whether Jev can run here, set up with its key on this device, and whether its server is on this computer. */
export interface JevState {
  ready: boolean;
  local: boolean;
}

// A server on this computer takes the key too: without it, tagging waits for it (#2615).
export const jevStateOf = (jev: JevSettings | null): JevState | null =>
  jev && { ready: jev.enabled && jev.hasApiKey, local: jev.service === null };

/**
 * Whether the list ends with "Use TypeSafe Jev…", which sets Jev up in place (#2615): while it
 * can't run here yet. In Local mode only for a Jev server on this computer that Jev's settings
 * already name, since the app finds no other.
 */
export const offersJevSetUp = (jev: JevState | null, localMode: boolean): boolean =>
  jev !== null && !jev.ready && (!localMode || jev.local);
