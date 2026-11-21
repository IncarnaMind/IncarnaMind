/**
 * First run's Your AI step has one more quiet line, below "Use a model in IncarnaMind": the model
 * that sorts and tags new Documents (#3570). It is optional, closed until it is pressed, and
 * opens the choice Settings › AI › Organize and Tags has, as the one setting. A User who never
 * presses it meets the step as it was; nothing is read, saved or sent for it before.
 */
import { DOMParser } from "linkedom";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AgentClient,
  AgentPairing,
  ChatReadiness,
  DecisionHostStatus,
  JevSettings,
  TaggingClassifier,
  TaggingModelOption,
  TaggingModels,
} from "../../src/core/api";
import { sortingKey } from "../../src/renderer/src/components/providers/sortingOptions";

const page = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
Object.defineProperty(page, "styleSheets", { value: [] });
// How React tells, as it loads, that this document has typing events.
Object.assign(page, { oninput: null });
const view = page.defaultView;

const DECIDER: TaggingModelOption = {
  classifier: { kind: "decision", host: "openrouter", modelId: "perplexity/pplx-decider-v1.2" },
  group: "keys",
  name: "Decider v1.2",
  provider: { en: "OpenRouter", zh: "OpenRouter" },
  goodForTagging: true,
  decisionModel: true,
  likelihoods: true,
  cost: { kind: "unknown" },
};
const NOTHING_CAN_SORT: TaggingModels = {
  automatic: null,
  options: [],
  localMode: false,
  planPausedUntil: null,
  saved: null,
};
const PERPLEXITY: DecisionHostStatus = {
  host: "perplexity",
  name: { en: "Perplexity", zh: "Perplexity" },
  key: "own",
  provider: null,
  account: null,
  hasKey: false,
  ready: false,
  models: [{ id: "pplx-decider-v1.2", name: "Decider v1.2", maker: "Perplexity" }],
  service: null,
  keyUrl: "https://example.test/keys",
  pricingUrl: "https://example.test/pricing",
};
const JEV_READY = {
  enabled: true,
  hasApiKey: true,
  endpoint: null,
  model: "jev-latest",
  service: null,
} as unknown as JevSettings;
const A_KEY = `pplx-${"0f9a".repeat(8)}`;

const client = (id: string, name: string): AgentClient =>
  ({
    id,
    name,
    otherNames: [],
    chat: false,
    installed: id === "claude-code",
    setup: "settings-file",
    skillPath: null,
  }) as unknown as AgentClient;

const world = {
  pairings: [] as AgentPairing[],
  models: NOTHING_CAN_SORT as TaggingModels,
  hosts: [PERPLEXITY],
  classifier: { kind: "automatic" } as { kind: string } & Record<string, unknown>,
  reading: "answers" as "answers" | "never" | "fails",
};
const calls: string[] = [];
/** How many calls the step had made when it was on screen: what comes after is what the User did. */
let baseline = 0;
const saved: Record<string, unknown>[] = [];
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (name: string, payload: unknown = null) => {
  for (const listener of listeners.get(name) ?? []) listener(payload);
};

const taggingModels = (): TaggingModels =>
  world.classifier.kind === "automatic"
    ? world.models
    : {
        ...world.models,
        saved: {
          classifier: world.classifier as unknown as TaggingClassifier,
          destination: {
            kind: "service",
            service: { id: "https://openrouter.ai", name: "OpenRouter" },
          },
        },
      };
