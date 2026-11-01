import { isMacOS } from "@tiptap/core";
import { Children, type ReactNode, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { ChatGptPlanStatus, ChatModelChoice, ChatProvider } from "../../../core/api";
import { isCloudModelName } from "../../../core/providers/ollamaCloud";
import type { MessageKey } from "../../../shared/i18n";
import { sameModel, setMindModel } from "../../../shared/mindModel";
import { useAnswers } from "../answers";
import { CheckLineIcon } from "../components/lineIcons";
import { OnThisComputer } from "../components/OnThisComputer";
import { ChatGptMark } from "../components/providers/ChatGptMark";
import {
  ChatGptSignInState,
  ManageUsageLink,
  useContinueWithChatGpt,
} from "../components/providers/ChatGptSignIn";
import { usePopoverMenu } from "../components/usePopoverMenu";
import { core } from "../core";
import { useT } from "../i18n";
import { turnOffLocalMode } from "../localMode";
import { useModelInUse } from "../modelInUse";
import { useModelMenuRequests } from "../modelMenu";
import { useModelNames } from "../modelNames";
import { usePlanStandIn } from "../planLimits";
import { useAppStore } from "../store";
import { untestedHintKey } from "../untestedModels";
import { ChevronDownSmallIcon } from "./icons";

/** Where a model runs, as the menu groups them (DESIGN.md, Composer › Model). */
type ModelGroup = "keys" | "plan" | "local" | "cloud";

const GROUPS: readonly ModelGroup[] = ["keys", "plan", "local", "cloud"];

/**
 * `cloud`: the model runs on ollama.com though its provider, Ollama, is on this
 * computer. The provider's own service says so only for the default model, so
 * the model list's word comes first.
 */
const groupOf = (provider: ChatProvider, cloud: boolean): ModelGroup =>
  provider.kind === "chatgpt"
    ? "plan"
    : cloud
      ? "cloud"
      : provider.service === null
        ? "local"
        : "keys";

const GROUP_NAMES: Record<ModelGroup, MessageKey> = {
  keys: "composer.model.group.keys",
  plan: "composer.model.group.plan",
  local: "composer.model.group.local",
  cloud: "composer.model.group.cloud",
};

/** How a model is reached, after its name in the chip's tooltip. */
const VIA: Record<ModelGroup, MessageKey> = {
  keys: "composer.model.via.keys",
  plan: "composer.model.via.plan",
  local: isMacOS() ? "composer.model.via.localMac" : "composer.model.via.local",
  cloud: "composer.model.via.cloud",
};

/** The model a run in the Mind uses: the one in use, else the default the composer shows. */
export function useRunModel(doc: Y.Doc | null): {
  providerId: string | null;
  modelId: string | null;
} {
  const inUse = useModelInUse(doc);
  const providerId = useAppStore((state) =>
    state.chatReadiness?.ready ? state.chatReadiness.provider.id : null,
  );
  const modelId = useAppStore((state) =>
    state.chatReadiness?.ready ? state.chatReadiness.modelId : null,
  );
  return inUse ?? { providerId, modelId };
}

function chooseModel(doc: Y.Doc | null, choice: ChatModelChoice): void {
  if (doc) setMindModel(doc, choice);
  void useAppStore.getState().updateSettings({ device: { lastChatModel: choice } });
}

/**
 * The composer's quiet model chip, before the Search scope: the model the
 * Mind's next Questions are asked with, and a menu to choose another, grouped
 * by where it runs (your keys, the ChatGPT plan, this computer), with a hint
 * only on a model that needs one. A choice is remembered for the Mind (`setMindModel`) and as the
 * last pick (`DeviceSettings.lastChatModel`); a Mind with none of its own follows the last pick,
 * else the Answers default (`modelInUse`). The menu names at its foot the model a new Mind starts on.
 * Until the User is signed in with ChatGPT, the plan's group offers "Continue
 * with ChatGPT"; while its model is chosen, it says the plan is in use, with
 * "Manage usage". Not shown before any chat model is set up.
 */
export function ModelChip({
  doc,
  onChosen,
  opensOnRequest = false,
}: {
  doc: Y.Doc | null;
  onChosen(): void;
  /** The assistant's chip: "Choose another model" on an Answer opens its menu (`requestModelMenu`). */
  opensOnRequest?: boolean;
}) {
  const t = useT();
  const current = useModelInUse(doc);
  const newMindModel = useModelInUse(null);
  const readiness = useAppStore((state) => state.chatReadiness);
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  const openSettings = useAppStore((state) => state.openSettings);
  const groups = useAnswers((state) => state.models);
  const loadModels = useAnswers((state) => state.loadModels);
  const nameOf = useModelNames();
  const standIn = usePlanStandIn();
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  // Over the composer, not on it.
  const menu = usePopoverMenu({ around: (chip) => chip.closest<HTMLElement>(".composer") });
  const [plan, setPlan] = useState<ChatGptPlanStatus | null>(null);
  const sign = useContinueWithChatGpt({
    keepDefault: true,
    onSignedIn: ({ provider, modelId }) => {
      loadModels();
      chooseModel(doc, { providerId: provider.id, modelId });
      menu.close();
      onChosen();
    },
  });

  // The menu lists what each provider offers: asked for when it is about to open.
  useEffect(() => {
    if (!menu.open) {
      setQuery("");
      return;
    }
    loadModels();
    core.getChatGptPlan().then(setPlan, () => undefined);
  }, [menu.open, loadModels]);
  useEffect(() => core.on("chatGptPlan.changed", setPlan), []);

  const requests = useModelMenuRequests((state) => state.count);
  const answered = useRef(requests);
  useEffect(() => {
    if (requests === answered.current) return;
    answered.current = requests;
    const chip = menu.buttonProps.ref.current;
    if (opensOnRequest && chip && !menu.open) chip.click();
  }, [requests, opensOnRequest, menu.buttonProps.ref, menu.open]);

  if (!current) return null;
  const providerOf = (providerId: string): ChatProvider | null =>
    groups?.find((group) => group.provider.id === providerId)?.provider ??
    (readiness && "provider" in readiness && readiness.provider.id === providerId
      ? readiness.provider
      : null);
  const provider = providerOf(current.providerId);
  const isCloud = (providerId: string, modelId: string) => {
    const group = groups?.find((each) => each.provider.id === providerId);
    // A model the provider doesn't list (a Mind's own choice) is cloud by its name, or as the provider says of its default.
    return group?.models.includes(modelId)
      ? group.cloud.includes(modelId)
      : isCloudModelName(modelId) || (provider?.kind === "ollama" && provider.service !== null);
  };
  const via = provider ? t(VIA[groupOf(provider, isCloud(provider.id, current.modelId))]) : null;
  const shown = nameOf(current.modelId, current.providerId);
  const answering =
    standIn && provider?.kind === "chatgpt" && standIn.insteadOf === current.modelId
      ? { name: nameOf(standIn.modelId, current.providerId).name, until: standIn.untilTime }
      : null;
  const chipText = answering?.until
    ? t("composer.model.standIn", { model: answering.name, time: answering.until })
    : (answering?.name ?? shown.name);
  const named = shown.id ? `${shown.name} · ${shown.id}` : shown.name;
  const title = answering
    ? answering.until
      ? t("composer.model.standIn.title", {
          chosen: shown.name,
          model: answering.name,
          time: answering.until,
        })
      : t("composer.model.standIn.titleForNow", { chosen: shown.name, model: answering.name })
    : via
      ? `${named} · ${via}`
      : named;
  const label = via
    ? t("composer.model.label", { model: chipText, via })
    : t("composer.model.labelPlain", { model: chipText });

  const choose = (choice: ChatModelChoice) => {
    // The User's own pick wins over a stand-in, for the model it stood in for too.
    if (answering || (standIn && choice.modelId === standIn.insteadOf)) {
      core.endPlanStandIn().catch(useAppStore.getState().reportError);
    }
    chooseModel(doc, choice);
    menu.close();
    onChosen();
  };

  // Each provider's models; the one in use is listed even if its provider didn't list it.
  const offered = (groups ?? []).map((group) => ({
    provider: group.provider,
    cloud:
      group.provider.id === current.providerId &&
      !group.models.includes(current.modelId) &&
      isCloud(group.provider.id, current.modelId)
        ? [current.modelId, ...group.cloud]
        : group.cloud,
    models:
      group.provider.id === current.providerId && !group.models.includes(current.modelId)
        ? [current.modelId, ...group.models]
        : group.models,
  }));

  const wanted = query.trim().toLowerCase();
  const matches = (providerId: string, modelId: string) =>
    wanted === "" ||
    modelId.toLowerCase().includes(wanted) ||
    nameOf(modelId, providerId).name.toLowerCase().includes(wanted);

  return (
    <span className="composer-model-anchor">
      <button
        type="button"
        {...menu.buttonProps}
        data-testid="composer-model"
        data-stand-in={answering ? "" : undefined}
        aria-label={label}
        title={title}
        onPointerEnter={loadModels}
        onFocus={loadModels}
        className="composer-chip composer-model"
      >
        {/* A stand-in's words carry the reset time, so they wrap rather than being cut (#400). */}
        <span className={answering?.until ? "min-w-0 break-words" : "truncate"}>{chipText}</span>
        <ChevronDownSmallIcon className="composer-model-chevron" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("composer.model.menu")}
        data-testid="composer-model-menu"
        className="model-menu"
      >
        {menu.open && (
          <>
            <div
              className="model-menu-list"
              onKeyDownCapture={(event) => {
                // Typing on an item searches, as in a Finder list.
                if (
                  event.key.length === 1 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  !(event.target instanceof HTMLInputElement)
                ) {
                  search.current?.focus();
                }
              }}
            >
              <input
                ref={search}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("composer.model.search")}
                aria-label={t("composer.model.search")}
                data-testid="composer-model-search"
                spellCheck={false}
                autoComplete="off"
                className="model-menu-search"
              />
              {GROUPS.map((group) => {
                // A provider can sit in two groups: Ollama's local models and its cloud ones.
                const inGroup = offered
                  .map((each) => ({
                    ...each,
                    models: each.models.filter(
                      (modelId) =>
                        groupOf(each.provider, each.cloud.includes(modelId)) === group &&
                        matches(each.provider.id, modelId),
                    ),
                  }))
                  .filter((each) => each.models.length > 0);
                if (group === "plan") {
                  return (
                    <PlanGroup
                      key={group}
                      signedIn={plan?.account.state === "signed-in"}
                      inUse={provider?.kind === "chatgpt"}
                      sign={sign}
                    >
                      {inGroup.flatMap(({ provider: each, models }) =>
                        models.map((modelId) => (
                          <ModelItem
                            key={`${each.id}\n${modelId}`}
                            provider={each}
                            modelId={modelId}
                            checked={sameModel({ providerId: each.id, modelId }, current)}
                            unavailable={localMode}
                            onChoose={choose}
                          />
                        )),
                      )}
                    </PlanGroup>
                  );
                }
                if (inGroup.length === 0) return null;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: a group of a menu's items, which a fieldset can't hold.
                  <div key={group} role="group" aria-label={t(GROUP_NAMES[group])}>
                    <p aria-hidden="true" className="model-menu-heading">
                      {group === "local" ? (
                        <OnThisComputer>{t(GROUP_NAMES[group])}</OnThisComputer>
                      ) : (
                        t(GROUP_NAMES[group])
                      )}
                    </p>
                    {group === "cloud" && (
                      <p className="model-menu-hint model-menu-group-hint">
                        {t("composer.model.hint.cloud")}
                      </p>
                    )}
                    {inGroup.flatMap(({ provider: each, models }) =>
                      models.map((modelId) => (
                        <ModelItem
                          key={`${each.id}\n${modelId}`}
                          provider={each}
                          modelId={modelId}
                          hint={untestedHintKey(each) ? t("providers.untested") : null}
                          checked={sameModel({ providerId: each.id, modelId }, current)}
                          // Local mode: only a model on this computer can be asked.
                          unavailable={localMode && group !== "local"}
                          onChoose={choose}
                        />
                      )),
                    )}
                  </div>
                );
              })}
              {localMode &&
                offered.some((each) =>
                  each.models.some(
                    (id) => groupOf(each.provider, each.cloud.includes(id)) !== "local",
                  ),
                ) && (
                  <p data-testid="composer-model-local-mode" className="model-menu-intro">
                    {t("composer.model.localModeOff")}
                    <span aria-hidden="true"> · </span>
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="composer-model-local-off"
                      onClick={() =>
                        turnOffLocalMode().catch((error: unknown) =>
                          useAppStore.getState().reportError(error),
                        )
                      }
                      className="model-menu-link"
                    >
                      {t("localMode.turnOff")}
                    </button>
                  </p>
                )}
              {groups === null || groups.length === 0 ? (
                <p className="model-menu-intro">{t("composer.model.loading")}</p>
              ) : wanted !== "" &&
                !offered.some((each) => each.models.some((id) => matches(each.provider.id, id))) ? (
                <p data-testid="composer-model-none" className="model-menu-intro">
                  {t("composer.model.noMatch")}
                </p>
              ) : null}
            </div>
            <div className="model-menu-foot">
              <span>
                {newMindModel
                  ? t("composer.model.default", {
                      model: nameOf(newMindModel.modelId, newMindModel.providerId).name,
                    })
                  : t("composer.model.defaultUnset")}
              </span>
              <span aria-hidden="true"> · </span>
              <button
                type="button"
                role="menuitem"
                data-testid="composer-model-settings"
                onClick={() => {
                  menu.close();
                  openSettings("models");
                }}
                className="model-menu-link"
              >
                {t("composer.model.change")}
              </button>
            </div>
          </>
        )}
      </div>
    </span>
  );
}

