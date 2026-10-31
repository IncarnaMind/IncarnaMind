/**
 * Which model tags and organizes Documents: one choice for automatic
 * tagging and Organize, Automatic unless the User picks one by hand. Automatic
 * covers tagging only: Organize asks once in the Library and keeps the model
 * the User said yes to (`LibrarySettings.organizeWith`). Automatic picks from
 * what the User has set up, in this order:
 *
 * 1. TypeSafe Jev, when a Jev key is saved;
 * 2. the tagging model of the User's chat provider: its `tagging` role in the
 *    catalog, else its quick-tasks model (the ChatGPT plan's GPT-6 Luna
 *    included). Never an Ollama cloud model: Ollama's cloud doesn't hold a
 *    reply to a schema, and on the Organize evaluation two of them gave
 *    nothing usable for many Documents;
 * 3. the local decision models installed in Ollama (Tev1, Clef-Flash);
 * 4. the User's chat model on this computer.
 *
 * In local mode it picks only models on this computer. On the Organize
 * evaluation a cloud provider's cheap model tagged better than any local
 * route, and Tev1 4B filed 71 of 75 text Documents to qwen3.5:4b's 59.
 */
import type { ChatModelChoice, ChatProvider, ExternalService } from "../api";
import { priceFor } from "../cost/price";
import { catalogProvider, catalogRoleModel } from "../providers/catalog";
import type { DescribedModel } from "../providers/chat";
import { serviceForUrl } from "../providers/kinds";
import { hasOllamaModel } from "../providers/ollama";
import type {
  AutomaticTaggingReason,
  LibraryClassifier,
  TaggingClassifier,
  TaggingCost,
  TaggingDestination,
  TaggingModelGroup,
  TaggingModelOption,
  TaggingModels,
} from "./types";

/** Ollama's local decision models Automatic uses: the text ones first, then the one that reads PDF pages. */
const TEXT_DECISION_MODELS = ["tev1:4b", "tev1:0.8b"] as const;
const PAGE_DECISION_MODEL = "clef-flash";
const DECISION_MODELS = [...TEXT_DECISION_MODELS, PAGE_DECISION_MODEL] as const;

/** A typical Document's tagging request, in tokens: an excerpt with the Folders and Tags, and a short reply. */
const TYPICAL_REQUEST = { input: 1_500, output: 25 };

/** How long what Ollama said it has installed is trusted before it is asked again. */
const INSTALLED_TTL_MS = 30_000;

const OLLAMA = { kind: "ollama", catalogId: "ollama" } as const;

/** Reasons whose model was picked for tagging (a provider's quick model counts). */
const PICKED_FOR_TAGGING: ReadonlySet<AutomaticTaggingReason> = new Set([
  "jev",
  "tagging-model",
  "quick-model",
  "plan",
  "decision-models",
]);

const sameChoice = (a: ChatModelChoice, b: ChatModelChoice) =>
  a.providerId === b.providerId && a.modelId === b.modelId;

export interface AutomaticTagging {
  classifier: TaggingClassifier;
  reason: AutomaticTaggingReason;
}

/**
 * Automatic's pick, from what the User has set up (see the order above):
 * - `jev`: whether a Jev key is saved, and whether its server is on this computer;
 * - `chat`: the default chat model, with its provider's tagging model and why;
 * - `decision`: Ollama's address and the decision models it has;
 * - `localChat`: a chat model on this computer.
 * Null when none can be used.
 */
export function automaticTagging(input: {
  localOnly: boolean;
  jev: { enabled: boolean; local: boolean };
  chat: {
    model: DescribedModel;
    tagging: DescribedModel;
    reason: Extract<
      AutomaticTaggingReason,
      "tagging-model" | "quick-model" | "answers-model" | "plan"
    >;
  } | null;
  decision: { baseUrl: string; models: readonly string[] } | null;
  localChat: ChatModelChoice | null;
}): AutomaticTagging | null {
  const { localOnly, jev, chat, decision, localChat } = input;
  if (jev.enabled && (jev.local || !localOnly))
    return { classifier: { kind: "jev" }, reason: "jev" };
  if (
    chat &&
    chat.model.service !== null &&
    !chat.model.ollamaCloud &&
    !chat.tagging.ollamaCloud &&
    (!localOnly || chat.tagging.service === null)
  ) {
    return { classifier: { kind: "chat", choice: chat.tagging.choice }, reason: chat.reason };
  }
  if (decision) {
    if (TEXT_DECISION_MODELS.some((model) => hasOllamaModel(decision.models, model))) {
      return { classifier: { kind: "auto", baseUrl: decision.baseUrl }, reason: "decision-models" };
    }
    if (hasOllamaModel(decision.models, PAGE_DECISION_MODEL)) {
      return {
        classifier: {
          kind: "ollama",
          baseUrl: decision.baseUrl,
          modelId: PAGE_DECISION_MODEL,
          usePageImages: true,
        },
        reason: "decision-models",
      };
    }
  }
  if (localChat) return { classifier: { kind: "chat", choice: localChat }, reason: "local-chat" };
  return null;
}