const snapshot = () => ({
  groups: [],
  assignments: [],
  asksFor: [],
  settings: {
    classifier: world.classifier,
    organizeWith: null,
    automatic: false,
    taggingStopped: [],
  },
});
const bridge: Record<string, (...args: never[]) => unknown> = {
  on: ((name: string, listener: (payload: unknown) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(listener);
    listeners.set(name, set);
    return () => set.delete(listener);
  }) as never,
  listAgentClients: async () => [client("claude-code", "Claude Code"), client("other", "")],
  getAgents: async () => ({ pairings: world.pairings }),
  listChatProviders: async () => [],
  listApprovalRequests: async () => [],
  listUserQuestions: async () => [],
  listChatModels: async () => [],
  getTaggingModels: (() => {
    if (world.reading === "never") return new Promise(() => undefined);
    if (world.reading === "fails") return Promise.reject(new Error("Ollama didn't answer."));
    return Promise.resolve(taggingModels());
  }) as never,
  listDecisionHosts: async () => world.hosts,
  getJevSettings: async () => JEV_READY,
  getSecretStorage: async () => ({ canSave: true }),
  getLibrary: async () => snapshot(),
  saveLibrarySettings: (async (input: Record<string, unknown>) => {
    saved.push(input);
    world.classifier = input.classifier as typeof world.classifier;
    emit("library.changed");
    emit("chatReadiness.changed", { ...NO_MODEL });
  }) as never,
  setDecisionKey: (async (input: { host: string }) => {
    world.hosts = world.hosts.map((each) =>
      each.host === input.host ? { ...each, hasKey: true, ready: true } : each,
    );
    world.models = { ...world.models, options: [...world.models.options, DECIDER] };
    return world.hosts;
  }) as never,
};
const methods = new Proxy(bridge, {
  get: (each, name) => {
    if (typeof name !== "string") return undefined;
    const method = each[name] ?? (() => Promise.resolve(undefined));
    return (...args: never[]) => {
      calls.push(name);
      return method(...args);
    };
  },
});
Object.assign(view, { incarnamind: methods, incarnamindFiles: methods });
Object.assign(view.HTMLElement.prototype, { scrollIntoView: () => undefined });
const globals: Record<string, unknown> = {
  document: page,
  window: view,
  HTMLElement: view.HTMLElement,
  HTMLInputElement: view.HTMLInputElement,
  Element: view.Element,
  Event: view.Event,
  Node: view.Node,
  MutationObserver: view.MutationObserver,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => undefined,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
vi.stubGlobal("navigator", { userAgent: "node" });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../../src/renderer/src/store");
const stepPath = "../../src/renderer/src/components/firstRun/AiStep.tsx";
const { AiStep }: { AiStep: ComponentType<{ place: unknown }> } = await import(stepPath);
const choicePath = "../../src/renderer/src/components/providers/SortingChoice.tsx";
const { useSorting }: { useSorting: () => unknown } = await import(choicePath);
const rowsPath = "../../src/renderer/src/components/ai/OrganizeRow.tsx";
const { OrganizeRows }: { OrganizeRows: ComponentType<{ id: string; sorting: unknown }> } =
  await import(rowsPath);

const NO_MODEL: ChatReadiness = { ready: false, reason: "no-provider" };
const MODEL = {
  ready: true,
  provider: { id: "anthropic", kind: "anthropic" },
  modelId: "claude-haiku-5-5",
  consent: "not-required",
} as unknown as ChatReadiness;
const FIRST_RUN = ["work", "ai", "meetings"] as const;
const MODEL_STEPS = ["ai", "sorting", "meetings"] as const;
const OWN_AI: AgentPairing = {
  id: "p1",
  name: "Claude Code",
  folderIds: [],
  client: "claude-code",
  propose: true,
  lastUsedAt: null,
  createdAt: "2026-11-21T10:00:00.000Z",
};

const LINE_EN = "Set up a model to sort and tag new Documents (optional)";
const ABOUT_EN =
  "Sorts and tags the Documents you add, by itself. It needs a key from an AI service or a model on this computer. Without it, IncarnaMind uses the model you set up, or asks your AI when you press Organize.";
const LINE_ZH = "设置用来整理新文档和打标签的模型（可选）";
const ABOUT_ZH =
  "自动整理你添加的文档，并为它们打标签。需要 AI 服务的密钥，或这台电脑上的模型。不设置时，IncarnaMind 会用你设置的模型，或在你点“整理”时请你的 AI 来做。";

const next = vi.fn();
let unmount: (() => Promise<void>) | null = null;
async function render(element: ReturnType<typeof createElement>) {
  const container = page.createElement("div", {});
  page.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await act(async () => undefined);
  await act(async () => undefined);
  const before = unmount;
  unmount = async () => {
    await before?.();
    await act(() => root.unmount());
    container.remove();
  };
  return container as unknown as HTMLElement;
}
async function step(
  readiness: ChatReadiness,
  { language = "en", steps = FIRST_RUN as readonly string[] } = {},
) {
  useAppStore.setState({
    chatReadiness: readiness,
    embedding: { localOnly: false },
    settings: { language, user: {}, device: {} },
  } as never);
  await act(async () => useAppStore.getState().refreshLibrary());
  const container = await render(
    createElement(AiStep, { place: { steps, at: steps.indexOf("ai"), next } }),
  );
  baseline = calls.length;
  return container;
}
const find = (container: HTMLElement, testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
const has = (container: HTMLElement, testId: string) => find(container, testId) !== null;
const press = (container: HTMLElement, testId: string) =>
  act(async () => {
    const target = find(container, testId);
    if (!target) throw new Error(`Nothing to press: ${testId}`);
    target.click();
  });
const select = (container: HTMLElement) =>
  container.querySelector('[data-testid="models-sorting"]') as HTMLSelectElement | null;
const choices = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid="models-sorting"] option')].map((each) => [
    each.getAttribute("value"),
    each.textContent,
  ]);