/**
 * One model in the menu: its name (its id on hover), who runs it, and, only when it needs one, a
 * hint (not yet tested for Citations). Where models run is said once, by their group's heading.
 * `unavailable`: listed but not chosen, with the reason as its hint (a cloud model in local mode).
 */
function ModelItem({
  provider,
  modelId,
  hint = null,
  checked,
  unavailable,
  onChoose,
}: {
  provider: ChatProvider;
  modelId: string;
  hint?: string | null;
  checked: boolean;
  unavailable: boolean;
  onChoose(choice: ChatModelChoice): void;
}) {
  const t = useT();
  const shown = useModelNames()(modelId, provider.id);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      aria-disabled={unavailable || undefined}
      data-testid="composer-model-option"
      title={shown.id}
      data-model={modelId}
      data-provider={provider.id}
      data-unavailable={unavailable || undefined}
      onClick={() => {
        if (!unavailable) onChoose({ providerId: provider.id, modelId });
      }}
      className="model-menu-item"
    >
      <CheckLineIcon
        className="model-menu-check"
        style={{ visibility: checked ? "visible" : "hidden" }}
      />
      <span className="model-menu-name">
        <span className="truncate">{shown.name}</span>
        {(unavailable || hint) && (
          <span className="model-menu-hint">
            {unavailable ? t("composer.model.localModeOff") : hint}
          </span>
        )}
      </span>
      <span className="model-menu-provider">{providerName(provider, t)}</span>
    </button>
  );
}

