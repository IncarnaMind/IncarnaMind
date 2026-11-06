import type {
  ChatModelChoice,
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