/** About what 100 Documents cost at a price per million tokens. */
export function costPer100(price: DescribedModel["price"]): TaggingCost {
  if (!price) return { kind: "unknown" };
  const paid = priceFor(price, TYPICAL_REQUEST.input);
  const amount =
    ((TYPICAL_REQUEST.input * paid.input + TYPICAL_REQUEST.output * paid.output) * 100) / 1e6;
  return { kind: "estimate", currency: price.currency, amount };
}

/** Ollama's decision models picked per Document ("auto"). */
const AUTO_DECISION_NAME = "Tev1, Clef-Flash";

/** A local decision model's name as Ollama's library shows it: "tev1:4b" is "Tev1 4B". */
const decisionModelName = (model: string) =>
  model === PAGE_DECISION_MODEL
    ? "Clef-Flash"
    : model.replace(/^tev1:(.+)$/i, (_, size: string) => `Tev1 ${size.toUpperCase()}`);

export interface TaggingOptions {
  setting(): LibraryClassifier;
  chat: {
    list(): Promise<ChatProvider[]>;
    defaultModel(): ChatModelChoice | null;
    describeModel(choice: ChatModelChoice): DescribedModel | undefined;
    /** The quick-tasks model for Answers asked with this model (in local mode, a local one or none). */
    quickTasksModel(answers: ChatModelChoice): ChatModelChoice | null;
  };
  jev: { enabled(): boolean; service(): ExternalService | null };
  localOnly(): boolean;
  /** Where Ollama is when no Ollama provider is saved. */
  ollamaUrl: string;
  /** The models Ollama on this computer has installed, at an address; none when it can't be reached. */
  localModels(baseUrl: string): Promise<readonly string[]>;
  /** Until when tagging on a plan (ChatGPT's or Claude's) waits for its limit to reset (ISO 8601), or null. */
  planPausedUntil(): string | null;
  now(): number;
}

export type Tagging = ReturnType<typeof createTagging>;