/**
 * The ChatGPT plan's group: its models once signed in, with "Using ChatGPT
 * plan · Manage usage" while one is chosen, as OpenAI's guidelines ask; else
 * "Continue with ChatGPT", which signs in and chooses the plan for this Mind.
 */
function PlanGroup({
  signedIn,
  inUse,
  sign,
  children,
}: {
  signedIn: boolean;
  inUse: boolean;
  sign: ReturnType<typeof useContinueWithChatGpt>;
  children: ReactNode;
}) {
  const t = useT();
  const items = Children.count(children);
  if (signedIn && items === 0) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of a menu's items, which a fieldset can't hold.
    <div role="group" aria-label={t(GROUP_NAMES.plan)} data-testid="composer-model-plan">
      <p aria-hidden="true" className="model-menu-heading">
        {t(GROUP_NAMES.plan)}
      </p>
      {signedIn ? (
        <>
          {children}
          {inUse && (
            <p data-testid="composer-model-plan-in-use" className="model-menu-intro">
              {t("chatgpt.inUse")}
              <span aria-hidden="true"> · </span>
              <ManageUsageLink />
            </p>
          )}
        </>
      ) : sign.waiting || sign.failureText ? (
        <div className="model-menu-intro">
          <ChatGptSignInState sign={sign} retry />
        </div>
      ) : (
        <button
          type="button"
          role="menuitem"
          data-testid="composer-model-chatgpt"
          onClick={() => void sign.run()}
          className="model-menu-item"
        >
          <ChatGptMark className="model-menu-check" />
          <span className="model-menu-name">
            <span className="truncate">{t("chatgpt.continue")}</span>
            <span className="model-menu-hint">{t("chatgpt.menu.hint")}</span>
          </span>
        </button>
      )}
    </div>
  );
}

/** Who runs a model, short: "Anthropic", "OpenAI", "ChatGPT", "Ollama", or a server's host. */
function providerName(provider: ChatProvider, t: ReturnType<typeof useT>): string {
  if (provider.kind === "chatgpt") return "ChatGPT";
  if (provider.kind === "openai-compatible") {
    return provider.service?.name ?? t("providers.kind.openai-compatible");
  }
  return t(`providers.kind.${provider.kind}`);
}
