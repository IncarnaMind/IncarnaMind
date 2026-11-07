import { describe, expect, test } from "vitest";
import type { JevSettings, TaggingModelOption, TaggingModels } from "../../src/core/api";
import {
  jevStateOf,
  offersJevSetUp,
  sortingOptions,
} from "../../src/renderer/src/components/providers/sortingOptions";

/*
 * The sorting picker's list (#2615): with no Jev key it ends with "Use TypeSafe Jev…", which sets
 * Jev up in place; with a key Jev comes first and the set-up row goes; in Local mode only a Jev
 * server on this computer is offered.
 */

const TYPESAFE = { id: "https://api.typesafe.ai", name: "TypeSafe Jev" };
const CHAT = { providerId: "anthropic-1", modelId: "claude-haiku-5-5" };

const jevSettings = (overrides: Partial<JevSettings>): JevSettings => ({
  enabled: false,
  hasApiKey: false,
  endpoint: null,
  model: "jev-latest",
  reviewBand: { low: 0.35, high: 0.65 },
  service: TYPESAFE,
  ...overrides,
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

const CHAT_OPTION: TaggingModelOption = {
  classifier: { kind: "chat", choice: CHAT },
  group: "keys",
  name: "Claude Haiku 5.5",
  provider: { en: "Anthropic", zh: "Anthropic" },
  goodForTagging: true,
  decisionModel: false,
  likelihoods: false,
  cost: { kind: "unknown" },
};

const models = (options: TaggingModelOption[], localMode = false): TaggingModels => ({
  automatic: null,
  options,
  localMode,
  planPausedUntil: null,
  saved: null,
});

/** The picker's rows, as it draws them: the choices, then the set-up row when it is offered. */
function rows(jev: JevSettings | null, options: TaggingModelOption[], localMode = false) {
  const state = jevStateOf(jev);
  const list = sortingOptions(models(options, localMode), {
    chatModel: CHAT,
    language: "en",
    localMode,
    jev: state,
    chatLabel: "Use your AI model",
    chatName: "Claude Haiku 5.5",
  }).map((option) => option.label);
  return offersJevSetUp(state, localMode) ? [...list, "Use TypeSafe Jev…"] : list;
}

describe("the sorting picker's Jev rows (#2615)", () => {
  test("with no Jev key, the set-up row comes last, after the choices that can run", () => {
    expect(rows(jevSettings({}), [CHAT_OPTION])).toEqual([
      "Use your AI model",
      "Use TypeSafe Jev…",
    ]);
  });

  test("set up, but with no key on this device, the set-up row is offered to enter it again", () => {
    expect(rows(jevSettings({ enabled: true }), [JEV_OPTION, CHAT_OPTION])).toEqual([
      "Use your AI model",
      "Use TypeSafe Jev…",
    ]);
  });

  test("with a Jev key, Jev comes first and there is no set-up row", () => {
    expect(
      rows(jevSettings({ enabled: true, hasApiKey: true }), [JEV_OPTION, CHAT_OPTION]),
    ).toEqual(["TypeSafe Jev", "Use your AI model"]);
  });

  test("in Local mode, without a Jev server on this computer, no Jev row appears", () => {
    const local: TaggingModelOption = {
      ...CHAT_OPTION,
      classifier: { kind: "chat", choice: { providerId: "ollama-1", modelId: "qwen3.5:4b" } },
      group: "local",
      name: "Qwen 3.5 4B",
      provider: null,
    };
    expect(rows(jevSettings({}), [local], true)).toEqual([]);
    expect(rows(jevSettings({ enabled: true, hasApiKey: true }), [JEV_OPTION], true)).toEqual([]);
  });

  test("in Local mode, a Jev server on this computer without its key here offers the set-up row", () => {
    const here = jevSettings({ enabled: true, endpoint: "http://127.0.0.1:8080", service: null });
    expect(rows(here, [JEV_OPTION], true)).toEqual(["Use TypeSafe Jev…"]);
  });

  test("in Local mode, a Jev server on this computer is a choice, first, with no set-up row", () => {
    const here = jevSettings({
      enabled: true,
      hasApiKey: true,
      endpoint: "http://127.0.0.1:8080",
      service: null,
    });
    expect(rows(here, [JEV_OPTION], true)).toEqual(["TypeSafe Jev"]);
  });

  test("before Jev's settings are read, no set-up row is drawn", () => {
    expect(rows(null, [CHAT_OPTION])).toEqual(["Use your AI model"]);
  });
});