export function createTagging(options: TaggingOptions) {
  const { chat, jev } = options;
  /** What Ollama said it has installed, by address: when it was asked, in order and in time. */
  const lists = new Map<string, { order: number; at: number; models: readonly string[] }>();
  let listsAsked = 0;
  /** What the last resolution gave, for the checks that can't wait (see `lastResolved`). */
  let last: TaggingClassifier | null = null;
  /**
   * The order of the list of installed models Automatic's last pick was made from: a pick from an
   * older list doesn't replace it, however late it ends, as a lookup that asked Ollama afresh can
   * end after one that read what it said before (#2302).
   */
  let lastList = 0;

  /**
   * Ollama on this computer: a saved Ollama provider's address there, else the
   * default (OLLAMA_HOST's when set) when that is on this computer; null when
   * it isn't, as Document text must not reach another computer unasked.
   */
  const ollamaUrl = (providers: readonly ChatProvider[]): string | null =>
    providers.find((each) => each.kind === "ollama" && each.baseUrl && each.service === null)
      ?.baseUrl ?? (serviceForUrl(options.ollamaUrl) ? null : options.ollamaUrl);

  /** What Ollama has installed, with the order the list was asked for in. */
  async function installedModels(
    baseUrl: string,
    fresh = false,
  ): Promise<{ order: number; models: readonly string[] }> {
    const cached = lists.get(baseUrl);
    const asked = { order: ++listsAsked, at: options.now() };
    if (!fresh && cached && asked.at - cached.at < INSTALLED_TTL_MS) return cached;
    const models = await options.localModels(baseUrl);
    // A list asked for after this one and answered first is newer (#2302).
    const kept = lists.get(baseUrl);
    if (!kept || kept.order < asked.order) lists.set(baseUrl, { ...asked, models });
    return { order: asked.order, models };
  }

  /**
   * The default chat model's provider's tagging model: its `tagging` role, the
   * ChatGPT plan's, or the quick-tasks model for Answers with it.
   */
  function providerTagging(model: DescribedModel) {
    const role = catalogRoleModel(model, "tagging");
    const reason: "plan" | "tagging-model" | "quick-model" | "answers-model" =
      model.kind === "chatgpt" ? "plan" : role ? "tagging-model" : "quick-model";
    const choice = role
      ? { providerId: model.choice.providerId, modelId: role }
      : chat.quickTasksModel(model.choice);
    const tagging = choice && chat.describeModel(choice);
    if (!tagging) return null;
    return {
      model,
      tagging,
      reason:
        reason === "quick-model" && sameChoice(tagging.choice, model.choice)
          ? "answers-model"
          : reason,
    } as const;
  }

  /** Automatic's pick, and the order of the list of installed models it was made from. */
  async function automatic(
    fresh = false,
  ): Promise<{ picked: AutomaticTagging | null; list: number }> {
    const providers = await chat.list();
    const baseUrl = ollamaUrl(providers);
    const { order: list, models } = baseUrl
      ? await installedModels(baseUrl, fresh)
      : { order: ++listsAsked, models: [] };
    const defaultModel = chat.defaultModel();
    const described = defaultModel ? chat.describeModel(defaultModel) : undefined;
    // On this computer: the default chat model, else Ollama's own small model when it is installed.
    const ollama = providers.find((each) => each.kind === "ollama" && each.service === null);
    const ollamaModel = catalogRoleModel(OLLAMA, "quickTasks");
    const localChat =
      described && described.service === null
        ? described.choice
        : ollama && ollamaModel && hasOllamaModel(models, ollamaModel)
          ? { providerId: ollama.id, modelId: ollamaModel }
          : null;
    const picked = automaticTagging({
      localOnly: options.localOnly(),
      jev: { enabled: jev.enabled(), local: jev.service() === null },
      chat: described ? providerTagging(described) : null,
      decision: baseUrl ? { baseUrl, models } : null,
      localChat,
    });
    return { picked, list };
  }

  /** Keeps Automatic's pick for `lastResolved`, unless the last one came from a newer list. */
  const keepPick = (classifier: TaggingClassifier | null, list: number) => {
    if (list < lastList) return;
    lastList = list;
    last = classifier;
  };

  /**
   * The model a setting tags with: itself, or Automatic's pick (null when there is none).
   * `fresh` asks Ollama what it has installed now, not what it said a moment ago.
   */
  async function resolve(
    setting: LibraryClassifier = options.setting(),
    fresh = false,
  ): Promise<TaggingClassifier | null> {
    if (setting.kind !== "automatic") {
      last = setting;
      return setting;
    }
    const { picked, list } = await automatic(fresh);
    const resolved = picked?.classifier ?? null;
    keepPick(resolved, list);
    return resolved;
  }

  const providerName = (model: DescribedModel): { en: string; zh: string } => {
    if (model.kind === "chatgpt") return { en: "ChatGPT plan", zh: "ChatGPT 订阅" };
    const entry = catalogProvider(model.catalogId);
    // A server the User gave the address of is named by it, as the data goes there.
    const atOwnAddress =
      model.service !== null && (model.kind === "ollama" || entry?.serverUrl === "required");
    if (entry && !atOwnAddress) return entry.name;
    const name = model.service?.name ?? model.kind;
    return { en: name, zh: name };
  };

  /** A model on a saved provider as the Tagging section lists it. */
  function chatOption(choice: ChatModelChoice, goodForTagging: boolean): TaggingModelOption | null {
    const model = chat.describeModel(choice);
    if (!model || model.ollamaCloud) return null;
    const group: TaggingModelGroup =
      model.kind === "chatgpt" ? "plan" : model.service === null ? "local" : "keys";
    return {
      classifier: { kind: "chat", choice },
      group,
      name: model.name,
      provider: providerName(model),
      goodForTagging,
      decisionModel: false,
      likelihoods: false,
      cost:
        group === "local"
          ? { kind: "free" }
          : group === "plan"
            ? { kind: "plan" }
            : costPer100(model.price),
    };
  }

  const decisionOption = (classifier: TaggingClassifier, name: string): TaggingModelOption => ({
    classifier,
    group: "local",
    name,
    provider: null,
    goodForTagging: true,
    decisionModel: true,
    likelihoods: true,
    cost: { kind: "free" },
  });

  const JEV_OPTION: TaggingModelOption = {
    classifier: { kind: "jev" },
    group: "keys",
    name: "TypeSafe Jev",
    provider: { en: "TypeSafe", zh: "TypeSafe" },
    goodForTagging: true,
    decisionModel: false,
    likelihoods: true,
    cost: { kind: "unknown" },
  };

  /** The option a classifier is: `goodForTagging` when it was picked for tagging. */
  function optionOf(
    classifier: TaggingClassifier,
    goodForTagging = false,
  ): TaggingModelOption | null {
    switch (classifier.kind) {
      case "jev":
        return JEV_OPTION;
      case "chat":
        return chatOption(classifier.choice, goodForTagging);
      case "auto":
        return decisionOption(classifier, AUTO_DECISION_NAME);
      case "ollama":
        return decisionOption(classifier, decisionModelName(classifier.modelId));
    }
  }

  const serviceOf = (classifier: TaggingClassifier): ExternalService | null => {
    if (classifier.kind === "jev") return jev.service();
    if (classifier.kind === "chat") return chat.describeModel(classifier.choice)?.service ?? null;
    return serviceForUrl(classifier.baseUrl);
  };

  /** Where a saved choice sends its requests; unknown when what it names isn't there. */
  function destinationOf(classifier: TaggingClassifier): TaggingDestination {
    if (classifier.kind === "chat" && !chat.describeModel(classifier.choice)) {
      return { kind: "unknown" };
    }
    if (classifier.kind === "jev" && !jev.enabled()) return { kind: "unknown" };
    const service = serviceOf(classifier);
    return service ? { kind: "service", service } : { kind: "here" };
  }

  return {
    resolve,

    /**
     * What the last resolution gave (see `resolve`): for the checks that can't
     * wait for Ollama, such as whether a scan can be read. Null before one.
     */
    lastResolved: () => last,

    /**
     * The local decision model that tags a Document's text, for Ollama's
     * decision models picked per Document ("auto"): Tev1 4B, else 0.8B, else
     * Clef-Flash. Null when none is installed.
     */
    async textDecisionModel(baseUrl: string): Promise<string | null> {
      const { models } = await installedModels(baseUrl);
      return DECISION_MODELS.find((model) => hasOllamaModel(models, model)) ?? null;
    },

    /** Where a model that tags sends its requests; null for one on this computer. */
    service: serviceOf,

    /** What the Tagging section shows (see `CoreApi.getTaggingModels`). */
    async models(): Promise<TaggingModels> {
      const { picked, list: pickedFrom } = await automatic(true);
      const providers = await chat.list();
      const baseUrl = ollamaUrl(providers);
      const models = baseUrl ? (await installedModels(baseUrl)).models : [];
      const defaultModel = chat.defaultModel();
      const list: TaggingModelOption[] = [];
      const add = (option: TaggingModelOption | null) => {
        const key = JSON.stringify(option?.classifier);
        if (option && !list.some((each) => JSON.stringify(each.classifier) === key)) {
          list.push(option);
        }
      };
      if (jev.enabled()) add(JEV_OPTION);
      for (const provider of providers) {
        const local = provider.service === null && provider.kind !== "chatgpt";
        const on = (modelId: string | undefined) =>
          modelId ? { providerId: provider.id, modelId } : null;
        if (!local) {
          const tagging = on(
            catalogRoleModel(provider, "tagging") ?? catalogRoleModel(provider, "quickTasks"),
          );
          if (tagging) add(chatOption(tagging, true));
        }
        if (defaultModel?.providerId === provider.id) add(chatOption(defaultModel, false));
        const answers = on(catalogProvider(provider.catalogId)?.roles.answers);
        if (answers && !local) add(chatOption(answers, false));
        // Ollama's own small model, when it is installed: the one measured with IncarnaMind.
        const small = on(catalogRoleModel(OLLAMA, "quickTasks"));
        if (provider.kind === "ollama" && local && small && hasOllamaModel(models, small.modelId)) {
          add(chatOption(small, false));
        }
      }
      const decision = DECISION_MODELS.filter((model) => hasOllamaModel(models, model));
      if (baseUrl) {
        if (decision.some((model) => model !== PAGE_DECISION_MODEL)) {
          add(decisionOption({ kind: "auto", baseUrl }, AUTO_DECISION_NAME));
        }
        for (const model of decision) {
          add(
            decisionOption(
              {
                kind: "ollama",
                baseUrl,
                modelId: model,
                ...(model === PAGE_DECISION_MODEL && { usePageImages: true }),
              },
              decisionModelName(model),
            ),
          );
        }
      }
      const order: Record<TaggingModelGroup, number> = { keys: 0, plan: 1, local: 2 };
      // By group, as the chip groups them; in each, the models picked for tagging first.
      list.sort(
        (a, b) =>
          order[a.group] - order[b.group] || Number(b.goodForTagging) - Number(a.goodForTagging),
      );
      const saved = options.setting();
      if (saved.kind === "automatic") keepPick(picked?.classifier ?? null, pickedFrom);
      const option = picked && optionOf(picked.classifier, PICKED_FOR_TAGGING.has(picked.reason));
      return {
        automatic: option && picked ? { ...option, reason: picked.reason } : null,
        options: list,
        localMode: options.localOnly(),
        planPausedUntil: options.planPausedUntil(),
        saved:
          saved.kind === "automatic"
            ? null
            : { classifier: saved, destination: destinationOf(saved) },
      };
    },
  };
}