async function choose(container: HTMLElement, value: string) {
  await act(async () => {
    const field = select(container);
    const option = [...(field?.querySelectorAll("option") ?? [])].find(
      (each) => each.getAttribute("value") === value,
    );
    if (!field || !option) throw new Error(`The choice has no ${value}.`);
    // linkedom clears only the options of the same group, so the others are cleared here.
    for (const each of field.querySelectorAll("option")) each.selected = false;
    option.selected = true;
    field.dispatchEvent(new view.Event("change", { bubbles: true }));
  });
  await act(async () => undefined);
}
async function type(container: HTMLElement, testId: string, text: string) {
  await act(async () => {
    const input = find(container, testId);
    if (!input) throw new Error(`Nothing to type in: ${testId}`);
    Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")?.set?.call(
      input,
      text,
    );
    const event = new view.Event("input", { bubbles: true });
    Object.defineProperty(event, "inputType", { value: "insertText" });
    input.dispatchEvent(event);
  });
}
const writes = () =>
  calls.slice(baseline).filter((name) => !/^(get|list)/.test(name) && name !== "on");
const order = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-testid]")].map((each) => each.getAttribute("data-testid"));

beforeEach(() => {
  world.pairings = [];
  world.models = NOTHING_CAN_SORT;
  world.hosts = [PERPLEXITY];
  world.classifier = { kind: "automatic" };
  world.reading = "answers";
  calls.length = 0;
  baseline = 0;
  saved.length = 0;
  next.mockReset();
});
afterEach(async () => {
  await unmount?.();
  unmount = null;
});

