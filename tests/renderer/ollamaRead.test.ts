import { describe, expect, test } from "vitest";
import type { OllamaStatus } from "../../src/core/api";
import { ollamaRead } from "../../src/renderer/src/ollamaRead";

const running: OllamaStatus = {
  running: true,
  baseUrl: "http://127.0.0.1:11434",
  models: [],
  cloudModels: [],
  recommendedModel: "qwen3.5:4b",
};
type NotRunning = Extract<OllamaStatus, { running: false }>;
const notRunning = (installed = true): NotRunning => ({
  running: false,
  baseUrl: "http://127.0.0.1:11434",
  installed,
  recommendedModel: "qwen3.5:4b",
});
const silent: NotRunning = { ...notRunning(), unknown: true };

describe("What a look for the model app says", () => {
  test("is looking while the first look is out", () => {
    expect(ollamaRead({ status: null, retryComing: false })).toBe("looking");
  });

  test("is still looking while the one retry after a silent look is to come", () => {
    expect(ollamaRead({ status: silent, retryComing: true })).toBe("looking");
  });

  test("settles to not heard from once the retry has been silent too, rather than looking for ever", () => {
    expect(ollamaRead({ status: silent, retryComing: false })).toBe("no-answer");
  });

  test("is found when it answers, with its models", () => {
    expect(ollamaRead({ status: running, retryComing: false })).toBe("running");
  });

  test("is not running when the address refused: the distinction holds both ways", () => {
    expect(ollamaRead({ status: notRunning(), retryComing: false })).toBe("not-running");
    expect(ollamaRead({ status: notRunning(false), retryComing: true })).toBe("not-running");
  });
});