describe("the line", () => {
  // protects=the Your AI step ends with one quiet line for the model that sorts and tags new Documents, below the line for a model in IncarnaMind, closed and marked optional in its own words, and until it is pressed nothing is read, saved or sent for it and the step is as it was; fails_when=the line is missing or open, sits above the other, isn't marked optional, or the choice is read before it is pressed.
  test("is there with no model, below the one above it, closed, optional, and reads nothing until pressed", async () => {
    const container = await step(NO_MODEL);
    const line = find(container, "setup-sorting-model-open");
    expect(line?.textContent).toBe(LINE_EN);
    expect(line?.getAttribute("aria-expanded")).toBe("false");
    const shown = order(container);
    expect(shown.indexOf("setup-sorting-model-open")).toBeGreaterThan(
      shown.indexOf("setup-in-app-open"),
    );
    expect(has(container, "setup-sorting-model")).toBe(false);
    expect(select(container)).toBeNull();
    // As it was: the AI they have leads, a model in IncarnaMind is its own closed line.
    expect([...container.querySelectorAll("h2")].map((each) => each.textContent)).toEqual([
      "Use the AI you already have",
    ]);
    expect(has(container, "setup-key")).toBe(false);
    expect(calls.filter((name) => /Tagging|DecisionHosts|Jev/.test(name))).toEqual([]);
    expect(writes()).toEqual([]);
  });

  // protects=the line follows a model that works the same way: below everything the step shows for it, closed; fails_when=it opens by itself, or goes with a model.
  test("with a model working it is the last thing in the step, closed", async () => {
    const container = await step(MODEL);
    const shown = order(container);
    expect(shown.indexOf("setup-sorting-model-open")).toBeGreaterThan(
      shown.indexOf("setup-way-local"),
    );
    expect(find(container, "setup-sorting-model-open")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(has(container, "setup-sorting-model")).toBe(false);
    expect(calls.filter((name) => /Tagging|DecisionHosts|Jev/.test(name))).toEqual([]);
  });

  // protects=the model steps again, which have a Sorting step of their own next, don't offer sorting twice; fails_when=the line shows in that dialog.
  test("is not in the model steps again, where a Sorting step follows", async () => {
    const container = await step(NO_MODEL, { steps: MODEL_STEPS });
    expect(has(container, "setup-in-app-open")).toBe(true);
    expect(has(container, "setup-sorting-model-open")).toBe(false);
  });

  // protects=the line says what it does, what it needs and what happens without it, in English and in Chinese, and the line itself names no decision model, tokens, model version or service; fails_when=a string changes unseen, or jargon or a service's name gets into the line.
  test("says what it does, needs and does without, in both languages, and the line names no service", async () => {
    for (const [language, line, about] of [
      ["en", LINE_EN, ABOUT_EN],
      ["zh-CN", LINE_ZH, ABOUT_ZH],
    ] as const) {
      const container = await step(NO_MODEL, { language });
      const toggle = find(container, "setup-sorting-model-open");
      expect(toggle?.textContent, language).toBe(line);
      expect(line, language).not.toMatch(
        /decision|token|\d\.\d|OpenRouter|Perplexity|Jev|OpenAI|Anthropic|Claude|决策|令牌/i,
      );
      await press(container, "setup-sorting-model-open");
      expect(
        find(container, "setup-sorting-model")?.querySelector("p")?.textContent,
        language,
      ).toBe(about);
      await unmount?.();
      unmount = null;
    }
  });
});

describe("Continue", () => {
  // protects=Continue works with the line closed, open and still reading, and open and failed: the line never holds it or greys it; fails_when=Continue waits for the choice or is disabled by it.
  test("never waits for it: with their AI connected, closed, open and reading, and open when the read fails", async () => {
    world.pairings = [OWN_AI];
    world.reading = "never";
    const container = await step(NO_MODEL);
    const button = () => find(container, "setup-next") as HTMLButtonElement;
    expect(button().disabled).toBe(false);

    await press(container, "setup-sorting-model-open");
    expect(has(container, "setup-sorting-model")).toBe(true);
    expect(select(container)).toBeNull();
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(next).toHaveBeenCalledTimes(1);

    await press(container, "setup-sorting-model-open");
    world.reading = "fails";
    await press(container, "setup-sorting-model-open");
    expect(has(container, "models-sorting-problem")).toBe(true);
    expect(button().disabled).toBe(false);
  });

  // protects=the line doesn't change what Continue waits for: with no AI it is still disabled, with the line closed or open, and Set up later is still there; fails_when=opening the line, or a model chosen in it, enables or disables Continue.
  test("waits for the AI as it did, whether the line is closed, open or used", async () => {
    world.models = { ...NOTHING_CAN_SORT, options: [DECIDER] };
    const container = await step(NO_MODEL);
    const button = () => find(container, "setup-next") as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    await press(container, "setup-sorting-model-open");
    expect(button().disabled).toBe(true);
    await choose(container, sortingKey(DECIDER.classifier));
    expect(button().disabled).toBe(true);
    expect(has(container, "setup-skip")).toBe(true);
  });
});

describe("opened", () => {
  // protects=pressing the line opens the choice in place under it, and pressing it again puts it away, with the step's own foot and the other line untouched and nothing saved or sent; fails_when=the choice doesn't show, the step is left, the line above opens with it, or opening saves or sends.
  test("shows the choice in place, and closing it changes nothing", async () => {
    const container = await step(NO_MODEL);
    await press(container, "setup-sorting-model-open");
    expect(find(container, "setup-sorting-model-open")?.getAttribute("aria-expanded")).toBe("true");
    const panel = find(container, "setup-sorting-model");
    expect(panel?.querySelector("p")?.textContent).toBe(ABOUT_EN);
    expect(panel?.querySelector("label")?.textContent).toBe("Model");
    expect(select(container)).not.toBeNull();
    for (const stays of ["setup-next", "setup-skip", "setup-in-app-open"]) {
      expect(has(container, stays), stays).toBe(true);
    }
    expect(has(container, "setup-key")).toBe(false);
    expect(calls.filter((name) => name === "getTaggingModels")).toHaveLength(1);

    await press(container, "setup-sorting-model-open");
    expect(has(container, "setup-sorting-model")).toBe(false);
    expect(find(container, "setup-sorting-model-open")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(writes()).toEqual([]);
    expect(saved).toEqual([]);
  });

  // protects=the choice is Settings › AI's own: the same pop-up with the same options and the same ways to set one up; fails_when=first run draws a second list of what can sort.
  test("is the choice Settings › AI draws, with the same options", async () => {
    world.models = { ...NOTHING_CAN_SORT, options: [DECIDER] };
    const container = await step(NO_MODEL);
    await press(container, "setup-sorting-model-open");
    const settings = await render(
      createElement(() =>
        createElement(OrganizeRows, { id: "settings-sorting", sorting: useSorting() }),
      ),
    );
    const here = choices(container);
    expect(here.map(([, label]) => label)).toEqual([
      "No model yet",
      "Decider v1.2 · OpenRouter",
      "Use Decider v1.2 · Perplexity…",
      "Other model…",
    ]);
    expect(choices(settings)).toEqual(here);
  });
});

describe("a choice made there", () => {
  // protects=a model chosen from the list is saved as Settings › AI saves it, the one setting, and is what Settings › AI shows; it turns automatic tagging on for nothing, and the line under it says what goes to its service; fails_when=first run keeps a setting of its own, turns the switch on, or shows a different model than Settings.
  test("is the one Settings › AI shows, turns nothing on, and says what it sends", async () => {
    world.models = { ...NOTHING_CAN_SORT, options: [DECIDER] };
    const container = await step(NO_MODEL);
    await press(container, "setup-sorting-model-open");
    const settings = await render(
      createElement(() =>
        createElement(OrganizeRows, { id: "settings-sorting", sorting: useSorting() }),
      ),
    );
    expect(has(container, "models-sorting-line")).toBe(false);

    const key = sortingKey(DECIDER.classifier);
    await choose(container, key);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ classifier: DECIDER.classifier, automatic: false });
    expect(saved[0]).not.toHaveProperty("turnOn");
    expect(select(container)?.value).toBe(key);
    expect(select(settings)?.value).toBe(key);
    // The service, and what goes to it, in the words of every place that chooses it.
    expect(find(container, "models-sorting-line")?.textContent).toContain("OpenRouter receives");
    expect(writes()).toEqual(["saveLibrarySettings"]);
  });

  // protects=a model set up in place sends nothing before its press: the form says what goes above Use this, a key typed goes nowhere, and only Use this keeps it and chooses the model, turning nothing on; fails_when=a key is sent or saved before the press, the line that says what goes is missing, or the switch is turned on.
  test("is set up with its own key only on Use this, under the line that says what goes", async () => {
    const container = await step(NO_MODEL);
    await press(container, "setup-sorting-model-open");
    await choose(container, "set-up:perplexity");

    expect(has(container, "decision-key-form-perplexity")).toBe(true);
    expect(find(container, "models-sorting-line")?.textContent).toContain("Perplexity receives");
    expect(has(container, "models-sorting-line")).toBe(true);
    await type(container, "decision-key-input", A_KEY);
    expect(writes()).toEqual([]);

    expect((find(container, "decision-key-save") as HTMLButtonElement).disabled).toBe(false);
    // The page's own submit: linkedom doesn't send one for a press on the button.
    await act(async () =>
      find(container, "decision-key-form-perplexity")?.dispatchEvent(
        new view.Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    await act(async () => undefined);
    expect(writes()).toEqual(["setDecisionKey", "saveLibrarySettings"]);
    expect(saved[0]).toMatchObject({
      classifier: { kind: "decision", host: "perplexity", modelId: "pplx-decider-v1.2" },
      automatic: false,
    });
    expect(saved[0]).not.toHaveProperty("turnOn");
  });

  // protects=while another model is set up in place the only line that says what goes is the form's own, not also one for the model chosen before; fails_when=two lines say what goes, for two services.
  test("shows one line of what goes while another model is being set up", async () => {
    world.models = { ...NOTHING_CAN_SORT, options: [DECIDER] };
    const container = await step(NO_MODEL);
    await press(container, "setup-sorting-model-open");
    await choose(container, sortingKey(DECIDER.classifier));
    expect(container.querySelectorAll('[data-testid="models-sorting-line"]')).toHaveLength(1);
    await choose(container, "set-up:perplexity");
    const lines = [...container.querySelectorAll('[data-testid="models-sorting-line"]')];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.closest('[data-testid="decision-key-form-perplexity"]')).not.toBeNull();
  });

  // protects=Cancel puts the form away with nothing kept; fails_when=a key typed and cancelled is sent or saved.
  test("is left with Cancel and nothing is kept or sent", async () => {
    const container = await step(NO_MODEL);
    await press(container, "setup-sorting-model-open");
    await choose(container, "set-up:perplexity");
    await type(container, "decision-key-input", A_KEY);
    await press(container, "decision-key-cancel");
    expect(has(container, "decision-key-form-perplexity")).toBe(false);
    expect(writes()).toEqual([]);
  });
});
